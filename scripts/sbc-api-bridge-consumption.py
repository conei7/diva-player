#!/usr/bin/env python3
"""Crash-safe consumption of the one-time SBC API bridge receipt.

The operation is intentionally represented by an owner-only durable intent.
Every restart can therefore converge only the frozen receipt inode/digest to a
single-link archive, publish a settlement receipt, and release the exact stale
hardening journal/lock.  Unrelated files are never replaced or removed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Callable, NamedTuple, NoReturn


HEX64 = re.compile(r"^[0-9a-f]{64}$")
RUN_ID = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[1-9][0-9]*$")
BOOT_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
ARCHIVE = re.compile(
    r"^api-bridge-receipt\.(calibration|completed|pre-mutation-failed)\."
    r"([0-9a-f]{64})\.json$"
)
MAX_DOCUMENT = 128 * 1024
NORMAL_REASONS = frozenset({"calibration", "completed"})
PRE_MUTATION_REASON = "pre-mutation-failed"
PRE_MUTATION_DEPLOYMENT_STATUSES = (
    "preflight",
    "building-qdrant",
    "preparing-postgres",
    "scanning-all-runtime-images",
    "quiescing-pipeline-writers",
    "failed",
)
PRE_MUTATION_WRITER_STATUSES = ("gating", "refused-busy")
PRE_MUTATION_ROLLBACK_SCAN_FAILURE_DEPLOYMENT_STATUSES = (
    "preflight",
    "building-qdrant",
    "preparing-postgres",
    "scanning-all-runtime-images",
    "failed",
)
PRE_MUTATION_CANDIDATE_SCAN_KEYS = (
    "image_scan.qdrant-runtime.receipt_sha256",
    "image_scan.qdrant-audit.receipt_sha256",
    "image_scan.postgres-runtime.receipt_sha256",
    "image_scan.postgres-migrate.receipt_sha256",
)
PRE_MUTATION_CANDIDATE_SCAN_SERVICES = (
    "qdrant-runtime",
    "qdrant-audit",
    "postgres-runtime",
    "postgres-migrate",
)
PRE_MUTATION_FORBIDDEN_STATE_KEYS = frozenset({
    "api_bridge.receipt_consumed",
    "api_bridge.receipt_consumption_settlement",
    "compose.management",
    "postgres.candidate",
    "postgres.candidate_container_id",
    "postgres.promoted_container_id",
    "postgres.rollback",
    "postgres.rollback_retained",
    "qdrant.candidate",
    "qdrant.candidate_container_id",
    "qdrant.promoted_container_id",
    "qdrant.rollback",
    "qdrant.rollback_retained",
    "qdrant.storage_upgrade",
})
PRE_MUTATION_FORBIDDEN_STATE_PREFIXES = (
    "daemon.",
    "promotion.",
    "qdrant.controller_",
    "qdrant.final_upgrade_",
    "qdrant.stable_",
    "postgres.stable_",
    "postgres_migrate.stable_",
)
PRE_MUTATION_FORBIDDEN_FILES = frozenset({
    "completed",
    "daemon-read-unresolved",
    "pipeline-writer-gate",
    "pipeline-writer-gate.tmp",
    "pipeline-writer-gate-result",
    "pipeline-writer-release-result",
    "promoted",
    "promotion-transaction",
    "promotion-transaction.tmp",
    "qdrant-storage-upgrade-controller-settlement.json",
    "qdrant-storage-upgrade-daemon-settlement.json",
    "qdrant-storage-upgrade-controller.log",
    "qdrant-storage-upgrade-result.json",
    "qdrant-storage-upgrade.json",
    "stateful-runtime-contract.prepared",
})
CURRENT_CALIBRATION_IMAGE_SCAN_STATUS = (
    "requires-reviewed-exact-inventory-and-finding-contracts"
)
CALIBRATION_IMAGE_SCAN_STATUSES = frozenset({
    CURRENT_CALIBRATION_IMAGE_SCAN_STATUS,
    # Runs created before the finding contract was added still need exact,
    # crash-safe convergence under the same mutation-free boundary checks.
    "requires-reviewed-exact-inventory-bounds",
})
Checkpoint = Callable[[str], None]
IntentValidator = Callable[[dict[str, object]], None]


class OwnerIdentity(NamedTuple):
    pid: int
    run_id: str
    boot_id: str
    start_ticks: int


class RunBinding(NamedTuple):
    run_id: str
    state_sha256: str


def _noop(_phase: str) -> None:
    return None


def _fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def _owner_id() -> int | None:
    return os.geteuid() if hasattr(os, "geteuid") else None


def _absolute(path: Path) -> Path:
    path = path.absolute()
    if not path.is_absolute():
        _fail(f"path is not absolute: {path}")
    return path


def _validate_fixed_state_paths(
    *,
    state_root: Path,
    canonical: Path,
    intent_path: Path,
    active: Path,
    lock_dir: Path,
    runtime_contract: Path,
) -> None:
    expected = {
        "canonical bridge receipt": state_root / "api-bridge-receipt.json",
        "consumption intent": state_root / "api-bridge-consume-intent.json",
        "active hardening journal": state_root / "stateful-hardening-active",
        "hardening lock": state_root / "stateful-hardening.lock",
        "stateful runtime contract": state_root / "stateful-runtime-contract",
    }
    observed = {
        "canonical bridge receipt": canonical,
        "consumption intent": intent_path,
        "active hardening journal": active,
        "hardening lock": lock_dir,
        "stateful runtime contract": runtime_contract,
    }
    for label, expected_path in expected.items():
        if observed[label] != expected_path:
            _fail(f"{label} is not at its fixed state-root path")


def _inspect_directory(path: Path, *, mode: int = 0o700) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) \
            or (os.name != "nt" and stat.S_IMODE(info.st_mode) != mode):
        _fail(f"unsafe directory: {path}")
    owner = _owner_id()
    if owner is not None and info.st_uid != owner:
        _fail(f"directory owner mismatch: {path}")
    return info


def _inspect_file(path: Path, *, links: set[int], maximum: int = MAX_DOCUMENT,
                  mode: int = 0o600) -> os.stat_result:
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode)
            or (os.name != "nt" and stat.S_IMODE(info.st_mode) != mode)
            or info.st_nlink not in links or info.st_size <= 0
            or info.st_size > maximum):
        _fail(f"unsafe owner file: {path}")
    owner = _owner_id()
    if owner is not None and info.st_uid != owner:
        _fail(f"file owner mismatch: {path}")
    return info


def _inspect_empty_file(path: Path, *, mode: int = 0o600) -> os.stat_result:
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode)
            or (os.name != "nt" and stat.S_IMODE(info.st_mode) != mode)
            or info.st_nlink != 1 or info.st_size != 0):
        _fail(f"unsafe empty owner file: {path}")
    owner = _owner_id()
    if owner is not None and info.st_uid != owner:
        _fail(f"file owner mismatch: {path}")
    return info


def _read_bytes(path: Path, *, links: set[int], maximum: int = MAX_DOCUMENT) -> tuple[bytes, os.stat_result]:
    before = _inspect_file(path, links=links, maximum=maximum)
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0),
    )
    try:
        opened = os.fstat(descriptor)
        identity = (before.st_dev, before.st_ino, before.st_mode,
                    before.st_nlink, before.st_size)
        if (opened.st_dev, opened.st_ino, opened.st_mode,
                opened.st_nlink, opened.st_size) != identity:
            _fail(f"file changed while opening: {path}")
        remaining = opened.st_size
        chunks: list[bytes] = []
        while remaining:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            if not chunk:
                _fail(f"file was truncated while reading: {path}")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            _fail(f"file grew while reading: {path}")
        after = os.fstat(descriptor)
        if (after.st_dev, after.st_ino, after.st_mode,
                after.st_nlink, after.st_size) != identity:
            _fail(f"file changed while reading: {path}")
        return b"".join(chunks), opened
    finally:
        os.close(descriptor)


def _read_json(path: Path, *, links: set[int]) -> tuple[dict[str, object], bytes, os.stat_result]:
    raw, info = _read_bytes(path, links=links)
    document = json.loads(raw.decode("utf-8"))
    if not isinstance(document, dict):
        _fail(f"JSON document is not an object: {path}")
    return document, raw, info


def _sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _sha256_file(path: Path, *, links: set[int], maximum: int = MAX_DOCUMENT) -> tuple[str, os.stat_result]:
    raw, info = _read_bytes(path, links=links, maximum=maximum)
    return _sha256_bytes(raw), info


def _read_virtual_file(path: Path, *, maximum: int) -> bytes:
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0),
    )
    try:
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = os.read(descriptor, min(4096, maximum + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > maximum:
                _fail(f"virtual owner identity file is too large: {path}")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _current_boot_id() -> str:
    raw = _read_virtual_file(
        Path("/proc/sys/kernel/random/boot_id"), maximum=128
    )
    try:
        boot_id = raw.decode("ascii").strip()
    except UnicodeError as error:
        raise RuntimeError("kernel boot ID is not ASCII") from error
    if BOOT_ID.fullmatch(boot_id) is None:
        _fail("kernel boot ID is invalid")
    return boot_id


def _process_start_ticks(pid: int) -> int | None:
    if not isinstance(pid, int) or pid <= 0:
        _fail("owner process PID is invalid")
    try:
        raw = _read_virtual_file(Path(f"/proc/{pid}/stat"), maximum=16 * 1024)
    except (FileNotFoundError, ProcessLookupError):
        return None
    marker = raw.rfind(b") ")
    if marker <= 0 or not raw.startswith(f"{pid} (".encode("ascii")):
        _fail("owner process stat identity is invalid")
    fields = raw[marker + 2:].split()
    # The first post-comm field is field 3 (state), so starttime field 22 is
    # index 19 here.  Splitting after the final ') ' also permits spaces and
    # parentheses in the kernel comm field.
    if len(fields) <= 19 or not fields[19].isdigit():
        _fail("owner process start time is invalid")
    start_ticks = int(fields[19])
    if start_ticks <= 0:
        _fail("owner process start time is invalid")
    return start_ticks


def _owner_payload(owner: OwnerIdentity) -> bytes:
    if owner.pid <= 0 or RUN_ID.fullmatch(owner.run_id) is None \
            or BOOT_ID.fullmatch(owner.boot_id) is None or owner.start_ticks <= 0:
        _fail("hardening lock owner identity is invalid")
    return (
        f"pid={owner.pid} run={owner.run_id} boot={owner.boot_id} "
        f"start={owner.start_ticks}\n"
    ).encode("ascii")


def _parse_owner(raw: bytes) -> OwnerIdentity:
    match = re.fullmatch(
        rb"pid=([1-9][0-9]*) "
        rb"run=([0-9]{8}T[0-9]{6}Z-[1-9][0-9]*) "
        rb"boot=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) "
        rb"start=([1-9][0-9]*)\r?\n",
        raw,
    )
    if match is None:
        _fail("hardening lock owner token is invalid")
    owner = OwnerIdentity(
        pid=int(match.group(1)),
        run_id=match.group(2).decode("ascii"),
        boot_id=match.group(3).decode("ascii"),
        start_ticks=int(match.group(4)),
    )
    _owner_payload(owner)
    return owner


def _owner_is_live(owner: OwnerIdentity | None) -> bool:
    if owner is None:
        return False
    # A boot mismatch proves that the PID belongs to a later boot.  If the
    # current boot/process identity cannot be read, fail closed by propagating
    # the error rather than releasing a possibly live interlock.
    if _current_boot_id() != owner.boot_id:
        return False
    observed_start = _process_start_ticks(owner.pid)
    return observed_start is not None and observed_start == owner.start_ticks


def _fsync_file(path: Path) -> None:
    flags = getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    flags |= os.O_RDWR if os.name == "nt" else os.O_RDONLY
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    # The production SBC is Linux.  Windows is only the deterministic test
    # host and does not support opening/fsyncing directory descriptors.
    if os.name == "nt":
        return
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if written <= 0:
            _fail("owner document write made no progress")
        offset += written


def _encode(document: dict[str, object]) -> bytes:
    return (json.dumps(document, ensure_ascii=True, separators=(",", ":"),
                       sort_keys=True) + "\n").encode("utf-8")


def _normalize_run_bindings(value: object) -> tuple[RunBinding, ...]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        _fail("pre-mutation retirement requires exactly two related run bindings")
    bindings: list[RunBinding] = []
    for item in value:
        if isinstance(item, RunBinding):
            binding = item
        elif isinstance(item, dict) and set(item) == {"runId", "stateSha256"}:
            binding = RunBinding(
                run_id=str(item["runId"]),
                state_sha256=str(item["stateSha256"]),
            )
        else:
            _fail("pre-mutation related run binding schema is invalid")
        if RUN_ID.fullmatch(binding.run_id) is None \
                or HEX64.fullmatch(binding.state_sha256) is None:
            _fail("pre-mutation related run binding identity is invalid")
        bindings.append(binding)
    if len({binding.run_id for binding in bindings}) != len(bindings):
        _fail("pre-mutation related run bindings contain a duplicate run ID")
    ordered = tuple(sorted(bindings, key=lambda binding: binding.run_id))
    if tuple(bindings) != ordered:
        _fail("pre-mutation related run bindings are not in canonical order")
    return ordered


def _run_binding_documents(bindings: tuple[RunBinding, ...]) -> list[dict[str, str]]:
    return [
        {"runId": binding.run_id, "stateSha256": binding.state_sha256}
        for binding in bindings
    ]


def _publish_document(prepared: Path, canonical: Path, payload: bytes, *,
                      prefix: str, checkpoint: Checkpoint) -> None:
    if len(payload) <= 1 or len(payload) > MAX_DOCUMENT:
        _fail("owner document payload size is invalid")
    if os.path.lexists(prepared) or os.path.lexists(canonical):
        _fail(f"owner document publication path already exists: {canonical}")
    descriptor = os.open(
        prepared,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0),
        0o600,
    )
    try:
        _write_all(descriptor, payload)
        checkpoint(prefix + "-after-prepared-write")
        os.fsync(descriptor)
        checkpoint(prefix + "-after-prepared-file-fsync")
    finally:
        os.close(descriptor)
    os.link(prepared, canonical, follow_symlinks=False)
    checkpoint(prefix + "-after-link")
    prepared_raw, prepared_info = _read_bytes(prepared, links={2})
    canonical_raw, canonical_info = _read_bytes(canonical, links={2})
    if (prepared_raw != payload or canonical_raw != payload
            or (prepared_info.st_dev, prepared_info.st_ino)
            != (canonical_info.st_dev, canonical_info.st_ino)):
        _fail("owner document publication identity changed")
    _fsync_file(canonical)
    checkpoint(prefix + "-after-canonical-file-fsync")
    _fsync_directory(canonical.parent)
    checkpoint(prefix + "-after-canonical-directory-fsync")
    os.unlink(prepared)
    checkpoint(prefix + "-after-prepared-unlink")
    _fsync_directory(prepared.parent)
    checkpoint(prefix + "-after-prepared-directory-fsync")
    final_raw, _ = _read_bytes(canonical, links={1})
    if final_raw != payload:
        _fail("owner document publication payload changed")
    _fsync_file(canonical)
    _fsync_directory(canonical.parent)


def _discard_empty_prepared(prepared: Path, *, prefix: str,
                            checkpoint: Checkpoint) -> None:
    before = prepared.lstat()
    owner = _owner_id()
    if (not stat.S_ISREG(before.st_mode)
            or (os.name != "nt" and stat.S_IMODE(before.st_mode) != 0o600)
            or before.st_nlink != 1 or before.st_size != 0
            or (owner is not None and before.st_uid != owner)):
        _fail(f"unsafe empty owner staging file: {prepared}")
    descriptor = os.open(
        prepared,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0),
    )
    try:
        opened = os.fstat(descriptor)
        identity = (
            before.st_dev, before.st_ino, before.st_mode,
            before.st_nlink, before.st_size,
        )
        if (
            opened.st_dev, opened.st_ino, opened.st_mode,
            opened.st_nlink, opened.st_size,
        ) != identity or os.read(descriptor, 1):
            _fail(f"empty owner staging file changed while opening: {prepared}")
    finally:
        os.close(descriptor)
    after = prepared.lstat()
    if (
        after.st_dev, after.st_ino, after.st_mode,
        after.st_nlink, after.st_size,
    ) != identity:
        _fail(f"empty owner staging file changed before removal: {prepared}")
    os.unlink(prepared)
    checkpoint(prefix + "-after-empty-prepared-unlink")
    _fsync_directory(prepared.parent)
    checkpoint(prefix + "-after-empty-prepared-directory-fsync")


def _converge_document_staging(prepared: Path, canonical: Path, *,
                               prefix: str, checkpoint: Checkpoint) -> bytes | None:
    canonical_exists = os.path.lexists(canonical)
    prepared_exists = os.path.lexists(prepared)
    if not canonical_exists and not prepared_exists:
        return None
    if not canonical_exists:
        if prepared.lstat().st_size == 0:
            # O_EXCL succeeds before the first payload byte is written.  An
            # exact-owned, single-link empty staging inode therefore proves a
            # pre-publication crash and is safe to discard durably.
            _discard_empty_prepared(
                prepared, prefix=prefix, checkpoint=checkpoint
            )
            return None
        try:
            payload, _ = _read_bytes(prepared, links={1})
            json.loads(payload.decode("utf-8"))
        except (OSError, RuntimeError, UnicodeError, json.JSONDecodeError):
            # Receipt mutation cannot begin before the canonical intent exists.
            # A partial exact-owned staging file is therefore safe to discard.
            _inspect_file(prepared, links={1})
            os.unlink(prepared)
            _fsync_directory(prepared.parent)
            checkpoint(prefix + "-discarded-partial-prepared")
            return None
        os.link(prepared, canonical, follow_symlinks=False)
        checkpoint(prefix + "-reconcile-after-link")
        _fsync_file(canonical)
        _fsync_directory(canonical.parent)
        checkpoint(prefix + "-reconcile-after-canonical-directory-fsync")
        canonical_exists = True
    payload, canonical_info = _read_bytes(canonical, links={1, 2})
    if prepared_exists or os.path.lexists(prepared):
        prepared_payload, prepared_info = _read_bytes(prepared, links={2})
        if (prepared_payload != payload
                or (prepared_info.st_dev, prepared_info.st_ino)
                != (canonical_info.st_dev, canonical_info.st_ino)):
            _fail("owner document staging path is unrelated")
        os.unlink(prepared)
        checkpoint(prefix + "-reconcile-after-prepared-unlink")
        _fsync_directory(prepared.parent)
        checkpoint(prefix + "-reconcile-after-prepared-directory-fsync")
    final, _ = _read_bytes(canonical, links={1})
    if final != payload:
        _fail("owner document changed during staging reconciliation")
    _fsync_file(canonical)
    _fsync_directory(canonical.parent)
    return payload


def _validate_layout(document: dict[str, object], intent_path: Path) -> dict[str, object]:
    required = {
        "activeJournal", "archivePath", "canonicalPath", "createdAt", "lockDir",
        "operation", "reason", "receiptDevice", "receiptInode", "receiptSha256",
        "receiptSize", "runId", "schemaVersion", "settlementPath", "stateRoot",
    }
    reason = document.get("reason")
    if reason == PRE_MUTATION_REASON:
        required.add("relatedRuns")
        if document.get("schemaVersion") != 2:
            _fail("pre-mutation consumption intent schema version is invalid")
        related_runs = _normalize_run_bindings(document.get("relatedRuns"))
    else:
        if document.get("schemaVersion") != 1:
            _fail("consumption intent schema version is invalid")
        related_runs = ()
    if set(document) != required \
            or document.get("operation") != "consume-sbc-api-bridge-receipt":
        _fail("consumption intent schema is invalid")
    run_id = document.get("runId")
    receipt_sha = document.get("receiptSha256")
    if reason not in NORMAL_REASONS | {PRE_MUTATION_REASON} \
            or not isinstance(run_id, str) or RUN_ID.fullmatch(run_id) is None \
            or not isinstance(receipt_sha, str) or HEX64.fullmatch(receipt_sha) is None:
        _fail("consumption intent identity is invalid")
    if reason == PRE_MUTATION_REASON \
            and run_id != related_runs[-1].run_id:
        _fail("pre-mutation archive run is not the latest related run")
    for key in ("receiptDevice", "receiptInode", "receiptSize"):
        if not isinstance(document.get(key), int) or int(document[key]) <= 0:
            _fail("consumption intent inode identity is invalid")
    state_root = _absolute(Path(str(document["stateRoot"])))
    canonical = _absolute(Path(str(document["canonicalPath"])))
    archive = _absolute(Path(str(document["archivePath"])))
    settlement = _absolute(Path(str(document["settlementPath"])))
    active = _absolute(Path(str(document["activeJournal"])))
    lock_dir = _absolute(Path(str(document["lockDir"])))
    run_dir = archive.parent
    if intent_path != state_root / "api-bridge-consume-intent.json" \
            or canonical != state_root / "api-bridge-receipt.json" \
            or active != state_root / "stateful-hardening-active" \
            or lock_dir != state_root / "stateful-hardening.lock" \
            or run_dir != state_root / ("stateful-" + run_id) \
            or settlement != Path(str(archive) + ".consumption-settlement.json"):
        _fail("consumption intent path binding is invalid")
    match = ARCHIVE.fullmatch(archive.name)
    if match is None or match.group(1) != reason or match.group(2) != receipt_sha:
        _fail("consumption archive binding is invalid")
    _inspect_directory(state_root)
    _inspect_directory(run_dir)
    created_at = document.get("createdAt")
    if not isinstance(created_at, str):
        _fail("consumption intent timestamp is invalid")
    dt.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    return document


def _receipt_identity(path: Path, expected_sha: str, *, links: set[int],
                      maximum: int = 4 * 1024 * 1024) -> os.stat_result:
    digest, info = _sha256_file(path, links=links, maximum=maximum)
    if digest != expected_sha:
        _fail(f"bridge receipt digest changed: {path}")
    return info


def _converge_receipt(document: dict[str, object], checkpoint: Checkpoint) -> os.stat_result:
    canonical = Path(str(document["canonicalPath"]))
    archive = Path(str(document["archivePath"]))
    expected = str(document["receiptSha256"])
    frozen = (int(document["receiptDevice"]), int(document["receiptInode"]),
              int(document["receiptSize"]))
    source_exists = os.path.lexists(canonical)
    archive_exists = os.path.lexists(archive)
    if not source_exists and not archive_exists:
        _fail("both canonical and archived bridge receipts are missing")
    if source_exists:
        source_info = _receipt_identity(
            canonical, expected, links={1, 2}
        )
        if (source_info.st_dev, source_info.st_ino, source_info.st_size) != frozen:
            _fail("canonical bridge receipt inode changed")
    else:
        source_info = None
    if archive_exists:
        archive_info = _receipt_identity(archive, expected, links={1, 2})
        if (archive_info.st_dev, archive_info.st_ino, archive_info.st_size) != frozen:
            _fail("archived bridge receipt inode changed")
    else:
        archive_info = None
    if source_info is not None and archive_info is None:
        if source_info.st_nlink != 1:
            _fail("canonical bridge receipt has an unknown extra link")
        os.link(canonical, archive, follow_symlinks=False)
        checkpoint("receipt-after-archive-link")
        archive_info = _receipt_identity(archive, expected, links={2})
        if (archive_info.st_dev, archive_info.st_ino) != frozen[:2]:
            _fail("archive is not the frozen canonical receipt inode")
        source_info = _receipt_identity(canonical, expected, links={2})
        if (source_info.st_dev, source_info.st_ino, source_info.st_size) != frozen:
            _fail("canonical bridge receipt changed after archival link")
    if source_info is not None and archive_info is not None:
        if ((source_info.st_dev, source_info.st_ino)
                != (archive_info.st_dev, archive_info.st_ino)
                or source_info.st_nlink != 2 or archive_info.st_nlink != 2):
            _fail("canonical and archive paths are not one exact two-link inode")
        _fsync_file(archive)
        checkpoint("receipt-after-archive-file-fsync")
        _fsync_directory(archive.parent)
        checkpoint("receipt-after-archive-directory-fsync")
        os.unlink(canonical)
        checkpoint("receipt-after-canonical-unlink")
        _fsync_directory(canonical.parent)
        checkpoint("receipt-after-canonical-directory-fsync")
    final = _receipt_identity(archive, expected, links={1})
    if (final.st_dev, final.st_ino, final.st_size) != frozen:
        _fail("consumed bridge receipt archive identity changed")
    _fsync_file(archive)
    checkpoint("receipt-after-single-link-file-fsync")
    _fsync_directory(archive.parent)
    checkpoint("receipt-after-final-archive-directory-fsync")
    return final


def _settlement_document(intent: dict[str, object], archive_info: os.stat_result) -> dict[str, object]:
    document: dict[str, object] = {
        "archiveDevice": archive_info.st_dev,
        "archiveInode": archive_info.st_ino,
        "archivePath": intent["archivePath"],
        "archiveSize": archive_info.st_size,
        "operation": "consume-sbc-api-bridge-receipt",
        "reason": intent["reason"],
        "receiptSha256": intent["receiptSha256"],
        "runId": intent["runId"],
        "schemaVersion": 1,
        "settledAt": dt.datetime.now(dt.timezone.utc).isoformat(
            timespec="seconds"
        ).replace("+00:00", "Z"),
        "status": "consumed-single-link-archive",
    }
    if intent["reason"] == PRE_MUTATION_REASON:
        document["schemaVersion"] = 2
        document["relatedRuns"] = intent["relatedRuns"]
    return document


def _validate_settlement(path: Path, intent: dict[str, object] | None = None) -> dict[str, object]:
    path = _absolute(path)
    document, _, _ = _read_json(path, links={1})
    required = {
        "archiveDevice", "archiveInode", "archivePath", "archiveSize", "operation",
        "reason", "receiptSha256", "runId", "schemaVersion", "settledAt", "status",
    }
    reason = document.get("reason")
    if reason == PRE_MUTATION_REASON:
        required.add("relatedRuns")
        if document.get("schemaVersion") != 2:
            _fail("pre-mutation consumption settlement schema version is invalid")
        related_runs = _normalize_run_bindings(document.get("relatedRuns"))
    else:
        if document.get("schemaVersion") != 1:
            _fail("consumption settlement schema version is invalid")
        related_runs = ()
    if set(document) != required \
            or document.get("operation") != "consume-sbc-api-bridge-receipt" \
            or document.get("status") != "consumed-single-link-archive":
        _fail("consumption settlement schema is invalid")
    if intent is not None:
        bound_keys = ["archivePath", "reason", "receiptSha256", "runId"]
        if reason == PRE_MUTATION_REASON:
            bound_keys.append("relatedRuns")
        for key in bound_keys:
            if document.get(key) != intent.get(key):
                _fail("consumption settlement does not match its intent")
    archive = _absolute(Path(str(document.get("archivePath"))))
    expected = str(document.get("receiptSha256"))
    run_id = document.get("runId")
    suffix = ".consumption-settlement.json"
    if not path.name.endswith(suffix):
        _fail("consumption settlement filename is invalid")
    bound_archive = path.with_name(path.name.removesuffix(suffix))
    archive_match = ARCHIVE.fullmatch(bound_archive.name)
    if archive != bound_archive or archive_match is None \
            or reason != archive_match.group(1) \
            or expected != archive_match.group(2) \
            or not isinstance(run_id, str) or RUN_ID.fullmatch(run_id) is None \
            or archive.parent.name != "stateful-" + run_id:
        _fail("consumption settlement archive path binding is invalid")
    if reason == PRE_MUTATION_REASON \
            and run_id != related_runs[-1].run_id:
        _fail("pre-mutation settlement archive run is not the latest related run")
    _inspect_directory(archive.parent)
    settled_at = document.get("settledAt")
    if not isinstance(settled_at, str):
        _fail("consumption settlement timestamp is invalid")
    dt.datetime.fromisoformat(settled_at.replace("Z", "+00:00"))
    archive_info = _receipt_identity(archive, expected, links={1})
    if (archive_info.st_dev, archive_info.st_ino, archive_info.st_size) != (
        document.get("archiveDevice"), document.get("archiveInode"),
        document.get("archiveSize"),
    ):
        _fail("consumption settlement archive inode changed")
    return document


def _ensure_settlement(intent: dict[str, object], archive_info: os.stat_result,
                       checkpoint: Checkpoint) -> dict[str, object]:
    settlement = Path(str(intent["settlementPath"]))
    prepared = Path(str(settlement) + ".prepared")
    payload = _converge_document_staging(
        prepared, settlement, prefix="settlement", checkpoint=checkpoint
    )
    if payload is None:
        document = _settlement_document(intent, archive_info)
        payload = _encode(document)
        _publish_document(
            prepared, settlement, payload, prefix="settlement", checkpoint=checkpoint
        )
    return _validate_settlement(settlement, intent)


def _load_intent(intent_path: Path, checkpoint: Checkpoint) -> dict[str, object] | None:
    prepared = Path(str(intent_path) + ".prepared")
    payload = _converge_document_staging(
        prepared, intent_path, prefix="intent", checkpoint=checkpoint
    )
    if payload is None:
        return None
    document = json.loads(payload.decode("utf-8"))
    if not isinstance(document, dict):
        _fail("consumption intent is not an object")
    return _validate_layout(document, intent_path)


def _finish_intent(intent_path: Path, intent: dict[str, object], checkpoint: Checkpoint) -> dict[str, object]:
    archive_info = _converge_receipt(intent, checkpoint)
    settlement = _ensure_settlement(intent, archive_info, checkpoint)
    current, _, _ = _read_json(intent_path, links={1})
    if current != intent:
        _fail("consumption intent changed before settlement")
    os.unlink(intent_path)
    checkpoint("intent-after-unlink")
    _fsync_directory(intent_path.parent)
    checkpoint("intent-after-unlink-directory-fsync")
    return settlement


def _active_run(
    active: Path, lock_dir: Path, state_root: Path
) -> tuple[Path | None, OwnerIdentity | None]:
    active_run: Path | None = None
    lock_run: Path | None = None
    lock_owner: OwnerIdentity | None = None
    if os.path.lexists(active):
        raw, _ = _read_bytes(active, links={1})
        try:
            active_text = raw.decode("utf-8").strip()
        except UnicodeError as error:
            raise RuntimeError("active journal is not UTF-8") from error
        if not active_text or "\n" in active_text or "\r" in active_text:
            _fail("active journal content is invalid")
        active_run = _absolute(Path(active_text))
    if os.path.lexists(lock_dir):
        _inspect_directory(lock_dir)
        owner_path = lock_dir / "owner"
        if os.path.lexists(owner_path):
            raw, _ = _read_bytes(owner_path, links={1})
            lock_owner = _parse_owner(raw)
            lock_run = state_root / ("stateful-" + lock_owner.run_id)
        elif active_run is None or any(os.scandir(lock_dir)):
            _fail("hardening lock owner is missing outside an exact release boundary")
    if active_run is not None and lock_run is not None and active_run != lock_run:
        _fail("active journal and hardening lock identify different runs")
    run_dir = active_run or lock_run
    if run_dir is not None:
        run_dir = _absolute(run_dir)
        if run_dir.parent != state_root or not run_dir.name.startswith("stateful-"):
            _fail("stale hardening run path is outside the state root")
        _inspect_directory(run_dir)
    return run_dir, lock_owner


def _state_document(run_dir: Path) -> tuple[bytes, list[tuple[str, str]], dict[str, list[str]]]:
    raw, _ = _read_bytes(run_dir / "state", links={1}, maximum=4 * 1024 * 1024)
    records: list[tuple[str, str]] = []
    values: dict[str, list[str]] = {}
    for raw_line in raw.decode("utf-8").splitlines():
        if "=" not in raw_line:
            _fail("hardening state line is malformed")
        key, value = raw_line.split("=", 1)
        if not key or not value:
            _fail("hardening state key/value is empty")
        records.append((key, value))
        values.setdefault(key, []).append(value)
    return raw, records, values


def _state_values(run_dir: Path) -> dict[str, list[str]]:
    return _state_document(run_dir)[2]


def _single_value(values: dict[str, list[str]], key: str) -> str:
    found = values.get(key, [])
    if not found or len(set(found)) != 1:
        _fail(f"hardening state identity is missing or divergent: {key}")
    return found[0]


def _validate_pre_mutation_writer_refusal(
    records: list[tuple[str, str]],
    values: dict[str, list[str]],
) -> None:
    if tuple(values.get("pipeline_writer.status", ())) \
            != PRE_MUTATION_WRITER_STATUSES:
        _fail("pre-mutation writer refusal sequence is not exact")
    if values.get("image_scan.status") != ["all-exact-receipts-verified"]:
        _fail("pre-mutation image scan boundary is not exact")
    if values.get("backup.freshness") != [
        "revalidated-before-writer-quiescence"
    ]:
        _fail("pre-mutation backup freshness boundary is not exact")
    required_order = (
        ("deployment.status", "quiescing-pipeline-writers"),
        ("pipeline_writer.status", "gating"),
        ("pipeline_writer.status", "refused-busy"),
        ("deployment.status", "failed"),
    )
    cursor = -1
    for expected_record in required_order:
        try:
            cursor = records.index(expected_record, cursor + 1)
        except ValueError:
            _fail("pre-mutation terminal state ordering is invalid")


def _validate_pre_mutation_rollback_scan_failure(
    run_dir: Path,
    records: list[tuple[str, str]],
    values: dict[str, list[str]],
) -> None:
    for forbidden_key in (
        "pipeline_writer.status",
        "image_scan.status",
        "backup.freshness",
        "promotion.status",
        "qdrant.rollback_scan_receipt_sha256",
        "postgres.rollback_scan_receipt_sha256",
    ):
        if forbidden_key in values:
            _fail(
                "pre-mutation rollback scan failure contains a later "
                f"boundary: {forbidden_key}"
            )
    if any(key.startswith("pipeline_writer.") for key in values):
        _fail("pre-mutation rollback scan failure contains writer state")
    for leaf in ("qdrant-quiesce-first.json", "qdrant-before.json"):
        if os.path.lexists(run_dir / leaf):
            _fail(
                "pre-mutation rollback scan failure has a post-quiescence "
                f"artifact: {leaf}"
            )
    observed_scan_keys = {
        key for key in values if key.startswith("image_scan.")
    }
    if observed_scan_keys != set(PRE_MUTATION_CANDIDATE_SCAN_KEYS):
        _fail("pre-mutation candidate image scan receipt key set is not exact")

    evidence = run_dir / "evidence"
    _inspect_directory(evidence)
    expected_scan_artifacts: set[str] = set()
    for key, service in zip(
        PRE_MUTATION_CANDIDATE_SCAN_KEYS,
        PRE_MUTATION_CANDIDATE_SCAN_SERVICES,
        strict=True,
    ):
        expected_scan_artifacts.update({
            f"image-scan-{service}.json",
            f"image-scan-{service}.receipt.json",
            f"image-scan-{service}.validation.json",
            f"image-scan-{service}.verification.json",
        })
        receipt_values = values.get(key, [])
        if len(receipt_values) != 1 or HEX64.fullmatch(receipt_values[0]) is None:
            _fail(f"pre-mutation candidate scan receipt is invalid: {service}")
        receipt = evidence / f"image-scan-{service}.receipt.json"
        receipt_sha, _ = _sha256_file(receipt, links={1})
        if receipt_sha != receipt_values[0]:
            _fail(f"pre-mutation candidate scan receipt changed: {service}")
        _inspect_file(
            evidence / f"image-scan-{service}.json",
            links={1},
            maximum=256 * 1024 * 1024,
        )
        _inspect_file(
            evidence / f"image-scan-{service}.validation.json",
            links={1},
        )
        _inspect_file(
            evidence / f"image-scan-{service}.verification.json",
            links={1},
        )

    required_order = [
        ("deployment.status", "scanning-all-runtime-images"),
        *(
            (key, values[key][0])
            for key in PRE_MUTATION_CANDIDATE_SCAN_KEYS
        ),
        ("deployment.status", "failed"),
    ]
    cursor = -1
    for expected_record in required_order:
        try:
            cursor = records.index(expected_record, cursor + 1)
        except ValueError:
            _fail("pre-mutation rollback scan terminal ordering is invalid")

    rollback_prefix = evidence / "image-scan-qdrant-rollback"
    rollback_report = Path(str(rollback_prefix) + ".json")
    rollback_validation = Path(str(rollback_prefix) + ".validation.json")
    expected_scan_artifacts.update({
        rollback_report.name,
        rollback_validation.name,
    })
    if not os.path.lexists(rollback_report):
        _fail("pre-mutation rollback scan report is absent")
    if not os.path.lexists(rollback_validation):
        _fail("pre-mutation rollback scan validation marker is absent")
    _inspect_file(
        rollback_report,
        links={1},
        maximum=256 * 1024 * 1024,
    )
    _inspect_empty_file(rollback_validation)
    for suffix in (
        ".receipt.json",
        ".verification.json",
        ".reverification.json",
        ".calibration.json",
    ):
        if os.path.lexists(Path(str(rollback_prefix) + suffix)):
            _fail(
                "pre-mutation rollback scan failure has an unexpected "
                f"artifact: {rollback_prefix.name}{suffix}"
            )
    observed_scan_artifacts = {
        entry.name
        for entry in os.scandir(evidence)
        if entry.name.startswith("image-scan-")
    }
    if observed_scan_artifacts != expected_scan_artifacts:
        _fail("pre-mutation rollback scan artifact set is not exact")


def _validate_pre_mutation_run(
    run_dir: Path,
    state_root: Path,
    binding: RunBinding,
    expected_receipt_sha: str,
) -> None:
    if run_dir != state_root / ("stateful-" + binding.run_id):
        _fail("pre-mutation run path binding is invalid")
    _inspect_directory(run_dir)
    raw, records, values = _state_document(run_dir)
    if _sha256_bytes(raw) != binding.state_sha256:
        _fail("pre-mutation hardening state digest changed")
    if values.get("run.id") != [binding.run_id]:
        _fail("pre-mutation hardening run ID is not exact")
    if values.get("api_bridge.receipt_sha256") != [
        expected_receipt_sha,
        expected_receipt_sha,
    ]:
        _fail("pre-mutation hardening receipt binding is not exact")
    deployment_statuses = tuple(values.get("deployment.status", ()))
    if deployment_statuses == PRE_MUTATION_DEPLOYMENT_STATUSES:
        _validate_pre_mutation_writer_refusal(records, values)
    elif deployment_statuses \
            == PRE_MUTATION_ROLLBACK_SCAN_FAILURE_DEPLOYMENT_STATUSES:
        _validate_pre_mutation_rollback_scan_failure(run_dir, records, values)
    else:
        _fail("pre-mutation hardening deployment status sequence is not exact")
    if values.get("api_bridge.verify_count") != ["1"]:
        _fail("pre-mutation bridge verification count is not exact")
    anchor_values = values.get("api_bridge.attestation_anchor_created_at", [])
    if len(anchor_values) != 1 or not anchor_values[0] \
            or len(anchor_values[0]) > 64:
        _fail("pre-mutation bridge attestation anchor is not exact")
    for key in values:
        if key in PRE_MUTATION_FORBIDDEN_STATE_KEYS \
                or key.startswith(PRE_MUTATION_FORBIDDEN_STATE_PREFIXES):
            _fail(f"pre-mutation hardening state contains mutation evidence: {key}")
    for leaf in PRE_MUTATION_FORBIDDEN_FILES:
        if os.path.lexists(run_dir / leaf):
            _fail(f"pre-mutation hardening artifact proves a later boundary: {leaf}")


def _validate_pre_mutation_related_runs(
    *,
    state_root: Path,
    active: Path,
    lock_dir: Path,
    runtime_contract: Path,
    expected_receipt_sha: str,
    related_runs: tuple[RunBinding, ...],
) -> tuple[RunBinding, ...]:
    if HEX64.fullmatch(expected_receipt_sha) is None:
        _fail("pre-mutation receipt digest is invalid")
    related_runs = _normalize_run_bindings(related_runs)
    _inspect_directory(state_root)
    for path, label in (
        (active, "active hardening journal"),
        (lock_dir, "hardening lock"),
        (runtime_contract, "stateful runtime contract"),
    ):
        if os.path.lexists(path):
            _fail(f"pre-mutation retirement found an unexpected {label}")

    discovered: dict[str, tuple[Path, bytes, dict[str, list[str]]]] = {}
    for entry in os.scandir(state_root):
        match = re.fullmatch(r"stateful-(" + RUN_ID.pattern[1:-1] + r")", entry.name)
        if match is None:
            continue
        run_dir = state_root / entry.name
        _inspect_directory(run_dir)
        raw, _, values = _state_document(run_dir)
        receipt_values = values.get("api_bridge.receipt_sha256", [])
        if expected_receipt_sha not in receipt_values:
            continue
        if not receipt_values or set(receipt_values) != {expected_receipt_sha}:
            _fail("a related hardening run has divergent bridge receipt bindings")
        run_id = match.group(1)
        if run_id in discovered:
            _fail("a related hardening run ID is duplicated")
        discovered[run_id] = (run_dir, raw, values)

    expected_ids = {binding.run_id for binding in related_runs}
    if set(discovered) != expected_ids:
        _fail("pre-mutation related run set differs from the exact bindings")
    for binding in related_runs:
        run_dir, raw, _ = discovered[binding.run_id]
        if _sha256_bytes(raw) != binding.state_sha256:
            _fail("pre-mutation related run state digest differs")
        _validate_pre_mutation_run(
            run_dir, state_root, binding, expected_receipt_sha
        )
    return related_runs


def _validate_pre_mutation_residuals(
    *,
    state_root: Path,
    archive_run_id: str,
    expected_receipt_sha: str,
    related_runs: tuple[RunBinding, ...],
    stage: str,
) -> None:
    related_runs = _normalize_run_bindings(related_runs)
    archive_name = (
        f"api-bridge-receipt.{PRE_MUTATION_REASON}."
        f"{expected_receipt_sha}.json"
    )
    settlement_name = archive_name + ".consumption-settlement.json"
    prepared_settlement_name = settlement_name + ".prepared"
    if stage == "unsettled":
        allowed: set[tuple[str, str]] = set()
    elif stage == "in-flight":
        allowed = {
            (archive_run_id, archive_name),
            (archive_run_id, settlement_name),
            (archive_run_id, prepared_settlement_name),
        }
    elif stage == "settled":
        allowed = {
            (archive_run_id, archive_name),
            (archive_run_id, settlement_name),
        }
    else:
        _fail("pre-mutation residual validation stage is invalid")

    observed: set[tuple[str, str]] = set()
    prefix = f"api-bridge-receipt.{PRE_MUTATION_REASON}."
    for binding in related_runs:
        run_dir = state_root / ("stateful-" + binding.run_id)
        _inspect_directory(run_dir)
        for entry in os.scandir(run_dir):
            if entry.name.startswith(prefix):
                observed.add((binding.run_id, entry.name))
    if stage == "in-flight":
        archive_entry = (archive_run_id, archive_name)
        settlement_entry = (archive_run_id, settlement_name)
        prepared_entry = (archive_run_id, prepared_settlement_name)
        valid_in_flight = (
            set(),
            {archive_entry},
            {archive_entry, prepared_entry},
            {archive_entry, settlement_entry, prepared_entry},
            {archive_entry, settlement_entry},
        )
        if observed not in valid_in_flight:
            _fail("pre-mutation retirement has an impossible residual path set")
    elif observed != allowed:
        _fail(f"pre-mutation retirement {stage} residual set is not exact")


def _validate_stage(run_dir: Path, state_root: Path,
                    runtime_contract: Path) -> tuple[str, str, str]:
    run_id = run_dir.name.removeprefix("stateful-")
    if RUN_ID.fullmatch(run_id) is None:
        _fail("stale hardening run ID is invalid")
    values = _state_values(run_dir)
    if _single_value(values, "run.id") != run_id:
        _fail("stale hardening state run ID changed")
    receipt_sha = _single_value(values, "api_bridge.receipt_sha256")
    if HEX64.fullmatch(receipt_sha) is None:
        _fail("stale hardening receipt digest is invalid")
    completed = run_dir / "completed"
    promoted = run_dir / "promoted"
    image_scan_statuses = values.get("image_scan.status", [])
    calibration_statuses = CALIBRATION_IMAGE_SCAN_STATUSES.intersection(
        image_scan_statuses
    )
    if calibration_statuses:
        if len(image_scan_statuses) != 1:
            _fail("calibration image scan status is ambiguous or divergent")
        allowed = {
            "preflight", "building-qdrant", "preparing-postgres",
            "scanning-all-runtime-images", "failed",
        }
        if set(values.get("deployment.status", [])) - allowed \
                or "pipeline_writer.status" in values or "promotion.status" in values \
                or os.path.lexists(completed) or os.path.lexists(promoted):
            _fail("calibration run advanced beyond its mutation-free boundary")
        return "calibration", run_id, receipt_sha
    if "durable-promoted" not in values.get("promotion.status", []) \
            or "released" not in values.get("pipeline_writer.status", []) \
            or "verified" not in values.get("deployment.status", []):
        _fail("stale run is not at a consumable calibration/completed boundary")
    for marker, status in ((promoted, "promoted"), (completed, "completed")):
        raw, _ = _read_bytes(marker, links={1})
        text = raw.decode("utf-8")
        if f"status={status}\n" not in text or f"run={run_id}\n" not in text:
            _fail(f"stale hardening {status} marker changed")
    contract_raw, _ = _read_bytes(runtime_contract, links={1})
    contract_text = contract_raw.decode("utf-8")
    if ("schema=1\n" not in contract_text or "status=completed\n" not in contract_text
            or f"run={run_id}\n" not in contract_text):
        _fail("published runtime contract does not identify the completed run")
    return "completed", run_id, receipt_sha


def _find_settlement(run_dir: Path) -> Path | None:
    matches = []
    for entry in os.scandir(run_dir):
        if not entry.name.endswith(".json.consumption-settlement.json"):
            continue
        archive_name = entry.name.removesuffix(".consumption-settlement.json")
        if ARCHIVE.fullmatch(archive_name) is not None:
            matches.append(run_dir / entry.name)
    if len(matches) > 1:
        _fail("multiple consumption settlements exist for one hardening run")
    return matches[0] if matches else None


def _build_intent(*, canonical: Path, archive: Path, intent_path: Path,
                  reason: str, run_id: str, state_root: Path, active: Path,
                  lock_dir: Path, expected_sha: str,
                  related_runs: tuple[RunBinding, ...] = ()) -> dict[str, object]:
    if reason not in NORMAL_REASONS | {PRE_MUTATION_REASON} \
            or RUN_ID.fullmatch(run_id) is None \
            or HEX64.fullmatch(expected_sha) is None:
        _fail("requested consumption identity is invalid")
    if reason == PRE_MUTATION_REASON:
        related_runs = _normalize_run_bindings(related_runs)
    elif related_runs:
        _fail("normal receipt consumption cannot bind pre-mutation runs")
    _inspect_directory(state_root)
    _inspect_directory(archive.parent)
    receipt_info = _receipt_identity(canonical, expected_sha, links={1})
    document: dict[str, object] = {
        "activeJournal": str(active),
        "archivePath": str(archive),
        "canonicalPath": str(canonical),
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(
            timespec="seconds"
        ).replace("+00:00", "Z"),
        "lockDir": str(lock_dir),
        "operation": "consume-sbc-api-bridge-receipt",
        "reason": reason,
        "receiptDevice": receipt_info.st_dev,
        "receiptInode": receipt_info.st_ino,
        "receiptSha256": expected_sha,
        "receiptSize": receipt_info.st_size,
        "runId": run_id,
        "schemaVersion": 2 if reason == PRE_MUTATION_REASON else 1,
        "settlementPath": str(archive) + ".consumption-settlement.json",
        "stateRoot": str(state_root),
    }
    if reason == PRE_MUTATION_REASON:
        document["relatedRuns"] = _run_binding_documents(related_runs)
    return _validate_layout(document, intent_path)


def _consume(*, canonical: Path, archive: Path, intent_path: Path, reason: str,
             run_id: str, state_root: Path, active: Path, lock_dir: Path,
             expected_sha: str, related_runs: tuple[RunBinding, ...] = (),
             before_finish: IntentValidator | None = None,
             checkpoint: Checkpoint = _noop) -> dict[str, object]:
    if reason == PRE_MUTATION_REASON and before_finish is None:
        _fail("pre-mutation consumption requires post-intent revalidation")
    paths = [canonical, archive, intent_path, state_root, active, lock_dir]
    canonical, archive, intent_path, state_root, active, lock_dir = map(_absolute, paths)
    if os.path.lexists(intent_path) or os.path.lexists(Path(str(intent_path) + ".prepared")):
        _fail("another receipt consumption intent already exists")
    document = _build_intent(
        canonical=canonical, archive=archive, intent_path=intent_path,
        reason=reason, run_id=run_id, state_root=state_root, active=active,
        lock_dir=lock_dir, expected_sha=expected_sha,
        related_runs=related_runs,
    )
    _publish_document(
        Path(str(intent_path) + ".prepared"), intent_path, _encode(document),
        prefix="intent", checkpoint=checkpoint,
    )
    loaded = _load_intent(intent_path, checkpoint)
    if loaded != document:
        _fail("published consumption intent changed")
    # A pre-mutation retirement uses its durable intent as one side of the
    # mutex with stateful hardening.  Revalidate the other side only after the
    # intent is durable and immediately before the receipt inode is touched.
    if before_finish is not None:
        before_finish(document)
    return _finish_intent(intent_path, document, checkpoint)


def consume(*, canonical: Path, archive: Path, intent_path: Path, reason: str,
            run_id: str, state_root: Path, active: Path, lock_dir: Path,
            expected_sha: str, checkpoint: Checkpoint = _noop) -> dict[str, object]:
    if reason not in NORMAL_REASONS:
        _fail("generic receipt consumption only accepts calibration or completed")
    return _consume(
        canonical=canonical, archive=archive, intent_path=intent_path,
        reason=reason, run_id=run_id, state_root=state_root, active=active,
        lock_dir=lock_dir, expected_sha=expected_sha, checkpoint=checkpoint,
    )


def _release_exact_run(active: Path, lock_dir: Path, state_root: Path,
                       run_dir: Path, lock_owner: OwnerIdentity | None,
                       checkpoint: Checkpoint) -> None:
    if os.path.lexists(lock_dir):
        owner = lock_dir / "owner"
        if os.path.lexists(owner):
            if lock_owner is None:
                _fail("hardening lock has no exact owner token")
            before = _inspect_file(owner, links={1})
            expected = _owner_payload(lock_owner)
            if lock_owner.run_id != run_dir.name.removeprefix("stateful-"):
                _fail("hardening lock owner run changed before release")
            raw, opened = _read_bytes(owner, links={1})
            if raw != expected or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                _fail("hardening lock owner changed before release")
            os.unlink(owner)
            checkpoint("lock-after-owner-unlink")
            _fsync_directory(lock_dir)
            checkpoint("lock-after-owner-directory-fsync")
        if any(os.scandir(lock_dir)):
            _fail("hardening lock directory contains an unrelated entry")
        os.rmdir(lock_dir)
        checkpoint("lock-after-directory-rmdir")
        _fsync_directory(state_root)
        checkpoint("lock-after-state-root-fsync")
    if os.path.lexists(active):
        raw, _ = _read_bytes(active, links={1})
        if raw.decode("utf-8").strip() != str(run_dir):
            _fail("active journal changed before release")
        os.unlink(active)
        checkpoint("active-after-unlink")
        _fsync_directory(state_root)
        checkpoint("active-after-state-root-fsync")


def startup_reconcile(*, state_root: Path, canonical: Path, intent_path: Path,
                      active: Path, lock_dir: Path, runtime_contract: Path,
                      checkpoint: Checkpoint = _noop) -> str:
    state_root, canonical, intent_path, active, lock_dir, runtime_contract = map(
        _absolute,
        (state_root, canonical, intent_path, active, lock_dir, runtime_contract),
    )
    _validate_fixed_state_paths(
        state_root=state_root,
        canonical=canonical,
        intent_path=intent_path,
        active=active,
        lock_dir=lock_dir,
        runtime_contract=runtime_contract,
    )
    _inspect_directory(state_root)
    # Observe and reject the exact live owner before even converging a prepared
    # intent.  Intent reconciliation mutates durable state and must never run
    # concurrently with the process that owns this interlock.
    run_dir, lock_owner = _active_run(active, lock_dir, state_root)
    if _owner_is_live(lock_owner):
        _fail("the hardening lock owner process is still alive")
    intent = _load_intent(intent_path, checkpoint)
    if intent is not None:
        intent_run_dir = Path(str(intent["archivePath"])).parent
        if intent["reason"] == PRE_MUTATION_REASON:
            if run_dir is not None:
                _fail("pre-mutation retirement intent exists beside a hardening interlock")
            bindings = _normalize_run_bindings(intent["relatedRuns"])
            _validate_pre_mutation_related_runs(
                state_root=state_root,
                active=active,
                lock_dir=lock_dir,
                runtime_contract=runtime_contract,
                expected_receipt_sha=str(intent["receiptSha256"]),
                related_runs=bindings,
            )
            _validate_pre_mutation_residuals(
                state_root=state_root,
                archive_run_id=str(intent["runId"]),
                expected_receipt_sha=str(intent["receiptSha256"]),
                related_runs=bindings,
                stage="in-flight",
            )
            if intent_run_dir != state_root / ("stateful-" + str(intent["runId"])):
                _fail("pre-mutation retirement archive run changed")
        else:
            if run_dir is not None and intent_run_dir != run_dir:
                _fail("consumption intent and stale hardening lock identify different runs")
            intent_stage = _validate_stage(
                intent_run_dir, state_root, runtime_contract
            )
            if intent_stage != (
                intent["reason"], intent["runId"], intent["receiptSha256"]
            ):
                _fail("consumption intent no longer matches its hardening stage")
        _finish_intent(intent_path, intent, checkpoint)
        if intent["reason"] == PRE_MUTATION_REASON:
            _validate_pre_mutation_residuals(
                state_root=state_root,
                archive_run_id=str(intent["runId"]),
                expected_receipt_sha=str(intent["receiptSha256"]),
                related_runs=_normalize_run_bindings(intent["relatedRuns"]),
                stage="settled",
            )
    if run_dir is None:
        if intent is not None:
            return str(intent["reason"])
        return "none"
    reason, run_id, expected_sha = _validate_stage(run_dir, state_root, runtime_contract)
    settlement_path = _find_settlement(run_dir)
    if settlement_path is None:
        archive = run_dir / f"api-bridge-receipt.{reason}.{expected_sha}.json"
        consume(
            canonical=canonical, archive=archive, intent_path=intent_path,
            reason=reason, run_id=run_id, state_root=state_root, active=active,
            lock_dir=lock_dir, expected_sha=expected_sha, checkpoint=checkpoint,
        )
        settlement_path = Path(str(archive) + ".consumption-settlement.json")
    elif os.path.lexists(canonical):
        _fail("canonical bridge receipt still exists beside its settlement")
    settlement = _validate_settlement(settlement_path)
    if (settlement.get("reason"), settlement.get("runId"),
            settlement.get("receiptSha256")) != (reason, run_id, expected_sha):
        _fail("stale hardening settlement does not match its state")
    if os.path.lexists(canonical):
        _fail("canonical bridge receipt reappeared after settlement validation")
    _release_exact_run(
        active, lock_dir, state_root, run_dir, lock_owner, checkpoint
    )
    return reason


def _validate_expected_pre_mutation_settlement(
    settlement_path: Path,
    *,
    archive_run_id: str,
    expected_receipt_sha: str,
    related_runs: tuple[RunBinding, ...],
) -> dict[str, object]:
    settlement = _validate_settlement(settlement_path)
    expected_related = _run_binding_documents(related_runs)
    if (
        settlement.get("reason") != PRE_MUTATION_REASON
        or settlement.get("runId") != archive_run_id
        or settlement.get("receiptSha256") != expected_receipt_sha
        or settlement.get("relatedRuns") != expected_related
    ):
        _fail("pre-mutation consumption settlement differs from the exact request")
    return settlement


def _cancel_unmutated_pre_mutation_intent(
    *,
    intent_path: Path,
    intent: dict[str, object],
    canonical: Path,
    state_root: Path,
    archive_run_id: str,
    expected_receipt_sha: str,
    related_runs: tuple[RunBinding, ...],
    checkpoint: Checkpoint,
) -> None:
    current, _, _ = _read_json(intent_path, links={1})
    if current != intent:
        _fail("pre-mutation intent changed before cancellation")
    if os.path.lexists(Path(str(intent_path) + ".prepared")):
        _fail("pre-mutation intent staging path reappeared before cancellation")
    receipt_info = _receipt_identity(canonical, expected_receipt_sha, links={1})
    if (receipt_info.st_dev, receipt_info.st_ino, receipt_info.st_size) != (
        intent.get("receiptDevice"),
        intent.get("receiptInode"),
        intent.get("receiptSize"),
    ):
        _fail("canonical receipt changed before intent cancellation")
    _validate_pre_mutation_residuals(
        state_root=state_root,
        archive_run_id=archive_run_id,
        expected_receipt_sha=expected_receipt_sha,
        related_runs=related_runs,
        stage="unsettled",
    )
    checkpoint("retirement-cancel-before-intent-unlink")
    current_again, _, _ = _read_json(intent_path, links={1})
    if current_again != intent:
        _fail("pre-mutation intent changed at its cancellation boundary")
    receipt_again = _receipt_identity(canonical, expected_receipt_sha, links={1})
    if (receipt_again.st_dev, receipt_again.st_ino, receipt_again.st_size) != (
        intent.get("receiptDevice"),
        intent.get("receiptInode"),
        intent.get("receiptSize"),
    ):
        _fail("canonical receipt changed at the intent cancellation boundary")
    os.unlink(intent_path)
    checkpoint("retirement-cancel-after-intent-unlink")
    _fsync_directory(state_root)
    checkpoint("retirement-cancel-after-intent-directory-fsync")
    if os.path.lexists(intent_path) \
            or os.path.lexists(Path(str(intent_path) + ".prepared")):
        _fail("pre-mutation intent remained after cancellation")
    final_receipt = _receipt_identity(canonical, expected_receipt_sha, links={1})
    if (final_receipt.st_dev, final_receipt.st_ino, final_receipt.st_size) != (
        intent.get("receiptDevice"),
        intent.get("receiptInode"),
        intent.get("receiptSize"),
    ):
        _fail("canonical receipt changed while cancelling the intent")
    _validate_pre_mutation_residuals(
        state_root=state_root,
        archive_run_id=archive_run_id,
        expected_receipt_sha=expected_receipt_sha,
        related_runs=related_runs,
        stage="unsettled",
    )


def retire_pre_mutation(
    *,
    canonical: Path,
    intent_path: Path,
    state_root: Path,
    active: Path,
    lock_dir: Path,
    runtime_contract: Path,
    archive_run_id: str,
    expected_sha: str,
    related_runs: tuple[RunBinding, ...],
    checkpoint: Checkpoint = _noop,
) -> dict[str, object]:
    paths = (
        canonical, intent_path, state_root, active, lock_dir, runtime_contract
    )
    canonical, intent_path, state_root, active, lock_dir, runtime_contract = map(
        _absolute, paths
    )
    _validate_fixed_state_paths(
        state_root=state_root,
        canonical=canonical,
        intent_path=intent_path,
        active=active,
        lock_dir=lock_dir,
        runtime_contract=runtime_contract,
    )
    related_runs = _normalize_run_bindings(related_runs)
    if RUN_ID.fullmatch(archive_run_id) is None \
            or archive_run_id != related_runs[-1].run_id:
        _fail("pre-mutation archive run ID is not the latest related run")
    if HEX64.fullmatch(expected_sha) is None:
        _fail("pre-mutation expected receipt digest is invalid")
    archive = (
        state_root / ("stateful-" + archive_run_id)
        / f"api-bridge-receipt.{PRE_MUTATION_REASON}.{expected_sha}.json"
    )
    settlement_path = Path(str(archive) + ".consumption-settlement.json")

    _validate_pre_mutation_related_runs(
        state_root=state_root,
        active=active,
        lock_dir=lock_dir,
        runtime_contract=runtime_contract,
        expected_receipt_sha=expected_sha,
        related_runs=related_runs,
    )

    prepared_intent = Path(str(intent_path) + ".prepared")
    if os.path.lexists(intent_path) or os.path.lexists(prepared_intent):
        _validate_pre_mutation_residuals(
            state_root=state_root,
            archive_run_id=archive_run_id,
            expected_receipt_sha=expected_sha,
            related_runs=related_runs,
            stage="in-flight",
        )
        reconciliation = startup_reconcile(
            state_root=state_root,
            canonical=canonical,
            intent_path=intent_path,
            active=active,
            lock_dir=lock_dir,
            runtime_contract=runtime_contract,
            checkpoint=checkpoint,
        )
        if reconciliation == PRE_MUTATION_REASON:
            _validate_pre_mutation_residuals(
                state_root=state_root,
                archive_run_id=archive_run_id,
                expected_receipt_sha=expected_sha,
                related_runs=related_runs,
                stage="settled",
            )
            return _validate_expected_pre_mutation_settlement(
                settlement_path,
                archive_run_id=archive_run_id,
                expected_receipt_sha=expected_sha,
                related_runs=related_runs,
            )
        if reconciliation != "none":
            _fail("a different receipt consumption was reconciled")

    archive_exists = os.path.lexists(archive)
    settlement_exists = os.path.lexists(settlement_path)
    canonical_exists = os.path.lexists(canonical)
    if archive_exists or settlement_exists or not canonical_exists:
        if not canonical_exists and archive_exists and settlement_exists:
            _validate_pre_mutation_residuals(
                state_root=state_root,
                archive_run_id=archive_run_id,
                expected_receipt_sha=expected_sha,
                related_runs=related_runs,
                stage="settled",
            )
            return _validate_expected_pre_mutation_settlement(
                settlement_path,
                archive_run_id=archive_run_id,
                expected_receipt_sha=expected_sha,
                related_runs=related_runs,
            )
        _fail("pre-mutation receipt retirement paths are incomplete or conflicting")

    _validate_pre_mutation_residuals(
        state_root=state_root,
        archive_run_id=archive_run_id,
        expected_receipt_sha=expected_sha,
        related_runs=related_runs,
        stage="unsettled",
    )

    def revalidate_or_cancel(intent: dict[str, object]) -> None:
        try:
            _validate_pre_mutation_related_runs(
                state_root=state_root,
                active=active,
                lock_dir=lock_dir,
                runtime_contract=runtime_contract,
                expected_receipt_sha=expected_sha,
                related_runs=related_runs,
            )
            _validate_pre_mutation_residuals(
                state_root=state_root,
                archive_run_id=archive_run_id,
                expected_receipt_sha=expected_sha,
                related_runs=related_runs,
                stage="unsettled",
            )
        except (OSError, RuntimeError, UnicodeError, ValueError,
                json.JSONDecodeError) as validation_error:
            try:
                _cancel_unmutated_pre_mutation_intent(
                    intent_path=intent_path,
                    intent=intent,
                    canonical=canonical,
                    state_root=state_root,
                    archive_run_id=archive_run_id,
                    expected_receipt_sha=expected_sha,
                    related_runs=related_runs,
                    checkpoint=checkpoint,
                )
            except (OSError, RuntimeError, UnicodeError, ValueError,
                    json.JSONDecodeError) as cancellation_error:
                raise RuntimeError(
                    "pre-mutation retirement revalidation failed and exact "
                    f"intent cancellation did not complete: {cancellation_error}"
                ) from validation_error
            raise

    settlement = _consume(
        canonical=canonical,
        archive=archive,
        intent_path=intent_path,
        reason=PRE_MUTATION_REASON,
        run_id=archive_run_id,
        state_root=state_root,
        active=active,
        lock_dir=lock_dir,
        expected_sha=expected_sha,
        related_runs=related_runs,
        before_finish=revalidate_or_cancel,
        checkpoint=checkpoint,
    )
    _validate_pre_mutation_related_runs(
        state_root=state_root,
        active=active,
        lock_dir=lock_dir,
        runtime_contract=runtime_contract,
        expected_receipt_sha=expected_sha,
        related_runs=related_runs,
    )
    _validate_pre_mutation_residuals(
        state_root=state_root,
        archive_run_id=archive_run_id,
        expected_receipt_sha=expected_sha,
        related_runs=related_runs,
        stage="settled",
    )
    validated = _validate_expected_pre_mutation_settlement(
        settlement_path,
        archive_run_id=archive_run_id,
        expected_receipt_sha=expected_sha,
        related_runs=related_runs,
    )
    if settlement != validated:
        _fail("pre-mutation settlement changed after consumption")
    return validated


def _parse_run_binding(value: str) -> RunBinding:
    run_id, separator, state_sha = value.partition(":")
    if not separator or ":" in state_sha or RUN_ID.fullmatch(run_id) is None \
            or HEX64.fullmatch(state_sha) is None:
        raise argparse.ArgumentTypeError(
            "related run must be RUN_ID:STATE_SHA256"
        )
    return RunBinding(run_id=run_id, state_sha256=state_sha)


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    consume_parser = subparsers.add_parser("consume")
    for target in (consume_parser,):
        target.add_argument("--canonical", required=True, type=Path)
        target.add_argument("--archive", required=True, type=Path)
        target.add_argument("--intent", required=True, type=Path)
        target.add_argument("--reason", required=True, choices=("calibration", "completed"))
        target.add_argument("--run-id", required=True)
        target.add_argument("--state-root", required=True, type=Path)
        target.add_argument("--active-journal", required=True, type=Path)
        target.add_argument("--lock-dir", required=True, type=Path)
        target.add_argument("--expected-sha256", required=True)
    startup_parser = subparsers.add_parser("startup-reconcile")
    startup_parser.add_argument("--canonical", required=True, type=Path)
    startup_parser.add_argument("--intent", required=True, type=Path)
    startup_parser.add_argument("--state-root", required=True, type=Path)
    startup_parser.add_argument("--active-journal", required=True, type=Path)
    startup_parser.add_argument("--lock-dir", required=True, type=Path)
    startup_parser.add_argument("--runtime-contract", required=True, type=Path)
    retire_parser = subparsers.add_parser("retire-pre-mutation")
    retire_parser.add_argument("--canonical", required=True, type=Path)
    retire_parser.add_argument("--intent", required=True, type=Path)
    retire_parser.add_argument("--state-root", required=True, type=Path)
    retire_parser.add_argument("--active-journal", required=True, type=Path)
    retire_parser.add_argument("--lock-dir", required=True, type=Path)
    retire_parser.add_argument("--runtime-contract", required=True, type=Path)
    retire_parser.add_argument("--archive-run-id", required=True)
    retire_parser.add_argument("--expected-sha256", required=True)
    retire_parser.add_argument(
        "--related-run", required=True, action="append", type=_parse_run_binding
    )
    arguments = parser.parse_args()
    if arguments.command == "consume":
        settlement = consume(
            canonical=arguments.canonical, archive=arguments.archive,
            intent_path=arguments.intent, reason=arguments.reason,
            run_id=arguments.run_id, state_root=arguments.state_root,
            active=arguments.active_journal, lock_dir=arguments.lock_dir,
            expected_sha=arguments.expected_sha256,
        )
        print(json.dumps(settlement, ensure_ascii=True, separators=(",", ":"),
                         sort_keys=True))
    elif arguments.command == "startup-reconcile":
        result = startup_reconcile(
            state_root=arguments.state_root, canonical=arguments.canonical,
            intent_path=arguments.intent, active=arguments.active_journal,
            lock_dir=arguments.lock_dir, runtime_contract=arguments.runtime_contract,
        )
        print(result)
    else:
        settlement = retire_pre_mutation(
            canonical=arguments.canonical,
            intent_path=arguments.intent,
            state_root=arguments.state_root,
            active=arguments.active_journal,
            lock_dir=arguments.lock_dir,
            runtime_contract=arguments.runtime_contract,
            archive_run_id=arguments.archive_run_id,
            expected_sha=arguments.expected_sha256,
            related_runs=tuple(arguments.related_run),
        )
        print(json.dumps(settlement, ensure_ascii=True, separators=(",", ":"),
                         sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        print(f"SBC API bridge receipt consumption: {error}", file=sys.stderr)
        raise SystemExit(1)
