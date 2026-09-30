#!/usr/bin/env python3
"""Tests for isolated PostgreSQL restore verification and API smoke checks."""

from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("postgres-restore-verify.py")
SPEC = importlib.util.spec_from_file_location("postgres_restore_verify", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


IMAGE_ID = f"sha256:{'a' * 64}"
RUN_ID = "postgres-20260928T233439Z-78919a5f"
VOLUME = "backend_postgres_restore_20260928_233439_78919a5f"
CONTAINER = "vocadb_postgres_restore_20260928_233439_78919a5f"
DATABASE_PORT = 25432
API_ROLE = "diva_api_login_restore_2026"
PIPELINE_ROLE = "diva_pipeline_login_restore_2026"


def candidate_song_item(song_id: int) -> dict:
    return {
        "songId": song_id,
        "name": f"song {song_id}",
        "producerIds": [],
        "vocalistIds": [],
        "youtubeViews": 0,
        "nicoViews": 0,
    }


def sample_preflight() -> dict:
    return {
        "status": "ready",
        "backup": {
            "runId": RUN_ID,
            "manifestSha256": "1" * 64,
            "dumpSha256": "2" * 64,
            "publicationGeneration": "generation-42",
        },
        "capacity": {
            "sufficient": True,
            "filesystemTotalBytes": 102_400_000,
            "filesystemUsedBytes": 20_480_000,
            "availableBytes": 81_920_000,
        },
        "postgres": {
            "image": "diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1",
            "imageId": IMAGE_ID,
            "adminUser": "vocadb",
            "oldVolume": "backend_postgres_data",
        },
    }


def candidate_inspection(*, network: str = "host", command: list[str] | None = None) -> tuple[str, str]:
    run_id = sample_preflight()["backup"]["runId"]
    manifest_sha = sample_preflight()["backup"]["manifestSha256"]
    dump_sha = sample_preflight()["backup"]["dumpSha256"]
    record = {
        "State": {"Running": True},
        "Config": {
            "Image": "diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1",
            "Labels": {
                "com.diva.postgres-restore.run-id": run_id,
                "com.diva.postgres-restore.manifest-sha256": manifest_sha,
                "com.diva.postgres-restore.dump-sha256": dump_sha,
                "com.diva.postgres-restore.purpose": "isolated-verification",
            },
            "Cmd": command or [
                "postgres", "-c", "listen_addresses=127.0.0.1", "-c", f"port={DATABASE_PORT}"
            ],
        },
        "Image": IMAGE_ID,
        "HostConfig": {"NetworkMode": network},
        "Mounts": [{
            "Type": "volume", "Name": VOLUME, "Destination": "/var/lib/postgresql/data"
        }],
    }
    volume = {
        "Name": VOLUME,
        "Labels": {
            "com.diva.postgres-restore.run-id": run_id,
            "com.diva.postgres-restore.manifest-sha256": manifest_sha,
            "com.diva.postgres-restore.dump-sha256": dump_sha,
            "com.diva.postgres-restore.purpose": "isolated-verification",
        },
    }
    return json.dumps([record]), json.dumps([volume])


class CandidateIdentityTests(unittest.TestCase):
    def test_refuses_to_treat_the_production_volume_as_a_candidate(self) -> None:
        with patch.object(MODULE, "run_command") as run_command:
            with self.assertRaisesRegex(MODULE.VerificationError, "production volume"):
                MODULE._inspect_candidate(
                    "vocadb_postgres_restore",
                    "backend_postgres_data",
                    sample_preflight(),
                    DATABASE_PORT,
                )
        run_command.assert_not_called()

    def test_requires_backup_labelled_volume_and_loopback_only_postgres_command(self) -> None:
        container_json, volume_json = candidate_inspection()
        with patch.object(MODULE, "run_command", side_effect=[container_json, volume_json]) as run_command:
            record = MODULE._inspect_candidate(CONTAINER, VOLUME, sample_preflight(), DATABASE_PORT)
        self.assertEqual(record["HostConfig"]["NetworkMode"], "host")
        self.assertEqual(run_command.call_count, 2)

    def test_rejects_network_or_port_mismatch_before_database_checks(self) -> None:
        container_json, _ = candidate_inspection(network="bridge")
        with patch.object(MODULE, "run_command", return_value=container_json) as run_command:
            with self.assertRaisesRegex(MODULE.VerificationError, "isolated host network"):
                MODULE._inspect_candidate(CONTAINER, VOLUME, sample_preflight(), DATABASE_PORT)
        run_command.assert_called_once()

        container_json, _ = candidate_inspection(command=[
            "postgres", "-c", "listen_addresses=0.0.0.0", "-c", f"port={DATABASE_PORT}"
        ])
        with patch.object(MODULE, "run_command", return_value=container_json) as run_command:
            with self.assertRaisesRegex(MODULE.VerificationError, "loopback port"):
                MODULE._inspect_candidate(CONTAINER, VOLUME, sample_preflight(), DATABASE_PORT)
        run_command.assert_called_once()


class ApiSmokeTests(unittest.TestCase):
    def test_only_calls_a_loopback_api_and_requires_all_dependency_checks(self) -> None:
        with patch.object(MODULE, "_api_get") as api_get:
            with self.assertRaisesRegex(MODULE.VerificationError, "loopback"):
                MODULE._api_smoke("https://api.example.test")
        api_get.assert_not_called()

        def fake_get(_base_url: str, path: str, query: dict | None = None) -> dict:
            if path == "/api/ready":
                return {
                "status": "ready",
                "dependencies": {"postgres": {"ok": True}, "qdrant": {"ok": True}},
                }
            if path == "/api/health":
                return {
                "status": "ok",
                "dependencies": {"postgres": {"ok": True}, "qdrant": {"ok": True}},
                }
            if path == "/api/songs/search":
                return {"items": [{"id": 1, "name": "seed one"}, {"id": 2, "name": "seed two"}]}
            if path in {"/api/recommend/metadata", "/api/recommend/audio"}:
                if query and query.get("songId") == "1":
                    return {"items": []}
                return {"items": [candidate_song_item(10), candidate_song_item(11)]}
            if path == "/api/recommend":
                return {"items": [candidate_song_item(12)], "error": None}
            raise AssertionError(f"unexpected API path: {path} {query}")

        with patch.object(MODULE, "_api_get", side_effect=fake_get):
            checks, counts = MODULE._api_smoke("http://127.0.0.1:15000")

        self.assertTrue(all(checks.values()))
        self.assertEqual(counts["searchResultCount"], 2)
        self.assertEqual(counts["metadataRecommendationCount"], 2)
        self.assertEqual(counts["hybridRecommendationCount"], 1)
        self.assertEqual(counts["audioRecommendationCount"], 2)

    def test_rejects_degraded_readiness(self) -> None:
        with patch.object(MODULE, "_api_get", return_value={"status": "degraded"}):
            with self.assertRaisesRegex(MODULE.VerificationError, "did not report ready"):
                MODULE._api_smoke("http://127.0.0.1:15000")


class RestoreVerificationTests(unittest.TestCase):
    def test_collects_database_and_api_evidence_for_the_exact_preflight_image(self) -> None:
        counts = {name: 12 for name in MODULE.TABLES_TO_COUNT}
        results = {
            "SELECT value FROM public.sync_state": "generation-42",
            "pg_stat_activity": "1",
            "SELECT pg_database_size": "2000000",
        }

        def fake_query(_container: str, _admin: str, _database: str, sql: str) -> str:
            for prefix, output in results.items():
                if prefix in sql:
                    return output
            raise AssertionError(f"unexpected query: {sql}")

        def fake_command(arguments: list[str], *, timeout: int = 300) -> str:
            del timeout
            if arguments[0] != "docker" or arguments[1:3] != ["exec", "candidate-db"]:
                raise AssertionError(f"unexpected command: {arguments}")
            if "-f" in arguments:
                return "PASS least-privilege database runtime role contract"
            if arguments[3] == "du":
                return "12288\t/var/lib/postgresql/data"
            if arguments[3] == "df":
                return (
                    "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
                    "/dev/root 100000 20000 80000 20% /var/lib/postgresql/data"
                )
            raise AssertionError(f"unexpected command: {arguments}")

        with (
            patch.object(MODULE, "_inspect_candidate"),
            patch.object(MODULE, "_table_counts", return_value=counts),
            patch.object(MODULE, "_sequence_state", return_value={
                "songs_id_seq": {"lastValue": 12, "maximumOwnedValue": 10, "isCalled": True}
            }),
            patch.object(MODULE, "_migrations", return_value={"count": 32, "latest": "0032_allow_shared_pv_ids.sql", "rows": []}),
            patch.object(MODULE, "_extensions", return_value={"vector": "0.8.6", "pg_trgm": "1.6", "pgcrypto": "1.3"}),
            patch.object(MODULE, "_indexes", return_value={"total": 96, "valid": 96}),
            patch.object(MODULE, "_collation", return_value={"recordedVersion": None, "actualVersion": None, "matches": True}),
            patch.object(MODULE, "_query", side_effect=fake_query),
            patch.object(MODULE, "_query_json", return_value={
                "diva_api_runtime": [API_ROLE],
                "diva_pipeline_runtime": [PIPELINE_ROLE],
            }),
            patch.object(MODULE, "run_command", side_effect=fake_command),
            patch.object(MODULE, "_api_smoke", return_value=(
                {"apiReady": True, "apiHealth": True, "search": True,
                 "metadataRecommendation": True, "hybridRecommendation": True,
                 "audioRecommendation": True, "apiConnectedToCandidateDatabase": True},
                {"searchResultCount": 12, "metadataRecommendationCount": 8,
                 "hybridRecommendationCount": 5, "audioRecommendationCount": 5,
                 "candidateDatabaseSessionCount": 1},
            )),
        ):
            result = MODULE.collect_verification(
                sample_preflight(),
                container="candidate-db",
                volume=VOLUME,
                api_url="http://127.0.0.1:15000",
                database_port=DATABASE_PORT,
                api_login_role=API_ROLE,
                pipeline_login_role=PIPELINE_ROLE,
                started_at="2026-09-30T01:00:00+00:00",
                logical_restore_finished_at="2026-09-30T01:08:00+00:00",
                resource_usage={
                    "schemaVersion": 1,
                    "sampleCount": 3,
                    "peakCandidateVolumeBytes": 16_384 * 1024,
                    "peakFilesystemUsedBytes": 25_000 * 1024,
                    "filesystemTotalBytes": 100_000 * 1024,
                    "firstSampleAt": "2026-09-30T01:00:10+00:00",
                    "lastSampleAt": "2026-09-30T01:00:30+00:00",
                },
            )

        self.assertEqual(result["backupRunId"], RUN_ID)
        self.assertEqual(result["postgresImageId"], IMAGE_ID)
        self.assertEqual(result["restoredVolume"], VOLUME)
        self.assertTrue(all(result["checks"].values()))
        self.assertEqual(result["api"]["audioRecommendationCount"], 5)
        self.assertEqual(result["api"]["metadataRecommendationCount"], 8)
        self.assertEqual(result["api"]["databaseConnection"]["candidateSessionCount"], 1)
        self.assertEqual(result["peakCandidateVolumeBytes"], 16_384 * 1024)
        self.assertEqual(result["peakFilesystemUsedBytes"], 25_000 * 1024)
        self.assertEqual(result["resourceUsage"]["sampleCount"], 3)
        self.assertEqual(result["filesystem"]["availableBytesBefore"], 81_920_000)

    def test_rejects_failed_preflight_before_inspecting_docker(self) -> None:
        preflight = sample_preflight()
        preflight["status"] = "insufficient-capacity"
        with patch.object(MODULE, "_inspect_candidate") as inspect_candidate:
            with self.assertRaisesRegex(MODULE.VerificationError, "preflight did not pass"):
                MODULE.collect_verification(
                    preflight,
                    container="candidate-db",
                    volume=VOLUME,
                    api_url="http://127.0.0.1:15000",
                    database_port=DATABASE_PORT,
                    api_login_role=API_ROLE,
                    pipeline_login_role=PIPELINE_ROLE,
                )
        inspect_candidate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
