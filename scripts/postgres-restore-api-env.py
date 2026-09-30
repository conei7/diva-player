#!/usr/bin/env python3
"""Create a private env file for a temporary API bound to an isolated database."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


API_ROLE = re.compile(r"diva_api_login_[a-z0-9][a-z0-9_]*\Z")


class ApiEnvironmentError(RuntimeError):
    """The live API configuration cannot safely seed a loopback smoke test."""


def _connection_user(value: str) -> str:
    match = re.search(r"(?:^|;)Username=([^;]+)", value, re.IGNORECASE)
    if match is None or not API_ROLE.fullmatch(match.group(1)):
        raise ApiEnvironmentError("live API connection string has no valid versioned login role")
    return match.group(1)


def build_environment(
    records: Any,
    *,
    password_file: Path,
    expected_role: str,
    database_port: int,
    api_port: int,
) -> dict[str, str]:
    if not API_ROLE.fullmatch(expected_role):
        raise ApiEnvironmentError("API login role name is invalid")
    if not 1024 <= database_port <= 65535 or not 1024 <= api_port <= 65535 or database_port == api_port:
        raise ApiEnvironmentError("isolated API ports are invalid")
    if not isinstance(records, list) or len(records) != 2 or any(not isinstance(item, dict) for item in records):
        raise ApiEnvironmentError("Docker must return both live API slot inspections")

    environments: list[dict[str, str]] = []
    image_ids: set[str] = set()
    for record in records:
        config = record.get("Config")
        if not isinstance(config, dict):
            raise ApiEnvironmentError("live API container configuration is unavailable")
        env_items = config.get("Env")
        if not isinstance(env_items, list) or not all(isinstance(item, str) and "=" in item for item in env_items):
            raise ApiEnvironmentError("live API environment is invalid")
        environment = dict(item.split("=", 1) for item in env_items)
        user = _connection_user(environment.get("ConnectionStrings__Postgres", ""))
        if user != expected_role:
            raise ApiEnvironmentError("live API login role changed after restore staging")
        if not environment.get("Recommender__PagesProxyKey"):
            raise ApiEnvironmentError("live API configuration has no pages proxy key")
        if not environment.get("Recommender__QdrantEndpoint") or not environment.get("Recommender__QdrantRestEndpoint"):
            raise ApiEnvironmentError("live API configuration has no Qdrant endpoints")
        for value in environment.values():
            if "\n" in value or "\r" in value:
                raise ApiEnvironmentError("live API environment contains a multiline value")
        image_id = record.get("Image")
        if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
            raise ApiEnvironmentError("live API image ID is invalid")
        image_ids.add(image_id)
        environments.append(environment)
    if len(image_ids) != 1:
        raise ApiEnvironmentError("live API slots do not use the same image")

    try:
        password = password_file.read_text(encoding="utf-8").rstrip("\r\n")
    except (OSError, UnicodeDecodeError) as error:
        raise ApiEnvironmentError("API password file is unavailable") from error
    if not password or "\n" in password or "\r" in password:
        raise ApiEnvironmentError("API password file is empty or multiline")

    environment = environments[0]
    try:
        aggregate = int(environment.get("Recommender__Bulkhead__AggregatePermitLimit", "6"))
        reserve = int(environment.get("Recommender__Bulkhead__DatabaseConnectionReserve", "4"))
    except ValueError as error:
        raise ApiEnvironmentError("live API database connection budget is invalid") from error
    if not 1 <= aggregate <= 64 or not 4 <= reserve <= 64:
        raise ApiEnvironmentError("live API database connection budget is out of range")
    pool_size = aggregate + reserve

    def quote_connection_value(value: str) -> str:
        return '"' + value.replace('"', '""') + '"' if any(char in value for char in ';"') else value

    environment.update({
        "ConnectionStrings__Postgres": (
            f"Host=127.0.0.1;Port={database_port};Database=vocadb_recommender;"
            f"Username={expected_role};Password={quote_connection_value(password)};"
            f"Maximum Pool Size={pool_size};Timeout=5;Application Name=diva-postgres-restore-check"
        ),
        "Recommender__QdrantEndpoint": "http://127.0.0.1:6334",
        "Recommender__QdrantRestEndpoint": "http://127.0.0.1:6333",
        "ASPNETCORE_URLS": f"http://127.0.0.1:{api_port}",
        "ASPNETCORE_ENVIRONMENT": "Production",
    })
    if not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) for name in environment):
        raise ApiEnvironmentError("API environment contains an invalid variable name")
    return environment


def _write_new_env_file(path: Path, environment: dict[str, str]) -> None:
    if path.is_symlink() or path.exists():
        raise ApiEnvironmentError("API environment output must be a new file")
    parent = path.parent
    if not parent.is_dir() or parent.is_symlink():
        raise ApiEnvironmentError("API environment output directory must be a real directory")
    if os.name != "nt":
        metadata = parent.stat()
        if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
            raise ApiEnvironmentError("API environment directory must be owner-only")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            for name, value in sorted(environment.items()):
                if "\n" in value or "\r" in value:
                    raise ApiEnvironmentError("API environment values must be single-line")
                stream.write(name + "=" + value + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise ApiEnvironmentError("could not write private API environment file") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--password-file", required=True, type=Path)
    parser.add_argument("--api-login-role", required=True)
    parser.add_argument("--database-port", required=True, type=int)
    parser.add_argument("--api-port", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        records = json.load(sys.stdin)
        environment = build_environment(
            records,
            password_file=args.password_file,
            expected_role=args.api_login_role,
            database_port=args.database_port,
            api_port=args.api_port,
        )
        _write_new_env_file(args.output, environment)
    except (ApiEnvironmentError, OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"status": "environment-written", "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
