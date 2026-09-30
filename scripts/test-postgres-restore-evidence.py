#!/usr/bin/env python3
"""Tests for backup-bound PostgreSQL restore evidence."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("postgres-restore-evidence.py")
SPEC = importlib.util.spec_from_file_location("postgres_restore_evidence", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


RUN_ID = "postgres-20260928T233439Z-78919a5f"
MANIFEST_SHA = "1" * 64
DUMP_SHA = "2" * 64


def sample_reports() -> tuple[dict, dict]:
    preflight = {
        "status": "ready",
        "capacity": {
            "sufficient": True,
            "filesystemTotalBytes": 2_000_000_000,
            "filesystemUsedBytes": 400_000_000,
            "availableBytes": 1_600_000_000,
            "restoreBasisBytes": 100_000_000,
            "requiredFreeBytes": 1_273_741_824,
        },
        "backup": {
            "runId": RUN_ID,
            "manifestSha256": MANIFEST_SHA,
            "dumpSha256": DUMP_SHA,
            "publicationGeneration": "generation-42",
        },
        "postgres": {
            "oldVolume": "backend_postgres_data",
            "oldVolumeAllocatedBytes": 300_000_000,
            "imageId": f"sha256:{'a' * 64}",
        },
    }
    verification = {
        "backupRunId": RUN_ID,
        "manifestSha256": MANIFEST_SHA,
        "dumpSha256": DUMP_SHA,
        "publicationGeneration": "generation-42",
        "postgresImage": MODULE.POSTGRES_IMAGE,
        "postgresImageId": f"sha256:{'a' * 64}",
        "restoredVolume": "backend_postgres_restore_20260928_78919a5f",
        "startedAt": "2026-09-30T01:00:00+00:00",
        "logicalRestoreFinishedAt": "2026-09-30T01:08:00+00:00",
        "finishedAt": "2026-09-30T01:12:30+00:00",
        "checks": {name: True for name in MODULE.REQUIRED_CHECKS},
        "tableCounts": {"songs": 100, "schema_migrations": 29, "sync_state": 12},
        "sequences": {
            "songs_id_seq": {
                "lastValue": 100,
                "maximumOwnedValue": 100,
                "isCalled": True,
            }
        },
        "migrations": {"count": 29, "latest": "0029_youtube_view_quota_safety.sql"},
        "extensions": {"vector": "0.8.6", "pg_trgm": "1.6", "pgcrypto": "1.3"},
        "indexes": {"total": 96, "valid": 96},
        "databaseCollations": {
            "vocadb_recommender": {"recordedVersion": None, "actualVersion": None, "matches": True},
            "postgres": {"recordedVersion": None, "actualVersion": None, "matches": True},
        },
        "roles": {
            "apiLogin": "diva_api_login_20260810a",
            "pipelineLogin": "diva_pipeline_login_20260810a",
            "leastPrivilegeContractPassed": True,
            "secretForRegressionTest": "must-not-be-copied",
        },
        "api": {
            "searchResultCount": 8,
            "metadataRecommendationCount": 8,
            "hybridRecommendationCount": 8,
            "audioRecommendationCount": 8,
            "candidateDatabaseSessionCount": 1,
        },
        "filesystem": {
            "totalBytesBefore": 2_000_000_000,
            "usedBytesBefore": 400_000_000,
            "availableBytesBefore": 1_600_000_000,
            "totalBytesAfter": 2_000_000_000,
            "usedBytesAfter": 450_000_000,
            "availableBytesAfter": 1_550_000_000,
        },
        "resourceUsage": {
            "sampleCount": 42,
            "firstSampleAt": "2026-09-30T01:00:10+00:00",
            "lastSampleAt": "2026-09-30T01:11:40+00:00",
            "sampledPeakCandidateVolumeBytes": 1_200_000,
            "sampledPeakFilesystemUsedBytes": 455_000_000,
        },
        "restoredLogicalDatabaseSizeBytes": 1_000_000,
        "peakCandidateVolumeBytes": 1_200_000,
        "peakFilesystemUsedBytes": 455_000_000,
    }
    return preflight, verification


class RestoreEvidenceTests(unittest.TestCase):
    def test_binds_restore_to_exact_backup_and_only_keeps_safe_fields(self) -> None:
        preflight, verification = sample_reports()
        evidence = MODULE.build_evidence(preflight, verification)

        self.assertEqual(evidence["status"], "restore-verified")
        self.assertEqual(evidence["backup"]["runId"], RUN_ID)
        self.assertEqual(evidence["backup"]["manifestSha256"], MANIFEST_SHA)
        self.assertEqual(evidence["postgres"]["restoredVolume"], verification["restoredVolume"])
        self.assertEqual(evidence["measurements"]["restoreDurationSeconds"], 750.0)
        self.assertEqual(evidence["measurements"]["logicalPostgresRestoreDurationSeconds"], 480.0)
        self.assertEqual(evidence["measurements"]["resourceUsageSampleCount"], 42)
        self.assertEqual(evidence["measurements"]["oldVolumeAllocatedBytes"], 300_000_000)
        self.assertNotIn("secretForRegressionTest", evidence["postgres"]["roles"])

    def test_rejects_a_report_bound_to_another_backup_or_generation(self) -> None:
        preflight, verification = sample_reports()
        verification["manifestSha256"] = "f" * 64
        with self.assertRaisesRegex(MODULE.EvidenceError, "does not match the preflight backup"):
            MODULE.build_evidence(preflight, verification)

        preflight, verification = sample_reports()
        verification["publicationGeneration"] = "generation-older"
        with self.assertRaisesRegex(MODULE.EvidenceError, "publication generation"):
            MODULE.build_evidence(preflight, verification)

    def test_rejects_a_different_postgres_image_id(self) -> None:
        preflight, verification = sample_reports()
        verification["postgresImageId"] = f"sha256:{'b' * 64}"
        with self.assertRaisesRegex(MODULE.EvidenceError, "does not match the preflight image"):
            MODULE.build_evidence(preflight, verification)

    def test_rejects_a_sequence_state_that_can_collide_with_restored_rows(self) -> None:
        preflight, verification = sample_reports()
        verification["sequences"]["songs_id_seq"]["lastValue"] = 99
        with self.assertRaisesRegex(MODULE.EvidenceError, "collision-safe sequence state"):
            MODULE.build_evidence(preflight, verification)

    def test_rejects_failed_capacity_or_restore_time_evidence(self) -> None:
        preflight, verification = sample_reports()
        preflight["capacity"]["availableBytes"] = 1
        with self.assertRaisesRegex(MODULE.EvidenceError, "insufficient filesystem capacity"):
            MODULE.build_evidence(preflight, verification)

        preflight, verification = sample_reports()
        verification["logicalRestoreFinishedAt"] = "2026-09-30T01:13:00+00:00"
        with self.assertRaisesRegex(MODULE.EvidenceError, "outside the verification interval"):
            MODULE.build_evidence(preflight, verification)

    def test_rejects_failed_or_missing_checks_and_incomplete_collation_validation(self) -> None:
        preflight, verification = sample_reports()
        verification["checks"]["audioRecommendation"] = False
        with self.assertRaisesRegex(MODULE.EvidenceError, "audioRecommendation"):
            MODULE.build_evidence(preflight, verification)

        preflight, verification = sample_reports()
        verification["databaseCollations"]["postgres"]["actualVersion"] = "2.36"
        with self.assertRaisesRegex(MODULE.EvidenceError, "collation versions do not match"):
            MODULE.build_evidence(preflight, verification)

    def test_refuses_to_overwrite_an_existing_evidence_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "restore-evidence.json"
            path.write_text("keep-existing", encoding="utf-8")
            with self.assertRaises(MODULE.EvidenceError):
                MODULE._write_new_file(path, {"status": "restore-verified"})
            self.assertEqual(path.read_text(encoding="utf-8"), "keep-existing")

    def test_creates_a_new_evidence_file_without_exposing_unrecognized_input(self) -> None:
        preflight, verification = sample_reports()
        payload = MODULE.build_evidence(preflight, verification)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "nested" / "restore-evidence.json"
            MODULE._write_new_file(path, payload)
            contents = path.read_text(encoding="utf-8")
            saved = json.loads(contents)

        self.assertEqual(saved["backup"]["dumpSha256"], DUMP_SHA)
        self.assertNotIn("must-not-be-copied", contents)


if __name__ == "__main__":
    unittest.main()
