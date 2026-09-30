#!/usr/bin/env python3
"""Tests for the read-only PostgreSQL restore capacity preflight."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("postgres-restore-preflight.py")
SPEC = importlib.util.spec_from_file_location("postgres_restore_preflight", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


RUN_ID = "postgres-20260928T233439Z-78919a5f"
IMAGE_ID = f"sha256:{'a' * 64}"
VOLUME_NAME = "backend_postgres_data"


def write_backup(root: Path, *, expected_sha_override: str | None = None) -> Path:
    directory = root / RUN_ID
    directory.mkdir()
    dump = b"test custom format archive"
    digest = hashlib.sha256(dump).hexdigest()
    manifest = {
        "schemaVersion": 1,
        "status": "complete",
        "runId": RUN_ID,
        "createdAt": "2026-09-28T23:34:39+00:00",
        "database": {
            "file": "postgres.dump",
            "format": "pg_dump-custom",
            "logicalSizeBytes": 200_000,
            "sizeBytes": len(dump),
            "sha256": expected_sha_override or digest,
        },
        "publication": {"generation": "generation-42"},
    }
    (directory / "postgres.dump").write_bytes(dump)
    (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return directory


class BackupValidationTests(unittest.TestCase):
    def test_validates_run_id_manifest_hash_dump_hash_and_generation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = write_backup(Path(temporary))
            result = MODULE._read_backup(directory, RUN_ID)

        self.assertEqual(result["runId"], RUN_ID)
        self.assertEqual(result["publicationGeneration"], "generation-42")
        self.assertEqual(len(result["manifestSha256"]), 64)
        self.assertEqual(len(result["dumpSha256"]), 64)
        self.assertEqual(result["logicalDatabaseSizeBytes"], 200_000)

    def test_rejects_a_different_requested_run_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = write_backup(Path(temporary))
            with self.assertRaisesRegex(MODULE.PreflightError, "requested run ID"):
                MODULE._read_backup(directory, "postgres-20260927T000000Z-00000000")

    def test_rejects_dump_digest_mismatch_and_extra_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = write_backup(Path(temporary), expected_sha_override="0" * 64)
            with self.assertRaisesRegex(MODULE.PreflightError, "digest"):
                MODULE._read_backup(directory, RUN_ID)
            (directory / "unexpected.txt").write_text("extra", encoding="utf-8")
            with self.assertRaisesRegex(MODULE.PreflightError, "inventory"):
                MODULE._read_backup(directory, RUN_ID)


class RuntimePreflightTests(unittest.TestCase):
    def _docker_responses(
        self,
        mountpoint: str,
        *,
        current_database_size: int = 100_000,
        available_kib: int = 2_000_000,
    ) -> dict[str, str]:
        container = {
            "State": {"Running": True},
            "Config": {"Image": MODULE.POSTGRES_IMAGE, "Env": ["POSTGRES_USER=vocadb"]},
            "Image": IMAGE_ID,
            "Mounts": [{
                "Type": "volume",
                "Name": VOLUME_NAME,
                "Destination": MODULE.POSTGRES_DATA_PATH,
            }],
        }
        responses = {
            "docker inspect": json.dumps([container]),
            "docker volume inspect": json.dumps([{"Name": VOLUME_NAME, "Mountpoint": mountpoint}]),
            "docker image inspect": json.dumps([{"Id": IMAGE_ID}]),
            "docker exec psql size": str(current_database_size),
            "docker exec psql generation": "generation-42",
            "docker exec du": f"4096\t{MODULE.POSTGRES_DATA_PATH}",
            "docker exec df": (
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
                f"/dev/root 3000000 1000000 {available_kib} 34% {MODULE.POSTGRES_DATA_PATH}"
            ),
        }
        return responses

    def _command_key(self, arguments: list[str]) -> str:
        if arguments[0] == "docker" and arguments[1] == "exec":
            if arguments[3] == "psql":
                return (
                    "docker exec psql generation"
                    if "recommendation_publication_generation" in arguments[-1]
                    else "docker exec psql size"
                )
            return f"docker exec {arguments[3]}"
        if arguments[0] == "docker" and arguments[1] in {"volume", "image"}:
            return " ".join(arguments[:3])
        return " ".join(arguments[:2])

    def _fake_command(self, responses: dict[str, str], calls: list[list[str]] | None = None):
        def fake_command(arguments: list[str]) -> str:
            if calls is not None:
                calls.append(arguments)
            prefix = self._command_key(arguments)
            if prefix not in responses:
                raise AssertionError(f"unexpected command: {arguments}")
            if arguments[0] == "docker":
                self.assertIn(arguments[1], {"inspect", "volume", "image", "exec"})
                self.assertNotIn("run", arguments)
                self.assertNotIn("create", arguments)
            return responses[prefix]

        return fake_command

    def test_reports_backup_and_live_sizes_without_mutating_docker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            backup_directory = write_backup(root)
            mountpoint = "/var/lib/docker/volumes/backend_postgres_data/_data"
            calls: list[list[str]] = []
            responses = self._docker_responses(mountpoint)
            with patch.object(MODULE, "run_command", side_effect=self._fake_command(responses, calls)):
                result = MODULE.preflight(backup_directory, expected_run_id=RUN_ID)

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["postgres"]["oldVolume"], VOLUME_NAME)
        self.assertEqual(result["postgres"]["currentPublicationGeneration"], "generation-42")
        self.assertTrue(result["postgres"]["oldVolumeRetained"])
        self.assertEqual(result["capacity"]["restoreBasisBytes"], 200_000)
        self.assertEqual(result["capacity"]["availableBytes"], 2_000_000 * 1024)
        self.assertEqual(result["postgres"]["oldVolumeAllocatedBytes"], 4096 * 1024)
        self.assertFalse(result["databaseChanged"])
        self.assertFalse(result["dockerResourcesChanged"])
        self.assertTrue(all(call[0] != "docker" or call[1] != "run" for call in calls))
        self.assertFalse(any("volume" in call and "create" in call for call in calls))

    def test_uses_a_conservative_reserve_for_the_larger_live_or_backup_database(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            backup_directory = write_backup(root)
            mountpoint = "/var/lib/docker/volumes/backend_postgres_data/_data"
            responses = self._docker_responses(
                mountpoint, current_database_size=300_000, available_kib=1_500_000
            )
            with patch.object(MODULE, "run_command", side_effect=self._fake_command(responses)):
                result = MODULE.preflight(backup_directory, expected_run_id=RUN_ID)

        self.assertEqual(result["capacity"]["restoreBasisBytes"], 300_000)
        self.assertEqual(result["capacity"]["requiredFreeBytes"], 2 * 300_000 + 1024**3)
        self.assertEqual(result["status"], "ready")

    def test_refuses_insufficient_space_before_any_resource_creation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            backup_directory = write_backup(root)
            mountpoint = "/var/lib/docker/volumes/backend_postgres_data/_data"
            responses = self._docker_responses(mountpoint, available_kib=1_000)
            with patch.object(MODULE, "run_command", side_effect=self._fake_command(responses)):
                result = MODULE.preflight(backup_directory, expected_run_id=RUN_ID)

        self.assertEqual(result["status"], "insufficient-capacity")
        self.assertFalse(result["capacity"]["sufficient"])

    def test_full_filesystem_with_zero_free_bytes_is_a_capacity_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            backup_directory = write_backup(Path(temporary))
            mountpoint = "/var/lib/docker/volumes/backend_postgres_data/_data"
            responses = self._docker_responses(
                mountpoint, available_kib=0
            )
            responses["docker exec df"] = (
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
                f"/dev/root 3000000 3000000 0 100% {MODULE.POSTGRES_DATA_PATH}"
            )
            with patch.object(MODULE, "run_command", side_effect=self._fake_command(responses)):
                result = MODULE.preflight(backup_directory, expected_run_id=RUN_ID)

        self.assertEqual(result["status"], "insufficient-capacity")
        self.assertEqual(result["capacity"]["availableBytes"], 0)

    def test_rejects_backup_from_a_different_publication_generation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            backup_directory = write_backup(Path(temporary))
            mountpoint = "/var/lib/docker/volumes/backend_postgres_data/_data"
            responses = self._docker_responses(mountpoint)
            responses["docker exec psql generation"] = "generation-older"
            with patch.object(MODULE, "run_command", side_effect=self._fake_command(responses)):
                with self.assertRaisesRegex(MODULE.PreflightError, "does not match the current"):
                    MODULE.preflight(backup_directory, expected_run_id=RUN_ID)


if __name__ == "__main__":
    unittest.main()
