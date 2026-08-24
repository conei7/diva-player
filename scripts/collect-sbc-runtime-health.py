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
import traceback
from typing import Any, Callable
from urllib import error as urllib_error
from urllib import request as urllib_request


DEFAULT_CONTAINERS = [
    "vocadb_api_a",
    "vocadb_api_b",
    "vocadb_api_gateway",
    "vocadb_postgres",
    "vocadb_qdrant",
]
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


def apply_critical_notification(
    snapshot: dict[str, Any], previous: dict[str, Any]
) -> dict[str, Any]:
    webhook = os.environ.get("DIVA_ALERT_WEBHOOK_URL")
    current_ids = {item["id"] for item in snapshot["critical"]}
    previous_notified_ids = previous.get("notifiedCriticalIds")
    if not isinstance(previous_notified_ids, list):
        previous_notified_ids = []
    notified_ids = []
    for item_id in previous_notified_ids:
        if item_id in current_ids and item_id not in notified_ids:
            notified_ids.append(item_id)
    notified_id_set = set(notified_ids)
    newly_critical = [
        item for item in snapshot["critical"] if item["id"] not in notified_id_set
    ]
    if not webhook:
        return {
            **snapshot,
            "notifiedCriticalIds": notified_ids,
            "notificationStatus": "disabled",
        }
    if not newly_critical:
        return {
            **snapshot,
            "notifiedCriticalIds": notified_ids,
            "notificationStatus": "up-to-date",
        }

    payload = json.dumps(
        {
            "event": "diva_runtime_health",
            "status": snapshot["status"],
            "checkedAt": snapshot["checkedAt"],
            "critical": newly_critical,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    webhook_request = urllib_request.Request(
        webhook,
        data=payload,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(webhook_request, timeout=10) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError(f"HTTP {response.status}")
        for item in newly_critical:
            if item["id"] not in notified_id_set:
                notified_ids.append(item["id"])
                notified_id_set.add(item["id"])
        return {
            **snapshot,
            "notifiedCriticalIds": notified_ids,
            "notificationStatus": "sent",
        }
    except Exception as exc:
        if isinstance(exc, urllib_error.HTTPError):
            message = f"HTTP {exc.code}"
        else:
            message = str(exc or "unknown error")
        return {
            **snapshot,
            "notifiedCriticalIds": notified_ids,
            "notificationStatus": "failed",
            "notificationError": message[:300],
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
    snapshot = evaluate_runtime_snapshot(
        collect_snapshot(),
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
