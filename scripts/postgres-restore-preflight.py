#!/usr/bin/env python3
"""Read-only capacity and backup preflight for a PostgreSQL-only restore."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


POSTGRES_IMAGE = "diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1"
DATABASE_NAME = "vocadb_recommender"
POSTGRES_DATA_PATH = "/var/lib/postgresql/data"
MINIMUM_RESTORE_HEADROOM_BYTES = 1024**3
RESTORE_MULTIPLIER = 2
BACKUP_RUN_ID = re.compile(r"postgres-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
IDENTIFIER = re.compile(r"[a-z_][a-z0-9_]{0,62}\Z")


class PreflightError(RuntimeError):
    """A required backup or production runtime invariant was not met."""


def run_command(arguments: Sequence[str]) -> str:
    try:
        result = subprocess.run(
            list(arguments),
            check=False,
            timeout=300,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PreflightError(f"command could not complete: {arguments[0]}") from error
    if result.returncode != 0:
        detail = result.stderr.strip()[-600:]
        raise PreflightError(
            f"command failed ({result.returncode}): {arguments[0]}"
            + (f": {detail}" if detail else "")
        )
    return result.stdout.strip()


def _positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise PreflightError(f"{label} must be a positive integer")
    return value


def _nonnegative_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise PreflightError(f"{label} must be a non-negative integer")
    return value


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _read_backup(backup_directory: Path, expected_run_id: str | None) -> dict[str, Any]:
    try:
        directory = backup_directory.resolve(strict=True)
    except OSError as error:
        raise PreflightError(f"backup directory is unavailable: {backup_directory}") from error
    if backup_directory.is_symlink() or not directory.is_dir():
        raise PreflightError("backup directory must be a real directory, not a symlink")

    run_id = directory.name
    if not BACKUP_RUN_ID.fullmatch(run_id):
        raise PreflightError("backup directory name is not a PostgreSQL export run ID")
    if expected_run_id is not None and run_id != expected_run_id:
        raise PreflightError("backup directory does not match the requested run ID")

    manifest_path = directory / "manifest.json"
    dump_path = directory / "postgres.dump"
    if manifest_path.is_symlink() or dump_path.is_symlink():
        raise PreflightError("backup manifest and dump must not be symlinks")
    if {entry.name for entry in directory.iterdir()} != {"manifest.json", "postgres.dump"}:
        raise PreflightError("backup directory inventory must contain only manifest.json and postgres.dump")
    if not manifest_path.is_file() or not dump_path.is_file():
        raise PreflightError("backup manifest or dump is missing")

    try:
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PreflightError("backup manifest is unreadable or invalid JSON") from error
    if not isinstance(manifest, dict):
        raise PreflightError("backup manifest must be a JSON object")
    if manifest.get("status") != "complete" or manifest.get("runId") != run_id:
        raise PreflightError("backup manifest is incomplete or names a different run")
    if type(manifest.get("schemaVersion")) is not int or manifest.get("schemaVersion") != 1:
        raise PreflightError("unsupported PostgreSQL backup manifest version")

    database = manifest.get("database")
    if not isinstance(database, dict):
        raise PreflightError("backup manifest has no database record")
    if database.get("file") != "postgres.dump" or database.get("format") != "pg_dump-custom":
        raise PreflightError("backup database record does not identify a custom-format PostgreSQL dump")
    dump_size = _positive_int(database.get("sizeBytes"), "manifest database.sizeBytes")
    logical_size = _positive_int(database.get("logicalSizeBytes"), "manifest database.logicalSizeBytes")
    expected_dump_sha = database.get("sha256")
    if not isinstance(expected_dump_sha, str) or not SHA256.fullmatch(expected_dump_sha):
        raise PreflightError("manifest database.sha256 is invalid")
    if dump_path.stat().st_size != dump_size:
        raise PreflightError("PostgreSQL dump size does not match its manifest")
    dump_digest = _sha256_file(dump_path)
    if dump_digest != expected_dump_sha:
        raise PreflightError("PostgreSQL dump digest does not match its manifest")

    publication = manifest.get("publication")
    generation = publication.get("generation") if isinstance(publication, dict) else None
    if not isinstance(generation, str) or not generation.strip():
        raise PreflightError("backup manifest has no publication generation")

    return {
        "runId": run_id,
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "dumpSha256": dump_digest,
        "dumpSizeBytes": dump_size,
        "logicalDatabaseSizeBytes": logical_size,
        "publicationGeneration": generation,
        "createdAt": manifest.get("createdAt"),
        **({"validationBaseline": manifest["validationBaseline"]} if "validationBaseline" in manifest else {}),
        "manifestPath": str(manifest_path),
        "dumpPath": str(dump_path),
    }


def _allocated_bytes(container: str) -> int:
    output = run_command(["docker", "exec", container, "du", "-sk", POSTGRES_DATA_PATH])
    try:
        return _positive_int(int(output.split()[0]) * 1024, "old PostgreSQL volume size")
    except (IndexError, ValueError) as error:
        raise PreflightError("could not measure the old PostgreSQL volume") from error


def _filesystem_usage(container: str) -> dict[str, int]:
    output = run_command(["docker", "exec", container, "df", "-Pk", POSTGRES_DATA_PATH])
    rows = [line.split() for line in output.splitlines() if line.strip()]
    if len(rows) < 2 or len(rows[-1]) < 6:
        raise PreflightError("could not measure PostgreSQL filesystem capacity")
    try:
        total_kib, used_kib, available_kib = (int(rows[-1][index]) for index in (1, 2, 3))
    except ValueError as error:
        raise PreflightError("PostgreSQL filesystem capacity output is invalid") from error
    total_bytes = _positive_int(total_kib * 1024, "PostgreSQL filesystem total bytes")
    used_bytes = _nonnegative_int(used_kib * 1024, "PostgreSQL filesystem used bytes")
    available_bytes = _nonnegative_int(
        available_kib * 1024, "PostgreSQL filesystem available bytes"
    )
    if used_bytes + available_bytes > total_bytes:
        raise PreflightError("PostgreSQL filesystem capacity output is internally inconsistent")
    return {
        "totalBytes": total_bytes,
        "usedBytes": used_bytes,
        "availableBytes": available_bytes,
    }


def _validate_user(user: str) -> str:
    if not IDENTIFIER.fullmatch(user):
        raise PreflightError("PostgreSQL admin user must be a lowercase identifier")
    return user


def preflight(
    backup_directory: Path,
    *,
    expected_run_id: str | None = None,
    current_container: str = "vocadb_postgres",
    admin_user: str | None = None,
) -> dict[str, Any]:
    if expected_run_id is None:
        raise PreflightError("an explicit backup run ID is required")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", current_container):
        raise PreflightError("current PostgreSQL container name is invalid")
    backup = _read_backup(backup_directory, expected_run_id)

    containers = json.loads(run_command(["docker", "inspect", current_container]))
    if not isinstance(containers, list) or len(containers) != 1 or not isinstance(containers[0], dict):
        raise PreflightError("Docker did not return exactly one current PostgreSQL container")
    container = containers[0]
    container_state = container.get("State")
    container_config = container.get("Config")
    if not isinstance(container_state, dict) or container_state.get("Running") is not True:
        raise PreflightError("current PostgreSQL container is not running")
    if not isinstance(container_config, dict) or container_config.get("Image") != POSTGRES_IMAGE:
        raise PreflightError("current PostgreSQL container is not using the pinned production image")
    configured_environment = container_config.get("Env")
    if not isinstance(configured_environment, list) or not all(
        isinstance(item, str) and "=" in item for item in configured_environment
    ):
        raise PreflightError("current PostgreSQL container environment is unavailable")
    environment_values = dict(item.split("=", 1) for item in configured_environment)
    configured_admin_user = environment_values.get("POSTGRES_USER")
    if admin_user is not None and configured_admin_user != admin_user:
        raise PreflightError("requested PostgreSQL admin user does not match the running container")
    admin_user = _validate_user(configured_admin_user or "")
    container_image_id = container.get("Image")
    if not isinstance(container_image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", container_image_id):
        raise PreflightError("current PostgreSQL container image ID is invalid")

    mounts = container.get("Mounts")
    data_mounts = [
        mount for mount in mounts if isinstance(mount, dict) and mount.get("Destination") == POSTGRES_DATA_PATH
    ] if isinstance(mounts, list) else []
    if len(data_mounts) != 1 or data_mounts[0].get("Type") != "volume":
        raise PreflightError("current PostgreSQL data directory is not backed by exactly one Docker volume")
    old_volume = data_mounts[0].get("Name")
    if not isinstance(old_volume, str) or not re.fullmatch(
        r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", old_volume
    ):
        raise PreflightError("current PostgreSQL volume name is unavailable")

    volume_records = json.loads(run_command(["docker", "volume", "inspect", old_volume]))
    if (
        not isinstance(volume_records, list)
        or len(volume_records) != 1
        or not isinstance(volume_records[0], dict)
    ):
        raise PreflightError("Docker did not return exactly one current PostgreSQL volume")
    volume = volume_records[0]
    mountpoint_value = volume.get("Mountpoint") if isinstance(volume, dict) else None
    if not isinstance(mountpoint_value, str) or not mountpoint_value:
        raise PreflightError("Docker did not return the current PostgreSQL volume mountpoint")
    if not mountpoint_value.startswith("/"):
        raise PreflightError("current PostgreSQL volume mountpoint is not an absolute Linux path")

    image_records = json.loads(run_command(["docker", "image", "inspect", POSTGRES_IMAGE]))
    if (
        not isinstance(image_records, list)
        or len(image_records) != 1
        or not isinstance(image_records[0], dict)
    ):
        raise PreflightError("pinned PostgreSQL image is not present exactly once locally")
    if image_records[0].get("Id") != container_image_id:
        raise PreflightError("running PostgreSQL container does not match the local pinned image")

    db_size_output = run_command([
        "docker", "exec", current_container, "psql", "-X", "-v", "ON_ERROR_STOP=1",
        "-U", admin_user, "-d", DATABASE_NAME, "-Atc",
        f"SELECT pg_database_size('{DATABASE_NAME}')::text",
    ])
    try:
        current_database_bytes = _positive_int(int(db_size_output), "current logical database size")
    except ValueError as error:
        raise PreflightError("PostgreSQL returned an invalid database size") from error

    current_generation = run_command([
        "docker", "exec", current_container, "psql", "-X", "-v", "ON_ERROR_STOP=1",
        "-U", admin_user, "-d", DATABASE_NAME, "-Atc",
        "SELECT value FROM public.sync_state WHERE key = 'recommendation_publication_generation'",
    ])
    if current_generation != backup["publicationGeneration"]:
        raise PreflightError(
            "backup publication generation does not match the current PostgreSQL/Qdrant generation"
        )

    filesystem = _filesystem_usage(current_container)
    available_bytes = filesystem["availableBytes"]
    old_volume_bytes = _allocated_bytes(current_container)
    restore_basis_bytes = max(current_database_bytes, backup["logicalDatabaseSizeBytes"])
    required_free_bytes = restore_basis_bytes * RESTORE_MULTIPLIER + MINIMUM_RESTORE_HEADROOM_BYTES
    return {
        "schemaVersion": 1,
        "status": "ready" if available_bytes >= required_free_bytes else "insufficient-capacity",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "backup": backup,
        "postgres": {
            "container": current_container,
            "image": POSTGRES_IMAGE,
            "imageId": container_image_id,
            "adminUser": admin_user,
            "databaseName": DATABASE_NAME,
            "currentLogicalDatabaseSizeBytes": current_database_bytes,
            "currentPublicationGeneration": current_generation,
            "oldVolume": old_volume,
            "oldVolumeAllocatedBytes": old_volume_bytes,
            "oldVolumeRetained": True,
        },
        "capacity": {
            "filesystemPath": mountpoint_value,
            "filesystemTotalBytes": filesystem["totalBytes"],
            "filesystemUsedBytes": filesystem["usedBytes"],
            "availableBytes": available_bytes,
            "restoreBasisBytes": restore_basis_bytes,
            "restoreMultiplier": RESTORE_MULTIPLIER,
            "additionalWalAndIndexBuildAllowanceBytes": restore_basis_bytes,
            "minimumAdditionalHeadroomBytes": MINIMUM_RESTORE_HEADROOM_BYTES,
            "requiredFreeBytes": required_free_bytes,
            "sufficient": available_bytes >= required_free_bytes,
        },
        "databaseChanged": False,
        "dockerResourcesChanged": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup-directory", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--current-container", default="vocadb_postgres")
    parser.add_argument("--admin-user")
    args = parser.parse_args()
    try:
        result = preflight(
            args.backup_directory,
            expected_run_id=args.run_id,
            current_container=args.current_container,
            admin_user=args.admin_user,
        )
    except (PreflightError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["status"] == "ready" else 2


if __name__ == "__main__":
    raise SystemExit(main())
