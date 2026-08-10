#!/usr/bin/env python3
"""Contract tests for the dependency-free SBC runtime-health collector."""

from __future__ import annotations

from contextlib import redirect_stdout
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest import mock


COLLECTOR_PATH = Path(__file__).with_name("collect-sbc-runtime-health.py")
COLLECTOR = types.ModuleType("collect_sbc_runtime_health")
COLLECTOR.__file__ = str(COLLECTOR_PATH)
exec(
    compile(COLLECTOR_PATH.read_bytes(), str(COLLECTOR_PATH), "exec"),
    COLLECTOR.__dict__,
)


class RuntimeHealthCollectorContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base_snapshot = {
            "checkedAt": "2026-08-10T00:00:00.000Z",
            "containers": [
                {
                    "name": "vocadb_api_a",
                    "health": "healthy",
                    "memoryUsedBytes": 400 * 1024**2,
                },
                {
                    "name": "vocadb_api_b",
                    "health": "healthy",
                    "memoryUsedBytes": 100 * 1024**2,
                },
            ],
            "postgres": {"total": 30, "active": 1, "applications": []},
            "haproxy": [
                {"slot": "api_a", "status": "UP", "currentSessions": 0},
                {"slot": "api_b", "status": "UP", "currentSessions": 0},
            ],
            "disk": {"usedPercent": 70},
        }

    def test_byte_size_and_docker_stats_parsers(self) -> None:
        self.assertEqual(COLLECTOR.parse_byte_size("129.8MiB"), 129.8 * 1024**2)
        self.assertEqual(COLLECTOR.parse_byte_size("1.5 GiB"), 1.5 * 1024**3)
        self.assertIsNone(COLLECTOR.parse_byte_size("invalid"))
        output = "\n".join(
            [
                json.dumps(
                    {
                        "Name": "vocadb_api_a",
                        "CPUPerc": "1.2%",
                        "MemUsage": "129.8MiB / 1GiB",
                        "MemPerc": "12.68%",
                        "PIDs": "18",
                    }
                ),
                json.dumps(
                    {
                        "Name": "vocadb_api_b",
                        "CPUPerc": "0%",
                        "MemUsage": "82.41MiB / 1GiB",
                        "MemPerc": "8.05%",
                        "PIDs": "17",
                    }
                ),
                "{not-json}",
            ]
        )
        containers = COLLECTOR.parse_docker_stats(output)
        self.assertEqual(len(containers), 2)
        self.assertEqual(containers[0]["memoryLimitBytes"], 1024**3)
        self.assertEqual(containers[1]["pids"], 17)

    def test_container_postgres_and_haproxy_parsers(self) -> None:
        self.assertEqual(
            COLLECTOR.parse_container_health(
                "/vocadb_api_a\thealthy\n/vocadb_api_b\trunning\n"
            ),
            {"vocadb_api_a": "healthy", "vocadb_api_b": "running"},
        )
        self.assertEqual(
            COLLECTOR.parse_postgres_activity(
                "diva-api-a\t1\t8\ndiva-api-b\t0\t7\n"
            ),
            {
                "applications": [
                    {"applicationName": "diva-api-a", "active": 1, "total": 8},
                    {"applicationName": "diva-api-b", "active": 0, "total": 7},
                ],
                "active": 1,
                "total": 15,
            },
        )
        self.assertEqual(
            COLLECTOR.parse_haproxy_stats(
                "\n".join(
                    [
                        "# pxname,svname,scur,status,",
                        "api_nodes,api_a,2,UP,",
                        "api_nodes,api_b,0,MAINT,",
                        "api_front,FRONTEND,2,OPEN,",
                    ]
                )
            ),
            [
                {"slot": "api_a", "status": "UP", "currentSessions": 2},
                {"slot": "api_b", "status": "MAINT", "currentSessions": 0},
            ],
        )

    def test_two_consecutive_violations_become_critical_and_recover(self) -> None:
        warning = COLLECTOR.evaluate_runtime_snapshot(self.base_snapshot)
        self.assertEqual(warning["status"], "warning")
        self.assertEqual(
            sorted(item["id"] for item in warning["violations"]),
            ["memory:vocadb_api_a", "postgres:connections"],
        )
        critical = COLLECTOR.evaluate_runtime_snapshot(self.base_snapshot, warning)
        self.assertEqual(critical["status"], "critical")
        self.assertEqual(len(critical["critical"]), 2)
        recovered_snapshot = copy.deepcopy(self.base_snapshot)
        recovered_snapshot["containers"][0]["memoryUsedBytes"] = 100 * 1024**2
        recovered_snapshot["postgres"]["total"] = 10
        recovered = COLLECTOR.evaluate_runtime_snapshot(recovered_snapshot, critical)
        self.assertEqual(recovered["status"], "ok")
        self.assertEqual(recovered["consecutiveViolations"], {})

    def test_collection_failures_and_missing_haproxy_slot_are_violations(self) -> None:
        failure_snapshot = copy.deepcopy(self.base_snapshot)
        failure_snapshot["collectionErrors"] = [
            {"source": "postgres", "error": "connection refused"}
        ]
        failure_snapshot["postgres"] = {
            "total": None,
            "active": None,
            "applications": [],
            "error": "connection refused",
        }
        failure_snapshot["haproxy"] = [
            {"slot": "api_a", "status": "UP", "currentSessions": 0}
        ]
        failure_snapshot["disk"] = {
            "usedPercent": None,
            "error": "unavailable",
        }
        evaluated = COLLECTOR.evaluate_runtime_snapshot(failure_snapshot)
        violation_ids = {item["id"] for item in evaluated["violations"]}
        self.assertIn("collector:postgres", violation_ids)
        self.assertIn("haproxy:api_b", violation_ids)

    def test_history_rotation_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory(prefix="diva-runtime-health-") as directory:
            history_path = Path(directory) / "runtime.jsonl"
            history_path.write_text("old-history\n", encoding="utf-8")
            self.assertTrue(COLLECTOR.rotate_history_if_needed(history_path, 4))
            self.assertEqual(
                Path(f"{history_path}.1").read_text(encoding="utf-8"),
                "old-history\n",
            )
            history_path.write_text("new\n", encoding="utf-8")
            self.assertFalse(COLLECTOR.rotate_history_if_needed(history_path, 100))
            with self.assertRaisesRegex(ValueError, "must be a positive number"):
                COLLECTOR.rotate_history_if_needed(history_path, 0)

    def test_main_persists_same_state_and_exit_code_contract(self) -> None:
        with tempfile.TemporaryDirectory(prefix="diva-runtime-health-") as directory:
            environment = {
                "DIVA_RUNTIME_STATE_DIR": directory,
                "DIVA_RUNTIME_HISTORY_MAX_BYTES": "1048576",
            }
            output = io.StringIO()
            with (
                mock.patch.dict(os.environ, environment, clear=True),
                mock.patch.object(
                    COLLECTOR,
                    "collect_snapshot",
                    side_effect=lambda: copy.deepcopy(self.base_snapshot),
                ),
                redirect_stdout(output),
            ):
                self.assertEqual(COLLECTOR.main(), 0)
                self.assertEqual(COLLECTOR.main(), 2)

            latest_path = Path(directory) / "runtime_health_latest.json"
            history_path = Path(directory) / "runtime_health_history.jsonl"
            latest = json.loads(latest_path.read_text(encoding="utf-8"))
            history = [
                json.loads(line)
                for line in history_path.read_text(encoding="utf-8").splitlines()
            ]
            stdout_snapshots = [
                json.loads(line) for line in output.getvalue().splitlines()
            ]
            self.assertEqual(latest["status"], "critical")
            self.assertEqual(latest["notificationStatus"], "disabled")
            self.assertEqual([item["status"] for item in history], ["warning", "critical"])
            self.assertEqual(stdout_snapshots, history)

    def test_collection_failure_is_still_persisted(self) -> None:
        failed_snapshot = copy.deepcopy(self.base_snapshot)
        failed_snapshot["containers"][0]["memoryUsedBytes"] = 100 * 1024**2
        failed_snapshot["postgres"] = {
            "applications": [],
            "active": 0,
            "total": 0,
            "error": "connection refused",
        }
        failed_snapshot["collectionErrors"] = [
            {"source": "postgres", "error": "connection refused"}
        ]

        with tempfile.TemporaryDirectory(prefix="diva-runtime-health-") as directory:
            with (
                mock.patch.dict(
                    os.environ,
                    {"DIVA_RUNTIME_STATE_DIR": directory},
                    clear=True,
                ),
                mock.patch.object(
                    COLLECTOR,
                    "collect_snapshot",
                    return_value=failed_snapshot,
                ),
                redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(COLLECTOR.main(), 0)

            latest = json.loads(
                (Path(directory) / "runtime_health_latest.json").read_text(
                    encoding="utf-8"
                )
            )
            history = [
                json.loads(line)
                for line in (
                    Path(directory) / "runtime_health_history.jsonl"
                ).read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(latest["status"], "warning")
            self.assertEqual(
                latest["collectionErrors"],
                [{"source": "postgres", "error": "connection refused"}],
            )
            self.assertEqual(history, [latest])

    def test_key_json_shapes_match_javascript_reference(self) -> None:
        fixture = {
            "dockerStats": "\n".join(
                [
                    json.dumps(
                        {
                            "Name": "vocadb_api_a",
                            "CPUPerc": "1.2%",
                            "MemUsage": "129.8MiB / 1GiB",
                            "MemPerc": "12.68%",
                            "PIDs": "18",
                        }
                    ),
                    "{not-json}",
                ]
            ),
            "containerHealth": "/vocadb_api_a\thealthy\n/vocadb_api_b\trunning\n",
            "postgres": "diva-api-a\t1\t8\ndiva-api-b\t0\t7\n",
            "haproxy": "\n".join(
                [
                    "# pxname,svname,scur,status,",
                    "api_nodes,api_a,2,UP,",
                    "api_nodes,api_b,0,MAINT,",
                ]
            ),
            "snapshot": self.base_snapshot,
        }
        module_url = COLLECTOR_PATH.with_suffix(".mjs").resolve().as_uri()
        javascript = f"""
import {{
  evaluateRuntimeSnapshot,
  parseContainerHealth,
  parseDockerStats,
  parseHaProxyStats,
  parsePostgresActivity,
}} from {json.dumps(module_url)};
let input = '';
for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input);
process.stdout.write(JSON.stringify({{
  dockerStats: parseDockerStats(fixture.dockerStats),
  containerHealth: parseContainerHealth(fixture.containerHealth),
  postgres: parsePostgresActivity(fixture.postgres),
  haproxy: parseHaProxyStats(fixture.haproxy),
  evaluated: evaluateRuntimeSnapshot(fixture.snapshot),
}}));
"""
        reference_process = subprocess.run(
            ["node", "--input-type=module", "--eval", javascript],
            input=json.dumps(fixture),
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        reference = json.loads(reference_process.stdout)
        python_result = {
            "dockerStats": COLLECTOR.parse_docker_stats(fixture["dockerStats"]),
            "containerHealth": COLLECTOR.parse_container_health(
                fixture["containerHealth"]
            ),
            "postgres": COLLECTOR.parse_postgres_activity(fixture["postgres"]),
            "haproxy": COLLECTOR.parse_haproxy_stats(fixture["haproxy"]),
            "evaluated": COLLECTOR.evaluate_runtime_snapshot(fixture["snapshot"]),
        }
        self.assertEqual(python_result, reference)

    def test_systemd_unit_uses_system_python_without_node(self) -> None:
        unit = Path(__file__).with_name("diva-runtime-health.service").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "ExecStart=/usr/bin/python3 -B %h/diva-player/scripts/collect-sbc-runtime-health.py",
            unit,
        )
        self.assertNotIn("/usr/bin/node", unit)


if __name__ == "__main__":
    unittest.main(verbosity=2)
