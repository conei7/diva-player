#!/usr/bin/env python3
"""Production-path tests for the SBC published-container runtime contract."""

from __future__ import annotations

import copy
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("sbc-runtime-contract.py")
SPEC = importlib.util.spec_from_file_location("sbc_runtime_contract", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load the SBC runtime contract helper")
CONTRACT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTRACT)


IMAGE_ID = "sha256:" + "a" * 64
CONTAINER_ID = "b" * 64


def inspect_document(service: str, *, published: bool = True) -> dict:
    contract = {
        "api_a": ("vocadb_api_a", "", 805306368, 268435456, 256, "64m", "1654"),
        "api_b": ("vocadb_api_b", "", 805306368, 268435456, 256, "64m", "1654"),
        "api_gateway": (
            "vocadb_api_gateway",
            "5000",
            268435456,
            67108864,
            128,
            "16m",
            "haproxy",
        ),
        "web": ("vocadb_web", "8080", 268435456, 67108864, 128, "16m", "101:101"),
    }[service]
    name, port, memory, reservation, pids, tmpfs_size, user = contract
    reference = {
        "api_a": "diva-player-api:local",
        "api_b": "diva-player-api:local",
        "api_gateway": "diva-player-api-gateway:local",
        "web": "diva-player-web:local",
    }[service]
    if published:
        reference = IMAGE_ID
    health_command = (
        "wget -q -O /dev/null http://127.0.0.1:8080/backend-api/api/ready"
        if service == "web"
        else "wget -q -T 5 -O /dev/null http://127.0.0.1:5000/api/ready"
    )
    bindings = {}
    if published and port:
        bindings[f"{port}/tcp"] = [{"HostIp": "0.0.0.0", "HostPort": port}]
    return {
        "Id": CONTAINER_ID,
        "Name": "/" + name,
        "Image": IMAGE_ID,
        "Config": {
            "Hostname": name if published else "candidate",
            "Domainname": "",
            "AttachStdin": False,
            "OpenStdin": False,
            "StdinOnce": False,
            "User": user,
            "Env": [f"DIVA_SLOT={service}", "TZ=Asia/Tokyo"],
            "Image": reference,
            "Entrypoint": ["/entrypoint"],
            "Cmd": ["serve"],
            "WorkingDir": "/app",
            "ExposedPorts": {f"{port or '5000'}/tcp": {}},
            "Healthcheck": {
                "Test": ["CMD-SHELL", health_command],
                "Interval": 5_000_000_000,
                "Timeout": 6_000_000_000,
                "Retries": 12,
                "StartPeriod": 5_000_000_000,
            },
            "Labels": {
                "com.docker.compose.config-hash": f"{service}-config",
                "com.docker.compose.container-number": "1",
                "com.docker.compose.image": IMAGE_ID,
                "com.docker.compose.oneoff": "False",
                "com.docker.compose.project": "backend",
                "com.docker.compose.service": service,
            },
        },
        "HostConfig": {
            "ReadonlyRootfs": True,
            "CapDrop": ["ALL"],
            "CapAdd": None,
            "SecurityOpt": ["no-new-privileges=true"],
            "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0},
            "Memory": memory,
            "MemoryReservation": reservation,
            "PidsLimit": pids,
            "Tmpfs": {"/tmp": f"size={tmpfs_size},mode=1777"},
            "NetworkMode": "backend_default" if published else "candidate_default",
            "PortBindings": bindings,
            "LogConfig": {"Type": "json-file", "Config": {"max-file": "5", "max-size": "10m"}},
            "BlkioDeviceReadBps": None,
            "BlkioDeviceReadIOps": None,
            "BlkioDeviceWriteBps": None,
            "BlkioDeviceWriteIOps": None,
            "BlkioWeightDevice": None,
            "Devices": None,
            "DnsOptions": None,
            "DnsSearch": None,
            "ExtraHosts": None,
            "OomKillDisable": None,
            "Ulimits": None,
        },
        "NetworkSettings": {
            "Networks": {
                "backend_default": {
                    "Aliases": [service, name],
                }
            }
        },
    }


class RuntimeContractTests(unittest.TestCase):
    def environment_file(self, root: Path, document: dict) -> Path:
        path = root / "candidate.env"
        CONTRACT.write_environment_contract(document, str(path))
        if os.name == "posix":
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        return path

    def verify(self, document: dict, service: str, environment: Path) -> None:
        CONTRACT.verify_published(
            document,
            service=service,
            expected_id=CONTAINER_ID,
            expected_reference=IMAGE_ID,
            expected_image_id=IMAGE_ID,
            expected_config_hash=f"{service}-config",
            environment_path=str(environment),
            expected_restart="no",
        )

    def test_candidate_and_published_runtime_projection_match(self) -> None:
        candidate = inspect_document("api_gateway", published=False)
        published = inspect_document("api_gateway", published=True)
        candidate["Config"]["AttachStdin"] = True
        candidate["Config"]["OpenStdin"] = True
        candidate["Config"]["StdinOnce"] = True
        candidate["Config"]["Env"].reverse()
        for field in (
            "BlkioDeviceReadBps",
            "BlkioDeviceReadIOps",
            "BlkioDeviceWriteBps",
            "BlkioDeviceWriteIOps",
            "BlkioWeightDevice",
            "Devices",
            "DnsOptions",
            "DnsSearch",
            "ExtraHosts",
            "Ulimits",
        ):
            candidate["HostConfig"][field] = []
        candidate["HostConfig"]["OomKillDisable"] = False
        self.assertEqual(
            CONTRACT.runtime_fingerprint(candidate),
            CONTRACT.runtime_fingerprint(published),
        )

    def test_api_slots_keep_distinct_environment_contracts(self) -> None:
        api_a = inspect_document("api_a")
        api_b = inspect_document("api_b")
        self.assertNotEqual(
            CONTRACT.runtime_fingerprint(api_a),
            CONTRACT.runtime_fingerprint(api_b),
        )

    def test_exact_published_contract_accepts_all_services(self) -> None:
        for service in ("api_a", "api_b", "api_gateway", "web"):
            with self.subTest(service=service), tempfile.TemporaryDirectory() as temporary:
                document = inspect_document(service)
                environment = self.environment_file(Path(temporary), document)
                self.verify(document, service, environment)

    def test_security_and_runtime_drift_is_rejected(self) -> None:
        mutations = {
            "environment": lambda value: value["Config"].__setitem__("Env", ["DIVA_SLOT=tampered"]),
            "image-reference": lambda value: value["Config"].__setitem__(
                "Image", "diva-player-api:mutable"
            ),
            "root-user": lambda value: value["Config"].__setitem__("User", "0"),
            "health-form": lambda value: value["Config"]["Healthcheck"].__setitem__(
                "Test", ["CMD", "curl", "-f", "http://127.0.0.1:5000/api/ready"]
            ),
            "port-binding": lambda value: value["HostConfig"].__setitem__(
                "PortBindings", {"5000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5001"}]}
            ),
            "restart-policy": lambda value: value["HostConfig"].__setitem__(
                "RestartPolicy", {"Name": "always", "MaximumRetryCount": 0}
            ),
            "cap-drop": lambda value: value["HostConfig"].__setitem__("CapDrop", []),
            "stdin": lambda value: value["Config"].__setitem__("OpenStdin", True),
            "device": lambda value: value["HostConfig"].__setitem__(
                "Devices", [{"PathOnHost": "/dev/null", "PathInContainer": "/dev/null"}]
            ),
            "ulimit": lambda value: value["HostConfig"].__setitem__(
                "Ulimits", [{"Name": "nofile", "Soft": 1024, "Hard": 1024}]
            ),
            "oom-kill-disable": lambda value: value["HostConfig"].__setitem__(
                "OomKillDisable", True
            ),
        }
        baseline = inspect_document("api_gateway")
        expected_runtime = CONTRACT.runtime_fingerprint(baseline)
        with tempfile.TemporaryDirectory() as temporary:
            environment = self.environment_file(Path(temporary), baseline)
            for label, mutate in mutations.items():
                with self.subTest(label=label):
                    changed = copy.deepcopy(baseline)
                    mutate(changed)
                    if CONTRACT.runtime_fingerprint(changed) != expected_runtime:
                        continue
                    with self.assertRaises(ValueError):
                        self.verify(changed, "api_gateway", environment)


if __name__ == "__main__":
    unittest.main()
