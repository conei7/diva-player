#!/usr/bin/python3
"""Collect a bounded DIVA Player runtime-health snapshot on the SBC.

This is the dependency-free Python counterpart of collect-sbc-runtime-health.mjs.
It intentionally keeps the same JSON schema, thresholds, history files, webhook
payload, and exit-code contract while avoiding a Node.js runtime dependency.
"""

from __future__ import annotations

import concurrent.futures
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone
import traceback
from typing import Any, Callable
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


DEFAULT_CONTAINERS = [
    "vocadb_api_a",
    "vocadb_api_b",
    "vocadb_api_gateway",
    "vocadb_postgres",
    "vocadb_qdrant",
]
DEFAULT_PUBLIC_ORIGIN = "https://diva-player.pages.dev"
PUBLIC_PATHS = {
    "public:root": "/",
    "public:ready": "/backend-api/api/ready",
    "public:health": "/backend-api/api/health",
}
MAX_PUBLIC_RESPONSE_BYTES = 1024 * 1024
_BYTE_SIZE_PATTERN = re.compile(
    r"^\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?i?b)\s*$",
    re.IGNORECASE,
)
_FLOAT_PREFIX_PATTERN = re.compile(
    r"^[\t\n\r ]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)"
)
_INT_PREFIX_PATTERN = re.compile(r"^[\t\n\r ]*([+-]?\d+)")


class CommandFailure(RuntimeError):
    """A subprocess failure that retains any usable standard output."""

    def __init__(self, message: str, stdout: str = "") -> None:
        super().__init__(message)
        self.stdout = stdout


def parse_byte_size(value: Any) -> float | None:
    match = _BYTE_SIZE_PATTERN.fullmatch(str(value or ""))
    if not match:
        return None
    units = {
        "b": 1,
        "kb": 1e3,
        "kib": 1024,
        "mb": 1e6,
        "mib": 1024**2,
        "gb": 1e9,
        "gib": 1024**3,
        "tb": 1e12,
        "tib": 1024**4,
    }
    multiplier = units.get(match.group(2).lower())
    if not multiplier:
        return None
    parsed = float(match.group(1)) * multiplier
    return int(parsed) if parsed.is_integer() else parsed


def _parse_float(value: Any) -> float:
    match = _FLOAT_PREFIX_PATTERN.match(str(value or ""))
    if not match:
        return 0.0
    try:
        parsed = float(match.group(1))
        if parsed == 0 or parsed.is_integer():
            return int(parsed)
        return parsed
    except ValueError:
        return 0.0


def _parse_int(value: Any) -> int:
    match = _INT_PREFIX_PATTERN.match(str(value or ""))
    if not match:
        return 0
    try:
        return int(match.group(1), 10)
    except ValueError:
        return 0


def parse_docker_stats(output: str) -> list[dict[str, Any]]:
    containers: list[dict[str, Any]] = []
    for line in output.splitlines():
        if not line:
            continue
        try:
            raw = json.loads(line)
            if not isinstance(raw, dict):
                continue
            memory_parts = str(raw.get("MemUsage") or "").split("/")
            used = memory_parts[0].strip() if memory_parts else ""
            limit = memory_parts[1].strip() if len(memory_parts) > 1 else ""
            containers.append(
                {
                    "name": raw.get("Name"),
                    "cpuPercent": _parse_float(raw.get("CPUPerc")),
                    "memoryUsedBytes": parse_byte_size(used),
                    "memoryLimitBytes": parse_byte_size(limit),
                    "memoryPercent": _parse_float(raw.get("MemPerc")),
                    "pids": _parse_int(raw.get("PIDs")),
                }
            )
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return containers


def parse_container_health(output: str) -> dict[str, str]:
    health: dict[str, str] = {}
    for line in output.splitlines():
        if not line:
            continue
        columns = line.removeprefix("/").split("\t")
        name = columns[0]
        status = columns[1] if len(columns) > 1 and columns[1] else "unknown"
        health[name] = status
    return health


def parse_postgres_activity(output: str) -> dict[str, Any]:
    applications = []
    for line in output.splitlines():
        if not line:
            continue
        columns = line.split("\t")
        applications.append(
            {
                "applicationName": columns[0] if columns else "",
                "active": _parse_int(columns[1] if len(columns) > 1 else ""),
                "total": _parse_int(columns[2] if len(columns) > 2 else ""),
            }
        )
    return {
        "applications": applications,
        "active": sum(item["active"] for item in applications),
        "total": sum(item["total"] for item in applications),
    }


def parse_haproxy_stats(output: str) -> list[dict[str, Any]]:
    lines = [line for line in output.splitlines() if line]
    if len(lines) < 2:
        return []
    header = re.sub(r"^#\s*", "", lines[0]).split(",")
    indexes = {name: position for position, name in enumerate(header)}
    required_columns = {"pxname", "svname", "status", "scur"}
    if not required_columns.issubset(indexes):
        return []

    slots = []
    for line in lines[1:]:
        columns = line.split(",")

        def column(name: str) -> str:
            position = indexes[name]
            return columns[position] if position < len(columns) else ""

        if column("pxname") != "api_nodes" or column("svname") not in {
            "api_a",
            "api_b",
        }:
            continue
        slots.append(
            {
                "slot": column("svname"),
                "status": column("status") or "UNKNOWN",
                "currentSessions": _parse_int(column("scur")),
            }
        )
    return slots


def parse_host_memory(
    meminfo_output: str,
    vmstat_output: str,
    pressure_output: str = "",
) -> dict[str, Any]:
    """Parse Linux host memory and cumulative swap-I/O counters."""
    meminfo: dict[str, int] = {}
    for line in meminfo_output.splitlines():
        match = re.fullmatch(r"([A-Za-z_()]+):\s+(\d+)\s+kB", line.strip())
        if match:
            meminfo[match.group(1)] = int(match.group(2)) * 1024
    required = {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}
    missing = sorted(required - meminfo.keys())
    if missing:
        raise ValueError(f"missing /proc/meminfo fields: {', '.join(missing)}")

    vmstat: dict[str, int] = {}
    for line in vmstat_output.splitlines():
        columns = line.split()
        if len(columns) == 2 and columns[0] in {"pswpin", "pswpout"}:
            vmstat[columns[0]] = int(columns[1])

    pressure: dict[str, dict[str, int | float | None]] = {}
    for line in pressure_output.splitlines():
        columns = line.split()
        if not columns or columns[0] not in {"some", "full"}:
            continue
        values: dict[str, int | float | None] = {
            "avg10Percent": None,
            "avg60Percent": None,
            "avg300Percent": None,
            "totalMicros": None,
        }
        for column in columns[1:]:
            name, separator, raw_value = column.partition("=")
            if not separator:
                continue
            if name == "total":
                values["totalMicros"] = int(raw_value)
            elif name in {"avg10", "avg60", "avg300"}:
                values[f"{name}Percent"] = float(raw_value)
        pressure[columns[0]] = values

    total = meminfo["MemTotal"]
    available = meminfo["MemAvailable"]
    swap_total = meminfo["SwapTotal"]
    swap_used = max(0, swap_total - meminfo["SwapFree"])
    return {
        "totalBytes": total,
        "availableBytes": available,
        "availablePercent": round(available / total * 100, 2) if total else None,
        "swapTotalBytes": swap_total,
        "swapUsedBytes": swap_used,
        "swapUsedPercent": round(swap_used / swap_total * 100, 2)
        if swap_total
        else 0,
        "swapInPages": vmstat.get("pswpin"),
        "swapOutPages": vmstat.get("pswpout"),
        "pressure": pressure or None,
    }


def _is_finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _display_number(value: int | float) -> str:
    if _is_finite(value) and float(value).is_integer():
        return str(int(value))
    return str(value)


def evaluate_runtime_snapshot(
    snapshot: dict[str, Any],
    previous: dict[str, Any] | None = None,
    thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    previous = previous or {}
    thresholds = thresholds or {}
    api_rss_warn_mib = thresholds.get("apiRssWarnMiB", 384)
    db_connections_warn = thresholds.get("dbConnectionsWarn", 28)
    disk_used_warn_percent = thresholds.get("diskUsedWarnPercent", 85)
    host_available_warn_percent = thresholds.get("hostAvailableWarnPercent", 10)
    violations: list[dict[str, str]] = []

    for collection_error in snapshot.get("collectionErrors") or []:
        source = collection_error.get("source")
        violations.append(
            {
                "id": f"collector:{source}",
                "message": f"{source} collection failed: {collection_error.get('error')}",
            }
        )

    for container in snapshot.get("containers") or []:
        name = container.get("name")
        health = container.get("health")
        if health not in {"healthy", "running"}:
            violations.append(
                {"id": f"container:{name}", "message": f"{name} is {health}"}
            )
        memory_used = container.get("memoryUsedBytes")
        if (
            name in {"vocadb_api_a", "vocadb_api_b"}
            and memory_used is not None
            and memory_used > api_rss_warn_mib * 1024**2
        ):
            violations.append(
                {
                    "id": f"memory:{name}",
                    "message": (
                        f"{name} container memory exceeds "
                        f"{_display_number(api_rss_warn_mib)} MiB"
                    ),
                }
            )

    haproxy = snapshot.get("haproxy") or []
    for slot in haproxy:
        status = slot.get("status") or ""
        if not status.startswith("UP"):
            violations.append(
                {
                    "id": f"haproxy:{slot.get('slot')}",
                    "message": f"{slot.get('slot')} is {status}",
                }
            )
    for required_slot in ("api_a", "api_b"):
        if not any(slot.get("slot") == required_slot for slot in haproxy):
            violations.append(
                {
                    "id": f"haproxy:{required_slot}",
                    "message": f"{required_slot} is missing from HAProxy stats",
                }
            )

    postgres_total = (snapshot.get("postgres") or {}).get("total")
    if _is_finite(postgres_total) and postgres_total > db_connections_warn:
        violations.append(
            {
                "id": "postgres:connections",
                "message": (
                    f"API DB connections exceed "
                    f"{_display_number(db_connections_warn)}"
                ),
            }
        )
    disk_used = (snapshot.get("disk") or {}).get("usedPercent")
    if _is_finite(disk_used) and disk_used > disk_used_warn_percent:
        violations.append(
            {
                "id": "disk:used",
                "message": (
                    f"disk use exceeds {_display_number(disk_used_warn_percent)}%"
                ),
            }
        )
    host_available = (snapshot.get("hostMemory") or {}).get("availablePercent")
    if _is_finite(host_available) and host_available < host_available_warn_percent:
        violations.append(
            {
                "id": "host:memory-available",
                "message": (
                    "host available memory is below "
                    f"{_display_number(host_available_warn_percent)}%"
                ),
            }
        )

    prior_counts = previous.get("consecutiveViolations") or {}
    consecutive_violations = {
        item["id"]: (prior_counts.get(item["id"]) or 0) + 1 for item in violations
    }
    critical = [
        item for item in violations if consecutive_violations[item["id"]] >= 2
    ]
    return {
        **snapshot,
        "status": "critical" if critical else "warning" if violations else "ok",
        "violations": violations,
        "critical": critical,
        "consecutiveViolations": consecutive_violations,
    }


def _public_origin() -> str:
    raw = os.environ.get("DIVA_PUBLIC_BASE_URL", DEFAULT_PUBLIC_ORIGIN)
    parsed = urlsplit(raw)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("DIVA_PUBLIC_BASE_URL must be a credential-free HTTPS origin")
    return f"{parsed.scheme}://{parsed.netloc}"


def _probe_public_endpoint(check_id: str, path: str, timeout_seconds: float = 15) -> dict[str, Any]:
    url = f"{_public_origin()}{path}"
    request = urllib_request.Request(
        url,
        headers={"User-Agent": "DIVA-Player-Runtime-Health/1.0", "Accept": "application/json"},
    )
    status: int | None = None
    try:
        try:
            response_context = urllib_request.urlopen(request, timeout=timeout_seconds)
        except urllib_error.HTTPError as exc:
            response_context = exc
        with response_context as response:
            status = int(response.status)
            headers = response.headers
            declared = _parse_int(headers.get("Content-Length"))
            if declared > MAX_PUBLIC_RESPONSE_BYTES:
                raise ValueError("response-too-large")
            body = response.read(MAX_PUBLIC_RESPONSE_BYTES + 1)
            if len(body) > MAX_PUBLIC_RESPONSE_BYTES:
                raise ValueError("response-too-large")
        if check_id == "public:root":
            ok = status == 200 and bool(body)
        else:
            payload = json.loads(body.decode("utf-8"))
            dependencies = payload.get("dependencies") if isinstance(payload, dict) else None
            deps_ok = isinstance(dependencies, dict) and all(
                isinstance(dependencies.get(name), dict)
                and dependencies[name].get("ok") is True
                for name in ("postgres", "qdrant")
            )
            routing_ok = headers.get("X-Diva-Origin-Role") == "primary" and headers.get("X-Diva-Standby-State") == "missing"
            if check_id == "public:ready":
                warmup = payload.get("warmup") if isinstance(payload, dict) else None
                ok = status == 200 and payload.get("status") == "ready" and deps_ok and routing_ok and isinstance(warmup, dict) and warmup.get("completed") is True
            else:
                if status == 200:
                    ok = payload.get("status") == "ok" and deps_ok and routing_ok
                elif status == 503 and payload.get("status") == "degraded" and deps_ok:
                    sections = [payload.get(name) for name in ("discoveryQuality", "audioFeatures")]
                    ok = routing_ok and all(isinstance(section, dict) and isinstance(section.get("ok"), bool) and (section["ok"] or str(section.get("error", "")).lower() == "stale") for section in sections) and any(section.get("ok") is False for section in sections)
                else:
                    ok = False
        return {"status": status, "ok": bool(ok), "error": None if ok else "invalid-response"}
    except urllib_error.HTTPError as exc:
        return {"status": int(exc.code), "ok": False, "error": f"http-{exc.code}"}
    except Exception as exc:
        error = "timeout" if isinstance(exc, TimeoutError) else str(exc) or type(exc).__name__
        return {"status": status, "ok": False, "error": error[:120]}


def collect_public_probes(now: datetime | None = None) -> dict[str, dict[str, Any]]:
    now = now or datetime.now(timezone.utc)
    checks = {key: value for key, value in PUBLIC_PATHS.items() if key != "public:health" or now.minute % 5 == 0}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(checks)) as executor:
        futures = {key: executor.submit(_probe_public_endpoint, key, path) for key, path in checks.items()}
        return {key: future.result() for key, future in futures.items()}


def advance_public_monitor(
    probes: dict[str, dict[str, Any]],
    previous: dict[str, Any],
    *,
    now: datetime | None = None,
) -> tuple[dict[str, Any], list[dict[str, str]], list[dict[str, str]]]:
    now = now or datetime.now(timezone.utc)
    prior = previous.get("publicMonitor") if isinstance(previous.get("publicMonitor"), dict) else {}
    states = prior.get("checks") if isinstance(prior.get("checks"), dict) else {}
    updated: dict[str, Any] = {}
    newly_active: list[dict[str, str]] = []
    recovered: list[dict[str, str]] = []
    for check_id, result in probes.items():
        old = states.get(check_id) if isinstance(states.get(check_id), dict) else {}
        state = {
            "consecutiveFailures": 0 if result.get("ok") else int(old.get("consecutiveFailures") or 0) + 1,
            "consecutiveSuccesses": int(old.get("consecutiveSuccesses") or 0) + 1 if result.get("ok") else 0,
            "active": bool(old.get("active")),
            "startedAt": old.get("startedAt"),
            "lastCheckedAt": now.astimezone(timezone.utc).isoformat(),
            "lastStatus": result.get("status"),
            "lastError": result.get("error"),
        }
        if not result.get("ok") and state["consecutiveFailures"] >= 2 and not state["active"]:
            state["active"] = True
            state["startedAt"] = state["lastCheckedAt"]
            if check_id == "cache:audio-retention":
                detail = result.get("error") or result.get("status") or "capacity pressure"
                message = f"SBC analyzed-audio cache retention needs attention ({detail})"
            elif check_id == "capacity:ops-logs":
                message = "SBC operational log generations exceed the 500 MiB retention budget"
            else:
                message = f"Public endpoint returned {result.get('status') or 'no response'} ({result.get('error') or 'failed'})"
            newly_active.append({"id": check_id, "message": message})
        elif result.get("ok") and state["active"] and state["consecutiveSuccesses"] >= 2:
            recovered.append({"id": check_id, "message": "Public endpoint recovered"})
            state["active"] = False
            state["startedAt"] = None
        updated[check_id] = state
    combined_states = {**states, **updated}
    violations: list[dict[str, str]] = []
    for check_id, state in combined_states.items():
        if not isinstance(state, dict) or not state.get("active"):
            continue
        if check_id == "cache:audio-retention":
            message = f"SBC analyzed-audio cache retention needs attention ({state.get('lastError') or state.get('lastStatus') or 'capacity pressure'})"
        elif check_id == "capacity:ops-logs":
            message = "SBC operational log generations exceed the 500 MiB retention budget"
        else:
            message = f"Public endpoint is unhealthy ({state.get('lastStatus') or 'no response'})"
        violations.append({"id": check_id, "message": message})
    return {"checks": combined_states}, violations, recovered


def _normalize_subprocess_output(value: str | bytes | None) -> str:
    if value is None:
        return ""
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value


def _run_command(
    command: list[str], input_text: str | None = None, timeout_seconds: float = 10
) -> str:
    try:
        completed = subprocess.run(
            command,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise CommandFailure(
            f"{command[0]} timed out after {round(timeout_seconds * 1000)}ms",
            _normalize_subprocess_output(exc.stdout),
        ) from exc
    except OSError as exc:
        raise CommandFailure(str(exc)) from exc
    if completed.returncode != 0:
        error_text = completed.stderr.strip()
        raise CommandFailure(
            f"{command[0]} exited {completed.returncode}: {error_text}",
            completed.stdout,
        )
    return completed.stdout


def _read_disk_stats() -> os.statvfs_result:
    return os.statvfs("/")


def _read_host_memory_stats() -> dict[str, Any]:
    return parse_host_memory(
        Path("/proc/meminfo").read_text(encoding="utf-8"),
        Path("/proc/vmstat").read_text(encoding="utf-8"),
        Path("/proc/pressure/memory").read_text(encoding="utf-8"),
    )


def _settle(source: str, operation: Callable[[], Any]) -> dict[str, Any]:
    try:
        return {"source": source, "ok": True, "value": operation(), "stdout": ""}
    except Exception as exc:  # Collection errors must not suppress local state.
        return {
            "source": source,
            "ok": False,
            "value": None,
            "stdout": getattr(exc, "stdout", "")
            if isinstance(getattr(exc, "stdout", ""), str)
            else "",
            "error": str(exc or "unknown error")[:300],
        }


def _iso_timestamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def collect_snapshot() -> dict[str, Any]:
    inspect_format = (
        "{{.Name}}\t{{if .State.Health}}{{.State.Health.Status}}"
        "{{else}}{{.State.Status}}{{end}}"
    )
    postgres_query = (
        "SELECT application_name, count(*) FILTER (WHERE state = 'active'), "
        "count(*) FROM pg_stat_activity WHERE application_name LIKE 'diva-api-%' "
        "GROUP BY application_name ORDER BY application_name"
    )
    operations: list[tuple[str, Callable[[], Any]]] = [
        (
            "docker-stats",
            lambda: _run_command(
                [
                    "docker",
                    "stats",
                    "--no-stream",
                    "--format",
                    "{{json .}}",
                    *DEFAULT_CONTAINERS,
                ],
                timeout_seconds=20,
            ),
        ),
        (
            "docker-inspect",
            lambda: _run_command(
                [
                    "docker",
                    "inspect",
                    "--format",
                    inspect_format,
                    *DEFAULT_CONTAINERS,
                ],
                timeout_seconds=10,
            ),
        ),
        (
            "postgres",
            lambda: _run_command(
                [
                    "docker",
                    "exec",
                    "vocadb_postgres",
                    "psql",
                    "-U",
                    "vocadb",
                    "-d",
                    "vocadb_recommender",
                    "-At",
                    "-F",
                    "\t",
                    "-c",
                    postgres_query,
                ],
                timeout_seconds=10,
            ),
        ),
        (
            "haproxy",
            lambda: _run_command(
                [
                    "docker",
                    "exec",
                    "-i",
                    "vocadb_api_gateway",
                    "socat",
                    "-",
                    "UNIX-CONNECT:/tmp/haproxy-admin.sock",
                ],
                input_text="show stat\n",
                timeout_seconds=10,
            ),
        ),
        ("host-memory", _read_host_memory_stats),
        ("disk", _read_disk_stats),
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(operations)) as executor:
        futures = [
            executor.submit(_settle, source, operation)
            for source, operation in operations
        ]
        results = [future.result() for future in futures]

    (
        stats_result,
        health_result,
        postgres_result,
        haproxy_result,
        host_memory_result,
        disk_result,
    ) = results
    collection_errors = [
        {"source": result["source"], "error": result["error"]}
        for result in results
        if not result["ok"]
    ]

    def output_of(result: dict[str, Any]) -> str:
        if result["ok"]:
            return result["value"] if isinstance(result["value"], str) else ""
        return result.get("stdout") or ""

    stats = parse_docker_stats(output_of(stats_result))
    stats_by_name = {container.get("name"): container for container in stats}
    health = parse_container_health(output_of(health_result))
    postgres = parse_postgres_activity(output_of(postgres_result))
    if not postgres_result["ok"]:
        postgres["error"] = postgres_result["error"]
    haproxy = parse_haproxy_stats(output_of(haproxy_result))
    host_memory = (
        host_memory_result["value"]
        if host_memory_result["ok"]
        else {
            "totalBytes": None,
            "availableBytes": None,
            "availablePercent": None,
            "swapTotalBytes": None,
            "swapUsedBytes": None,
            "swapUsedPercent": None,
            "swapInPages": None,
            "swapOutPages": None,
            "pressure": None,
            "error": host_memory_result["error"],
        }
    )
    disk = disk_result["value"] if disk_result["ok"] else None
    containers = []
    for name in DEFAULT_CONTAINERS:
        container = {
            "name": name,
            "cpuPercent": None,
            "memoryUsedBytes": None,
            "memoryLimitBytes": None,
            "memoryPercent": None,
            "pids": None,
            **(stats_by_name.get(name) or {}),
            "health": health.get(name) or "missing",
        }
        containers.append(container)

    total_bytes = disk.f_blocks * disk.f_frsize if disk else None
    available_bytes = disk.f_bavail * disk.f_frsize if disk else None
    used_percent = (
        round(((disk.f_blocks - disk.f_bavail) / disk.f_blocks) * 100, 2)
        if disk and disk.f_blocks > 0
        else None
    )
    disk_snapshot: dict[str, Any] = {
        "totalBytes": total_bytes,
        "availableBytes": available_bytes,
        "usedPercent": used_percent,
    }
    if not disk_result["ok"]:
        disk_snapshot["error"] = disk_result["error"]

    return {
        "checkedAt": _iso_timestamp(),
        "collectionErrors": collection_errors,
        "containers": containers,
        "postgres": postgres,
        "haproxy": haproxy,
        "hostMemory": host_memory,
        "disk": disk_snapshot,
    }


def _probe_audio_cache_retention() -> dict[str, Any] | None:
    configured = os.environ.get("DIVA_AUDIO_CACHE_RETENTION_STATUS_PATH")
    if configured:
        path = Path(configured).expanduser()
    else:
        try:
            path = Path.home() / "diva-data-pipeline" / "logs" / "audio_cache_retention_status.json"
        except RuntimeError:
            return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError):
        return {"ok": False, "status": "invalid", "error": "retention-status-unreadable"}
    if not isinstance(payload, dict):
        return {"ok": False, "status": "invalid", "error": "retention-status-invalid"}
    status = str(payload.get("status") or "unknown")
    checked_at = payload.get("checkedAt")
    stale = False
    if isinstance(checked_at, str):
        try:
            parsed = datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            stale = (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds() > 36 * 60 * 60
        except ValueError:
            stale = True
    log_retention = payload.get("logRetention") if isinstance(payload.get("logRetention"), dict) else {}
    log_bytes = 0
    try:
        log_bytes = sum(
            max(0, int(source.get("totalBytes") or 0))
            for source in log_retention.values()
            if isinstance(source, dict)
        )
    except (TypeError, ValueError):
        log_bytes = 500 * 1024 * 1024 + 1
    log_pressure = log_bytes > 500 * 1024 * 1024
    ok = status in {"success", "empty"} and not stale and not log_pressure
    return {
        "ok": ok,
        "status": status,
        "error": "retention-status-stale" if stale else "operational-log-budget-exceeded" if log_pressure else None if ok else status,
        "logCapacityPressure": log_pressure,
        "remainingBytes": payload.get("remainingBytes"),
        "protectedBytesOverLimit": payload.get("protectedBytesOverLimit"),
        "operationalLogBytes": log_bytes,
    }


def load_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
            return value if isinstance(value, dict) else {}
    except FileNotFoundError:
        return {}


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(f"{path}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temporary, path)


def rotate_history_if_needed(path: Path, maximum_bytes: float) -> bool:
    if not _is_finite(maximum_bytes) or maximum_bytes <= 0:
        raise ValueError("DIVA_RUNTIME_HISTORY_MAX_BYTES must be a positive number")
    try:
        if path.stat().st_size < maximum_bytes:
            return False
    except FileNotFoundError:
        return False

    rotated = Path(f"{path}.1")
    try:
        rotated.unlink()
    except FileNotFoundError:
        pass
    path.rename(rotated)
    return True


def _discord_message_id(value: Any) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value > 0:
        return str(value)
    if isinstance(value, str) and re.fullmatch(r"[0-9]+", value) and any(
        digit != "0" for digit in value
    ):
        return value
    return None


def _discord_wait_url(webhook: str) -> str:
    parts = urlsplit(webhook)
    query = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if key != "wait"
    ]
    query.append(("wait", "true"))
    return urlunsplit(parts._replace(query=urlencode(query)))


def _discord_content(
    snapshot: dict[str, Any],
    critical: list[dict[str, Any]],
    recovered: list[str] | None = None,
) -> str:
    recovered = recovered or []
    lines = [
        "DIVA Player runtime health: INCIDENT UPDATE",
        f"Checked at: {snapshot.get('checkedAt', 'unknown')}",
    ]
    if critical:
        lines.append("Active incidents:")
    for item in critical:
        item_id = " ".join(str(item.get("id") or "unknown").split())
        message = item.get("message")
        safe_message = " ".join(message.split()) if isinstance(message, str) else ""
        lines.append(f"- {item_id}{': ' + safe_message if safe_message else ''}")
    if recovered:
        lines.append("Recovered after two consecutive healthy checks:")
        lines.extend(f"- {item_id}" for item_id in recovered)
    content = "\n".join(lines)
    if len(content.encode("utf-16-le")) // 2 <= 1900:
        return content
    truncated = []
    length = 0
    for character in content:
        units = len(character.encode("utf-16-le")) // 2
        if length + units > 1897:
            break
        truncated.append(character)
        length += units
    return "".join(truncated) + "..."


def _safe_notification_error(error: Any, webhook: str) -> str:
    message = str(error or "unknown error")
    if webhook:
        message = message.replace(webhook, "[redacted webhook]")
    return re.sub(r"https?://\S+", "[redacted URL]", message)[:300]


def apply_critical_notification(
    snapshot: dict[str, Any], previous: dict[str, Any]
) -> dict[str, Any]:
    webhook = os.environ.get("DIVA_ALERT_WEBHOOK_URL")
    current_ids = {item["id"] for item in snapshot["critical"]}
    previous_notified_ids = previous.get("notifiedCriticalIds")
    if not isinstance(previous_notified_ids, list):
        previous_notified_ids = []
    known_ids = list(dict.fromkeys(item_id for item_id in previous_notified_ids if isinstance(item_id, str)))
    if previous.get("notificationSchemaVersion") != 2:
        known_ids = [item_id for item_id in known_ids if item_id in current_ids]
    notified_id_set = set(known_ids)
    previous_message_id = _discord_message_id(previous.get("lastDiscordMessageId"))
    notification_state = {
        **snapshot,
        "notifiedCriticalIds": known_ids,
        "notificationSchemaVersion": 2,
        **({"lastDiscordMessageId": previous_message_id} if previous_message_id else {}),
    }
    newly_critical = [
        item for item in snapshot["critical"] if item["id"] not in notified_id_set
    ]
    recovered = sorted(notified_id_set - current_ids)
    if not webhook:
        return {**notification_state, "notificationStatus": "disabled"}
    if not newly_critical and not recovered:
        return {**notification_state, "notificationStatus": "up-to-date"}

    payload = json.dumps(
        {
            "content": _discord_content(snapshot, newly_critical, recovered),
            "allowed_mentions": {"parse": []},
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    webhook_request = urllib_request.Request(
        _discord_wait_url(webhook),
        data=payload,
        headers={
            "content-type": "application/json",
            "user-agent": "DIVA-Player-Runtime-Health/1.0",
        },
        method="POST",
    )
    try:
        with urllib_request.urlopen(webhook_request, timeout=10) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError(f"HTTP {response.status}")
            try:
                discord_message = json.loads(response.read())
            except (TypeError, ValueError, json.JSONDecodeError):
                raise RuntimeError("Discord response was not JSON") from None
        message_id = _discord_message_id(
            discord_message.get("id") if isinstance(discord_message, dict) else None
        )
        if not message_id:
            raise RuntimeError("Discord response did not include a message id")
        return {
            **snapshot,
            "notifiedCriticalIds": sorted(current_ids),
            "notificationSchemaVersion": 2,
            "lastDiscordMessageId": message_id,
            "notificationStatus": "sent",
        }
    except Exception as exc:
        message = f"HTTP {exc.code}" if isinstance(exc, urllib_error.HTTPError) else exc
        return {
            **notification_state,
            "notificationStatus": "failed",
            "notificationError": _safe_notification_error(message, webhook),
        }


def _environment_number(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw.strip())
    except ValueError:
        return math.nan


def main() -> int:
    configured_state_dir = os.environ.get("DIVA_RUNTIME_STATE_DIR")
    state_dir = (
        Path(configured_state_dir)
        if configured_state_dir
        else Path.home() / ".local" / "state" / "diva-player"
    )
    latest_path = state_dir / "runtime_health_latest.json"
    history_path = state_dir / "runtime_health_history.jsonl"
    previous = load_json(latest_path)
    now = datetime.now(timezone.utc)
    collected = collect_snapshot()
    probes = collect_public_probes(now)
    audio_cache_probe = _probe_audio_cache_retention()
    if audio_cache_probe is not None:
        probes["cache:audio-retention"] = {
            **audio_cache_probe,
            "ok": audio_cache_probe.get("status") in {"success", "empty"}
            and audio_cache_probe.get("error") in {None, "operational-log-budget-exceeded"},
        }
        probes["capacity:ops-logs"] = {
            "ok": not audio_cache_probe.get("logCapacityPressure"),
            "status": "over-budget" if audio_cache_probe.get("logCapacityPressure") else "within-budget",
            "error": audio_cache_probe.get("error") if audio_cache_probe.get("logCapacityPressure") else None,
            "operationalLogBytes": audio_cache_probe.get("operationalLogBytes"),
        }
    public_state, public_violations, _ = advance_public_monitor(probes, previous, now=now)
    collected["publicMonitor"] = public_state
    collected["externalHealthViolations"] = public_violations
    snapshot = evaluate_runtime_snapshot(
        collected,
        previous,
        {
            "apiRssWarnMiB": _environment_number(
                "DIVA_RUNTIME_API_RSS_WARN_MIB", 384
            ),
            "dbConnectionsWarn": _environment_number(
                "DIVA_RUNTIME_DB_CONNECTIONS_WARN", 28
            ),
            "diskUsedWarnPercent": _environment_number(
                "DIVA_RUNTIME_DISK_USED_WARN_PERCENT", 85
            ),
            "hostAvailableWarnPercent": _environment_number(
                "DIVA_RUNTIME_HOST_AVAILABLE_WARN_PERCENT", 10
            ),
        },
    )
    active_public_ids = {item["id"] for item in public_violations}
    critical_by_id = {item["id"]: item for item in snapshot["critical"]}
    critical_by_id.update({item["id"]: item for item in public_violations if item["id"] in active_public_ids and public_state["checks"].get(item["id"], {}).get("active") is True})
    snapshot["critical"] = list(critical_by_id.values())
    snapshot["violations"] = list({item["id"]: item for item in [*snapshot["violations"], *public_violations]}.values())
    if snapshot["critical"]:
        snapshot["status"] = "critical"
    elif snapshot["violations"]:
        snapshot["status"] = "warning"
    else:
        snapshot["status"] = "ok"
    # Notification failures are recorded without suppressing the local state.
    # notifiedCriticalIds advances only after delivery, so the next timer run
    # retries while still avoiding duplicate alerts after a successful send.
    snapshot = apply_critical_notification(snapshot, previous)
    write_json_atomic(latest_path, snapshot)
    rotate_history_if_needed(
        history_path,
        _environment_number("DIVA_RUNTIME_HISTORY_MAX_BYTES", 20 * 1024 * 1024),
    )
    with history_path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(
            json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n"
        )
    print(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")))
    if snapshot["status"] == "critical":
        return 2
    if snapshot["notificationStatus"] == "failed":
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
