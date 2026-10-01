#!/usr/bin/env python3
"""Static safety contract for isolated PostgreSQL restore shell entrypoints."""

from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESTORE = ROOT / "scripts" / "restore-sbc-postgres-isolated.sh"
SMOKE = ROOT / "scripts" / "smoke-sbc-postgres-isolated-api.sh"
RESOURCE_MONITOR = ROOT / "scripts" / "postgres-restore-resource-monitor.py"


class IsolatedRestoreControllerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.restore = RESTORE.read_text(encoding="utf-8")
        cls.smoke = SMOKE.read_text(encoding="utf-8")
        cls.resource_monitor = RESOURCE_MONITOR.read_text(encoding="utf-8")

    def test_restore_is_volume_separated_network_isolated_and_pinned(self) -> None:
        self.assertIn("diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1", self.restore)
        self.assertIn('candidate_volume="backend_postgres_restore_${run_suffix}"', self.restore)
        self.assertIn('candidate_container="vocadb_postgres_restore_${run_suffix}"', self.restore)
        self.assertIn("--network none", self.restore)
        self.assertIn("--tmpfs /docker-entrypoint-initdb.d", self.restore)
        self.assertIn("--mount \"type=volume,src=$candidate_volume", self.restore)
        self.assertIn("pg_restore --exit-on-error --no-owner --no-privileges", self.restore)
        self.assertIn("pg_restore --list", self.restore)
        self.assertIn("write_state 'candidate-volume-creating'", self.restore)
        self.assertIn('"$state_directory/state.json"', self.restore)
        self.assertIn("postgres-restore-resource-monitor.py", self.restore)
        self.assertIn('"resourceUsageFile": "resource-usage.json"', self.restore)
        self.assertIn("--interval-seconds 10", self.restore)
        self.assertIn("peakFilesystemUsedBytes", self.resource_monitor)
        self.assertLess(
            self.restore.index('[[ -d "$backup_directory" && ! -L "$backup_directory"'),
            self.restore.index('backup_directory="$(realpath -e -- "$backup_directory")"'),
        )

    def test_restore_rebuilds_existing_migration_role_and_acl_contracts(self) -> None:
        for required in (
            "/restore-migrations/0018_runtime_database_roles.sql",
            "sh /tmp/restore-migrate.sh",
            "/restore-migrations/0025_reconcile_runtime_role_migration_history_acl.sql",
            "/restore-scripts/postgres-restore-runtime-acls.sql",
            "provision-sbc-db-roles.sh\" create",
        ):
            self.assertIn(required, self.restore)

    def test_only_the_candidate_postgres_container_is_restarted_for_api_smoke(self) -> None:
        self.assertIn("postgres -c listen_addresses=127.0.0.1", self.restore)
        self.assertIn("--network host", self.restore)
        self.assertIn('docker stop "$candidate_container"', self.restore)
        self.assertIn('docker rm "$candidate_container"', self.restore)
        self.assertNotIn("docker compose down", self.restore)
        self.assertNotIn("docker volume rm", self.restore)
        self.assertNotIn("--clean", self.restore)
        self.assertNotIn("--create", self.restore)

    def test_api_smoke_analyzes_bound_candidate_before_warmup(self) -> None:
        self.assertIn('vacuumdb --analyze-only --jobs=2', self.smoke)
        self.assertLess(self.smoke.index("vacuumdb --analyze-only"),self.smoke.index("candidate_api_started=true"))

    def test_api_smoke_is_loopback_bound_and_removes_only_its_temporary_container(self) -> None:
        self.assertIn("http://127.0.0.1:$api_port/api/ready", self.smoke)
        self.assertIn('"http://127.0.0.1:$api_port"', self.smoke)
        self.assertIn('docker rm -f "$candidate_api_container"', self.smoke)
        self.assertIn('docker volume inspect "$old_volume"', self.smoke)
        self.assertIn("--assert-candidate-only", self.smoke)
        self.assertIn('ss -H -lnt "sport = :$api_port"', self.smoke)
        self.assertIn('"127.0.0.1:$api_port"', self.smoke)
        self.assertIn("--database-port \"$database_port\"", self.smoke)
        self.assertIn("--resource-usage-json \"$resource_usage_json\"", self.smoke)
        self.assertNotIn("docker compose down", self.smoke)
        self.assertNotIn("docker volume rm", self.smoke)


if __name__ == "__main__":
    unittest.main()
