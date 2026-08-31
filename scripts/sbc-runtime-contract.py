#!/usr/bin/env python3
"""Canonical runtime projection and exact published-container verification."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


def _load_inspect(path: str) -> dict[str, Any]:
    payload = Path(path).read_bytes()
    if len(payload) > 4 * 1024 * 1024:
        raise ValueError("Docker inspect output is too large")
    document = json.loads(payload)
    if (
        not isinstance(document, list)
        or len(document) != 1
        or not isinstance(document[0], dict)
    ):
        raise ValueError("Docker inspect output must contain exactly one object")
    return document[0]


def runtime_projection(item: dict[str, Any]) -> dict[str, Any]:
    config = item.get("Config")
    host = item.get("HostConfig")
    if not isinstance(config, dict) or not isinstance(host, dict):
        raise ValueError("Docker inspect Config/HostConfig is missing")
    config = dict(config)
    host = dict(host)
    # These fields intentionally differ between an unexposed candidate and
    # its canonical published container. Env, Healthcheck, User, entrypoint,
    # command, resources, caps, tmpfs, logging, and stop contract remain bound.
    config.pop("Hostname", None)
    config.pop("Domainname", None)
    config.pop("Labels", None)
    host.pop("NetworkMode", None)
    host.pop("PortBindings", None)
    # Candidate containers are intentionally created with restart=no.  The
    # deployment commits unless-stopped only after all published identities
    # pass their final checks, so restart policy is verified explicitly at
    # each phase instead of weakening the rest of the runtime fingerprint.
    host.pop("RestartPolicy", None)
    return {"Config": config, "HostConfig": host}


def runtime_fingerprint(item: dict[str, Any]) -> str:
    encoded = json.dumps(
        runtime_projection(item),
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _load_environment(path: str) -> list[str]:
    values: list[str] = []
    for raw_line in Path(path).read_text(encoding="utf-8").splitlines():
        if not raw_line:
            continue
        key, separator, value = raw_line.partition("=")
        if (
            separator != "="
            or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) is None
            or "\x00" in value
            or "\r" in value
            or "\n" in value
        ):
            raise ValueError("invalid private environment contract")
        values.append(f"{key}={value}")
    return _load_environment_lines(values)


def write_environment_contract(item: dict[str, Any], destination: str) -> None:
    config = item.get("Config")
    environment = config.get("Env") if isinstance(config, dict) else None
    if not isinstance(environment, list) or not all(isinstance(value, str) for value in environment):
        raise ValueError("Docker inspect environment is invalid")
    normalized = _load_environment_lines(environment)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(destination, flags, 0o600)
    os.set_inheritable(fd, False)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n", closefd=False) as handle:
            for value in normalized:
                handle.write(value + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(fd)


def _load_environment_lines(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        key, separator, remainder = value.partition("=")
        if (
            separator != "="
            or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) is None
            or key in seen
            or any(mark in remainder for mark in ("\x00", "\r", "\n"))
        ):
            raise ValueError("invalid Docker environment contract")
        seen.add(key)
        result.append(value)
    return sorted(result)


def verify_published(
    item: dict[str, Any],
    *,
    service: str,
    expected_id: str,
    expected_reference: str,
    expected_image_id: str,
    expected_config_hash: str,
    environment_path: str,
    expected_restart: str,
) -> None:
    service_contract = {
        "api_a": {
            "name": "vocadb_api_a",
            "memory": 805306368,
            "reservation": 268435456,
            "pids": 256,
            "published": "",
            "tmpfs": "/tmp:size=64m,mode=1777",
            "user": "",
        },
        "api_b": {
            "name": "vocadb_api_b",
            "memory": 805306368,
            "reservation": 268435456,
            "pids": 256,
            "published": "",
            "tmpfs": "/tmp:size=64m,mode=1777",
            "user": "",
        },
        "api_gateway": {
            "name": "vocadb_api_gateway",
            "memory": 268435456,
            "reservation": 67108864,
            "pids": 128,
            "published": "5000",
            "tmpfs": "/tmp:size=16m,mode=1777",
            "user": "",
        },
        "web": {
            "name": "vocadb_web",
            "memory": 268435456,
            "reservation": 67108864,
            "pids": 128,
            "published": "8080",
            "tmpfs": "/tmp:size=16m,mode=1777",
            "user": "101:101",
        },
    }.get(service)
    if service_contract is None:
        raise ValueError("unknown service")
    config = item.get("Config")
    host = item.get("HostConfig")
    networks = (item.get("NetworkSettings") or {}).get("Networks")
    if not isinstance(config, dict) or not isinstance(host, dict) or not isinstance(networks, dict):
        raise ValueError("runtime structure is invalid")
    name = service_contract["name"]
    labels = config.get("Labels")
    expected_labels = {
        "com.docker.compose.config-hash": expected_config_hash,
        "com.docker.compose.container-number": "1",
        "com.docker.compose.image": expected_image_id,
        "com.docker.compose.oneoff": "False",
        "com.docker.compose.project": "backend",
        "com.docker.compose.service": service,
    }
    if (
        item.get("Id") != expected_id
        or item.get("Name") != "/" + name
        or item.get("Image") != expected_image_id
        or config.get("Image") != expected_reference
        or not isinstance(labels, dict)
        or any(labels.get(key) != value for key, value in expected_labels.items())
        or config.get("User", "") != service_contract["user"]
    ):
        raise ValueError("identity/image/label/user contract mismatch")
    expected_env = _load_environment(environment_path)
    actual_env = config.get("Env")
    if not isinstance(actual_env, list) or _load_environment_lines(actual_env) != expected_env:
        raise ValueError("environment contract mismatch")
    if (
        host.get("ReadonlyRootfs") is not True
        or sorted(host.get("CapDrop") or []) != ["ALL"]
        or host.get("CapAdd") not in (None, [])
        or sorted(host.get("SecurityOpt") or []) != ["no-new-privileges=true"]
        or host.get("RestartPolicy", {}).get("Name") != expected_restart
        or host.get("Memory") != service_contract["memory"]
        or host.get("MemoryReservation") != service_contract["reservation"]
        or host.get("PidsLimit") != service_contract["pids"]
    ):
        raise ValueError("host security/resource contract mismatch")
    tmpfs = host.get("Tmpfs") or {}
    if tmpfs != {"/tmp": service_contract["tmpfs"]}:
        raise ValueError("tmpfs contract mismatch")
    bindings = host.get("PortBindings") or {}
    published = service_contract["published"]
    if not published:
        if bindings:
            raise ValueError("unpublished API gained a host port")
    else:
        key = published + "/tcp"
        if (
            set(bindings) != {key}
            or not isinstance(bindings[key], list)
            or not bindings[key]
            or any(
                not isinstance(binding, dict)
                or binding.get("HostPort") != published
                or binding.get("HostIp", "") not in ("", "0.0.0.0")
                for binding in bindings[key]
            )
        ):
            raise ValueError("published port contract mismatch")
    network = networks.get("backend_default")
    aliases = network.get("Aliases") if isinstance(network, dict) else None
    if (
        set(networks) != {"backend_default"}
        or not isinstance(aliases, list)
        or not {service, name}.issubset(set(aliases))
    ):
        raise ValueError("network/alias contract mismatch")


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "fingerprint":
        print(runtime_fingerprint(_load_inspect(argv[2])))
        return 0
    if len(argv) == 10 and argv[1] == "verify":
        verify_published(
            _load_inspect(argv[2]),
            service=argv[3],
            expected_id=argv[4],
            expected_reference=argv[5],
            expected_image_id=argv[6],
            expected_config_hash=argv[7],
            environment_path=argv[8],
            expected_restart=argv[9],
        )
        return 0
    if len(argv) == 4 and argv[1] == "environment":
        write_environment_contract(_load_inspect(argv[2]), argv[3])
        return 0
    return 64


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except (OSError, ValueError, json.JSONDecodeError):
        raise SystemExit(2)
