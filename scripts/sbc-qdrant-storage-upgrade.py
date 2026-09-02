#!/usr/bin/env python3
"""Crash-evident, offline Qdrant storage upgrade for the primary SBC.

The controller deliberately never publishes the upgraded store.  It clones an
exact stopped v1.9.4 volume, advances the clone through every supported minor
release, and leaves the final v1.19 container stopped for the calling shell to
perform the coupled API/Qdrant cutover.  Every Docker mutation is preceded by
an fsync'd intent and followed by an observed receipt.

This module is intentionally standard-library-only.  The production semantic
probe is executed with the separately attested pipeline virtual environment.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence


SCHEMA_VERSION = 1
MAX_JOURNAL_BYTES = 2 * 1024 * 1024
NAME_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\Z")
HEX64_RE = re.compile(r"[0-9a-f]{64}\Z")
CONTAINER_ID_RE = re.compile(r"[0-9a-f]{64}\Z")
PRODUCTION_STATE_ROOT = Path("/var/lib/diva-player-deploy")
STATEFUL_RUN_PREFIX = "stateful-"
JOURNAL_BASENAME = "qdrant-storage-upgrade.json"
RESULT_BASENAME = "qdrant-storage-upgrade-result.json"
TEST_MODE_ENV = "DIVA_QDRANT_UPGRADE_TEST_MODE"
TEST_STATE_ROOT_ENV = "DIVA_QDRANT_UPGRADE_TEST_STATE_ROOT"
DOCKER_ENDPOINT_ENV = frozenset({
    "DOCKER_API_VERSION",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_CUSTOM_HEADERS",
    "DOCKER_DEFAULT_PLATFORM",
    "DOCKER_HOST",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
})


@dataclasses.dataclass(frozen=True)
class Hop:
    version: str
    tag: str
    digest: str
    unprivileged: bool

    @property
    def reference(self) -> str:
        return f"qdrant/qdrant:{self.tag}@sha256:{self.digest}"

    @property
    def key(self) -> str:
        return "v" + self.version.replace(".", "_")


HOPS: tuple[Hop, ...] = (
    Hop("1.10.1", "v1.10.1-unprivileged", "f0c9863ac7a98b8a8b01db259de35ae0ae79580bb2ccc685e848db3be9c1879e", True),
    Hop("1.11.5", "v1.11.5", "4d7cb5cd2948b61d083581bc1c0a3509ce60ba8eb42e11fd54350d015ea403f6", False),
    Hop("1.12.6", "v1.12.6", "b1a8dda0efdfe1443d3ab1847ade77c128af1d6f324af3de8bf6fbd3bd2d3ea2", False),
    Hop("1.13.6", "v1.13.6", "d0de18974353178cb0a9bbfe4129e4268122d949a3bd89925fffb9bcfc5b8c1e", False),
    Hop("1.14.1", "v1.14.1", "fc59f0ade2574cd64d15888a1095e6991e95ad25d4dd53733aa260c160fab6ac", False),
    # v1.15.5 contains the /logger issue.  It is used only as the required
    # offline migration hop on an internal network with no host port.
    Hop("1.15.5", "v1.15.5", "48c12634a17d8d54f4e3fb95c2b081668039e6e4517ebba57be1882109199ae7", False),
    Hop("1.16.3", "v1.16.3-unprivileged", "9dfabc51ededc48158899a288a19a04de1ab54a11d8c512e1c40eebbd5e2bc92", True),
    Hop("1.17.1", "v1.17.1-unprivileged", "9ccb41c57d4297b082bfadeeb985359234c0497e6456a11b824a63a0e7a9cf65", True),
    Hop("1.18.3", "v1.18.3-unprivileged", "affb67e1d6f2f93d7d20b90d238a7d4b974d36351c162e73bda794e4b2e03483", True),
    Hop("1.19.0", "v1.19.0-unprivileged", "a0e04fe623cb064502cd869cefc1dc7ce359d8edd481063b5bd351c0a0a2c91e", True),
)

AUDIT_BASE_DIGEST = "sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659"
AUDIT_BASE_REFERENCE = f"alpine:3.23.3@{AUDIT_BASE_DIGEST}"
AUDIT_INVENTORY_SHA256 = "3f18c4f5c16154eeba3ffd4970bf886c1699a3b901a3ddcf7948f99a8d2b8c53"
AUDIT_CONTRACT_HELPER_SHA256 = "05da48154d8001f2f97d707b98f4c5870c66a0909ad204adc3c6a34f7de4b6d8"
AUDIT_ARCH_CONTRACTS = {
    "x86_64": {
        "busyboxSha256": "f3547b3d78d08a028a4833ddb83b77cf012838c078bfd2b76355f53d1d8bba62",
        "contractSha256": "ecf630ad651e1e3b53d257b0d19e1aa2e2f28e543442218f4c3992b073425a61",
    },
    "aarch64": {
        "busyboxSha256": "dd10691d81c84f0182f5af5f1583d566ddc0b9d0d9fc46b41b99b83c398306dd",
        "contractSha256": "7c9d227469c7c5ffe8e1b407619bc4f132bdd68ca8d254a2be28ee458bfcc3aa",
    },
}
RUNTIME_CONTRACT = "rootless-readonly-scratch-v3"
RUNTIME_ENV = [
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "QDRANT__STORAGE__SNAPSHOTS_PATH=/qdrant/storage/snapshots",
    "QDRANT__TELEMETRY_DISABLED=true",
]
RUNTIME_COMMAND = ["--config-path", "/qdrant/config/production.yaml"]


class UpgradeError(RuntimeError):
    """Fail-closed upgrade error."""


@dataclasses.dataclass(frozen=True)
class StandaloneBoundary:
    """Privilege and state-root boundary established before argument parsing."""

    state_root: Path
    expected_uid: int
    expected_gid: int
    test_mode: bool


def establish_standalone_boundary(
    environment: Mapping[str, str] | None = None,
    *,
    effective_uid: int | None = None,
    effective_gid: int | None = None,
) -> StandaloneBoundary:
    """Reject ambient Docker routing and select the one permitted state root.

    Production has no state-root override: it is uid/gid 0 at the fixed durable
    root. Deterministic tests must opt in with both test variables and must run
    unprivileged, so the test escape hatch cannot weaken a root invocation.
    """
    values = os.environ if environment is None else environment
    routed = sorted(
        key for key in values
        if key in DOCKER_ENDPOINT_ENV or key.startswith("DOCKER_TLS_")
    )
    if routed:
        raise UpgradeError(
            "ambient Docker endpoint environment is forbidden: " + ", ".join(routed)
        )
    if effective_uid is None:
        getuid = getattr(os, "geteuid", None)
        effective_uid = getuid() if getuid is not None else None
    if effective_gid is None:
        getgid = getattr(os, "getegid", None)
        effective_gid = getgid() if getgid is not None else None

    test_flag_present = TEST_MODE_ENV in values
    test_root_present = TEST_STATE_ROOT_ENV in values
    if test_flag_present or test_root_present:
        if (
            values.get(TEST_MODE_ENV) != "1"
            or not test_root_present
            or not values.get(TEST_STATE_ROOT_ENV)
        ):
            raise UpgradeError("the deterministic Qdrant upgrade test boundary is incomplete")
        if effective_uid is None or effective_gid is None or effective_uid == 0:
            raise UpgradeError("the deterministic Qdrant upgrade test boundary refuses uid 0")
        root_text = values[TEST_STATE_ROOT_ENV]
        state_root = Path(root_text)
        if (
            not state_root.is_absolute()
            or os.path.normpath(root_text) != root_text
            or any(part == ".." for part in state_root.parts)
        ):
            raise UpgradeError("the deterministic Qdrant upgrade test state root is not exact")
        return StandaloneBoundary(state_root, effective_uid, effective_gid, True)

    if effective_uid != 0 or effective_gid != 0:
        raise UpgradeError("standalone Qdrant storage upgrade requires uid/gid 0")
    return StandaloneBoundary(PRODUCTION_STATE_ROOT, 0, 0, False)


def _require_secure_directory(
    path: Path,
    *,
    expected_uid: int,
    expected_gid: int,
    exact_mode: int,
) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise UpgradeError(f"required private state directory is absent: {path}") from error
    if not stat.S_ISDIR(info.st_mode) or path.is_symlink():
        raise UpgradeError(f"private state path is not a real directory: {path}")
    if os.name == "posix" and (
        info.st_uid != expected_uid
        or info.st_gid != expected_gid
        or stat.S_IMODE(info.st_mode) != exact_mode
    ):
        raise UpgradeError(f"private state directory metadata is unsafe: {path}")


def _require_trusted_system_directory(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise UpgradeError(f"trusted system ancestry is absent: {path}") from error
    if (
        not stat.S_ISDIR(info.st_mode)
        or path.is_symlink()
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) & 0o022
    ):
        raise UpgradeError(f"trusted system ancestry is unsafe: {path}")


def _require_secure_regular_or_absent(
    path: Path,
    *,
    expected_uid: int,
    expected_gid: int,
) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if (
        not stat.S_ISREG(info.st_mode)
        or path.is_symlink()
        or info.st_nlink != 1
        or (
            os.name == "posix"
            and (
                info.st_uid != expected_uid
                or info.st_gid != expected_gid
                or stat.S_IMODE(info.st_mode) != 0o600
            )
        )
    ):
        raise UpgradeError(f"existing standalone output is unsafe: {path}")


def validate_standalone_paths(
    arguments: argparse.Namespace,
    boundary: StandaloneBoundary,
) -> None:
    """Bind standalone mutation evidence to one pre-created private run dir."""
    run_id = require_name(arguments.run_id, "run ID")
    run_directory = boundary.state_root / f"{STATEFUL_RUN_PREFIX}{run_id}"
    journal = run_directory / JOURNAL_BASENAME
    result = run_directory / RESULT_BASENAME
    if arguments.journal != str(journal) or arguments.output != str(result):
        raise UpgradeError("journal and result must be the exact fixed run children")
    if boundary.test_mode:
        if not isinstance(arguments.docker, str) or not arguments.docker:
            raise UpgradeError("test Docker command is empty")
    elif arguments.docker != "/usr/bin/docker":
        raise UpgradeError("production standalone upgrade requires /usr/bin/docker")

    if not boundary.test_mode:
        for parent in (Path("/"), Path("/var"), Path("/var/lib")):
            _require_trusted_system_directory(parent)
    _require_secure_directory(
        boundary.state_root,
        expected_uid=boundary.expected_uid,
        expected_gid=boundary.expected_gid,
        exact_mode=0o700,
    )
    _require_secure_directory(
        run_directory,
        expected_uid=boundary.expected_uid,
        expected_gid=boundary.expected_gid,
        exact_mode=0o700,
    )
    _require_secure_regular_or_absent(
        journal,
        expected_uid=boundary.expected_uid,
        expected_gid=boundary.expected_gid,
    )
    _require_secure_regular_or_absent(
        result,
        expected_uid=boundary.expected_uid,
        expected_gid=boundary.expected_gid,
    )


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_bytes(document: Any) -> bytes:
    return (json.dumps(document, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load_runtime_attestation(path_text: str) -> tuple[dict[str, Any], str]:
    """Load the hardener-produced, bounded venv probe attestation.

    This controller is deliberately stdlib-only and never executes the
    pipeline virtual environment.  Its only dependency on that runtime is a
    canonical, owner-only attestation captured by the root hardener while the
    pipeline's shared runtime lock is held.
    """
    path = Path(path_text)
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or (os.name == "posix" and stat.S_IMODE(info.st_mode) != 0o600)
        or info.st_size <= 0
        or info.st_size > 64 * 1024
        or (getattr(os, "geteuid", lambda: -1)() == 0 and info.st_uid != 0)
    ):
        raise UpgradeError("pipeline runtime attestation is unsafe")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or (os.name == "posix" and stat.S_IMODE(opened.st_mode) != 0o600)
            or opened.st_size != info.st_size
            or opened.st_dev != info.st_dev
            or opened.st_ino != info.st_ino
        ):
            raise UpgradeError("pipeline runtime attestation changed while opening")
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                raise UpgradeError("pipeline runtime attestation was truncated")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise UpgradeError("pipeline runtime attestation grew while reading")
        raw = b"".join(chunks)
        if len(raw) != opened.st_size:
            raise UpgradeError("pipeline runtime attestation changed while reading")
        after = os.fstat(descriptor)
        if (after.st_dev, after.st_ino, after.st_size, after.st_nlink) != (
            opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink
        ):
            raise UpgradeError("pipeline runtime attestation changed while reading")
    finally:
        os.close(descriptor)
    try:
        document = json.loads(raw)
    except (UnicodeDecodeError, ValueError) as error:
        raise UpgradeError("pipeline runtime attestation is not JSON") from error
    expected = {
        "baseExecutable", "contract", "executable", "gid", "lockSha256", "patcherSha256",
        "privilegeBoundary", "qdrantClientVersion", "qdrantModule", "runtimeReceiptSha256",
        "schema", "uid", "verifierSha256",
    }
    if (
        not isinstance(document, dict)
        or set(document) != expected
        or document.get("schema") != "diva.pipeline-qdrant-probe-runtime.v1"
        or document.get("contract") != "linux-aarch64"
        or document.get("qdrantClientVersion") != "1.19.0"
        or document.get("privilegeBoundary") != "uid-gid-no-groups-no-caps-nnp"
        or not isinstance(document.get("uid"), int) or document["uid"] <= 0
        or not isinstance(document.get("gid"), int) or document["gid"] < 0
        or any(not isinstance(document.get(key), str) or HEX64_RE.fullmatch(document[key]) is None
               for key in ("lockSha256", "patcherSha256", "runtimeReceiptSha256", "verifierSha256"))
    ):
        raise UpgradeError("pipeline runtime attestation contract mismatch")
    if canonical_bytes(document) != raw:
        raise UpgradeError("pipeline runtime attestation is not canonical")
    return document, sha256_bytes(raw)


def fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except PermissionError:
        # Windows does not permit opening a directory with the POSIX fsync
        # shape.  Production is Linux; Windows is supported only for the
        # deterministic contract tests.
        if os.name == "nt":
            return
        raise
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: Path, payload: bytes, *, mode: int = 0o600) -> None:
    if path.is_symlink():
        raise UpgradeError(f"refusing symlink destination: {path}")
    temporary = path.with_name(path.name + ".tmp")
    if temporary.exists() or temporary.is_symlink():
        raise UpgradeError(f"stale journal staging path exists: {temporary}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open(temporary, flags, mode)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    os.chmod(path, mode)
    fsync_directory(path.parent)


def load_json_exact(path: Path, *, maximum: int = MAX_JOURNAL_BYTES) -> Any:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or (os.name == "posix" and info.st_mode & 0o077):
        raise UpgradeError(f"unsafe journal file: {path}")
    if info.st_size <= 0 or info.st_size > maximum:
        raise UpgradeError(f"journal size is invalid: {path}")
    payload = path.read_bytes()
    document = json.loads(payload)
    if canonical_bytes(document) != payload:
        raise UpgradeError(f"journal is not canonical: {path}")
    return document


class DurableJournal:
    def __init__(self, path: Path, initial: dict[str, Any]) -> None:
        self.path = path
        if path.exists() or path.is_symlink():
            loaded = load_json_exact(path)
            if not isinstance(loaded, dict) or loaded.get("schemaVersion") != SCHEMA_VERSION:
                raise UpgradeError("unsupported upgrade journal")
            immutable = ("runId", "old", "candidate", "expected", "probe")
            if any(loaded.get(key) != initial.get(key) for key in immutable):
                raise UpgradeError("resume parameters do not match the durable journal")
            self.document = loaded
        else:
            self.document = initial
            self.document["schemaVersion"] = SCHEMA_VERSION
            self.document["createdAt"] = utc_now()
            self.document["updatedAt"] = self.document["createdAt"]
            self.document["phase"] = "initialized"
            self.document["intents"] = {}
            self.document["receipts"] = {}
            self._commit()

    def _commit(self) -> None:
        self.document["updatedAt"] = utc_now()
        atomic_write(self.path, canonical_bytes(self.document))

    def set_phase(self, phase: str) -> None:
        self.document["phase"] = phase
        self._commit()

    def intent(self, key: str, operation: str, target: str, command: Sequence[str]) -> None:
        record = {
            "operation": operation,
            "target": target,
            "commandSha256": sha256_bytes("\0".join(command).encode()),
            "createdAt": utc_now(),
        }
        existing = self.document["intents"].get(key)
        if existing is not None and existing != record:
            # Timestamps naturally differ on resume, so compare the immutable fields.
            for field in ("operation", "target", "commandSha256"):
                if existing.get(field) != record[field]:
                    raise UpgradeError(f"mutation intent changed during resume: {key}")
            return
        if existing is None:
            self.document["intents"][key] = record
            self._commit()

    def receipt(self, key: str, observed: dict[str, Any]) -> None:
        if key not in self.document["intents"]:
            raise UpgradeError(f"receipt without durable intent: {key}")
        record = {"observedAt": utc_now(), **observed}
        existing = self.document["receipts"].get(key)
        if existing is not None:
            comparable = dict(existing)
            comparable.pop("observedAt", None)
            expected = dict(record)
            expected.pop("observedAt", None)
            if comparable != expected:
                raise UpgradeError(f"observed resource changed after receipt: {key}")
            return
        self.document["receipts"][key] = record
        self._commit()

    def has_receipt(self, key: str) -> bool:
        return key in self.document["receipts"]

    def receipt_payload(self, key: str) -> dict[str, Any] | None:
        record = self.document["receipts"].get(key)
        if record is None:
            return None
        payload = dict(record)
        payload.pop("observedAt", None)
        return payload


class Runner:
    def __init__(self, docker: str, read_timeout: int, mutation_timeout: int) -> None:
        self.docker = docker
        self.read_timeout = read_timeout
        self.mutation_timeout = mutation_timeout

    def run(self, arguments: Sequence[str], *, mutation: bool = False, input_text: str | None = None) -> str:
        timeout = self.mutation_timeout if mutation else self.read_timeout
        try:
            command_environment = {
                "PATH": os.environ.get("PATH", ""),
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
            }
            if os.environ.get("DOCKER_HOST"):
                command_environment["DOCKER_HOST"] = os.environ["DOCKER_HOST"]
            completed = subprocess.run(
                list(arguments),
                input=input_text,
                text=True,
                encoding="utf-8",
                errors="strict",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
                env=command_environment,
            )
        except subprocess.TimeoutExpired as exception:
            raise UpgradeError(f"bounded command timed out: {arguments[0]}") from exception
        if completed.returncode != 0:
            detail = completed.stderr.strip()[-1000:]
            raise UpgradeError(f"command failed ({completed.returncode}): {arguments[0]}: {detail}")
        return completed.stdout

    def docker_read(self, *arguments: str) -> str:
        return self.run((self.docker, *arguments))

    def docker_mutation(self, *arguments: str) -> str:
        return self.run((self.docker, *arguments), mutation=True)


def require_name(value: str, label: str) -> str:
    if NAME_RE.fullmatch(value) is None:
        raise UpgradeError(f"invalid {label}")
    return value


def require_container_id(value: str, label: str) -> str:
    if CONTAINER_ID_RE.fullmatch(value) is None:
        raise UpgradeError(f"invalid {label}")
    return value


def require_image_id(value: str, label: str) -> str:
    if not value.startswith("sha256:") or HEX64_RE.fullmatch(value[7:]) is None:
        raise UpgradeError(f"invalid {label}")
    return value


def require_sha256(value: str, label: str) -> str:
    if HEX64_RE.fullmatch(value) is None:
        raise UpgradeError(f"invalid {label} SHA-256")
    return value


def inspect_one(runner: Runner, kind: str, reference: str) -> dict[str, Any] | None:
    try:
        raw = runner.docker_read(kind, "inspect", reference)
    except UpgradeError as error:
        # Only a conclusive Docker 'not found' is absence.  Daemon/read errors
        # remain fatal and preserve the journal.
        detail = str(error)
        if kind == "volume":
            exact_absence_suffixes = (
                f"Error response from daemon: get {reference}: no such volume",
                f"Error response from daemon: No such volume: {reference}",
                f"Error: No such volume: {reference}",
            )
            if any(detail.endswith(suffix) for suffix in exact_absence_suffixes):
                return None
            raise
        if "No such" in detail or "not found" in detail.lower():
            return None
        raise
    document = json.loads(raw)
    if not isinstance(document, list) or len(document) != 1 or not isinstance(document[0], dict):
        raise UpgradeError(f"ambiguous Docker {kind} inspect result")
    return document[0]


def container_by_name(runner: Runner, name: str) -> dict[str, Any] | None:
    raw = runner.docker_read(
        "container", "ls", "-a", "--no-trunc", "--filter", f"name=^/{name}$", "--format", "{{.ID}}"
    )
    values = raw.split()
    if len(values) > 1:
        raise UpgradeError(f"ambiguous container name: {name}")
    if not values:
        return None
    require_container_id(values[0], "container inventory ID")
    return inspect_one(runner, "container", values[0])


def volume_projection(item: dict[str, Any]) -> dict[str, Any]:
    labels = item.get("Labels") or {}
    options = item.get("Options") or {}
    projection = {
        "name": item.get("Name"),
        "driver": item.get("Driver"),
        "scope": item.get("Scope"),
        "mountpoint": item.get("Mountpoint"),
        "createdAt": item.get("CreatedAt"),
        "labelsSha256": sha256_bytes(canonical_bytes(labels)),
        "optionsSha256": sha256_bytes(canonical_bytes(options)),
    }
    if not all(isinstance(value, str) and value for value in projection.values()):
        raise UpgradeError("Docker volume identity is incomplete")
    return projection


def assert_old_identity(runner: Runner, expected: dict[str, Any], *, require_stopped: bool) -> dict[str, Any]:
    item = inspect_one(runner, "container", expected["containerId"])
    if item is None:
        raise UpgradeError("exact rollback container disappeared")
    mounts = [
        mount for mount in item.get("Mounts") or []
        if mount.get("Destination") == "/qdrant/storage" and mount.get("Type") == "volume"
    ]
    running = bool((item.get("State") or {}).get("Running"))
    if (
        item.get("Id") != expected["containerId"]
        or item.get("Image") != expected["imageId"]
        or len(mounts) != 1
        or mounts[0].get("Name") != expected["volume"]
        or (require_stopped and running)
    ):
        raise UpgradeError("exact rollback container identity changed")
    volume = inspect_one(runner, "volume", expected["volume"])
    if volume is None or volume_projection(volume) != expected["volumeIdentity"]:
        raise UpgradeError("exact rollback volume identity changed")
    return item


def assert_internal_network(item: dict[str, Any], name: str) -> dict[str, Any]:
    if item.get("Name") != name or item.get("Internal") is not True or item.get("Driver") != "bridge":
        raise UpgradeError("candidate network is not an exact internal bridge")
    if item.get("Options") not in ({}, None) or item.get("Labels") is None:
        raise UpgradeError("candidate network options are unexpected")
    return {"id": item.get("Id"), "name": name, "internal": True, "driver": "bridge"}


def container_projection(item: dict[str, Any], volume: str, network: str, image_id: str) -> dict[str, Any]:
    mounts = [mount for mount in item.get("Mounts") or [] if mount.get("Destination") == "/qdrant/storage"]
    networks = (item.get("NetworkSettings") or {}).get("Networks") or {}
    host = item.get("HostConfig") or {}
    config = item.get("Config") or {}
    if (
        item.get("Image") != image_id
        or len(mounts) != 1
        or mounts[0].get("Type") != "volume"
        or mounts[0].get("Name") != volume
        or set(networks) != {network}
        or (host.get("PortBindings") or {}) != {}
        or host.get("ReadonlyRootfs") is not True
        or sorted(host.get("CapDrop") or []) != ["ALL"]
        or host.get("SecurityOpt") not in (
            ["no-new-privileges"], ["no-new-privileges=true"], ["no-new-privileges:true"]
        )
        or config.get("User") != "1000:1000"
    ):
        raise UpgradeError("upgrade-hop runtime contract mismatch")
    return {
        "containerId": item.get("Id"),
        "imageId": item.get("Image"),
        "volume": volume,
        "network": network,
        "running": bool((item.get("State") or {}).get("Running")),
    }


def audit_container_projection(
    item: dict[str, Any], image_id: str, command_script: str,
) -> dict[str, Any]:
    """Bind the one-shot audit attester to an offline, immutable runtime."""
    host = item.get("HostConfig") or {}
    config = item.get("Config") or {}
    state = item.get("State") or {}
    restart = host.get("RestartPolicy") or {}
    if (
        item.get("Image") != image_id
        or item.get("Mounts") not in (None, [])
        or host.get("NetworkMode") != "none"
        or (host.get("PortBindings") or {}) != {}
        or host.get("ReadonlyRootfs") is not True
        or sorted(host.get("CapDrop") or []) != ["ALL"]
        or (host.get("CapAdd") or []) != []
        or host.get("Privileged") is not False
        or host.get("AutoRemove") is not False
        or restart.get("Name") not in ("", "no")
        or host.get("SecurityOpt") not in (
            ["no-new-privileges"], ["no-new-privileges=true"], ["no-new-privileges:true"]
        )
        or config.get("User") != "65534:65534"
        or config.get("Entrypoint") != ["/bin/sh"]
        or config.get("Cmd") != ["-ec", command_script]
        or state.get("Running") is not False
        or state.get("ExitCode") != 0
    ):
        raise UpgradeError("offline audit attester runtime contract mismatch")
    return {
        "containerId": require_container_id(item.get("Id", ""), "audit attester ID"),
        "imageId": image_id,
        "exitCode": 0,
        "networkMode": "none",
        "user": "65534:65534",
    }


def image_id_for_reference(runner: Runner, reference: str) -> str | None:
    try:
        raw = runner.docker_read("image", "inspect", "--format", "{{.Id}}", reference).strip()
    except UpgradeError as error:
        if "No such" in str(error) or "not found" in str(error).lower():
            return None
        raise
    return require_image_id(raw, "image ID")


class UpgradeController:
    def __init__(self, arguments: argparse.Namespace) -> None:
        self.arguments = arguments
        self.runner = Runner(arguments.docker, arguments.read_timeout, arguments.mutation_timeout)
        run_id = require_name(arguments.run_id, "run ID")
        old_volume = require_name(arguments.old_volume, "old volume")
        candidate_volume = require_name(arguments.candidate_volume, "candidate volume")
        if candidate_volume == old_volume or run_id not in candidate_volume:
            raise UpgradeError("candidate volume must be run-unique and separate from rollback")
        self.network = require_name(arguments.upgrade_network, "upgrade network")
        if run_id not in self.network:
            raise UpgradeError("upgrade network must be run-unique")
        self.old = {
            "containerId": require_container_id(arguments.old_container_id, "old container ID"),
            "containerName": require_name(arguments.old_container_name, "old container name"),
            "imageId": require_image_id(arguments.old_image_id, "old image ID"),
            "volume": old_volume,
            "volumeIdentity": json.loads(arguments.old_volume_identity),
        }
        expected = json.loads(Path(arguments.expected_fingerprint).read_text(encoding="utf-8"))
        if not isinstance(expected, dict) or not isinstance(expected.get("collections"), dict):
            raise UpgradeError("expected Qdrant fingerprint is invalid")
        self.expected_fingerprint = expected
        probe_slots = json.loads(arguments.probe_slots)
        if set(probe_slots) != {"api_a", "api_b"}:
            raise UpgradeError("exact API A/B probe images are required")
        for slot, image_id in probe_slots.items():
            probe_slots[slot] = require_image_id(image_id, f"{slot} probe image")
        self.audit_image_id = require_image_id(arguments.audit_image_id, "offline audit image")
        final_image_id = require_image_id(arguments.final_image_id, "hardened final image")
        if self.audit_image_id == final_image_id:
            raise UpgradeError("offline audit image must be distinct from the scratch runtime")
        self.runtime_evidence = {
            "binarySha256": require_sha256(arguments.runtime_binary_sha256, "Qdrant binary"),
            "configTreeSha256": require_sha256(arguments.runtime_config_sha256, "Qdrant config tree"),
            "linksSha256": require_sha256(arguments.runtime_links_sha256, "Qdrant runtime links"),
            "dockerfileSha256": require_sha256(arguments.dockerfile_sha256, "Qdrant Dockerfile"),
            "baseReference": HOPS[-1].reference,
        }
        audit_architecture = arguments.audit_architecture
        audit_expected = AUDIT_ARCH_CONTRACTS.get(audit_architecture)
        if audit_expected is None:
            raise UpgradeError("offline audit architecture is unsupported")
        self.audit_evidence = {
            "architecture": audit_architecture,
            "baseDigest": AUDIT_BASE_DIGEST,
            "baseReference": AUDIT_BASE_REFERENCE,
            "inventorySha256": require_sha256(
                arguments.audit_inventory_sha256, "offline audit package inventory"
            ),
            "busyboxSha256": require_sha256(
                arguments.audit_busybox_sha256, "offline audit BusyBox"
            ),
            "contractSha256": require_sha256(
                arguments.audit_contract_sha256, "offline audit contract"
            ),
            "contractHelperSha256": require_sha256(
                arguments.audit_contract_helper_sha256, "offline audit contract helper"
            ),
        }
        if (
            self.audit_evidence["inventorySha256"] != AUDIT_INVENTORY_SHA256
            or self.audit_evidence["busyboxSha256"] != audit_expected["busyboxSha256"]
            or self.audit_evidence["contractSha256"] != audit_expected["contractSha256"]
            or self.audit_evidence["contractHelperSha256"] != AUDIT_CONTRACT_HELPER_SHA256
        ):
            raise UpgradeError("offline audit evidence does not match the pinned architecture map")
        runtime_attestation, runtime_attestation_sha256 = load_runtime_attestation(
            arguments.runtime_attestation
        )
        initial = {
            "runId": run_id,
            "old": self.old,
            "candidate": {"volume": candidate_volume, "network": self.network},
            "expected": {
                "fingerprintSha256": sha256_bytes(canonical_bytes(expected)),
                "publicationGeneration": arguments.publication_generation,
                "hops": [dataclasses.asdict(hop) for hop in HOPS],
                "auditImageId": self.audit_image_id,
                "auditEvidence": self.audit_evidence,
                "finalImageId": final_image_id,
                "runtimeEvidence": self.runtime_evidence,
                "pipelineRuntimeAttestation": runtime_attestation,
                "pipelineRuntimeAttestationSha256": runtime_attestation_sha256,
            },
            "probe": {"apiImages": probe_slots, "seedSongId": arguments.seed_song_id},
        }
        journal_path = Path(arguments.journal)
        if not journal_path.parent.is_dir() or journal_path.parent.is_symlink():
            raise UpgradeError("journal parent is not the pre-created private run directory")
        self.journal = DurableJournal(journal_path, initial)
        self.candidate_volume = candidate_volume
        self.probe_slots: dict[str, str] = probe_slots

    def mutation(
        self,
        key: str,
        operation: str,
        target: str,
        command: Sequence[str],
        observe: Callable[[], dict[str, Any] | None],
    ) -> dict[str, Any]:
        self.journal.intent(key, operation, target, (self.arguments.docker, *command))
        observed = observe()
        if observed is None:
            if self.journal.has_receipt(key):
                raise UpgradeError(f"received resource disappeared: {key}")
            self.runner.docker_mutation(*command)
            observed = observe()
            if observed is None:
                raise UpgradeError(f"Docker mutation did not create expected state: {key}")
        self.journal.receipt(key, observed)
        return observed

    def ensure_image(self, hop: Hop) -> str:
        key = f"pull.{hop.key}"
        expected_digest = "sha256:" + hop.digest

        def observe() -> dict[str, Any] | None:
            image_id = image_id_for_reference(self.runner, hop.reference)
            if image_id is None:
                return None
            raw = self.runner.docker_read("image", "inspect", hop.reference)
            item = json.loads(raw)[0]
            repo_digests = item.get("RepoDigests") or []
            if not any(value.endswith("@" + expected_digest) for value in repo_digests):
                raise UpgradeError(f"pulled image lacks exact manifest digest: {hop.version}")
            return {"imageId": image_id, "manifestDigest": expected_digest, "reference": hop.reference}

        result = self.mutation(key, "image-pull", hop.reference, ("pull", hop.reference), observe)
        return require_image_id(result["imageId"], "pulled image ID")

    def ensure_network(self) -> dict[str, Any]:
        labels = ("com.diva.role=qdrant-offline-upgrade", f"com.diva.run={self.arguments.run_id}")

        def observe() -> dict[str, Any] | None:
            item = inspect_one(self.runner, "network", self.network)
            if item is None:
                return None
            projection = assert_internal_network(item, self.network)
            actual_labels = item.get("Labels") or {}
            if actual_labels != {
                "com.diva.role": "qdrant-offline-upgrade",
                "com.diva.run": self.arguments.run_id,
            }:
                raise UpgradeError("upgrade network labels changed")
            return projection

        command = (
            "network", "create", "--driver", "bridge", "--internal",
            "--label", labels[0], "--label", labels[1], self.network,
        )
        return self.mutation("network.create", "network-create", self.network, command, observe)

    def ensure_volume(self) -> dict[str, Any]:
        expected_labels = {
            "com.diva.role": "qdrant-upgrade-candidate",
            "com.diva.run": self.arguments.run_id,
            "com.diva.rollback-volume": self.old["volume"],
        }

        def observe() -> dict[str, Any] | None:
            item = inspect_one(self.runner, "volume", self.candidate_volume)
            if item is None:
                return None
            if item.get("Labels") != expected_labels or item.get("Options") not in ({}, None):
                raise UpgradeError("candidate volume labels/options changed")
            return volume_projection(item)

        command: list[str] = ["volume", "create", "--driver", "local"]
        for key, value in sorted(expected_labels.items()):
            command.extend(("--label", f"{key}={value}"))
        command.append(self.candidate_volume)
        return self.mutation("volume.create", "volume-create", self.candidate_volume, tuple(command), observe)

    def stop_old(self) -> dict[str, Any]:
        def observe() -> dict[str, Any] | None:
            item = assert_old_identity(self.runner, self.old, require_stopped=False)
            if (item.get("State") or {}).get("Running") is True:
                return None
            assert_old_identity(self.runner, self.old, require_stopped=True)
            return {"containerId": self.old["containerId"], "running": False}

        return self.mutation(
            "old.stop", "container-stop", self.old["containerId"],
            ("stop", "--time", "120", self.old["containerId"]), observe,
        )

    def helper_container(
        self,
        key: str,
        name: str,
        image_id: str,
        command: Sequence[str],
        mounts: Sequence[tuple[str, str, bool]],
        *,
        restart_exit_codes: frozenset[int] = frozenset(),
    ) -> dict[str, Any]:
        expected_mounts = {
            destination: {"name": source, "readOnly": read_only}
            for source, destination, read_only in mounts
        }
        if len(expected_mounts) != len(mounts):
            raise UpgradeError("duplicate helper mount destination")

        def project(item: dict[str, Any]) -> dict[str, Any]:
            config = item.get("Config") or {}
            host = item.get("HostConfig") or {}
            actual_mounts: dict[str, dict[str, Any]] = {}
            for mount in item.get("Mounts") or []:
                destination = mount.get("Destination")
                if not isinstance(destination, str) or destination in actual_mounts:
                    raise UpgradeError(f"helper mount inventory is ambiguous: {name}")
                actual_mounts[destination] = {
                    "name": mount.get("Name"),
                    "readOnly": mount.get("RW") is False,
                }
            entrypoint = config.get("Entrypoint")
            if isinstance(entrypoint, str):
                entrypoint = [entrypoint]
            labels = config.get("Labels") or {}
            if (
                item.get("Image") != image_id
                or actual_mounts != expected_mounts
                or host.get("NetworkMode") != "none"
                or host.get("ReadonlyRootfs") is not True
                or sorted(host.get("CapDrop") or []) != ["ALL"]
                or sorted(host.get("CapAdd") or []) != ["CHOWN", "DAC_OVERRIDE"]
                or host.get("SecurityOpt") not in (
                    ["no-new-privileges"], ["no-new-privileges=true"],
                    ["no-new-privileges:true"],
                )
                or config.get("User") != "0:0"
                or entrypoint != [command[0]]
                or (config.get("Cmd") or []) != list(command[1:])
                or labels.get("com.diva.role") != "qdrant-offline-helper"
                or labels.get("com.diva.run") != self.arguments.run_id
                or labels.get("com.diva.operation") != key
            ):
                raise UpgradeError(f"helper runtime contract mismatch: {name}")
            state = item.get("State") or {}
            return {
                "containerId": item.get("Id"),
                "imageId": image_id,
                "exitCode": state.get("ExitCode"),
                "running": state.get("Running") is True,
                "mounts": expected_mounts,
            }

        def wait_for_exit(item: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
            projection = project(item)
            if projection["running"] is True:
                deadline = time.monotonic() + self.arguments.mutation_timeout
                while time.monotonic() < deadline:
                    time.sleep(1)
                    item = inspect_one(self.runner, "container", str(item["Id"]))
                    if item is None:
                        raise UpgradeError(f"helper disappeared: {name}")
                    projection = project(item)
                    if projection["running"] is not True:
                        break
            if projection["running"] is True:
                raise UpgradeError(f"helper did not stop within its bound: {name}")
            return item, projection

        def restart_interrupted(item: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
            container_id = require_container_id(str(item.get("Id") or ""), "helper container ID")
            prefix = key + ".restart."
            numbers: list[int] = []
            pending: list[str] = []
            for restart_key in self.journal.document["intents"]:
                if not restart_key.startswith(prefix):
                    continue
                suffix = restart_key[len(prefix):]
                if not suffix.isdigit():
                    raise UpgradeError(f"malformed helper restart intent: {restart_key}")
                numbers.append(int(suffix))
                if not self.journal.has_receipt(restart_key):
                    pending.append(restart_key)
            if len(pending) > 1:
                raise UpgradeError("multiple unresolved helper restart intents")
            if pending:
                restart_key = pending[0]
            else:
                next_number = max(numbers, default=0) + 1
                if next_number > 100:
                    raise UpgradeError("helper restart budget exhausted")
                restart_key = f"{prefix}{next_number}"
            docker_restart = ("start", container_id)
            self.journal.intent(
                restart_key, "helper-restart", container_id,
                (self.arguments.docker, *docker_restart),
            )
            current = inspect_one(self.runner, "container", container_id)
            if current is None:
                raise UpgradeError("interrupted helper disappeared before exact restart")
            current_projection = project(current)
            if current_projection["running"] is not True and current_projection["exitCode"] != 0:
                if current_projection["exitCode"] not in restart_exit_codes:
                    raise UpgradeError(f"helper failed rather than being interrupted: {name}")
                self.runner.docker_mutation(*docker_restart)
                current = inspect_one(self.runner, "container", container_id)
                if current is None:
                    raise UpgradeError("helper disappeared after exact restart")
            current, current_projection = wait_for_exit(current)
            if current_projection["exitCode"] != 0:
                raise UpgradeError(f"restarted helper did not finish exactly: {name}")
            self.journal.receipt(restart_key, {
                "containerId": container_id,
                "imageId": image_id,
                "exitCode": 0,
            })
            return current, current_projection

        def observe() -> dict[str, Any] | None:
            item = container_by_name(self.runner, name)
            if item is None:
                return None
            item, projection = wait_for_exit(item)
            pending_restart = any(
                restart_key.startswith(key + ".restart.")
                and not self.journal.has_receipt(restart_key)
                for restart_key in self.journal.document["intents"]
            )
            if pending_restart or (
                projection["exitCode"] != 0 and projection["exitCode"] in restart_exit_codes
            ):
                item, projection = restart_interrupted(item)
            if projection["exitCode"] != 0:
                raise UpgradeError(f"helper did not finish exactly: {name}")
            return {
                "containerId": item.get("Id"),
                "imageId": image_id,
                "exitCode": 0,
                "mounts": expected_mounts,
            }

        docker_command = (
            "run", "--name", name, "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE",
            "--security-opt", "no-new-privileges", "--user", "0:0",
            "--label", "com.diva.role=qdrant-offline-helper",
            "--label", f"com.diva.run={self.arguments.run_id}",
            "--label", f"com.diva.operation={key}",
            *(
                option
                for source, destination, read_only in mounts
                for option in ("--volume", f"{source}:{destination}:{'ro' if read_only else 'rw'}")
            ),
            "--entrypoint", command[0], image_id, *command[1:],
        )
        return self.mutation(key, "helper-run", name, docker_command, observe)

    def attest_audit_filesystem(self) -> dict[str, Any]:
        """Execute the audit image's filesystem contract as its default nobody user.

        This deliberately runs before the rollback Qdrant is stopped.  The image
        receives no mounts, network, capabilities or writable root, so failure
        cannot mutate either the old store or the candidate.
        """
        evidence = self.audit_evidence
        hardlinks = "awk chown cp find readlink sha256sum sort stat tr wc xargs"
        directories = "/ /bin /etc /lib /lib/apk /lib/apk/db /usr /usr/share /usr/share/diva-qdrant"
        script = f"""
set -eu
[ "$(sha256sum /bin/busybox | awk '{{print $1}}')" = '{evidence['busyboxSha256']}' ]
[ "$(busybox 2>&1 | awk 'NR == 1 {{ print }}')" = 'BusyBox v1.37.0 (2025-12-16 14:19:28 UTC) multi-call binary.' ]
busybox_identity=$(stat -c '%d:%i' /bin/busybox)
[ "$(stat -c '%u:%g:%a:%h' /bin/busybox)" = '0:0:755:12' ]
for applet in {hardlinks}; do
  [ -f "/bin/$applet" ] && [ ! -L "/bin/$applet" ]
  [ "$(stat -c '%d:%i' "/bin/$applet")" = "$busybox_identity" ]
  [ "$(stat -c '%u:%g:%a:%h' "/bin/$applet")" = '0:0:755:12' ]
done
[ -L /bin/sh ] && [ "$(readlink /bin/sh)" = /bin/busybox ]
[ -f /lib/apk/db/installed ] && [ ! -L /lib/apk/db/installed ]
[ "$(stat -c '%u:%g:%a:%h' /lib/apk/db/installed)" = '0:0:644:1' ]
for directory in {directories}; do
  [ -d "$directory" ] && [ ! -L "$directory" ]
  [ "$(stat -c '%u:%g:%a' "$directory")" = '0:0:755' ]
  [ -x "$directory" ] && [ ! -w "$directory" ]
done
[ "$(sha256sum /usr/share/diva-qdrant/audit-packages.txt | awk '{{print $1}}')" = '{evidence['inventorySha256']}' ]
[ "$(/bin/busybox cat /usr/share/diva-qdrant/audit-contract.sha256)" = '{evidence['contractSha256']}' ]
[ "$(sha256sum /usr/share/diva-qdrant/audit-contract.txt | awk '{{print $1}}')" = '{evidence['contractSha256']}' ]
cd /
sha256sum -c /usr/share/diva-qdrant/audit-files.sha256 >/dev/null
printf 'filesystemContractSha256=%s\ninventorySha256=%s\nbusyboxSha256=%s\nbusyboxNlink=12\n' \
  '{evidence['contractSha256']}' '{evidence['inventorySha256']}' '{evidence['busyboxSha256']}'
""".strip()
        name = require_name(
            f"diva_qaudit_attest_{self.arguments.run_id}", "audit attester"
        )
        command = (
            "run", "--name", name, "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--user", "65534:65534", "--restart", "no",
            "--label", "com.diva.role=qdrant-audit-attester",
            "--label", f"com.diva.run={self.arguments.run_id}",
            "--entrypoint", "/bin/sh", self.audit_image_id, "-ec", script,
        )
        key = "audit.filesystem.attest"
        self.journal.intent(
            key, "audit-filesystem-attest", self.audit_image_id,
            (self.arguments.docker, *command),
        )
        item = container_by_name(self.runner, name)
        if item is None:
            if self.journal.has_receipt(key):
                raise UpgradeError("received audit attester disappeared")
            self.runner.docker_mutation(*command)
            item = container_by_name(self.runner, name)
        if item is None:
            raise UpgradeError("audit attester did not create an observable container")
        deadline = time.monotonic() + self.arguments.read_timeout
        while bool((item.get("State") or {}).get("Running")) and time.monotonic() < deadline:
            time.sleep(1)
            refreshed = inspect_one(self.runner, "container", item.get("Id", ""))
            if refreshed is None:
                raise UpgradeError("audit attester disappeared while running")
            item = refreshed
        projection = audit_container_projection(item, self.audit_image_id, script)
        output = self.runner.docker_read("logs", projection["containerId"])
        values: dict[str, str] = {}
        expected = {
            "filesystemContractSha256": evidence["contractSha256"],
            "inventorySha256": evidence["inventorySha256"],
            "busyboxSha256": evidence["busyboxSha256"],
            "busyboxNlink": "12",
        }
        for line in output.splitlines():
            field, separator, value = line.partition("=")
            if separator != "=" or field not in expected or field in values:
                raise UpgradeError("audit attester output is malformed")
            values[field] = value
        if values != expected:
            raise UpgradeError("audit attester evidence does not match the pinned contract")
        observed = {**projection, **values}
        self.journal.receipt(key, observed)
        return observed

    def volume_tree_digest(self, key: str, name: str, audit_image_id: str, volume: str) -> dict[str, str]:
        script = r'''
set -eu
cd /volume
structure=$(
  find . -xdev -print0 | LC_ALL=C sort -z |
    while IFS= read -r -d '' path; do
      link=''
      [ ! -L "$path" ] || link=$(readlink "$path")
      printf '%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0' \
        "$(stat -c '%f' "$path")" "${path#./}" "$(stat -c '%s' "$path")" \
        "$(stat -c '%u' "$path")" "$(stat -c '%g' "$path")" \
        "$(stat -c '%a' "$path")" "$(stat -c '%Y' "$path")" "$link"
    done | sha256sum | awk '{print $1}'
)
logical_structure=$(
  find . -xdev -print0 | LC_ALL=C sort -z |
    while IFS= read -r -d '' path; do
      link=''
      [ ! -L "$path" ] || link=$(readlink "$path")
      printf '%s\0%s\0%s\0%s\0%s\0%s\0' \
        "$(stat -c '%f' "$path")" "${path#./}" "$(stat -c '%s' "$path")" \
        "$(stat -c '%a' "$path")" "$(stat -c '%Y' "$path")" "$link"
    done | sha256sum | awk '{print $1}'
)
content=$(
  find . -xdev -type f -print0 | LC_ALL=C sort -z |
    while IFS= read -r -d '' path; do
      digest=$(sha256sum "$path"); digest=${digest%% *}
      printf '%s\0%s\0' "${path#./}" "$digest"
    done | sha256sum | awk '{print $1}'
)
entries=$(find . -xdev -print0 | while IFS= read -r -d '' path; do printf '.\n'; done | wc -l | tr -d '[:space:]')
non_root_owned=$(find . -xdev -print0 | while IFS= read -r -d '' path; do
  [ "$(stat -c '%u:%g' "$path")" = 0:0 ] || printf .
done | wc -c | tr -d '[:space:]')
non_rootless_owned=$(find . -xdev -print0 | while IFS= read -r -d '' path; do
  [ "$(stat -c '%u:%g' "$path")" = 1000:1000 ] || printf .
done | wc -c | tr -d '[:space:]')
printf 'structure=%s\nlogicalStructure=%s\ncontent=%s\nentries=%s\nnonRootOwned=%s\nnonRootlessOwned=%s\n' \
  "$structure" "$logical_structure" "$content" "$entries" "$non_root_owned" "$non_rootless_owned"
'''.strip()
        command = (
            "run", "--name", name, "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "0:0",
            "--volume", f"{volume}:/volume:ro",
            "--entrypoint", "/bin/sh", audit_image_id,
            "-ec", script,
        )
        self.journal.intent(key, "volume-tree-digest", volume, (self.arguments.docker, *command))
        item = container_by_name(self.runner, name)
        if item is None:
            if self.journal.has_receipt(key):
                raise UpgradeError(f"received volume digest helper disappeared: {name}")
            self.runner.docker_mutation(*command)
            item = container_by_name(self.runner, name)
        if item is None or item.get("Image") != audit_image_id:
            raise UpgradeError("volume digest helper identity mismatch")
        state = item.get("State") or {}
        if state.get("Running") is True or state.get("ExitCode") != 0:
            raise UpgradeError("volume digest helper did not finish exactly")
        output = self.runner.docker_read("logs", item["Id"])
        values: dict[str, str] = {}
        digest_fields = {"structure", "logicalStructure", "content"}
        count_fields = {"entries", "nonRootOwned", "nonRootlessOwned"}
        for line in output.splitlines():
            field, separator, value = line.partition("=")
            if separator == "=" and (
                (field in digest_fields and HEX64_RE.fullmatch(value))
                or (field in count_fields and re.fullmatch(r"0|[1-9][0-9]{0,15}", value))
            ):
                if field in values:
                    raise UpgradeError("duplicate volume digest field")
                values[field] = value
        if set(values) != digest_fields | count_fields:
            raise UpgradeError("volume digest helper output is malformed")
        observed = {"containerId": item["Id"], "imageId": audit_image_id, **values}
        self.journal.receipt(key, observed)
        return values

    def clone_volume(self, audit_image_id: str) -> None:
        name = require_name(f"diva_qclone_{self.arguments.run_id}", "clone helper")
        self.helper_container(
            "volume.clone", name, audit_image_id,
            ("/bin/cp", "-a", "/source/.", "/target/"),
            (
                (self.old["volume"], "/source", True),
                (self.candidate_volume, "/target", False),
            ),
            restart_exit_codes=frozenset({137, 143}),
        )

    def chown_candidate_fd_safe(self) -> None:
        """Idempotently convert only the offline candidate tree to uid/gid 1000.

        Docker never receives the rollback volume as writable.  The host-side
        walk opens every directory relative to an already verified descriptor,
        refuses symlinks for descent and refuses device-boundary crossings.
        Replaying after power loss is safe because fchown is idempotent and no
        file bytes, names, modes or timestamps are modified.
        """
        if os.name != "posix" or os.geteuid() != 0:
            raise UpgradeError("fd-safe candidate ownership conversion requires production uid 0")
        candidate_item = inspect_one(self.runner, "volume", self.candidate_volume)
        old_item = inspect_one(self.runner, "volume", self.old["volume"])
        if candidate_item is None or old_item is None:
            raise UpgradeError("candidate or rollback volume disappeared before ownership conversion")
        candidate_projection = volume_projection(candidate_item)
        expected_candidate = self.journal.receipt_payload("volume.create")
        if expected_candidate != candidate_projection:
            raise UpgradeError("candidate volume identity changed before ownership conversion")
        if volume_projection(old_item) != self.old["volumeIdentity"]:
            raise UpgradeError("rollback volume identity changed before ownership conversion")
        candidate_path = Path(candidate_projection["mountpoint"])
        old_path = Path(self.old["volumeIdentity"]["mountpoint"])
        flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        candidate_fd = os.open(candidate_path, flags)
        old_fd = os.open(old_path, flags)
        try:
            candidate_root = os.fstat(candidate_fd)
            old_root = os.fstat(old_fd)
            if (candidate_root.st_dev, candidate_root.st_ino) == (old_root.st_dev, old_root.st_ino):
                raise UpgradeError("candidate and rollback volume roots alias")
            identity = f"{candidate_root.st_dev}:{candidate_root.st_ino}"
            command = ("host-fd-chown", self.candidate_volume, identity, "1000:1000")
            self.journal.intent(
                "volume.chown", "fd-safe-candidate-ownership", self.candidate_volume, command,
            )
            received = self.journal.receipt_payload("volume.chown")
            expected_receipt = {
                "mountpointDeviceInode": identity,
                "uid": 1000,
                "gid": 1000,
                "oldVolumeUntouched": self.old["volume"],
            }
            if received is not None:
                if received != expected_receipt:
                    raise UpgradeError("candidate ownership receipt identity changed")
                return

            root_device = candidate_root.st_dev

            def convert(directory_fd: int) -> None:
                with os.scandir(directory_fd) as inventory:
                    entries = list(inventory)
                for entry in entries:
                    before = entry.stat(follow_symlinks=False)
                    if before.st_dev != root_device:
                        raise UpgradeError("candidate ownership walk crossed a device boundary")
                    if stat.S_ISDIR(before.st_mode):
                        child_fd = os.open(entry.name, flags, dir_fd=directory_fd)
                        try:
                            opened = os.fstat(child_fd)
                            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                                raise UpgradeError("candidate directory changed during fd-safe walk")
                            convert(child_fd)
                            os.fchown(child_fd, 1000, 1000)
                            os.fsync(child_fd)
                        finally:
                            os.close(child_fd)
                    elif stat.S_ISREG(before.st_mode):
                        file_flags = (
                            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
                            | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
                        )
                        file_fd = os.open(entry.name, file_flags, dir_fd=directory_fd)
                        try:
                            opened = os.fstat(file_fd)
                            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                                raise UpgradeError("candidate file changed during fd-safe walk")
                            os.fchown(file_fd, 1000, 1000)
                            os.fsync(file_fd)
                        finally:
                            os.close(file_fd)
                    elif stat.S_ISLNK(before.st_mode):
                        os.chown(
                            entry.name, 1000, 1000, dir_fd=directory_fd,
                            follow_symlinks=False,
                        )
                    else:
                        raise UpgradeError("candidate contains a non-file/non-directory/non-symlink entry")
            convert(candidate_fd)
            os.fchown(candidate_fd, 1000, 1000)
            os.fsync(candidate_fd)
            if hasattr(os, "sync"):
                os.sync()
            self.journal.receipt("volume.chown", expected_receipt)
        finally:
            os.close(old_fd)
            os.close(candidate_fd)

    def hop_name(self, hop: Hop) -> str:
        return require_name(f"diva_qhop_{self.arguments.run_id}_{hop.key}", "hop container")

    def _restart_upgrade_container(
        self, start_key: str, item: dict[str, Any], image_id: str,
    ) -> dict[str, Any]:
        container_id = require_container_id(str(item.get("Id") or ""), "upgrade container ID")
        prefix = start_key + ".restart."
        restart_numbers: list[int] = []
        pending: list[str] = []
        for key in self.journal.document["intents"]:
            if not key.startswith(prefix):
                continue
            suffix = key[len(prefix):]
            if not suffix.isdigit():
                raise UpgradeError(f"malformed restart intent: {key}")
            restart_numbers.append(int(suffix))
            if not self.journal.has_receipt(key):
                pending.append(key)
        if len(pending) > 1:
            raise UpgradeError("multiple unresolved container restart intents")
        if pending:
            restart_key = pending[0]
        else:
            next_number = max(restart_numbers, default=0) + 1
            if next_number > 100:
                raise UpgradeError("upgrade container restart budget exhausted")
            restart_key = f"{prefix}{next_number}"
        command = ("start", container_id)
        self.journal.intent(
            restart_key, "container-restart", container_id,
            (self.arguments.docker, *command),
        )
        current = inspect_one(self.runner, "container", container_id)
        if current is None:
            raise UpgradeError("upgrade container disappeared during exact restart")
        projection = container_projection(current, self.candidate_volume, self.network, image_id)
        if projection["running"] is not True:
            self.runner.docker_mutation(*command)
            current = inspect_one(self.runner, "container", container_id)
            if current is None:
                raise UpgradeError("upgrade container disappeared after exact restart")
            projection = container_projection(current, self.candidate_volume, self.network, image_id)
        if projection["running"] is not True:
            raise UpgradeError("upgrade container did not become running after exact restart")
        self.journal.receipt(restart_key, {
            "containerId": container_id,
            "imageId": image_id,
            "running": True,
        })
        return projection

    def _ensure_upgrade_container(
        self, start_key: str, name: str, image_id: str, command: Sequence[str],
    ) -> dict[str, Any]:
        self.journal.intent(
            start_key, "container-run", name,
            (self.arguments.docker, *command),
        )
        item = container_by_name(self.runner, name)
        received = self.journal.receipt_payload(start_key)
        if item is None:
            if received is not None:
                raise UpgradeError(f"received upgrade container disappeared: {start_key}")
            self.runner.docker_mutation(*command)
            item = container_by_name(self.runner, name)
        if item is None:
            raise UpgradeError(f"upgrade container was not durably created: {start_key}")
        projection = container_projection(item, self.candidate_volume, self.network, image_id)
        if received is not None:
            expected = dict(projection)
            expected["running"] = True
            if received != expected:
                raise UpgradeError(f"upgrade container identity changed after receipt: {start_key}")
        if projection["running"] is not True:
            projection = self._restart_upgrade_container(start_key, item, image_id)
        self.journal.receipt(start_key, projection)
        return projection

    def _validate_hop_receipts(self, hop: Hop, image_id: str) -> tuple[str | None, bool]:
        start_key = f"hop.{hop.key}.start"
        validated_key = f"hop.{hop.key}.validated"
        stop_key = f"hop.{hop.key}.stop"
        remove_key = f"hop.{hop.key}.remove"
        start = self.journal.receipt_payload(start_key)
        validated = self.journal.receipt_payload(validated_key)
        stopped = self.journal.receipt_payload(stop_key)
        removed = self.journal.receipt_payload(remove_key)
        if validated is not None and start is None:
            raise UpgradeError(f"validated hop lacks start receipt: {hop.version}")
        if stopped is not None and validated is None:
            raise UpgradeError(f"stopped hop lacks validation receipt: {hop.version}")
        if removed is not None and stopped is None:
            raise UpgradeError(f"removed hop lacks stop receipt: {hop.version}")
        if start is None:
            return None, False
        container_id = require_container_id(str(start.get("containerId") or ""), "hop receipt container ID")
        if start != {
            "containerId": container_id,
            "imageId": image_id,
            "volume": self.candidate_volume,
            "network": self.network,
            "running": True,
        }:
            raise UpgradeError(f"hop start receipt identity changed: {hop.version}")
        if validated is not None and (
            validated.get("containerId") != container_id
            or validated.get("imageId") != image_id
            or validated.get("version") != hop.version
            or validated.get("publicationGeneration") != self.arguments.publication_generation
            or HEX64_RE.fullmatch(str(validated.get("fingerprintSha256") or "")) is None
            or set(validated) != {
                "containerId", "fingerprintSha256", "imageId",
                "publicationGeneration", "version",
            }
        ):
            raise UpgradeError(f"hop validation receipt identity changed: {hop.version}")
        if stopped is not None and stopped != {"containerId": container_id, "running": False}:
            raise UpgradeError(f"hop stop receipt identity changed: {hop.version}")
        if removed is not None and removed != {"containerId": container_id, "absent": True}:
            raise UpgradeError(f"hop remove receipt identity changed: {hop.version}")
        return container_id, removed is not None

    def assert_hop_receipt_order(self, image_ids: dict[str, str]) -> None:
        incomplete_seen = False
        all_completed = True
        for hop in HOPS:
            prefix = f"hop.{hop.key}."
            touched = any(
                key.startswith(prefix)
                for collection in (self.journal.document["intents"], self.journal.document["receipts"])
                for key in collection
            )
            _, completed = self._validate_hop_receipts(hop, image_ids[hop.version])
            if incomplete_seen and touched:
                raise UpgradeError(f"out-of-order hop evidence exists: {hop.version}")
            if touched and not completed:
                incomplete_seen = True
            elif not touched:
                incomplete_seen = True
            all_completed = all_completed and completed
        final_touched = any(
            key.startswith("final.hardened.")
            for collection in (self.journal.document["intents"], self.journal.document["receipts"])
            for key in collection
        )
        if final_touched and not all_completed:
            raise UpgradeError("hardened final evidence precedes completion of the official hop chain")

    def completed_hop(self, hop: Hop, image_id: str) -> bool:
        container_id, completed = self._validate_hop_receipts(hop, image_id)
        remove_key = f"hop.{hop.key}.remove"
        stop_key = f"hop.{hop.key}.stop"
        if (
            not completed
            and container_id is not None
            and self.journal.has_receipt(stop_key)
            and remove_key in self.journal.document["intents"]
            and not self.journal.has_receipt(remove_key)
        ):
            # Power may fail after Docker removed the exact stopped hop but
            # before the absence receipt reached disk.  Only conclusive absence
            # of both its immutable ID and run-unique name closes that intent.
            if (
                inspect_one(self.runner, "container", container_id) is None
                and container_by_name(self.runner, self.hop_name(hop)) is None
            ):
                self.journal.receipt(remove_key, {"containerId": container_id, "absent": True})
                container_id, completed = self._validate_hop_receipts(hop, image_id)
        if not completed:
            return False
        if container_id is None:
            raise UpgradeError("completed hop has no exact container identity")
        if inspect_one(self.runner, "container", container_id) is not None:
            raise UpgradeError(f"removed hop container reappeared: {hop.version}")
        if container_by_name(self.runner, self.hop_name(hop)) is not None:
            raise UpgradeError(f"completed hop name was reused: {hop.version}")
        return True

    def reconcile_validated_hop(self, hop: Hop, image_id: str) -> bool:
        validated_key = f"hop.{hop.key}.validated"
        if not self.journal.has_receipt(validated_key):
            return False
        container_id, completed = self._validate_hop_receipts(hop, image_id)
        if completed or container_id is None:
            raise UpgradeError(f"validated hop reconciliation state is invalid: {hop.version}")
        item = inspect_one(self.runner, "container", container_id)
        named = container_by_name(self.runner, self.hop_name(hop))
        if item is None or named is None or named.get("Id") != container_id:
            raise UpgradeError(f"validated hop container disappeared before removal: {hop.version}")
        projection = container_projection(item, self.candidate_volume, self.network, image_id)
        stop_key = f"hop.{hop.key}.stop"
        if self.journal.has_receipt(stop_key):
            if projection["running"] is True:
                raise UpgradeError(f"stopped validated hop was restarted externally: {hop.version}")
        else:
            self.stop_hop_after_receipt(hop, container_id)
        self.remove_hop_after_receipt(hop, container_id)
        return True

    def validate_hardened_final_receipt(
        self, final_container: dict[str, Any], image_id: str,
    ) -> bool:
        receipt = self.journal.receipt_payload("final.hardened.validated")
        if receipt is None:
            return False
        if (
            receipt.get("containerId") != final_container.get("containerId")
            or receipt.get("imageId") != image_id
            or receipt.get("version") != HOPS[-1].version
            or receipt.get("publicationGeneration") != self.arguments.publication_generation
            or HEX64_RE.fullmatch(str(receipt.get("fingerprintSha256") or "")) is None
            or set(receipt) != {
                "containerId", "fingerprintSha256", "imageId",
                "publicationGeneration", "version",
            }
        ):
            raise UpgradeError("hardened final validation receipt identity changed")
        return True

    def start_hop(self, hop: Hop, image_id: str) -> dict[str, Any]:
        name = self.hop_name(hop)
        command = (
            "run", "-d", "--name", name, "--network", self.network,
            "--network-alias", "qdrant-upgrade", "--read-only",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--user", "1000:1000", "--pids-limit", "512", "--memory", "8g",
            "--restart", "no", "--volume", f"{self.candidate_volume}:/qdrant/storage",
            "--env", "QDRANT__SERVICE__GRPC_PORT=6334",
            "--env", "QDRANT__STORAGE__SNAPSHOTS_PATH=/qdrant/storage/snapshots",
            "--env", "QDRANT__TELEMETRY_DISABLED=true", image_id,
        )
        return self._ensure_upgrade_container(f"hop.{hop.key}.start", name, image_id, command)

    def probe_curl(self, probe_image: str, path: str, *, method: str = "GET", body: str | None = None) -> str:
        sequence = self.journal.document.get("probeSequence", 0)
        if not isinstance(sequence, int) or sequence < 0 or sequence >= 10000:
            raise UpgradeError("probe sequence is invalid or exhausted")
        sequence += 1
        self.journal.document["probeSequence"] = sequence
        self.journal._commit()
        probe_identity = (
            f"{sequence}\0{self.journal.document['phase']}\0{method}\0{path}\0{body or ''}"
        )
        name = require_name(
            f"diva_qprobe_{self.arguments.run_id}_{hashlib.sha256(probe_identity.encode()).hexdigest()[:12]}",
            "probe",
        )
        existing = container_by_name(self.runner, name)
        if existing is not None:
            # Probe containers are never adopted: their stdout is evidence and
            # a crash between run and capture is ambiguous.
            raise UpgradeError(f"stale probe container requires inspection: {name}")
        command = [
            "run", "--name", name, "--network", self.network, "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--entrypoint", "curl", probe_image, "-fsS", "--connect-timeout", "2",
            "--max-time", "30", "-X", method,
        ]
        if body is not None:
            command.extend(("-H", "content-type: application/json", "--data-binary", body))
        command.append(f"http://qdrant-upgrade:6333{path}")
        key = f"probe.{name}"
        self.journal.intent(key, "probe-run", name, (self.arguments.docker, *command))
        command_error: UpgradeError | None = None
        try:
            output = self.runner.docker_mutation(*command)
        except UpgradeError as error:
            output = ""
            command_error = error
        item = container_by_name(self.runner, name)
        if item is None:
            raise UpgradeError("probe container result is not durable") from command_error
        state = item.get("State") or {}
        if state.get("Running") is True:
            # A timed-out Docker client can leave its daemon operation live.
            # Preserve the exact container and journal for explicit resume.
            raise UpgradeError("probe mutation remains in flight; preserving evidence") from command_error
        exit_code = state.get("ExitCode")
        logs = self.runner.docker_read("logs", item["Id"])
        if output and logs != output:
            raise UpgradeError("probe stdout and durable Docker logs disagree")
        output = logs
        self.journal.receipt(key, {
            "containerId": item.get("Id"),
            "outputSha256": sha256_bytes(output.encode()),
            "exitCode": exit_code,
        })
        # Deletion is also intent-first.  No --rm is used anywhere.
        remove_key = key + ".remove"
        self.journal.intent(remove_key, "container-remove", item["Id"], (self.arguments.docker, "rm", item["Id"]))
        self.runner.docker_mutation("rm", item["Id"])
        if container_by_name(self.runner, name) is not None:
            raise UpgradeError("probe container removal did not stabilize")
        self.journal.receipt(remove_key, {"containerId": item["Id"], "absent": True})
        if exit_code != 0 or command_error is not None:
            raise UpgradeError(f"Qdrant internal probe failed with exit {exit_code}") from command_error
        return output

    def live_fingerprint(self, probe_image: str, hop: Hop) -> dict[str, Any]:
        root = json.loads(self.probe_curl(probe_image, "/"))
        version = str((((root.get("result") or {}).get("version")) or root.get("version") or ""))
        if version != hop.version:
            raise UpgradeError(f"Qdrant hop reported wrong version: {version!r} != {hop.version}")
        collections_payload = json.loads(self.probe_curl(probe_image, "/collections"))
        rows = ((collections_payload.get("result") or {}).get("collections") or [])
        names = sorted(row.get("name") for row in rows if isinstance(row, dict))
        expected_names = sorted(self.expected_fingerprint["collections"])
        if names != expected_names:
            raise UpgradeError("collection inventory changed during Qdrant upgrade")
        aliases_payload = json.loads(self.probe_curl(probe_image, "/aliases"))
        aliases = sorted(
            (row.get("alias_name"), row.get("collection_name"))
            for row in ((aliases_payload.get("result") or {}).get("aliases") or [])
        )
        raw_expected_aliases = self.expected_fingerprint.get("aliases") or []
        if (
            not isinstance(raw_expected_aliases, list)
            or not all(isinstance(row, list) and len(row) == 2 for row in raw_expected_aliases)
        ):
            raise UpgradeError("expected alias fingerprint is malformed")
        expected_aliases = sorted((row[0], row[1]) for row in raw_expected_aliases)
        if aliases != expected_aliases:
            raise UpgradeError("alias topology changed during Qdrant upgrade")
        projected: dict[str, Any] = {"version": version, "collections": {}, "aliases": aliases}
        for name in names:
            payload = json.loads(self.probe_curl(probe_image, f"/collections/{name}"))
            result = payload.get("result") or {}
            expected = self.expected_fingerprint["collections"][name]
            points = result.get("points_count")
            indexed = result.get("indexed_vectors_count")
            payload_schema = result.get("payload_schema") or {}
            params = ((result.get("config") or {}).get("params") or {})
            stable_config = {
                "onDiskPayload": params.get("on_disk_payload"),
                "replicationFactor": params.get("replication_factor"),
                "shardNumber": params.get("shard_number"),
                "vectors": params.get("vectors"),
                "writeConsistencyFactor": params.get("write_consistency_factor"),
            }
            expected_stable_config = {
                key: expected.get(key) for key in stable_config
            }
            if (
                points != expected.get("pointsCount")
                or payload_schema != expected.get("payloadSchema")
                or stable_config != expected_stable_config
            ):
                raise UpgradeError(f"logical collection fingerprint changed: {name}")
            # Indexed count may legitimately finish optimization after clone,
            # but may never exceed points or fall below its pre-upgrade value.
            old_indexed = expected.get("indexedVectorsCount", 0)
            if not isinstance(indexed, int) or indexed < old_indexed or indexed > points:
                raise UpgradeError(f"indexed-vector invariant failed: {name}")
            projected["collections"][name] = {
                "pointsCount": points,
                "indexedVectorsCount": indexed,
                "payloadSchema": payload_schema,
                **stable_config,
            }
        return projected

    def start_hardened_final(self, image_id: str) -> dict[str, Any]:
        name = require_name(f"diva_qfinal_{self.arguments.run_id}", "hardened final container")
        command = (
            "run", "-d", "--name", name, "--network", self.network,
            "--network-alias", "qdrant-upgrade", "--read-only",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--user", "1000:1000", "--pids-limit", "512", "--memory", "8g",
            "--restart", "no", "--volume", f"{self.candidate_volume}:/qdrant/storage",
            "--env", "QDRANT__SERVICE__GRPC_PORT=6334",
            "--env", "QDRANT__STORAGE__SNAPSHOTS_PATH=/qdrant/storage/snapshots",
            "--env", "QDRANT__TELEMETRY_DISABLED=true", image_id,
        )
        return self._ensure_upgrade_container("final.hardened.start", name, image_id, command)

    def stop_hop_after_receipt(self, hop: Hop, container_id: str) -> None:
        key = f"hop.{hop.key}.stop"

        def observe() -> dict[str, Any] | None:
            item = inspect_one(self.runner, "container", container_id)
            if item is None:
                raise UpgradeError("received hop disappeared before cutover")
            if (item.get("State") or {}).get("Running") is True:
                return None
            return {"containerId": container_id, "running": False}

        self.mutation(key, "container-stop", container_id, ("stop", "--time", "120", container_id), observe)

    def remove_hop_after_receipt(self, hop: Hop, container_id: str) -> None:
        key = f"hop.{hop.key}.remove"
        self.journal.intent(
            key, "container-remove", container_id,
            (self.arguments.docker, "rm", container_id),
        )
        item = inspect_one(self.runner, "container", container_id)
        if item is not None:
            if (item.get("State") or {}).get("Running") is True:
                raise UpgradeError("refusing to remove a running received hop")
            self.runner.docker_mutation("rm", container_id)
        if inspect_one(self.runner, "container", container_id) is not None:
            raise UpgradeError("received hop removal did not stabilize")
        self.journal.receipt(key, {"containerId": container_id, "absent": True})

    def run(self) -> dict[str, Any]:
        self.journal.set_phase("preflight")
        assert_old_identity(self.runner, self.old, require_stopped=False)
        image_ids = {hop.version: self.ensure_image(hop) for hop in HOPS}
        final_image_id = require_image_id(self.arguments.final_image_id, "hardened final image")
        final_base = image_ids[HOPS[-1].version]
        if final_image_id == final_base:
            raise UpgradeError("hardened final image must be a distinct audited image")
        final_inspect = inspect_one(self.runner, "image", final_image_id)
        if final_inspect is None:
            raise UpgradeError("hardened final image is missing")
        final_config = final_inspect.get("Config") or {}
        labels = final_config.get("Labels") or {}
        if (
            labels.get("com.diva.qdrant.base-digest") != "sha256:" + HOPS[-1].digest
            or labels.get("com.diva.qdrant.base-reference") != HOPS[-1].reference
            or labels.get("com.diva.qdrant.dockerfile-sha256") != self.runtime_evidence["dockerfileSha256"]
            or labels.get("com.diva.qdrant.runtime-contract") != RUNTIME_CONTRACT
            or final_config.get("User") != "1000:1000"
            or final_config.get("Entrypoint") != ["/qdrant/qdrant"]
            or final_config.get("Cmd") != RUNTIME_COMMAND
            or final_config.get("Env") != RUNTIME_ENV
            or final_config.get("WorkingDir") != "/qdrant"
            or final_config.get("Shell") is not None
            or final_config.get("Volumes") not in (None, {})
        ):
            raise UpgradeError("hardened final image provenance is invalid")
        audit_inspect = inspect_one(self.runner, "image", self.audit_image_id)
        if audit_inspect is None:
            raise UpgradeError("offline audit image is missing")
        audit_config = audit_inspect.get("Config") or {}
        audit_labels = audit_config.get("Labels") or {}
        if (
            audit_labels.get("com.diva.qdrant.base-digest") != self.audit_evidence["baseDigest"]
            or audit_labels.get("com.diva.qdrant.base-reference") != self.audit_evidence["baseReference"]
            or audit_labels.get("com.diva.qdrant.dockerfile-sha256") != self.runtime_evidence["dockerfileSha256"]
            or audit_labels.get("com.diva.qdrant.audit-contract") != "offline-storage-audit-v3-alpine"
            or audit_labels.get("com.diva.qdrant.audit-contract-sha256")
               != self.audit_evidence["contractSha256"]
            or audit_labels.get("com.diva.qdrant.audit-contract-helper-sha256")
               != self.audit_evidence["contractHelperSha256"]
            or audit_labels.get("com.diva.qdrant.alpine-inventory-sha256")
               != self.audit_evidence["inventorySha256"]
            or audit_labels.get("com.diva.qdrant.audit-architecture")
               != self.audit_evidence["architecture"]
            or audit_labels.get("com.diva.qdrant.busybox-version") != "1.37.0-r30"
            or audit_labels.get("com.diva.qdrant.busybox-binary-sha256")
               != self.audit_evidence["busyboxSha256"]
            or audit_config.get("User") != "65534:65534"
            or audit_config.get("Entrypoint") != ["/bin/sh"]
            or audit_config.get("Cmd") is not None
            or audit_config.get("WorkingDir") not in (None, "")
            or audit_config.get("Shell") is not None
            or audit_config.get("Volumes") not in (None, {})
        ):
            raise UpgradeError("offline audit image provenance is invalid")
        self.attest_audit_filesystem()
        self.ensure_network()
        self.ensure_volume()
        self.journal.set_phase("old-stopping")
        self.stop_old()
        assert_old_identity(self.runner, self.old, require_stopped=True)
        old_before = self.volume_tree_digest(
            "old.digest.before", require_name(f"diva_qdigest_old0_{self.arguments.run_id}", "digest helper"),
            self.audit_image_id, self.old["volume"],
        )
        if old_before["nonRootOwned"] != "0":
            raise UpgradeError("legacy rollback volume is not uniformly owned by root:root")
        self.journal.set_phase("cloning")
        self.clone_volume(self.audit_image_id)
        candidate_clone = self.volume_tree_digest(
            "candidate.digest.cloned",
            require_name(f"diva_qdigest_clone_{self.arguments.run_id}", "digest helper"),
            self.audit_image_id, self.candidate_volume,
        )
        if candidate_clone != old_before:
            raise UpgradeError("candidate volume is not an exact metadata/content clone")
        old_after = self.volume_tree_digest(
            "old.digest.after", require_name(f"diva_qdigest_old1_{self.arguments.run_id}", "digest helper"),
            self.audit_image_id, self.old["volume"],
        )
        if old_after != old_before:
            raise UpgradeError("rollback volume changed while cloning")
        self.journal.set_phase("candidate-ownership")
        self.chown_candidate_fd_safe()
        assert_old_identity(self.runner, self.old, require_stopped=True)
        candidate_owned = self.volume_tree_digest(
            "candidate.digest.owned",
            require_name(f"diva_qdigest_owned_{self.arguments.run_id}", "digest helper"),
            self.audit_image_id, self.candidate_volume,
        )
        if (
            candidate_owned["logicalStructure"] != candidate_clone["logicalStructure"]
            or candidate_owned["content"] != candidate_clone["content"]
            or candidate_owned["entries"] != candidate_clone["entries"]
            or candidate_owned["nonRootlessOwned"] != "0"
        ):
            raise UpgradeError("candidate ownership conversion changed logical data or is incomplete")
        old_after_chown = self.volume_tree_digest(
            "old.digest.after-candidate-chown",
            require_name(f"diva_qdigest_old2_{self.arguments.run_id}", "digest helper"),
            self.audit_image_id, self.old["volume"],
        )
        if old_after_chown != old_before:
            raise UpgradeError("rollback volume changed during candidate ownership conversion")
        assert_old_identity(self.runner, self.old, require_stopped=True)

        probe_image = self.probe_slots["api_a"]
        self.assert_hop_receipt_order(image_ids)
        for hop in HOPS:
            self.journal.set_phase(f"hop-{hop.version}")
            if self.completed_hop(hop, image_ids[hop.version]):
                continue
            if self.reconcile_validated_hop(hop, image_ids[hop.version]):
                continue
            hop_container = self.start_hop(hop, image_ids[hop.version])
            deadline = time.monotonic() + self.arguments.health_timeout
            fingerprint: dict[str, Any] | None = None
            while time.monotonic() < deadline:
                try:
                    fingerprint = self.live_fingerprint(probe_image, hop)
                    break
                except (UpgradeError, json.JSONDecodeError):
                    time.sleep(2)
            if fingerprint is None:
                raise UpgradeError(f"Qdrant hop did not become semantically ready: {hop.version}")
            assert_old_identity(self.runner, self.old, require_stopped=True)
            receipt_key = f"hop.{hop.key}.validated"
            self.journal.intent(
                receipt_key, "logical-validation", hop_container["containerId"],
                ("validate", hop.version, self.journal.document["expected"]["fingerprintSha256"]),
            )
            self.journal.receipt(receipt_key, {
                "containerId": hop_container["containerId"],
                "imageId": image_ids[hop.version],
                "version": hop.version,
                "fingerprintSha256": sha256_bytes(canonical_bytes(fingerprint)),
                "publicationGeneration": self.arguments.publication_generation,
            })
            self.stop_hop_after_receipt(hop, hop_container["containerId"])
            self.remove_hop_after_receipt(hop, hop_container["containerId"])

        # The pinned official final hop proves the on-disk migration.  The
        # separately built/attested image must also boot and preserve the same
        # semantics before it is eligible for a public Compose cutover.
        self.journal.set_phase("hardened-final")
        final_container = self.start_hardened_final(final_image_id)
        hardened_fingerprint = self.live_fingerprint(probe_image, HOPS[-1])
        if not self.validate_hardened_final_receipt(final_container, final_image_id):
            self.journal.intent(
                "final.hardened.validated", "logical-validation", final_container["containerId"],
                ("validate", "hardened-1.19.0", self.journal.document["expected"]["fingerprintSha256"]),
            )
            self.journal.receipt("final.hardened.validated", {
                "containerId": final_container["containerId"],
                "imageId": final_image_id,
                "version": HOPS[-1].version,
                "fingerprintSha256": sha256_bytes(canonical_bytes(hardened_fingerprint)),
                "publicationGeneration": self.arguments.publication_generation,
            })
        assert_old_identity(self.runner, self.old, require_stopped=True)
        self.journal.set_phase("final-validated")
        result_base = {
            "schemaVersion": SCHEMA_VERSION,
            "status": "ready-for-coupled-cutover",
            "runId": self.arguments.run_id,
            "oldContainerId": self.old["containerId"],
            "oldVolume": self.old["volume"],
            "candidateVolume": self.candidate_volume,
            "candidateContainerId": final_container["containerId"],
            "candidateImageId": final_image_id,
            "hardenedFinalImageId": final_image_id,
            "offlineAuditImageId": self.audit_image_id,
            "auditEvidence": self.audit_evidence,
            "runtimeEvidence": self.runtime_evidence,
            "publicationGeneration": self.arguments.publication_generation,
        }
        existing_result = self.journal.document.get("result")
        if existing_result is None:
            result = {**result_base, "completedAt": utc_now()}
        else:
            if (
                not isinstance(existing_result, dict)
                or {key: existing_result.get(key) for key in result_base} != result_base
                or set(existing_result) != {*result_base, "completedAt"}
                or not isinstance(existing_result.get("completedAt"), str)
            ):
                raise UpgradeError("durable controller result identity changed")
            result = existing_result
        self.journal.document["result"] = result
        self.journal.set_phase("ready-for-coupled-cutover")
        published_result = {
            **result,
            "journalSha256": sha256_bytes(self.journal.path.read_bytes()),
        }
        output = Path(self.arguments.output)
        atomic_write(output, canonical_bytes(published_result))
        return published_result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--journal", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--old-container-id", required=True)
    parser.add_argument("--old-container-name", required=True)
    parser.add_argument("--old-image-id", required=True)
    parser.add_argument("--old-volume", required=True)
    parser.add_argument("--old-volume-identity", required=True)
    parser.add_argument("--candidate-volume", required=True)
    parser.add_argument("--upgrade-network", required=True)
    parser.add_argument("--expected-fingerprint", required=True)
    parser.add_argument("--publication-generation", required=True)
    parser.add_argument("--probe-slots", required=True)
    parser.add_argument("--seed-song-id", required=True, type=int)
    parser.add_argument("--runtime-attestation", required=True)
    parser.add_argument("--final-image-id", required=True)
    parser.add_argument("--audit-image-id", required=True)
    parser.add_argument("--audit-architecture", required=True)
    parser.add_argument("--audit-inventory-sha256", required=True)
    parser.add_argument("--audit-busybox-sha256", required=True)
    parser.add_argument("--audit-contract-sha256", required=True)
    parser.add_argument("--audit-contract-helper-sha256", required=True)
    parser.add_argument("--runtime-binary-sha256", required=True)
    parser.add_argument("--runtime-config-sha256", required=True)
    parser.add_argument("--runtime-links-sha256", required=True)
    parser.add_argument("--dockerfile-sha256", required=True)
    parser.add_argument("--docker", default="docker")
    parser.add_argument("--read-timeout", type=int, default=120)
    parser.add_argument("--mutation-timeout", type=int, default=7200)
    parser.add_argument("--health-timeout", type=int, default=1800)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    boundary = establish_standalone_boundary()
    arguments = build_parser().parse_args(argv)
    validate_standalone_paths(arguments, boundary)
    for value in (arguments.read_timeout, arguments.mutation_timeout, arguments.health_timeout):
        if value <= 0:
            raise UpgradeError("timeouts must be positive")
    controller = UpgradeController(arguments)
    result = controller.run()
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (UpgradeError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(2)
