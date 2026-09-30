#!/usr/bin/env python3
"""Static safety contract for reapplying ACLs omitted by PostgreSQL dumps."""

from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ACL_REPAIR = ROOT / "scripts" / "postgres-restore-runtime-acls.sql"
ROLE_PROVISIONER = ROOT / "scripts" / "provision-sbc-db-roles.sh"
ROLE_CONTRACT = ROOT / "scripts" / "test-database-role-contract.sql"
BASE_ROLE_MIGRATION = ROOT / "backend" / "database" / "migrations" / "0018_runtime_database_roles.sql"
HISTORY_ACL_MIGRATION = ROOT / "backend" / "database" / "migrations" / "0025_reconcile_runtime_role_migration_history_acl.sql"


class PostgresRestoreAclTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.acl = ACL_REPAIR.read_text(encoding="utf-8")
        cls.provisioner = ROLE_PROVISIONER.read_text(encoding="utf-8")
        cls.role_contract = ROLE_CONTRACT.read_text(encoding="utf-8")
        cls.base_roles = BASE_ROLE_MIGRATION.read_text(encoding="utf-8")
        cls.history_acl = HISTORY_ACL_MIGRATION.read_text(encoding="utf-8")

    def test_repair_restores_later_least_privilege_grants(self) -> None:
        for statement in (
            "GRANT SELECT ON TABLE public.song_album_links TO diva_api_runtime",
            "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.song_album_links",
            "REVOKE ALL ON FUNCTION public.sync_song_album_links_from_raw_json_v1()",
            "REVOKE ALL ON PROCEDURE public.backfill_song_album_links_batch_v1(INTEGER, INTEGER)",
            "GRANT EXECUTE ON FUNCTION public.reserve_youtube_quota(text)",
        ):
            self.assertIn(statement, self.acl)
        self.assertIn("test-database-role-contract.sql", self.acl)
        self.assertIn("migration 0018 runtime privilege roles are missing", self.acl)

    def test_repair_has_no_data_or_migration_history_mutations(self) -> None:
        self.assertIn("No migration-history", self.acl)
        self.assertNotRegex(self.acl, r"(?im)^\s*(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|DROP\s+(?:TABLE|ROLE|SCHEMA))\b")
        self.assertNotIn("schema_migrations", self.acl)
        self.assertNotIn("CREATE ROLE", self.acl)

    def test_existing_migration_and_provisioning_contracts_remain_the_authority(self) -> None:
        self.assertIn("CREATE ROLE diva_api_runtime", self.base_roles)
        self.assertIn("CREATE ROLE diva_pipeline_runtime", self.base_roles)
        self.assertIn("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public", self.base_roles)
        self.assertIn("REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM %I", self.history_acl)
        self.assertIn("DIVA_DB_API_LOGIN_ROLE is required", self.provisioner)
        self.assertIn("DIVA_DB_PIPELINE_LOGIN_ROLE is required", self.provisioner)
        self.assertIn("least-privilege database runtime role contract", self.role_contract)


if __name__ == "__main__":
    unittest.main()
