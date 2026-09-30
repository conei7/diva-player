#!/usr/bin/env python3
"""Sample isolated PostgreSQL volume and filesystem usage into a small receipt."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import stat
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CONTAINER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
SAMPLE_COMMAND = "du -sk /var/lib/postgresql/data; df -Pk /var/lib/postgresql/data"


class ResourceMonitorError(RuntimeError):
    """The isolated restore resource report cannot be trusted."""


def parse_sample(output: str, *, sampled_at: str | None = None) -> dict[str, Any]:
    lines = [line.split() for line in output.splitlines() if line.strip()]
    if len(lines) < 3 or len(lines[0]) < 2 or len(lines[-1]) < 6:
        raise ResourceMonitorError("Docker returned incomplete PostgreSQL resource usage")
    try:
        volume_kib = int(lines[0][0])
        total_kib, used_kib, available_kib = (int(lines[-1][index]) for index in (1, 2, 3))
    except ValueError as error:
        raise ResourceMonitorError("Docker returned invalid PostgreSQL resource usage") from error
    volume_bytes = volume_kib * 1024
    total_bytes, used_bytes, available_bytes = (
        total_kib * 1024,
        used_kib * 1024,
        available_kib * 1024,
    )
    if volume_bytes <= 0 or total_bytes <= 0 or used_bytes < 0 or available_bytes < 0:
        raise ResourceMonitorError("Docker returned non-positive PostgreSQL resource usage")
    if used_bytes + available_bytes > total_bytes:
        raise ResourceMonitorError("Docker returned inconsistent PostgreSQL filesystem usage")
    return {
        "sampledAt": sampled_at or datetime.now(timezone.utc).isoformat(),
        "candidateVolumeBytes": volume_bytes,
        "filesystemTotalBytes": total_bytes,
        "filesystemUsedBytes": used_bytes,
        "filesystemAvailableBytes": available_bytes,
    }


def _read_summary(path: Path, *, append: bool) -> dict[str, Any]:
    if path.is_symlink():
        raise ResourceMonitorError("resource usage output must not be a symlink")
    if append:
        if not path.is_file():
            raise ResourceMonitorError("resource usage summary is missing before append")
        metadata = path.stat()
        if os.name != "nt" and (
            metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600
        ):
            raise ResourceMonitorError("resource usage summary must be root-owned mode 0600")
        try:
            summary = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ResourceMonitorError("resource usage summary is invalid") from error
        if not isinstance(summary, dict) or summary.get("schemaVersion") != 1:
            raise ResourceMonitorError("resource usage summary has an unsupported schema")
        return summary
    if path.exists():
        raise ResourceMonitorError("resource usage output must be a new file")
    return {
        "schemaVersion": 1,
        "sampleCount": 0,
        "peakCandidateVolumeBytes": 0,
        "peakFilesystemUsedBytes": 0,
        "filesystemTotalBytes": 0,
        "filesystemAvailableBytesBeforeRestore": None,
        "firstSampleAt": None,
        "lastSampleAt": None,
    }


def _write_summary(path: Path, summary: dict[str, Any]) -> None:
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(summary, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError as error:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise ResourceMonitorError("could not update the private resource usage summary") from error


def _sample_container(container: str) -> dict[str, Any] | None:
    try:
        result = subprocess.run(
            ["docker", "exec", container, "sh", "-c", SAMPLE_COMMAND],
            check=False,
            timeout=15,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        return parse_sample(result.stdout)
    except ResourceMonitorError:
        return None


def _record_sample(path: Path, summary: dict[str, Any], sample: dict[str, Any]) -> None:
    summary["sampleCount"] = int(summary.get("sampleCount", 0)) + 1
    summary["peakCandidateVolumeBytes"] = max(
        int(summary.get("peakCandidateVolumeBytes", 0)), sample["candidateVolumeBytes"]
    )
    summary["peakFilesystemUsedBytes"] = max(
        int(summary.get("peakFilesystemUsedBytes", 0)), sample["filesystemUsedBytes"]
    )
    summary["filesystemTotalBytes"] = sample["filesystemTotalBytes"]
    summary["filesystemAvailableBytes"] = sample["filesystemAvailableBytes"]
    summary["firstSampleAt"] = summary.get("firstSampleAt") or sample["sampledAt"]
    summary["lastSampleAt"] = sample["sampledAt"]
    _write_summary(path, summary)


def run_monitor(container: str, output: Path, *, interval_seconds: float, append: bool) -> int:
    if not CONTAINER_NAME.fullmatch(container):
        raise ResourceMonitorError("candidate PostgreSQL container name is invalid")
    if not 1 <= interval_seconds <= 60:
        raise ResourceMonitorError("resource sampling interval must be between 1 and 60 seconds")
    parent = output.parent
    if not parent.is_dir() or parent.is_symlink():
        raise ResourceMonitorError("resource usage output directory must be a real directory")
    if os.name != "nt":
        metadata = parent.stat()
        if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) & 0o077:
            raise ResourceMonitorError("resource usage output directory must be owner-only")

    summary = _read_summary(output, append=append)
    initial_count = int(summary.get("sampleCount", 0))
    _write_summary(output, summary)
    stop = threading.Event()
    parent_pid = os.getppid()
    signal.signal(signal.SIGTERM, lambda _signal, _frame: stop.set())
    signal.signal(signal.SIGINT, lambda _signal, _frame: stop.set())

    while not stop.is_set():
        if os.getppid() != parent_pid:
            stop.set()
            continue
        sample = _sample_container(container)
        if sample is not None:
            _record_sample(output, summary, sample)
        if stop.wait(interval_seconds):
            sample = _sample_container(container)
            if sample is not None:
                _record_sample(output, summary, sample)
            break
    return 0 if int(summary["sampleCount"]) > initial_count else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--interval-seconds", type=float, default=10)
    parser.add_argument("--append", action="store_true")
    args = parser.parse_args()
    try:
        return run_monitor(
            args.container,
            args.output,
            interval_seconds=args.interval_seconds,
            append=args.append,
        )
    except (ResourceMonitorError, OSError, ValueError, TypeError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
