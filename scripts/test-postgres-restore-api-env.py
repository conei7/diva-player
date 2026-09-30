#!/usr/bin/env python3
"""Tests for the private temporary API environment builder."""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("postgres-restore-api-env.py")
SPEC = importlib.util.spec_from_file_location("postgres_restore_api_env", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


ROLE = "diva_api_login_restore_2026"
IMAGE_ID = f"sha256:{'a' * 64}"


def records(*, second_role: str = ROLE, second_image: str = IMAGE_ID) -> list[dict]:
    first = {
        "Image": IMAGE_ID,
        "Config": {"Env": [
            "ConnectionStrings__Postgres=Host=postgres;Port=5432;Database=vocadb_recommender;Username=" + ROLE + ";Password=old-secret",
            "Recommender__PagesProxyKey=proxy-secret",
            "Recommender__QdrantEndpoint=http://qdrant:6334",
            "Recommender__QdrantRestEndpoint=http://qdrant:6333",
            "ASPNETCORE_URLS=http://+:5000",
        ]},
    }
    second = {
        "Image": second_image,
        "Config": {"Env": [
            "ConnectionStrings__Postgres=Host=postgres;Port=5432;Database=vocadb_recommender;Username=" + second_role + ";Password=old-secret",
            "Recommender__PagesProxyKey=proxy-secret",
            "Recommender__QdrantEndpoint=http://qdrant:6334",
            "Recommender__QdrantRestEndpoint=http://qdrant:6333",
            "ASPNETCORE_URLS=http://+:5000",
        ]},
    }
    return [first, second]


class RestoreApiEnvironmentTests(unittest.TestCase):
    def test_repoints_only_the_temporary_api_to_candidate_postgres_and_loopback_qdrant(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            password_file = Path(temporary) / "api-password"
            password_file.write_text('p;ass"word', encoding="utf-8")
            environment = MODULE.build_environment(
                records(), password_file=password_file, expected_role=ROLE,
                database_port=25432, api_port=25000,
            )

        connection = environment["ConnectionStrings__Postgres"]
        self.assertIn("Host=127.0.0.1;Port=25432", connection)
        self.assertIn('Password="p;ass""word"', connection)
        self.assertNotIn("old-secret", connection)
        self.assertEqual(environment["Recommender__QdrantEndpoint"], "http://127.0.0.1:6334")
        self.assertEqual(environment["Recommender__QdrantRestEndpoint"], "http://127.0.0.1:6333")
        self.assertEqual(environment["ASPNETCORE_URLS"], "http://127.0.0.1:25000")

    def test_rejects_role_image_or_port_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            password_file = Path(temporary) / "api-password"
            password_file.write_text("password", encoding="utf-8")
            with self.assertRaisesRegex(MODULE.ApiEnvironmentError, "login role"):
                MODULE.build_environment(
                    records(second_role="diva_api_login_old"), password_file=password_file,
                    expected_role=ROLE, database_port=25432, api_port=25000,
                )
            with self.assertRaisesRegex(MODULE.ApiEnvironmentError, "same image"):
                MODULE.build_environment(
                    records(second_image=f"sha256:{'b' * 64}"), password_file=password_file,
                    expected_role=ROLE, database_port=25432, api_port=25000,
                )
            with self.assertRaisesRegex(MODULE.ApiEnvironmentError, "ports"):
                MODULE.build_environment(
                    records(), password_file=password_file, expected_role=ROLE,
                    database_port=25432, api_port=25432,
                )

    def test_private_output_is_new_and_keeps_secret_values_out_of_tool_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            password_file = root / "api-password"
            password_file.write_text("private-password", encoding="utf-8")
            environment = MODULE.build_environment(
                records(), password_file=password_file, expected_role=ROLE,
                database_port=25432, api_port=25000,
            )
            output = root / "api.env"
            MODULE._write_new_env_file(output, environment)
            saved = output.read_text(encoding="utf-8")
            with self.assertRaises(MODULE.ApiEnvironmentError):
                MODULE._write_new_env_file(output, environment)

        self.assertIn("private-password", saved)
        if os.name != "nt":
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
