#!/usr/bin/env python3
"""Validate and write a backup-bound PostgreSQL restore verification receipt."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


POSTGRES_IMAGE = "diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1"
RUN_ID = re.compile(r"postgres-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
VOLUME_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\Z")
LOGIN_ROLE = re.compile(r"diva_(?:api|pipeline)_login_[a-z0-9][a-z0-9_]*\Z")
MIGRATION_ID = re.compile(r"[0-9]{4}_[a-z0-9][a-z0-9_]*\.sql\Z")
REQUIRED_CHECKS = (
    "tableCounts",
    "majorData",
    "sequences",
    "migrations",
    "extensions",
    "roles",
    "publicationGeneration",
    "allIndexesValid",
    "applicationDatabaseCollation",
    "administrativeDatabaseCollation",
    "apiReady",
    "apiHealth",
    "apiConnectedToCandidateDatabase",
    "search",
    "metadataRecommendation",
    "hybridRecommendation",
    "audioRecommendation",
)


class EvidenceError(RuntimeError):
    """The restore report is incomplete, inconsistent, or unsafe to publish."""


def _load_object(path: Path, label: str) -> dict[str, Any]:
    try:
        if path.is_symlink() or not path.is_file():
            raise EvidenceError(f"{label} must be a regular non-symlink file")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EvidenceError(f"{label} is unreadable or invalid JSON") from error
    if not isinstance(value, dict):
        raise EvidenceError(f"{label} must be a JSON object")
    return value


def _positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise EvidenceError(f"{label} must be a positive integer")
    return value


def _nonnegative_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise EvidenceError(f"{label} must be a non-negative integer")
    return value


def _timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise EvidenceError(f"{label} must be an ISO timestamp")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise EvidenceError(f"{label} must be an ISO timestamp") from error
    if result.tzinfo is None or result.utcoffset() is None:
        raise EvidenceError(f"{label} must include a timezone")
    return result.astimezone(timezone.utc)


def _required_check_results(value: Any) -> dict[str, bool]:
    if not isinstance(value, dict):
        raise EvidenceError("verification checks must be a JSON object")
    failures = [name for name in REQUIRED_CHECKS if value.get(name) is not True]
    if failures:
        raise EvidenceError("restore verification has failed or missing checks: " + ", ".join(failures))
    return {name: True for name in REQUIRED_CHECKS}


def build_evidence(preflight: dict[str, Any], verification: dict[str, Any]) -> dict[str, Any]:
    if preflight.get("status") != "ready" or preflight.get("capacity", {}).get("sufficient") is not True:
        raise EvidenceError("restore cannot be attested because the preflight did not pass")
    backup = preflight.get("backup")
    if not isinstance(backup, dict):
        raise EvidenceError("preflight has no backup identity")
    run_id = backup.get("runId")
    manifest_sha = backup.get("manifestSha256")
    dump_sha = backup.get("dumpSha256")
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        raise EvidenceError("preflight backup run ID is invalid")
    if not isinstance(manifest_sha, str) or not SHA256.fullmatch(manifest_sha):
        raise EvidenceError("preflight manifest SHA-256 is invalid")
    if not isinstance(dump_sha, str) or not SHA256.fullmatch(dump_sha):
        raise EvidenceError("preflight dump SHA-256 is invalid")

    if (
        verification.get("backupRunId") != run_id
        or verification.get("manifestSha256") != manifest_sha
        or verification.get("dumpSha256") != dump_sha
    ):
        raise EvidenceError("restore verification does not match the preflight backup")
    if verification.get("publicationGeneration") != backup.get("publicationGeneration"):
        raise EvidenceError("restore verification does not match the backup publication generation")
    if verification.get("postgresImage") != POSTGRES_IMAGE:
        raise EvidenceError("restore verification used a different PostgreSQL image")
    image_id = verification.get("postgresImageId")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise EvidenceError("restore verification PostgreSQL image ID is invalid")
    preflight_postgres = preflight.get("postgres")
    if not isinstance(preflight_postgres, dict) or preflight_postgres.get("imageId") != image_id:
        raise EvidenceError("restore verification PostgreSQL image ID does not match the preflight image")

    old_volume = preflight.get("postgres", {}).get("oldVolume")
    new_volume = verification.get("restoredVolume")
    if not isinstance(old_volume, str) or not VOLUME_NAME.fullmatch(old_volume):
        raise EvidenceError("preflight old volume name is invalid")
    if not isinstance(new_volume, str) or not VOLUME_NAME.fullmatch(new_volume):
        raise EvidenceError("restored volume name is invalid")
    if new_volume == old_volume:
        raise EvidenceError("restored volume must remain separate from the old PostgreSQL volume")

    started = _timestamp(verification.get("startedAt"), "verification.startedAt")
    finished = _timestamp(verification.get("finishedAt"), "verification.finishedAt")
    duration_seconds = (finished - started).total_seconds()
    if duration_seconds <= 0:
        raise EvidenceError("restore duration must be positive")
    logical_restore_finished = _timestamp(
        verification.get("logicalRestoreFinishedAt"), "verification.logicalRestoreFinishedAt"
    )
    logical_restore_duration_seconds = (logical_restore_finished - started).total_seconds()
    if logical_restore_duration_seconds <= 0 or logical_restore_finished > finished:
        raise EvidenceError("logical PostgreSQL restore duration is outside the verification interval")

    preflight_capacity = preflight.get("capacity")
    if not isinstance(preflight_capacity, dict) or preflight_capacity.get("sufficient") is not True:
        raise EvidenceError("preflight filesystem capacity check did not pass")
    filesystem_total_before = _positive_int(
        preflight_capacity.get("filesystemTotalBytes"), "preflight filesystemTotalBytes"
    )
    filesystem_used_before = _nonnegative_int(
        preflight_capacity.get("filesystemUsedBytes"), "preflight filesystemUsedBytes"
    )
    filesystem_available_before = _positive_int(
        preflight_capacity.get("availableBytes"), "preflight availableBytes"
    )
    restore_basis = _positive_int(preflight_capacity.get("restoreBasisBytes"), "preflight restoreBasisBytes")
    required_free = _positive_int(preflight_capacity.get("requiredFreeBytes"), "preflight requiredFreeBytes")
    old_volume_allocated = _positive_int(
        preflight.get("postgres", {}).get("oldVolumeAllocatedBytes"),
        "preflight oldVolumeAllocatedBytes",
    )
    if filesystem_used_before + filesystem_available_before > filesystem_total_before:
        raise EvidenceError("preflight filesystem usage is inconsistent")
    if filesystem_available_before < required_free:
        raise EvidenceError("preflight reported insufficient filesystem capacity")

    filesystem = verification.get("filesystem")
    if not isinstance(filesystem, dict):
        raise EvidenceError("verification must record before and after filesystem capacity")
    if (
        filesystem.get("totalBytesBefore") != filesystem_total_before
        or filesystem.get("usedBytesBefore") != filesystem_used_before
        or filesystem.get("availableBytesBefore") != filesystem_available_before
    ):
        raise EvidenceError("verification filesystem baseline does not match the preflight")
    filesystem_total_after = _positive_int(filesystem.get("totalBytesAfter"), "filesystem.totalBytesAfter")
    filesystem_used_after = _nonnegative_int(filesystem.get("usedBytesAfter"), "filesystem.usedBytesAfter")
    filesystem_available_after = _nonnegative_int(
        filesystem.get("availableBytesAfter"), "filesystem.availableBytesAfter"
    )
    if filesystem_used_after + filesystem_available_after > filesystem_total_after:
        raise EvidenceError("post-restore filesystem usage is inconsistent")

    resource_usage = verification.get("resourceUsage")
    if not isinstance(resource_usage, dict):
        raise EvidenceError("verification must record sampled restore resource usage")
    resource_sample_count = _positive_int(resource_usage.get("sampleCount"), "resourceUsage.sampleCount")
    resource_first_sample = _timestamp(resource_usage.get("firstSampleAt"), "resourceUsage.firstSampleAt")
    resource_last_sample = _timestamp(resource_usage.get("lastSampleAt"), "resourceUsage.lastSampleAt")
    if resource_first_sample > resource_last_sample:
        raise EvidenceError("resource usage sample timestamps are not ordered")
    sampled_peak_volume = _positive_int(
        resource_usage.get("sampledPeakCandidateVolumeBytes"),
        "resourceUsage.sampledPeakCandidateVolumeBytes",
    )
    sampled_peak_filesystem = _positive_int(
        resource_usage.get("sampledPeakFilesystemUsedBytes"),
        "resourceUsage.sampledPeakFilesystemUsedBytes",
    )
    peak_volume = _positive_int(verification.get("peakCandidateVolumeBytes"), "peakCandidateVolumeBytes")
    peak_filesystem = _positive_int(verification.get("peakFilesystemUsedBytes"), "peakFilesystemUsedBytes")
    if sampled_peak_volume > peak_volume or sampled_peak_filesystem > peak_filesystem:
        raise EvidenceError("recorded resource peaks are lower than a sampled peak")
    if peak_filesystem > max(filesystem_total_before, filesystem_total_after):
        raise EvidenceError("recorded peak filesystem usage exceeds the measured filesystem size")

    comparison = verification.get("backupComparison", {"status": "not-recorded-in-source-backup"})
    if backup.get("validationBaseline") is not None:
        baseline = backup["validationBaseline"]
        if (comparison.get("status") != "matched" or verification.get("tableCounts") != baseline.get("tableCounts")
            or verification.get("migrations", {}).get("rows") != baseline.get("migrations")):
            raise EvidenceError("backup snapshot comparison is missing or inconsistent")
    elif comparison.get("status") != "not-recorded-in-source-backup": raise EvidenceError("cannot attest comparison absent from backup")
    checks = _required_check_results(verification.get("checks"))
    table_counts = verification.get("tableCounts")
    if not isinstance(table_counts, dict) or not all(
        isinstance(name, str)
        and isinstance(count, int)
        and not isinstance(count, bool)
        and count >= 0
        for name, count in table_counts.items()
    ):
        raise EvidenceError("verification tableCounts must map table names to non-negative row counts")
    for table_name in ("songs", "schema_migrations", "sync_state"):
        if table_counts.get(table_name, 0) <= 0:
            raise EvidenceError(f"verification tableCounts is missing required data in {table_name}")

    sequences = verification.get("sequences")
    if not isinstance(sequences, dict) or not sequences or not all(
        isinstance(name, str)
        and name
        and isinstance(value, dict)
        and isinstance(value.get("lastValue"), int)
        and not isinstance(value.get("lastValue"), bool)
        and isinstance(value.get("maximumOwnedValue"), int)
        and not isinstance(value.get("maximumOwnedValue"), bool)
        and isinstance(value.get("isCalled"), bool)
        and (
            value["lastValue"] >= value["maximumOwnedValue"]
            if value["isCalled"]
            else value["lastValue"] > value["maximumOwnedValue"]
        )
        for name, value in sequences.items()
    ):
        raise EvidenceError("verification must record collision-safe sequence state")
    migrations = verification.get("migrations")
    if not isinstance(migrations, dict):
        raise EvidenceError("verification must record migration state")
    migration_count = _positive_int(migrations.get("count"), "migrations.count")
    latest_migration = migrations.get("latest")
    if not isinstance(latest_migration, str) or not MIGRATION_ID.fullmatch(latest_migration):
        raise EvidenceError("migrations.latest is invalid")

    extensions = verification.get("extensions")
    if not isinstance(extensions, dict) or not all(
        isinstance(name, str) and isinstance(version, str) and version
        for name, version in extensions.items()
    ):
        raise EvidenceError("verification extensions must map extension names to versions")
    if extensions.get("vector") != "0.8.6" or not {"pg_trgm", "pgcrypto"}.issubset(extensions):
        raise EvidenceError("verification is missing a required PostgreSQL extension")

    indexes = verification.get("indexes")
    if not isinstance(indexes, dict):
        raise EvidenceError("verification must record index validity totals")
    total_indexes = _positive_int(indexes.get("total"), "indexes.total")
    valid_indexes = _positive_int(indexes.get("valid"), "indexes.valid")
    if valid_indexes != total_indexes:
        raise EvidenceError("verification reports invalid database indexes")

    collation_checks = verification.get("databaseCollations")
    if not isinstance(collation_checks, dict):
        raise EvidenceError("verification must record application and administrative database collations")
    collation_evidence: dict[str, dict[str, Any]] = {}
    for database_name in ("vocadb_recommender", "postgres"):
        state = collation_checks.get(database_name)
        if not isinstance(state, dict) or state.get("matches") is not True:
            raise EvidenceError(f"collation verification failed for database {database_name}")
        for field in ("recordedVersion", "actualVersion"):
            if state.get(field) is not None and not isinstance(state.get(field), str):
                raise EvidenceError(f"collation {field} is invalid for database {database_name}")
        if state.get("recordedVersion") != state.get("actualVersion"):
            raise EvidenceError(f"collation versions do not match for database {database_name}")
        collation_evidence[database_name] = {
            "recordedVersion": state.get("recordedVersion"),
            "actualVersion": state.get("actualVersion"),
            "matches": True,
        }

    roles = verification.get("roles")
    if not isinstance(roles, dict) or roles.get("leastPrivilegeContractPassed") is not True:
        raise EvidenceError("runtime database role contract did not pass")
    for field in ("apiLogin", "pipelineLogin"):
        role_name = roles.get(field)
        if not isinstance(role_name, str) or not LOGIN_ROLE.fullmatch(role_name):
            raise EvidenceError(f"roles.{field} is invalid")

    api = verification.get("api")
    if not isinstance(api, dict):
        raise EvidenceError("verification must record isolated API checks")
    api_counts = {}
    for field in (
        "searchResultCount",
        "metadataRecommendationCount",
        "hybridRecommendationCount",
        "audioRecommendationCount",
        "candidateDatabaseSessionCount",
    ):
        api_counts[field] = _positive_int(api.get(field), f"api.{field}")

    role_evidence = {
        "apiLogin": roles["apiLogin"],
        "pipelineLogin": roles["pipelineLogin"],
        "leastPrivilegeContractPassed": True,
    }
    measurements = {
        "restoreDurationSeconds": round(duration_seconds, 3),
        "logicalPostgresRestoreDurationSeconds": round(logical_restore_duration_seconds, 3),
        "restoredLogicalDatabaseSizeBytes": _positive_int(
            verification.get("restoredLogicalDatabaseSizeBytes"),
            "restoredLogicalDatabaseSizeBytes",
        ),
        "oldVolumeAllocatedBytes": old_volume_allocated,
        "restoreBasisBytes": restore_basis,
        "requiredFreeBytes": required_free,
        "filesystemTotalBytesBefore": filesystem_total_before,
        "filesystemUsedBytesBefore": filesystem_used_before,
        "filesystemAvailableBytesBefore": filesystem_available_before,
        "filesystemTotalBytesAfter": filesystem_total_after,
        "filesystemUsedBytesAfter": filesystem_used_after,
        "filesystemAvailableBytesAfter": filesystem_available_after,
        "resourceUsageSampleCount": resource_sample_count,
        "sampledPeakCandidateVolumeBytes": sampled_peak_volume,
        "peakCandidateVolumeBytes": peak_volume,
        "sampledPeakFilesystemUsedBytes": sampled_peak_filesystem,
        "peakFilesystemUsedBytes": peak_filesystem,
    }

    return {
        "schemaVersion": 1,
        "status": "restore-verified",
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "backup": {
            "runId": run_id,
            "manifestSha256": manifest_sha,
            "dumpSha256": dump_sha,
            "publicationGeneration": backup.get("publicationGeneration"),
        },
        "postgres": {
            "image": POSTGRES_IMAGE,
            "imageId": image_id,
            "oldVolume": old_volume,
            "restoredVolume": new_volume,
            "oldVolumeRetained": True,
            "restoreStartedAt": started.isoformat(),
            "logicalRestoreFinishedAt": logical_restore_finished.isoformat(),
            "verificationFinishedAt": finished.isoformat(),
            "databaseCollations": collation_evidence,
            "extensions": extensions,
            "indexes": {"total": total_indexes, "valid": valid_indexes},
            "migrations": {"count": migration_count, "latest": latest_migration},
            "tableCounts": table_counts,
            "sequences": sequences,
            "roles": role_evidence,
        },
        "api": {
            "ready": checks["apiReady"],
            "health": checks["apiHealth"],
            "search": {"passed": checks["search"], "resultCount": api_counts["searchResultCount"]},
            "metadataRecommendation": {
                "passed": checks["metadataRecommendation"],
                "resultCount": api_counts["metadataRecommendationCount"],
            },
            "hybridRecommendation": {
                "passed": checks["hybridRecommendation"],
                "resultCount": api_counts["hybridRecommendationCount"],
            },
            "audioRecommendation": {
                "passed": checks["audioRecommendation"],
                "resultCount": api_counts["audioRecommendationCount"],
            },
            "databaseConnection": {
                "passed": checks["apiConnectedToCandidateDatabase"],
                "candidateSessionCount": api_counts["candidateDatabaseSessionCount"],
            },
        },
        "checks": checks,
        "backupComparison": comparison,
        "measurements": measurements,
    }


def _write_new_file(path: Path, payload: dict[str, Any]) -> None:
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    for ancestor in (parent, *parent.parents):
        if ancestor.is_symlink():
            raise EvidenceError("evidence output path must not contain symlink directories")
    if os.name != "nt":
        metadata = parent.stat()
        if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
            raise EvidenceError("evidence output directory must be owner-only and owned by the current user")

    descriptor: int | None = None
    created_path = False
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created_path = True
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            descriptor = None
            json.dump(payload, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        if created_path:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        raise EvidenceError(f"could not create new restore evidence file: {path}") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight-json", required=True, type=Path)
    parser.add_argument("--verification-json", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = build_evidence(
            _load_object(args.preflight_json, "preflight report"),
            _load_object(args.verification_json, "verification report"),
        )
        _write_new_file(args.output, result)
    except (EvidenceError, OSError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"status": result["status"], "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
