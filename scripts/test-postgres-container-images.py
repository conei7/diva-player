#!/usr/bin/env python3
"""Static fail-closed contracts for the two PostgreSQL deployment images."""

from __future__ import annotations

import os
import re
import stat
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATABASE = ROOT / "backend" / "database"
POSTGRES_DOCKERFILE = DATABASE / "Dockerfile.pgvector"
MIGRATE_DOCKERFILE = DATABASE / "Dockerfile.migrate"
DOCKERIGNORE = DATABASE / ".dockerignore"
SCHEMA = DATABASE / "schema.sql"
WORKFLOW = ROOT / ".github" / "workflows" / "deploy.yml"
GITATTRIBUTES = ROOT / ".gitattributes"

POSTGRES_BASE = (
    "postgres:16-alpine3.23@sha256:"
    "421b84e07a72bb8f3715f20501a1fdbe1219aad1fa4af7786a49d9a3f2480296"
)
MIGRATE_BASE = (
    "alpine:3.23.3@sha256:"
    "25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659"
)
OLD_VULNERABLE_DIGESTS = (
    "ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b",
    "cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class PostgresContainerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.postgres = read(POSTGRES_DOCKERFILE)
        cls.migrate = read(MIGRATE_DOCKERFILE)
        cls.workflow = read(WORKFLOW)

    def test_build_context_is_an_exact_non_secret_allowlist(self) -> None:
        self.assertEqual(
            read(DOCKERIGNORE).splitlines(),
            ["*", "!Dockerfile.pgvector", "!Dockerfile.migrate", "!schema.sql"],
        )
        self.assertNotIn("!migrate.sh", read(DOCKERIGNORE))
        self.assertNotIn("!migrations", read(DOCKERIGNORE))
        self.assertIn("backend/database/schema.sql text eol=lf", read(GITATTRIBUTES))
        self.assertIn("backend/database/Dockerfile.* text eol=lf", read(GITATTRIBUTES))
        self.assertIn("backend/database/.dockerignore text eol=lf", read(GITATTRIBUTES))
        schema_stat = os.lstat(SCHEMA)
        self.assertTrue(stat.S_ISREG(schema_stat.st_mode))
        self.assertFalse(SCHEMA.is_symlink())

    def test_postgres_image_is_pinned_and_has_no_live_upgrade(self) -> None:
        self.assertEqual(self.postgres.count(f"FROM {POSTGRES_BASE}"), 2)
        self.assertNotRegex(self.postgres, r"(?m)^\s*(?:RUN\s+)?apk\s+upgrade\b")
        self.assertNotRegex(self.postgres, r"(?m)^\s*(?:RUN\s+)?apk\s+update\b")
        self.assertNotIn("latest", self.postgres.lower())
        for package in (
            "build-base=0.5-r3",
            "postgresql16-dev=16.15-r0",
            "libcrypto3=3.5.8-r0",
            "libssl3=3.5.8-r0",
            "libuuid=2.41.6-r0",
            "su-exec=0.3-r0",
        ):
            self.assertIn(package, self.postgres)
        self.assertIn("x86_64) vector_libc=libc.musl-x86_64.so.1", self.postgres)
        self.assertIn("aarch64) vector_libc=libc.musl-aarch64.so.1", self.postgres)
        self.assertIn("*) echo \"unsupported architecture:", self.postgres)

    def test_pgvector_download_and_entrypoint_patch_are_fail_closed(self) -> None:
        self.assertIn(
            "PGVECTOR_COMMIT=8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c",
            self.postgres,
        )
        self.assertIn(
            "PGVECTOR_ARCHIVE_SHA256=d076a3098010905fd60256649327809651f6288327db6413f0938305f62ea299",
            self.postgres,
        )
        self.assertIn("sha256sum -c -", self.postgres)
        self.assertIn(
            "= 9c440299ae04a0a79d55b8bf03307036d890a40979d2fb698073c9050d4b20a5",
            self.postgres,
        )
        for path in (
            "/usr/local/bin/docker-entrypoint.sh",
            "/usr/local/bin/gosu",
            "/sbin/su-exec",
        ):
            self.assertIn(f"test -f {path}", self.postgres)
            self.assertIn(f"test ! -L {path}", self.postgres)
        self.assertIn("test -L /usr/local/bin/su-exec", self.postgres)
        self.assertIn(
            '[ "$(readlink /usr/local/bin/su-exec)" = gosu ]',
            self.postgres,
        )
        self.assertIn(
            '[ "$(stat -c \'%u:%g\' /usr/local/bin/su-exec)" = 0:0 ]',
            self.postgres,
        )
        self.assertIn("rm /usr/local/bin/su-exec", self.postgres)
        self.assertIn("test ! -e /usr/local/bin/su-exec", self.postgres)
        self.assertIn("test ! -L /usr/local/bin/su-exec", self.postgres)
        self.assertIn("test ! -L /usr/local/bin/gosu", self.postgres)
        self.assertLess(
            self.postgres.index("test -L /usr/local/bin/su-exec"),
            self.postgres.index("rm /usr/local/bin/su-exec"),
        )
        self.assertLess(
            self.postgres.index("rm /usr/local/bin/su-exec"),
            self.postgres.index('[ "$(command -v su-exec)" = /sbin/su-exec ]'),
        )
        self.assertIn("exec su-exec postgres", self.postgres)
        self.assertIn("! command -v gosu", self.postgres)
        self.assertIn("\\( -user 70 -o -group 70 \\)", self.postgres)
        self.assertIn('legacy_owner="$(find ', self.postgres)
        self.assertIn('[ -z "$legacy_owner" ]', self.postgres)
        self.assertIn("[ \"$(id -u postgres):$(id -g postgres)\" = 999:999 ]", self.postgres)

    def test_schema_and_source_identity_are_baked_and_attested(self) -> None:
        self.assertIn(
            "COPY --chown=0:0 schema.sql /docker-entrypoint-initdb.d/01_schema.sql",
            self.postgres,
        )
        self.assertIn("chmod 0444 /docker-entrypoint-initdb.d/01_schema.sql", self.postgres)
        for argument in (
            "DIVA_POSTGRES_DOCKERFILE_SHA256",
            "DIVA_POSTGRES_SCHEMA_SHA256",
            "DIVA_POSTGRES_SOURCE_BUNDLE_SHA256",
        ):
            self.assertIn(f"ARG {argument}", self.postgres)
            self.assertRegex(
                self.postgres,
                rf'printf \'%s\\n\' "\${argument}"\s+\\\n\s+\| grep -Eq \'\^\[0-9a-f\]\{{64\}}\$\'',
            )
        self.assertIn("source-bundle.attestation", self.postgres)
        source_fields = (
            "dockerfile.sha256=",
            "pgvector.archive.sha256=",
            "pgvector.commit=",
            "schema.sha256=",
        )
        postgres_positions = [self.postgres.index(field) for field in source_fields]
        workflow_positions = [self.workflow.index(field) for field in source_fields]
        self.assertEqual(postgres_positions, sorted(postgres_positions))
        self.assertEqual(workflow_positions, sorted(workflow_positions))
        for label in (
            "com.diva.postgres.dockerfile-sha256",
            "com.diva.postgres.schema-sha256",
            "com.diva.postgres.source-bundle-sha256",
            "com.diva.postgres.build-timestamp",
            "com.diva.postgres.runtime-contract",
        ):
            self.assertIn(label, self.postgres)

    def test_migrate_image_is_only_a_pinned_rootless_psql_client(self) -> None:
        self.assertTrue(self.migrate.startswith(f"FROM {MIGRATE_BASE}\n"))
        self.assertNotIn("COPY ", self.migrate)
        self.assertNotIn("migrate.sh", self.migrate)
        self.assertNotIn("/migrations", self.migrate)
        self.assertNotRegex(self.migrate, r"(?m)^\s*(?:RUN\s+)?apk\s+(?:update|upgrade)\b")
        for package in (
            "libcrypto3=3.5.8-r0",
            "libssl3=3.5.8-r0",
            "musl=1.2.5-r23",
            "musl-utils=1.2.5-r23",
            "postgresql16-client=16.15-r0",
            "zlib=1.3.2-r0",
        ):
            self.assertIn(package, self.migrate)
        self.assertIn("case \"$(apk --print-arch)\" in x86_64|aarch64)", self.migrate)
        self.assertIn("ENV HOME=/tmp", self.migrate)
        self.assertIn("USER 65534:65534", self.migrate)
        self.assertIn('ENTRYPOINT ["psql"]', self.migrate)
        self.assertIn("rootless-readonly-psql-client-v1", self.migrate)
        self.assertIn("DIVA_POSTGRES_MIGRATE_DOCKERFILE_SHA256", self.migrate)
        self.assertIn("DIVA_POSTGRES_MIGRATE_BUILD_TIMESTAMP", self.migrate)

    def test_workflow_builds_runs_and_scans_the_exact_local_images(self) -> None:
        for digest in OLD_VULNERABLE_DIGESTS:
            self.assertNotIn(digest, self.workflow)
        self.assertNotIn("PGVECTOR_RUNTIME_IMAGE", self.workflow)
        self.assertNotIn("POSTGRES_MIGRATE_IMAGE", self.workflow)
        self.assertNotRegex(self.workflow, r"(?m)^    services:\s*$")
        for dockerfile, tag in (
            ("backend/database/Dockerfile.pgvector", "diva-player-ci-postgres:current"),
            (
                "backend/database/Dockerfile.migrate",
                "diva-player-ci-postgres-migrate:current",
            ),
        ):
            self.assertIn(f"--file {dockerfile}", self.workflow)
            self.assertIn(f"--tag {tag} backend/database", self.workflow)
        self.assertIn('"$postgres_image_id")', self.workflow)
        self.assertEqual(
            self.workflow.count(
                '--entrypoint /bin/sh "$migrate_image_id" /migrations/migrate.sh'
            ),
            1,
        )
        self.assertIn("type=bind,src=$GITHUB_WORKSPACE/backend/database/migrate.sh", self.workflow)
        self.assertIn("type=bind,src=$GITHUB_WORKSPACE/backend/database/migrations", self.workflow)
        self.assertIn("--read-only --cap-drop ALL", self.workflow)
        self.assertIn("--security-opt no-new-privileges", self.workflow)
        stable_gate = self.workflow.index("postgres_endpoint_stable=false")
        migration = self.workflow.index(
            'if ! docker run --rm --network host --read-only --cap-drop ALL'
        )
        self.assertLess(stable_gate, migration)
        self.assertIn("SELECT pg_postmaster_start_time()::text", self.workflow)
        self.assertIn("--env PGCONNECT_TIMEOUT=5", self.workflow)
        self.assertIn(
            'docker exec "$postgres_container" cat /proc/1/comm', self.workflow
        )
        self.assertIn('[[ "$postgres_main_process" == postgres ]]', self.workflow)
        self.assertIn(
            "SELECT COUNT(*)::text FROM sync_state WHERE key IN "
            "('last_daily_sync', 'dump_imported')",
            self.workflow,
        )
        self.assertIn('[[ "$postgres_stable_samples" -ge 2', self.workflow)
        self.assertRegex(
            self.workflow,
            r'(?s)if ! docker run --rm --network host --read-only --cap-drop ALL '
            r'.*?--entrypoint /bin/sh "\$migrate_image_id" /migrations/migrate\.sh; then'
            r'.*?docker logs "\$postgres_container" \|\| true.*?exit 1',
        )
        self.assertGreaterEqual(
            self.workflow.count("stat -c '%u:%g' /var/lib/postgresql/data)\" = 999:999"),
            2,
        )
        self.assertIn("CREATE INDEX IF NOT EXISTS diva_ci_vector_smoke_hnsw", self.workflow)
        self.assertIn("embedding <-> '[1,0,0]'", self.workflow)
        self.assertGreaterEqual(
            self.workflow.count("Index Scan using diva_ci_vector_smoke_hnsw"), 2
        )
        self.assertIn('docker restart --time 30 "$postgres_container"', self.workflow)
        self.assertGreaterEqual(
            self.workflow.count(
                "docker container inspect --format '{{.Image}}' \"$postgres_container\""
            ),
            2,
        )
        self.assertIn('"pgvector-runtime|diva-player-ci-postgres:current|alpine|', self.workflow)
        self.assertIn(
            '"postgres-migrate-helper|diva-player-ci-postgres-migrate:current|alpine|',
            self.workflow,
        )
        self.assertNotIn("pull_first", self.workflow)
        self.assertNotRegex(self.workflow, r"docker pull \"\$source_reference\"")
        self.assertIn("source reference moved while its exact image ID was scanned", self.workflow)
        self.assertIn("source reference moved before the receipt gate completed", self.workflow)

    def test_postgres_inventory_bounds_are_exactly_calibrated(self) -> None:
        expected = {
            "pgvector-runtime": 46,
            "postgres-migrate-helper": 24,
        }
        for service, package_count in expected.items():
            self.assertRegex(
                self.workflow,
                rf'"{service}\|[^|]+\|alpine\|os-pkgs:alpine:'
                rf'{package_count}:{package_count}:1"',
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
