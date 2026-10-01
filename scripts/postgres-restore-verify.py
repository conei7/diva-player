#!/usr/bin/env python3
"""Read-only validation for an isolated PostgreSQL restore and API smoke test."""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


DATABASE_NAME = "vocadb_recommender"
POSTGRES_DATA_PATH = "/var/lib/postgresql/data"
API_PATHS = {
    "ready": "/api/ready",
    "health": "/api/health",
}
MAJOR_TABLES = (
    "songs",
    "song_artists",
    "song_tags",
    "pvs",
    "sync_state",
    "view_history",
    "song_discovery_quality",
    "song_audio_analysis",
    "schema_migrations",
)
TABLES_TO_COUNT = (
    "songs",
    "artists",
    "song_artists",
    "tags",
    "song_tags",
    "pvs",
    "song_album_links",
    "view_history",
    "sync_state",
    "song_discovery_quality",
    "song_lyrics",
    "song_audio_analysis",
    "song_audio_instruments",
    "song_features",
    "markov_transitions",
    "schema_migrations",
)
LOGIN_ROLE = re.compile(r"diva_(?:api|pipeline)_login_[a-z0-9][a-z0-9_]*\Z")
MIGRATION_ID = re.compile(r"[0-9]{4}_[a-z0-9][a-z0-9_]*\.sql\Z")
CONTAINER_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\Z")
VOLUME_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\Z")
BACKUP_RUN_ID = re.compile(r"postgres-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\Z")


class VerificationError(RuntimeError):
    """The isolated database or API did not meet a required check."""


def run_command(arguments: Sequence[str], *, timeout: int = 300) -> str:
    try:
        result = subprocess.run(
            list(arguments),
            check=False,
            timeout=timeout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise VerificationError(f"command could not complete: {arguments[0]}") from error
    if result.returncode != 0:
        detail = result.stderr.strip()[-600:]
        raise VerificationError(
            f"command failed ({result.returncode}): {arguments[0]}"
            + (f": {detail}" if detail else "")
        )
    return result.stdout.strip()


def _identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _query(container: str, admin_user: str, database: str, sql: str) -> str:
    return run_command([
        "docker", "exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1",
        "-U", admin_user, "-d", database, "-Atq", "-c", sql,
    ])


def _query_json(container: str, admin_user: str, database: str, sql: str, label: str) -> Any:
    output = _query(container, admin_user, database, sql)
    try:
        return json.loads(output)
    except json.JSONDecodeError as error:
        raise VerificationError(f"PostgreSQL returned invalid JSON for {label}") from error


def _positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise VerificationError(f"{label} must be a positive integer")
    return value


def _measure_container(container: str, command: str) -> int:
    output = run_command(["docker", "exec", container, command, "-sk", POSTGRES_DATA_PATH])
    try:
        return _positive_int(int(output.split()[0]) * 1024, f"candidate volume {command} size")
    except (IndexError, ValueError) as error:
        raise VerificationError(f"could not measure candidate PostgreSQL volume with {command}") from error


def _filesystem_usage(container: str) -> dict[str, int]:
    output = run_command(["docker", "exec", container, "df", "-Pk", POSTGRES_DATA_PATH])
    rows = [line.split() for line in output.splitlines() if line.strip()]
    if len(rows) < 2 or len(rows[-1]) < 6:
        raise VerificationError("could not read candidate PostgreSQL filesystem usage")
    try:
        total_kib, used_kib, available_kib = (int(rows[-1][index]) for index in (1, 2, 3))
    except ValueError as error:
        raise VerificationError("candidate PostgreSQL filesystem usage is invalid") from error
    if total_kib <= 0 or used_kib < 0 or available_kib < 0 or used_kib + available_kib > total_kib:
        raise VerificationError("candidate PostgreSQL filesystem usage is inconsistent")
    return {
        "totalBytes": total_kib * 1024,
        "usedBytes": used_kib * 1024,
        "availableBytes": available_kib * 1024,
    }


def _inspect_candidate(
    container: str,
    volume: str,
    preflight: dict[str, Any],
    expected_port: int,
    *, allow_stopped: bool = False,
) -> dict[str, Any]:
    if not CONTAINER_NAME.fullmatch(container):
        raise VerificationError("candidate PostgreSQL container name is invalid")
    if not VOLUME_NAME.fullmatch(volume):
        raise VerificationError("candidate PostgreSQL volume name is invalid")
    postgres = preflight.get("postgres")
    backup = preflight.get("backup")
    capacity = preflight.get("capacity")
    if preflight.get("status") != "ready" or not isinstance(capacity, dict) or capacity.get("sufficient") is not True:
        raise VerificationError("preflight did not pass")
    if not isinstance(postgres, dict):
        raise VerificationError("preflight report has no PostgreSQL identity")
    if not isinstance(backup, dict) or not isinstance(backup.get("runId"), str):
        raise VerificationError("preflight report has no backup run ID")
    old_volume = postgres.get("oldVolume")
    if not isinstance(old_volume, str) or not VOLUME_NAME.fullmatch(old_volume):
        raise VerificationError("preflight production volume name is invalid")
    if old_volume == volume:
        raise VerificationError("candidate PostgreSQL volume is the production volume")
    run_id = backup["runId"]
    if not BACKUP_RUN_ID.fullmatch(run_id):
        raise VerificationError("preflight backup run ID is invalid")
    suffix = run_id.removeprefix("postgres-").replace("T", "_").replace("Z", "").replace("-", "_")
    expected_volume = f"backend_postgres_restore_{suffix}"
    expected_container = f"vocadb_postgres_restore_{suffix}"
    if volume != expected_volume or container != expected_container:
        raise VerificationError("candidate PostgreSQL resource names do not match the backup run ID")
    if isinstance(expected_port, bool) or not isinstance(expected_port, int) or not 1024 <= expected_port <= 65535:
        raise VerificationError("candidate PostgreSQL loopback port is invalid")

    raw = run_command(["docker", "inspect", container])
    try:
        inspected = json.loads(raw)
    except json.JSONDecodeError as error:
        raise VerificationError("Docker returned invalid candidate container inspection data") from error
    if not isinstance(inspected, list) or len(inspected) != 1 or not isinstance(inspected[0], dict):
        raise VerificationError("Docker did not return exactly one candidate PostgreSQL container")
    record = inspected[0]
    state = record.get("State")
    config = record.get("Config")
    if not isinstance(state, dict) or (state.get("Running") is not True and not allow_stopped):
        raise VerificationError("candidate PostgreSQL container is not running")
    if not isinstance(config, dict) or config.get("Image") != postgres.get("image"):
        raise VerificationError("candidate PostgreSQL container uses a different image tag")
    if record.get("Image") != postgres.get("imageId"):
        raise VerificationError("candidate PostgreSQL container uses a different image ID")
    labels = config.get("Labels")
    if not isinstance(labels, dict) or any(labels.get(name) != value for name, value in {
        "com.diva.postgres-restore.run-id": run_id,
        "com.diva.postgres-restore.manifest-sha256": backup.get("manifestSha256"),
        "com.diva.postgres-restore.dump-sha256": backup.get("dumpSha256"),
        "com.diva.postgres-restore.purpose": "isolated-verification",
    }.items()):
        raise VerificationError("candidate PostgreSQL container labels do not match the backup")
    host_config = record.get("HostConfig")
    if not isinstance(host_config, dict) or host_config.get("NetworkMode") != "host":
        raise VerificationError("candidate PostgreSQL container is not on the isolated host network")
    command = config.get("Cmd")
    expected_command = [
        "postgres", "-c", "listen_addresses=127.0.0.1", "-c", f"port={expected_port}"
    ]
    if command != expected_command:
        raise VerificationError("candidate PostgreSQL command is not restricted to the expected loopback port")
    mounts = record.get("Mounts")
    matches = [
        mount for mount in mounts
        if isinstance(mount, dict)
        and mount.get("Type") == "volume"
        and mount.get("Name") == volume
        and mount.get("Destination") == POSTGRES_DATA_PATH
    ] if isinstance(mounts, list) else []
    if len(matches) != 1:
        raise VerificationError("candidate PostgreSQL container is not mounted to the expected new volume")
    volume_raw = run_command(["docker", "volume", "inspect", volume])
    try:
        volume_records = json.loads(volume_raw)
    except json.JSONDecodeError as error:
        raise VerificationError("Docker returned invalid candidate volume inspection data") from error
    if not isinstance(volume_records, list) or len(volume_records) != 1 or not isinstance(volume_records[0], dict):
        raise VerificationError("Docker did not return exactly one candidate PostgreSQL volume")
    volume_record = volume_records[0]
    volume_labels = volume_record.get("Labels")
    if volume_record.get("Name") != volume or not isinstance(volume_labels, dict) or any(
        volume_labels.get(name) != value for name, value in {
            "com.diva.postgres-restore.run-id": run_id,
            "com.diva.postgres-restore.manifest-sha256": backup.get("manifestSha256"),
            "com.diva.postgres-restore.dump-sha256": backup.get("dumpSha256"),
            "com.diva.postgres-restore.purpose": "isolated-verification",
        }.items()
    ):
        raise VerificationError("candidate PostgreSQL volume labels do not match the backup")
    return record


def _publication_alignment(expected: str) -> dict[str, str]:
    inspected = json.loads(run_command(["docker", "inspect", "vocadb_postgres"]))[0]
    env = dict(item.split("=", 1) for item in inspected["Config"]["Env"])
    current = _query("vocadb_postgres", env["POSTGRES_USER"], env["POSTGRES_DB"],
        "SELECT value FROM public.sync_state WHERE key='recommendation_publication_generation'")
    busy = _query("vocadb_postgres", env["POSTGRES_USER"], env["POSTGRES_DB"],
        "SELECT count(*) FROM public.sync_state WHERE key='recommendation_publication_in_progress'")
    if current != expected or busy != "0": raise VerificationError("production publication generation changed or publication is in progress")
    parts = expected.split(":")
    if len(parts) != 2 or not all(re.fullmatch(r"[0-9a-f]+", part) for part in parts): raise VerificationError("publication has no verifiable Qdrant build identity")
    suffix = parts[0][:12] + "_" + parts[1][:8]
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://127.0.0.1:6333/aliases", timeout=10) as response:
        aliases = json.load(response)["result"]["aliases"]
    targets = {item["alias_name"]: item["collection_name"] for item in aliases}
    required = {"song_metadata_active": "song_metadata_basis_", "songs_v2_active": "songs_v2_basis_", "song_hybrid_active": "song_hybrid_basis_"}
    if any(targets.get(alias) != prefix + suffix for alias, prefix in required.items()): raise VerificationError("Qdrant aliases do not match backup publication generation")
    return {alias: targets[alias] for alias in required}

def _backup_comparison(backup: dict, counts: dict, migrations: dict) -> dict:
    baseline = backup.get("validationBaseline")
    if baseline is None: return {"status": "not-recorded-in-source-backup", "tableCountsMatched": False, "migrationsMatched": False}
    if not isinstance(baseline, dict) or baseline.get("schemaVersion") != 1 or not baseline.get("snapshot"): raise VerificationError("backup validation baseline is invalid")
    expected = baseline.get("tableCounts")
    if not isinstance(expected, dict) or set(expected) != set(TABLES_TO_COUNT) or any(type(v) is not int or v < 0 for v in expected.values()): raise VerificationError("backup validation table counts are incomplete")
    if counts != expected: raise VerificationError("restored table counts do not match source backup snapshot")
    expected_migrations = baseline.get("migrations")
    if not isinstance(expected_migrations, list) or not expected_migrations or migrations.get("rows") != expected_migrations: raise VerificationError("restored migrations do not match source backup snapshot")
    return {"status": "matched", "snapshot": baseline["snapshot"], "tableCountsMatched": True, "migrationsMatched": True}

def _table_counts(container: str, admin_user: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table_name in TABLES_TO_COUNT:
        quoted_table = _identifier(table_name)
        output = _query(
            container,
            admin_user,
            DATABASE_NAME,
            f"SELECT count(*)::text FROM public.{quoted_table}",
        )
        try:
            count = int(output)
        except ValueError as error:
            raise VerificationError(f"table count is invalid for public.{table_name}") from error
        if count < 0:
            raise VerificationError(f"table count is negative for public.{table_name}")
        counts[table_name] = count
    for table_name in MAJOR_TABLES:
        if counts.get(table_name, 0) <= 0:
            raise VerificationError(f"restored major table has no rows: public.{table_name}")
    return counts


def _sequence_state(container: str, admin_user: str) -> dict[str, dict[str, int | bool]]:
    sql = """
SELECT COALESCE(json_agg(json_build_object(
    'sequenceSchema', sequence_ns.nspname,
    'sequenceName', sequence.relname,
    'tableSchema', table_ns.nspname,
    'tableName', table_class.relname,
    'columnName', attribute.attname,
    'increment', sequence_config.seqincrement
) ORDER BY sequence_ns.nspname, sequence.relname), '[]'::json)::text
FROM pg_class sequence
JOIN pg_namespace sequence_ns ON sequence_ns.oid = sequence.relnamespace
JOIN pg_sequence sequence_config ON sequence_config.seqrelid = sequence.oid
JOIN pg_depend dependency
  ON dependency.classid = 'pg_class'::regclass
 AND dependency.objid = sequence.oid
 AND dependency.refclassid = 'pg_class'::regclass
 AND dependency.deptype IN ('a', 'i')
JOIN pg_class table_class ON table_class.oid = dependency.refobjid
JOIN pg_namespace table_ns ON table_ns.oid = table_class.relnamespace
JOIN pg_attribute attribute
  ON attribute.attrelid = table_class.oid
 AND attribute.attnum = dependency.refobjsubid
WHERE sequence.relkind = 'S'
  AND sequence_ns.nspname = 'public'
  AND table_ns.nspname = 'public'
"""
    records = _query_json(container, admin_user, DATABASE_NAME, sql, "sequence inventory")
    if not isinstance(records, list) or not records:
        raise VerificationError("restored database has no owned public sequences")

    result: dict[str, dict[str, int | bool]] = {}
    for item in records:
        if not isinstance(item, dict):
            raise VerificationError("PostgreSQL returned an invalid sequence inventory row")
        sequence_name = str(item.get("sequenceName", ""))
        sequence_schema = str(item.get("sequenceSchema", ""))
        table_name = str(item.get("tableName", ""))
        table_schema = str(item.get("tableSchema", ""))
        column_name = str(item.get("columnName", ""))
        increment = int(item.get("increment", 0))
        if not all((sequence_name, sequence_schema, table_name, table_schema, column_name)) or increment <= 0:
            raise VerificationError("restored sequence has an invalid owner or increment")

        last_output = _query(
            container,
            admin_user,
            DATABASE_NAME,
            f"SELECT last_value::text || E'\\t' || is_called::text FROM "
            f"{_identifier(sequence_schema)}.{_identifier(sequence_name)}",
        )
        maximum_output = _query(
            container,
            admin_user,
            DATABASE_NAME,
            f"SELECT COALESCE(MAX({_identifier(column_name)}), 0)::text "
            f"FROM {_identifier(table_schema)}.{_identifier(table_name)}",
        )
        try:
            last_value_text, called_text = last_output.split("\t", 1)
            last_value = int(last_value_text)
            maximum_value = int(maximum_output)
            is_called = called_text in {"t", "true"}
        except (ValueError, TypeError) as error:
            raise VerificationError(f"could not read restored sequence state: {sequence_name}") from error
        if called_text not in {"t", "f", "true", "false"}:
            raise VerificationError(f"restored sequence call state is invalid: {sequence_name}")
        safe_next_value = last_value >= maximum_value if is_called else last_value > maximum_value
        if not safe_next_value:
            raise VerificationError(f"restored sequence may collide with existing rows: {sequence_name}")
        result[sequence_name] = {
            "lastValue": last_value,
            "maximumOwnedValue": maximum_value,
            "isCalled": is_called,
        }
    return result


def _migrations(container: str, admin_user: str) -> dict[str, Any]:
    sql = """
SELECT COALESCE(json_agg(json_build_object(
    'id', migration_id,
    'sha256', content_sha256
) ORDER BY migration_id), '[]'::json)::text
FROM public.schema_migrations
"""
    records = _query_json(container, admin_user, DATABASE_NAME, sql, "migration history")
    if not isinstance(records, list) or not records:
        raise VerificationError("restored migration history is empty")
    migrations = []
    previous = ""
    for item in records:
        if not isinstance(item, dict):
            raise VerificationError("restored migration history contains an invalid row")
        migration_id = item.get("id")
        if not isinstance(migration_id, str) or not MIGRATION_ID.fullmatch(migration_id):
            raise VerificationError("restored migration history contains an invalid migration ID")
        if previous and migration_id <= previous:
            raise VerificationError("restored migration history is not uniquely ordered")
        previous = migration_id
        checksum = item.get("sha256")
        if checksum is not None and (not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum)):
            raise VerificationError(f"restored migration checksum is invalid: {migration_id}")
        migrations.append({"id": migration_id, "sha256": checksum})
    return {"count": len(migrations), "latest": migrations[-1]["id"], "rows": migrations}


def _expected_restored_extensions(source: dict[str, str]) -> dict[str, str]:
    # pg_dump emits CREATE EXTENSION without VERSION; this pinned image ships
    # only vector 0.8.6 SQL. Its running binary is already 0.8.6 in production.
    if source.get("vector") not in {"0.8.2", "0.8.6"}:
        raise VerificationError("unreviewed vector registered-version transition")
    result = dict(source)
    result["vector"] = "0.8.6"
    return result

def _extensions(container: str, admin_user: str) -> dict[str, str]:
    sql = """
SELECT COALESCE(json_object_agg(extname, extversion ORDER BY extname), '{}'::json)::text
FROM pg_extension
"""
    result = _query_json(container, admin_user, DATABASE_NAME, sql, "PostgreSQL extensions")
    if not isinstance(result, dict) or not all(
        isinstance(name, str) and isinstance(version, str) and version
        for name, version in result.items()
    ):
        raise VerificationError("restored PostgreSQL extension inventory is invalid")
    if not {"vector", "pg_trgm"}.issubset(result):
        raise VerificationError("restored PostgreSQL extensions do not match the runtime contract")
    return result


def _indexes(container: str, admin_user: str) -> dict[str, int]:
    sql = """
SELECT count(*)::text || E'\\t' ||
       count(*) FILTER (WHERE index.indisvalid AND index.indisready)::text
FROM pg_index index
JOIN pg_class table_class ON table_class.oid = index.indrelid
JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
WHERE namespace.nspname = 'public'
"""
    output = _query(container, admin_user, DATABASE_NAME, sql)
    try:
        total_text, valid_text = output.split("\t", 1)
        total = int(total_text)
        valid = int(valid_text)
    except ValueError as error:
        raise VerificationError("PostgreSQL returned invalid index validity totals") from error
    if total <= 0 or valid != total:
        raise VerificationError("restored database contains invalid or not-ready indexes")
    return {"total": total, "valid": valid}


def _collation(container: str, admin_user: str, database: str) -> dict[str, Any]:
    sql = (
        "SELECT json_build_object('database', datname, 'recordedVersion', datcollversion, "
        "'actualVersion', pg_database_collation_actual_version(oid))::text "
        "FROM pg_database WHERE datname = current_database()"
    )
    result = _query_json(container, admin_user, database, sql, f"{database} database collation")
    if not isinstance(result, dict):
        raise VerificationError(f"PostgreSQL returned invalid collation state for {database}")
    recorded = result.get("recordedVersion")
    actual = result.get("actualVersion")
    if (recorded is not None and not isinstance(recorded, str)) or (
        actual is not None and not isinstance(actual, str)
    ):
        raise VerificationError(f"PostgreSQL returned invalid collation versions for {database}")
    if recorded != actual:
        raise VerificationError(f"database collation version mismatch: {database}")
    return {"recordedVersion": recorded, "actualVersion": actual, "matches": True}


def _api_get(base_url: str, path: str, query: dict[str, str] | None = None) -> Any:
    url = base_url.rstrip("/") + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=30) as response:
            if response.status != 200:
                raise VerificationError(f"isolated API request failed: {path} HTTP {response.status}")
            body = response.read(1_048_577)
    except urllib.error.HTTPError as error:
        raise VerificationError(f"isolated API request failed: {path} HTTP {error.code}") from error
    except (OSError, urllib.error.URLError) as error:
        raise VerificationError(f"isolated API request could not complete: {path}") from error
    if len(body) > 1_048_576:
        raise VerificationError(f"isolated API response is too large: {path}")
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        raise VerificationError(f"isolated API returned invalid JSON: {path}") from error


def _api_smoke(base_url: str) -> tuple[dict[str, bool], dict[str, int]]:
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise VerificationError("isolated API URL must be HTTP on the local loopback interface")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise VerificationError("isolated API URL must not contain a path, query, or fragment")

    ready = _api_get(base_url, API_PATHS["ready"])
    if not isinstance(ready, dict) or ready.get("status") != "ready":
        raise VerificationError("isolated API readiness did not report ready")
    ready_dependencies = ready.get("dependencies")
    if not isinstance(ready_dependencies, dict) or any(
        not isinstance(ready_dependencies.get(name), dict)
        or ready_dependencies[name].get("ok") is not True
        for name in ("postgres", "qdrant")
    ):
        raise VerificationError("isolated API readiness dependencies are not healthy")

    health = _api_get(base_url, API_PATHS["health"])
    if not isinstance(health, dict) or health.get("status") != "ok":
        raise VerificationError("isolated API health did not report ok")
    health_dependencies = health.get("dependencies")
    if not isinstance(health_dependencies, dict) or any(
        not isinstance(health_dependencies.get(name), dict)
        or health_dependencies[name].get("ok") is not True
        for name in ("postgres", "qdrant")
    ):
        raise VerificationError("isolated API health dependencies are not healthy")

    search = _api_get(
        base_url,
        "/api/songs/search",
        {
            "sort": "FavoritedTimes",
            "order": "desc",
            "start": "0",
            "maxResults": "12",
            "audioComputed": "true",
        },
    )
    search_items = search.get("items") if isinstance(search, dict) else None
    if not isinstance(search_items, list) or not search_items:
        raise VerificationError("isolated API search returned no results")
    for item in search_items:
        if (
            not isinstance(item, dict)
            or isinstance(item.get("id"), bool)
            or not isinstance(item.get("id"), int)
            or item["id"] <= 0
            or not isinstance(item.get("name"), str)
            or not item["name"]
        ):
            raise VerificationError("isolated API search returned an invalid song contract")

    def require_song_items(items: Any, label: str) -> list[dict[str, Any]]:
        if not isinstance(items, list) or not items:
            raise VerificationError(f"isolated API {label} recommendation returned no results")
        for item in items:
            if not isinstance(item, dict):
                raise VerificationError(f"isolated API {label} recommendation returned an invalid item")
            song_id = item.get("songId")
            if isinstance(song_id, bool) or not isinstance(song_id, int) or song_id <= 0:
                raise VerificationError(f"isolated API {label} recommendation returned an invalid song ID")
            if not isinstance(item.get("name"), str):
                raise VerificationError(f"isolated API {label} recommendation omitted a song name")
            if not isinstance(item.get("producerIds"), list) or not isinstance(item.get("vocalistIds"), list):
                raise VerificationError(f"isolated API {label} recommendation omitted artist IDs")
            for field in ("youtubeViews", "nicoViews"):
                views = item.get(field)
                if (
                    isinstance(views, bool)
                    or not isinstance(views, (int, float))
                    or not math.isfinite(views)
                ):
                    raise VerificationError(f"isolated API {label} recommendation omitted {field}")
        return items

    def seed_with_results(path: str, label: str) -> tuple[int, list[Any]]:
        for song in search_items:
            if not isinstance(song, dict):
                continue
            song_id = song.get("id")
            if isinstance(song_id, bool) or not isinstance(song_id, int) or song_id <= 0:
                continue
            result = _api_get(
                base_url,
                path,
                {"songId": str(song_id), "count": "8", "offset": "0"},
            )
            items = result.get("items") if isinstance(result, dict) else None
            if isinstance(items, list) and items:
                checked_items = require_song_items(items, label)
                if any(item["songId"] == song_id for item in checked_items):
                    raise VerificationError(f"isolated API {label} recommendation included its seed song")
                return song_id, checked_items
        raise VerificationError(f"isolated API {label} recommendation returned no candidates for 12 seed songs")

    metadata_song_id, metadata_items = seed_with_results(
        "/api/recommend/metadata", "metadata"
    )
    _, audio_items = seed_with_results("/api/recommend/audio", "audio")

    hybrid = _api_get(
        base_url,
        "/api/recommend",
        {"songId": str(metadata_song_id), "count": "5", "sessionProgress": "0"},
    )
    hybrid_items = hybrid.get("items") if isinstance(hybrid, dict) else None
    hybrid_items = require_song_items(hybrid_items, "hybrid")
    if hybrid.get("error") not in (None, ""):
        raise VerificationError("isolated API hybrid recommendation returned an error")

    return (
        {
            "apiReady": True,
            "apiHealth": True,
            "search": True,
            "metadataRecommendation": True,
            "hybridRecommendation": True,
            "audioRecommendation": True,
        },
        {
            "searchResultCount": len(search_items),
            "metadataRecommendationCount": len(metadata_items),
            "hybridRecommendationCount": len(hybrid_items),
            "audioRecommendationCount": len(audio_items),
        },
    )


def collect_verification(
    preflight: dict[str, Any],
    *,
    container: str,
    volume: str,
    api_url: str,
    database_port: int,
    api_login_role: str,
    pipeline_login_role: str,
    started_at: str | None = None,
    logical_restore_finished_at: str | None = None,
    resource_usage: dict[str, Any] | None = None,
    expected_extensions: dict[str, str] | None = None,
) -> dict[str, Any]:
    if preflight.get("status") != "ready" or preflight.get("capacity", {}).get("sufficient") is not True:
        raise VerificationError("preflight did not pass")
    postgres = preflight.get("postgres")
    if not isinstance(postgres, dict):
        raise VerificationError("preflight has no PostgreSQL state")
    admin_user = postgres.get("adminUser")
    if not isinstance(admin_user, str) or not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", admin_user):
        raise VerificationError("preflight PostgreSQL admin user is invalid")
    if not LOGIN_ROLE.fullmatch(api_login_role) or not api_login_role.startswith("diva_api_login_"):
        raise VerificationError("API runtime login role name is invalid")
    if not LOGIN_ROLE.fullmatch(pipeline_login_role) or not pipeline_login_role.startswith("diva_pipeline_login_"):
        raise VerificationError("pipeline runtime login role name is invalid")

    started = started_at or datetime.now(timezone.utc).isoformat()
    _inspect_candidate(container, volume, preflight, database_port)

    counts = _table_counts(container, admin_user)
    sequences = _sequence_state(container, admin_user)
    migrations = _migrations(container, admin_user)
    comparison = _backup_comparison(preflight["backup"], counts, migrations)
    extensions = _extensions(container, admin_user)
    if expected_extensions is not None and extensions != expected_extensions:
        raise VerificationError("restored PostgreSQL extensions differ from the source database")
    indexes = _indexes(container, admin_user)
    app_collation = _collation(container, admin_user, DATABASE_NAME)
    admin_collation = _collation(container, admin_user, "postgres")
    generation = _query(
        container,
        admin_user,
        DATABASE_NAME,
        "SELECT value FROM public.sync_state WHERE key = 'recommendation_publication_generation'",
    )
    expected_generation = preflight.get("backup", {}).get("publicationGeneration")
    if generation != expected_generation:
        raise VerificationError("restored PostgreSQL publication generation does not match the backup")

    roles_sql = Path(__file__).with_name("test-database-role-contract.sql")
    if not roles_sql.is_file() or roles_sql.is_symlink():
        raise VerificationError("existing least-privilege role contract file is unavailable")
    run_command([
        "docker", "exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1",
        "-U", admin_user, "-d", DATABASE_NAME,
        "-f", "/restore-scripts/test-database-role-contract.sql",
    ], timeout=900)
    role_query = """
SELECT COALESCE(json_object_agg(parent.rolname, members.login_names ORDER BY parent.rolname), '{}'::json)::text
FROM (
    SELECT parent_role.rolname,
           json_agg(member.rolname ORDER BY member.rolname) AS login_names
    FROM pg_auth_members membership
    JOIN pg_roles parent_role ON parent_role.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    WHERE parent_role.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
      AND member.rolcanlogin
    GROUP BY parent_role.rolname
) members
JOIN pg_roles parent ON parent.rolname = members.rolname
"""
    role_state = _query_json(container, admin_user, DATABASE_NAME, role_query, "runtime roles")
    if not isinstance(role_state, dict):
        raise VerificationError("restored runtime-role inventory is invalid")
    if api_login_role not in role_state.get("diva_api_runtime", []):
        raise VerificationError("API login role is not a member of diva_api_runtime")
    if pipeline_login_role not in role_state.get("diva_pipeline_runtime", []):
        raise VerificationError("pipeline login role is not a member of diva_pipeline_runtime")

    api_checks, api_counts = _api_smoke(api_url)
    candidate_api_sessions = _query(
        container,
        admin_user,
        DATABASE_NAME,
        "SELECT count(*)::text FROM pg_stat_activity "
        f"WHERE datname = current_database() AND usename = '{api_login_role}' "
        "AND application_name = 'diva-postgres-restore-check'",
    )
    try:
        candidate_api_session_count = int(candidate_api_sessions)
    except ValueError as error:
        raise VerificationError("could not confirm isolated API sessions on the candidate database") from error
    if candidate_api_session_count <= 0:
        raise VerificationError("isolated API did not connect to the candidate PostgreSQL database")
    api_checks["apiConnectedToCandidateDatabase"] = True
    api_counts["candidateDatabaseSessionCount"] = candidate_api_session_count

    restored_size = _positive_int(
        int(_query(container, admin_user, DATABASE_NAME, f"SELECT pg_database_size('{DATABASE_NAME}')::text")),
        "restored logical database size",
    )
    final_volume_bytes = _measure_container(container, "du")
    filesystem_after = _filesystem_usage(container)
    capacity_before = preflight.get("capacity")
    if not isinstance(capacity_before, dict):
        raise VerificationError("preflight has no PostgreSQL filesystem capacity snapshot")
    filesystem_total_before = _positive_int(
        capacity_before.get("filesystemTotalBytes"), "preflight filesystem total bytes"
    )
    filesystem_used_before = capacity_before.get("filesystemUsedBytes")
    filesystem_available_before = _positive_int(
        capacity_before.get("availableBytes"), "preflight filesystem available bytes"
    )
    if (
        isinstance(filesystem_used_before, bool)
        or not isinstance(filesystem_used_before, int)
        or filesystem_used_before < 0
        or filesystem_used_before + filesystem_available_before > filesystem_total_before
    ):
        raise VerificationError("preflight PostgreSQL filesystem capacity snapshot is inconsistent")

    sample_count = 0
    sampled_peak_volume = 0
    sampled_peak_fs_used = 0
    first_sample_at = None
    last_sample_at = None
    if resource_usage is not None:
        if resource_usage.get("schemaVersion") != 1:
            raise VerificationError("resource usage summary has an unsupported schema")
        sample_count = _positive_int(resource_usage.get("sampleCount"), "resource usage sample count")
        sampled_peak_volume = _positive_int(
            resource_usage.get("peakCandidateVolumeBytes"), "sampled candidate volume peak"
        )
        sampled_peak_fs_used = _positive_int(
            resource_usage.get("peakFilesystemUsedBytes"), "sampled filesystem usage peak"
        )
        resource_total = _positive_int(
            resource_usage.get("filesystemTotalBytes"), "sampled filesystem total bytes"
        )
        first_sample_at = resource_usage.get("firstSampleAt")
        last_sample_at = resource_usage.get("lastSampleAt")
        if not isinstance(first_sample_at, str) or not isinstance(last_sample_at, str):
            raise VerificationError("resource usage sampling timestamps are missing")
        if sampled_peak_fs_used > resource_total:
            raise VerificationError("sampled filesystem usage exceeds the filesystem size")
    peak_volume = max(final_volume_bytes, sampled_peak_volume)
    peak_fs_used = max(filesystem_after["usedBytes"], sampled_peak_fs_used)
    finished = datetime.now(timezone.utc).isoformat()

    checks = {
        "tableCounts": True,
        "majorData": True,
        "sequences": True,
        "migrations": migrations["count"] > 0,
        "extensions": True,
        "roles": True,
        "publicationGeneration": generation == expected_generation,
        "allIndexesValid": indexes["total"] == indexes["valid"],
        "applicationDatabaseCollation": app_collation["matches"],
        "administrativeDatabaseCollation": admin_collation["matches"],
        **api_checks,
    }
    return {
        "backupRunId": preflight["backup"]["runId"],
        "manifestSha256": preflight["backup"]["manifestSha256"],
        "dumpSha256": preflight["backup"]["dumpSha256"],
        "publicationGeneration": generation,
        "postgresImage": postgres["image"],
        "postgresImageId": postgres["imageId"],
        "restoredVolume": volume,
        "startedAt": started,
        "finishedAt": finished,
        "checks": checks,
        "tableCounts": counts,
        "backupComparison": comparison,
        "sequences": sequences,
        "migrations": migrations,
        "extensions": extensions,
        "extensionsComparison": {"reference": "current-production" if expected_extensions is not None else "inventory-only", "expected": expected_extensions},
        "indexes": indexes,
        "databaseCollations": {
            DATABASE_NAME: app_collation,
            "postgres": admin_collation,
        },
        "roles": {
            "apiLogin": api_login_role,
            "pipelineLogin": pipeline_login_role,
            "leastPrivilegeContractPassed": True,
        },
        "api": {
            **api_counts,
            "databaseConnection": {
                "passed": api_checks["apiConnectedToCandidateDatabase"],
                "candidateSessionCount": api_counts["candidateDatabaseSessionCount"],
            },
        },
        "restoredLogicalDatabaseSizeBytes": restored_size,
        "peakCandidateVolumeBytes": peak_volume,
        "peakFilesystemUsedBytes": peak_fs_used,
        "filesystem": {
            "totalBytesBefore": filesystem_total_before,
            "usedBytesBefore": filesystem_used_before,
            "availableBytesBefore": filesystem_available_before,
            "totalBytesAfter": filesystem_after["totalBytes"],
            "usedBytesAfter": filesystem_after["usedBytes"],
            "availableBytesAfter": filesystem_after["availableBytes"],
        },
        "resourceUsage": {
            "sampleCount": sample_count,
            "firstSampleAt": first_sample_at,
            "lastSampleAt": last_sample_at,
            "sampledPeakCandidateVolumeBytes": sampled_peak_volume,
            "sampledPeakFilesystemUsedBytes": sampled_peak_fs_used,
        },
        "logicalRestoreFinishedAt": logical_restore_finished_at,
    }


def _load_object(path: Path, label: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise VerificationError(f"{label} must be a regular non-symlink file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationError(f"{label} is unreadable or invalid JSON") from error
    if not isinstance(value, dict):
        raise VerificationError(f"{label} must be a JSON object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight-json", required=True, type=Path)
    parser.add_argument("--container", required=True)
    parser.add_argument("--volume", required=True)
    parser.add_argument("--api-url")
    parser.add_argument("--database-port", required=True, type=int)
    parser.add_argument("--assert-candidate-only", action="store_true")
    parser.add_argument("--api-login-role")
    parser.add_argument("--pipeline-login-role")
    parser.add_argument("--started-at")
    parser.add_argument("--logical-restore-finished-at")
    parser.add_argument("--resource-usage-json", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        preflight = _load_object(args.preflight_json, "preflight report")
        if args.assert_candidate_only:
            _inspect_candidate(args.container, args.volume, preflight, args.database_port)
            print(json.dumps({"status": "candidate-identity-passed"}, ensure_ascii=False))
            return 0
        if not args.api_url or not args.api_login_role or not args.pipeline_login_role:
            parser.error("--api-url, --api-login-role, and --pipeline-login-role are required for full verification")
        if args.output is None:
            parser.error("--output is required for full verification")
        if not args.logical_restore_finished_at:
            parser.error("--logical-restore-finished-at is required for full verification")
        if args.resource_usage_json is None:
            parser.error("--resource-usage-json is required for full verification")
        aliases_before = _publication_alignment(preflight["backup"]["publicationGeneration"])
        source_extensions = _extensions("vocadb_postgres", preflight["postgres"]["adminUser"])
        expected_extensions = _expected_restored_extensions(source_extensions)
        verification = collect_verification(
            preflight,
            container=args.container,
            volume=args.volume,
            api_url=args.api_url,
            database_port=args.database_port,
            api_login_role=args.api_login_role,
            pipeline_login_role=args.pipeline_login_role,
            started_at=args.started_at,
            logical_restore_finished_at=args.logical_restore_finished_at,
            resource_usage=_load_object(args.resource_usage_json, "resource usage summary"),
            expected_extensions=expected_extensions,
        )
        verification["extensionsComparison"] = {"reference": "fixed-image-logical-restore", "source": source_extensions, "expected": expected_extensions,
            "registeredVersionChanges": {key: {"source": value, "restored": expected_extensions[key]} for key,value in source_extensions.items() if value != expected_extensions[key]}}
        if _publication_alignment(preflight["backup"]["publicationGeneration"]) != aliases_before:
            raise VerificationError("Qdrant publication changed during API validation")
        if args.output.is_symlink() or args.output.exists():
            raise VerificationError("verification output must be a new file")
        args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location("restore_state", Path(__file__).with_name("postgres-restore-state.py"))
        state_module = module_from_spec(spec)
        spec.loader.exec_module(state_module)
        state_module.atomic_json(args.output, verification)
    except (VerificationError, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"status": "verification-passed", "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
