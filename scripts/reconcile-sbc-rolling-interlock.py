#!/usr/bin/env python3
"""Fail-closed reconciliation for one interrupted SBC rolling run.

This command is only for the terminal ``compose run migrate`` settlement
boundary. It proves that the migration container exited successfully, no
candidate service was started, and both old API slots are still the exact live
containers before restoring the HAProxy routes and releasing the interlock.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


STATE_ROOT = Path("/var/lib/diva-player-deploy")
ACTIVE = STATE_ROOT / "rolling-deployment-active"
LOCK = STATE_ROOT / "deploy.lock"
DOCKER = "/usr/bin/docker"
COMPOSE_CANDIDATE_PREFIXES = (
    "diva_api_a_candidate_",
    "diva_api_b_candidate_",
    "diva_web_candidate_",
    "diva_api_gateway_candidate_",
)
HEX40 = re.compile(r"^[0-9a-f]{40}$")
RUN_ID = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9]+$")


class ReconcileError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise ReconcileError(message)


def _regular(path: Path, mode: int = 0o600) -> os.stat_result:
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode),
            f"unsafe regular path: {path}")
    require(info.st_uid == 0 and info.st_gid == 0
            and stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1,
            f"unsafe ownership or mode: {path}")
    return info


def _directory(path: Path, mode: int = 0o700) -> os.stat_result:
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),
            f"unsafe directory: {path}")
    require(info.st_uid == 0 and info.st_gid == 0
            and stat.S_IMODE(info.st_mode) == mode,
            f"unsafe directory ownership or mode: {path}")
    return info


def _run(command: list[str], *, input_data: bytes | None = None,
         timeout: int = 30) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(command, input=input_data, capture_output=True,
                              timeout=timeout, check=False,
                              env={"PATH": "/usr/bin:/bin"})
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ReconcileError(f"command did not settle: {command[0]}") from error


def _inspect(name: str) -> dict[str, Any] | None:
    result = _run([DOCKER, "inspect", name])
    if result.returncode != 0:
        return None
    try:
        value = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReconcileError(f"Docker inspect output is invalid: {name}") from error
    require(isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict),
            f"Docker inspect identity is ambiguous: {name}")
    return value[0]


def _state(path: Path) -> dict[str, list[str]]:
    _regular(path)
    values: dict[str, list[str]] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        key, separator, value = raw.partition("=")
        require(separator and key and value, "rolling state contains an invalid row")
        values.setdefault(key, []).append(value)
    return values


def _last(values: dict[str, list[str]], key: str) -> str:
    require(key in values and values[key], f"rolling state is missing {key}")
    return values[key][-1]


def _identity(path: Path, *, include_size: bool, directory: bool = False) -> str:
    info = _directory(path) if directory else _regular(path)
    mode = f"{info.st_mode & 0xffff:x}"
    if include_size:
        return f"{info.st_dev}:{info.st_ino}:{info.st_size}:{mode}:{info.st_nlink}"
    return f"{info.st_dev}:{info.st_ino}"


def _route_rows(gateway: str) -> dict[str, list[str]]:
    result = _run([DOCKER, "exec", "-i", gateway, "socat", "-",
                   "UNIX-CONNECT:/tmp/haproxy-admin.sock"],
                  input_data=b"show stat\n")
    require(result.returncode == 0, "HAProxy stats query failed")
    try:
        rows = csv.reader(io.StringIO(result.stdout.decode("utf-8")))
        parsed = {row[1]: row for row in rows
                  if len(row) > 17 and row[0] == "api_nodes"
                  and row[1] in {"api_a", "api_b"}}
    except (UnicodeDecodeError, csv.Error) as error:
        raise ReconcileError("HAProxy stats output is invalid") from error
    require(set(parsed) == {"api_a", "api_b"},
            "HAProxy API route set is not exact")
    return parsed


def _route_command(gateway: str, slot: str) -> None:
    command = f"enable server api_nodes/{slot}\n".encode("ascii")
    result = _run([DOCKER, "exec", "-i", gateway, "socat", "-",
                   "UNIX-CONNECT:/tmp/haproxy-admin.sock"], input_data=command)
    require(result.returncode == 0, f"HAProxy route enable failed: {slot}")


def _ready(url: str) -> None:
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            require(response.status == 200, f"readiness check failed: {url}")
    except (OSError, urllib.error.URLError) as error:
        raise ReconcileError(f"readiness check failed: {url}") from error


def _append_state(state_path: Path, rows: list[tuple[str, str]]) -> None:
    info = _regular(state_path)
    with state_path.open("ab") as handle:
        for key, value in rows:
            handle.write(f"{key}={value}\n".encode("utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
    require(_identity(state_path, include_size=True).split(":")[:2]
            == [str(info.st_dev), str(info.st_ino)],
            "rolling state identity changed during reconciliation")


def _release_interlocks(state_path: Path, values: dict[str, list[str]]) -> None:
    require(_identity(ACTIVE, include_size=True)
            == _last(values, "deployment.journal_identity"),
            "active journal identity changed")
    _directory(LOCK)
    require(_identity(LOCK, include_size=False, directory=True)
            == _last(values, "deployment.lock_dir_identity"),
            "deploy lock identity changed")
    owner = LOCK / "owner"
    require(_identity(owner, include_size=True)
            == _last(values, "deployment.lock_owner_identity"),
            "deploy lock owner identity changed")
    os.unlink(ACTIVE)
    directory = os.open(STATE_ROOT, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    os.unlink(owner)
    os.rmdir(LOCK)
    directory = os.open(STATE_ROOT, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    require(not ACTIVE.exists() and not LOCK.exists(), "interlock release did not settle")


def reconcile(run_id: str) -> dict[str, str]:
    require(os.geteuid() == 0, "rolling interlock reconciliation requires uid 0")
    require(RUN_ID.fullmatch(run_id) is not None, "run ID is invalid")
    _regular(ACTIVE)
    active_target = ACTIVE.read_text(encoding="utf-8").strip()
    run_dir = STATE_ROOT / run_id
    require(active_target == str(run_dir), "active journal does not bind requested run")
    state_path = run_dir / "state"
    values = _state(state_path)
    require(_last(values, "deployment.status")
            == "daemon-unresolved-fail-stop-manual-reconciliation-required",
            "run is not at the interrupted compose-run boundary")
    require(_last(values, "deployment.interlock")
            == "active-journal-and-deploy-lock-retained",
            "run interlock is not the expected manual-reconciliation boundary")
    require(_last(values, "daemon_mutation.12.intent") == "compose-run",
            "run mutation intent is not the migration compose-run")
    require(_last(values, "daemon_mutation.interrupted")
            == "compose-run-terminal-release-forbidden",
            "run was not interrupted at the expected terminal-release boundary")
    owner = LOCK / "owner"
    _regular(owner)
    owner_values = _state(owner)
    owner_pid = int(_last(owner_values, "pid"))
    require(not Path(f"/proc/{owner_pid}").exists(),
            "deployment owner process is still alive")

    migration_name = f"diva_migration_{run_id}"
    migration = _inspect(migration_name)
    require(migration is not None and migration.get("State", {}).get("Status") == "exited"
            and migration.get("State", {}).get("ExitCode") == 0,
            "migration container did not exit successfully")

    old_ids = {
        "vocadb_api_a": _last(values, "api_a.old_container_id"),
        "vocadb_api_b": _last(values, "api_b.old_container_id"),
        "vocadb_api_gateway": _last(values, "gateway.old_container_id"),
        "vocadb_web": _last(values, "web.old_container_id"),
    }
    services = {name: _inspect(name) for name in old_ids}
    for name, expected_id in old_ids.items():
        service = services[name]
        require(service is not None and service.get("Id") == expected_id
                and service.get("State", {}).get("Running") is True,
                f"live service identity changed: {name}")
    for name in ("vocadb_api_a", "vocadb_api_b"):
        require((services[name].get("State", {}).get("Health") or {}).get("Status")
                == "healthy", f"old API is not healthy: {name}")

    for prefix in COMPOSE_CANDIDATE_PREFIXES:
        require(_inspect(prefix + run_id) is None,
                f"candidate service exists: {prefix}{run_id}")
    rows = _route_rows("vocadb_api_gateway")
    require(rows["api_a"][17].startswith("MAINT")
            and rows["api_b"][17].startswith("MAINT"),
            "HAProxy routes are not both disabled as expected")
    _route_command("vocadb_api_gateway", "api_a")
    _route_command("vocadb_api_gateway", "api_b")
    rows = _route_rows("vocadb_api_gateway")
    require(rows["api_a"][17].startswith("UP") and rows["api_b"][17].startswith("UP"),
            "HAProxy routes did not return to UP")
    _ready("http://127.0.0.1:5000/api/ready")
    _ready("http://127.0.0.1:8080/backend-api/api/ready")

    removed = _run([DOCKER, "rm", migration_name])
    require(removed.returncode == 0 and _inspect(migration_name) is None,
            "migration container cleanup did not settle")
    _append_state(state_path, [
        ("migration.container_quiescence", "manual-reconciled-exited-0"),
        ("migration.acl_reconciliation", "manual-reconciled-by-successful-migration"),
        ("migration.publication_gate", "manual-restored-old-running-api-routes"),
        ("recovery.status", "manual-daemon-settlement-reconciled"),
        ("deployment.status", "failed-manual-reconciliation-completed"),
        ("deployment.interlock", "manual-reconciliation-verified-no-live-service-replacement"),
    ])
    _release_interlocks(state_path, values)
    return {"runId": run_id, "status": "reconciled", "oldApiA": old_ids["vocadb_api_a"],
            "oldApiB": old_ids["vocadb_api_b"],
            "stateSha256": hashlib.sha256(state_path.read_bytes()).hexdigest()}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    print(json.dumps(reconcile(args.run_id), ensure_ascii=True, sort_keys=True,
                     separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ReconcileError, ValueError, json.JSONDecodeError) as error:
        print(f"SBC rolling interlock reconciliation: {error}", file=os.sys.stderr)
        raise SystemExit(1)
