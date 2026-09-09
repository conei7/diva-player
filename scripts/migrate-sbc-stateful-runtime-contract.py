#!/usr/bin/env python3
"""Safely migrate the one known typo in a published SBC runtime contract.

This is a one-time, fail-closed repair for contracts emitted before
``postgres_migrate_image_scan_receipt_sha256`` was corrected in the publisher.
It changes no value and never runs while a deployment interlock is present.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
from pathlib import Path


STATE_ROOT = Path("/var/lib/diva-player-deploy")
CONTRACT = STATE_ROOT / "stateful-runtime-contract"
INTERLOCKS = (
    "stateful-hardening-active",
    "stateful-hardening.lock",
    "api-bridge-receipt.json",
    "deploy.lock",
    "rolling-deployment-active",
)
EXPECTED_LEGACY_KEYS = """schema
status
run
qdrant_stable_tag
qdrant_image_id
qdrant_source_commit
qdrant_dockerfile_sha256
postgres_image_reference
postgres_image_id
postgres_migrate_image_reference
postgres_migrate_image_id
qdrant_image_scan_receipt_sha256
qdrant_audit_image_scan_receipt_sha256
postgres_image_scan_receipt_sha256
postgres_migrate_scan_receipt_sha256
postgres_dockerfile_sha256
postgres_schema_sha256
postgres_source_bundle_sha256
postgres_migrate_dockerfile_sha256
stateful_compose_projection_sha256
promotion_manifest_sha256
player_commit
pipeline_commit""".splitlines()
EXPECTED_KEYS = [
    key if key != "postgres_migrate_scan_receipt_sha256"
    else "postgres_migrate_image_scan_receipt_sha256"
    for key in EXPECTED_LEGACY_KEYS
]
RUN_ID = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9]+$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")


class MigrationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise MigrationError(message)


def regular(path: Path, *, mode: int = 0o600) -> os.stat_result:
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode), f"contract is not a regular file: {path}")
    require(info.st_uid == 0 and info.st_gid == 0, "contract owner is not root:root")
    require(stat.S_IMODE(info.st_mode) == mode, "contract mode is not 0600")
    require(info.st_nlink == 1, "contract has unexpected hard links")
    return info


def parse(raw: bytes) -> tuple[list[str], dict[str, str]]:
    require(raw and not raw.startswith(b"\xef\xbb\xbf"), "contract encoding is invalid")
    require(raw.endswith(b"\n") and b"\r" not in raw, "contract line endings are invalid")
    lines = raw.decode("utf-8").splitlines()
    keys: list[str] = []
    values: dict[str, str] = {}
    for line in lines:
        key, separator, value = line.partition("=")
        require(separator and key and value and "=" not in key,
                "contract contains an invalid assignment")
        require(key not in values, "contract contains a duplicate key")
        keys.append(key)
        values[key] = value
    return keys, values


def validate_values(values: dict[str, str]) -> None:
    require(values["schema"] == "1" and values["status"] == "completed",
            "contract completion identity is invalid")
    require(RUN_ID.fullmatch(values["run"]) is not None, "contract run ID is invalid")
    for key in ("qdrant_image_id", "postgres_image_id", "postgres_migrate_image_id"):
        require(IMAGE_ID.fullmatch(values[key]) is not None, f"invalid image ID: {key}")
    for key in (
        "qdrant_image_scan_receipt_sha256",
        "qdrant_audit_image_scan_receipt_sha256",
        "postgres_image_scan_receipt_sha256",
        "postgres_migrate_scan_receipt_sha256",
        "postgres_dockerfile_sha256",
        "postgres_schema_sha256",
        "postgres_source_bundle_sha256",
        "postgres_migrate_dockerfile_sha256",
        "stateful_compose_projection_sha256",
        "promotion_manifest_sha256",
    ):
        require(SHA256.fullmatch(values[key]) is not None, f"invalid digest: {key}")
    for key in ("qdrant_source_commit", "player_commit", "pipeline_commit"):
        require(COMMIT.fullmatch(values[key]) is not None, f"invalid commit: {key}")
    for key in (
        "qdrant_stable_tag",
        "postgres_image_reference",
        "postgres_migrate_image_reference",
    ):
        require("\n" not in values[key] and values[key], f"invalid image reference: {key}")


def atomic_replace(path: Path, payload: bytes, previous: os.stat_result,
                   previous_digest: bytes) -> None:
    temporary = path.with_name(f".{path.name}.migrate.{os.getpid()}")
    require(not os.path.lexists(temporary), "migration temporary path already exists")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        offset = 0
        while offset < len(payload):
            count = os.write(descriptor, payload[offset:])
            require(count > 0, "contract migration write failed")
            offset += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        require(regular(path).st_ino == previous.st_ino
                and hashlib.sha256(path.read_bytes()).digest() == previous_digest,
                "contract changed during migration")
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def migrate() -> dict[str, str]:
    require(os.geteuid() == 0, "contract migration requires uid 0")
    root_info = STATE_ROOT.lstat()
    require(stat.S_ISDIR(root_info.st_mode) and root_info.st_uid == 0
            and root_info.st_gid == 0 and stat.S_IMODE(root_info.st_mode) == 0o700,
            "state root ownership or mode is unsafe")
    require(not any(os.path.lexists(STATE_ROOT / name) for name in INTERLOCKS),
            "deployment interlock is present")
    previous = regular(CONTRACT)
    raw = CONTRACT.read_bytes()
    previous_digest = hashlib.sha256(raw).digest()
    keys, values = parse(raw)
    require(keys == EXPECTED_LEGACY_KEYS, "contract is not the known legacy shape")
    validate_values(values)
    migrated = raw.replace(
        b"postgres_migrate_scan_receipt_sha256=",
        b"postgres_migrate_image_scan_receipt_sha256=",
        1,
    )
    new_keys, _ = parse(migrated)
    require(new_keys == EXPECTED_KEYS, "migration did not produce the canonical key order")
    atomic_replace(CONTRACT, migrated, previous, previous_digest)
    final = regular(CONTRACT)
    require(CONTRACT.read_bytes() == migrated, "migrated contract verification failed")
    return {
        "oldSha256": hashlib.sha256(raw).hexdigest(),
        "newSha256": hashlib.sha256(migrated).hexdigest(),
        "inode": str(final.st_ino),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.parse_args()
    print(migrate())
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, MigrationError, UnicodeError, ValueError) as error:
        print(f"SBC runtime contract migration: {error}")
        raise SystemExit(1)
