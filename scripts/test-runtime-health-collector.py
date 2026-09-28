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
import threading
import types
import unittest
from datetime import datetime, timedelta, timezone
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
            "hostMemory": {
                "totalBytes": 8 * 1024**3,
                "availableBytes": 4 * 1024**3,
                "availablePercent": 50,
                "swapTotalBytes": 20 * 1024**3,
                "swapUsedBytes": 7 * 1024**3,
                "swapUsedPercent": 35,
                "swapInPages": 100,
                "swapOutPages": 50,
                "pressure": {
                    "some": {
                        "avg10Percent": 1.5,
                        "avg60Percent": 2.5,
                        "avg300Percent": 3.5,
                        "totalMicros": 1000,
                    },
                    "full": {
                        "avg10Percent": 0.5,
                        "avg60Percent": 1.5,
                        "avg300Percent": 2.5,
                        "totalMicros": 500,
                    },
                },
            },
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

    def test_host_memory_parser_and_consecutive_low_available_alert(self) -> None:
        host_memory = COLLECTOR.parse_host_memory(
            "MemTotal:       8000000 kB\nMemAvailable:   3200000 kB\n"
            "SwapTotal:     20000000 kB\nSwapFree:      12500000 kB\n",
            "pswpin 123\npswpout 45\n",
            "some avg10=1.50 avg60=2.50 avg300=3.50 total=1000\n"
            "full avg10=0.50 avg60=1.50 avg300=2.50 total=500\n",
        )
        self.assertEqual(host_memory["availablePercent"], 40)
        self.assertEqual(host_memory["swapUsedPercent"], 37.5)
        self.assertEqual(host_memory["swapInPages"], 123)
        self.assertEqual(host_memory["swapOutPages"], 45)
        self.assertEqual(host_memory["pressure"]["some"]["avg60Percent"], 2.5)
        self.assertEqual(host_memory["pressure"]["full"]["totalMicros"], 500)

        low = copy.deepcopy(self.base_snapshot)
        low["hostMemory"]["availablePercent"] = 8
        warning = COLLECTOR.evaluate_runtime_snapshot(low)
        self.assertIn(
            "host:memory-available",
            {item["id"] for item in warning["violations"]},
        )
        critical = COLLECTOR.evaluate_runtime_snapshot(low, warning)
        self.assertIn(
            "host:memory-available",
            {item["id"] for item in critical["critical"]},
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
        first_healthy = COLLECTOR.evaluate_runtime_snapshot(recovered_snapshot, critical)
        self.assertEqual(first_healthy["status"], "critical")
        self.assertEqual(set(first_healthy["consecutiveSuccesses"].values()), {1})
        recovered_snapshot["checkedAt"] = "2026-08-10T00:01:00.000Z"
        recovered = COLLECTOR.evaluate_runtime_snapshot(recovered_snapshot, first_healthy)
        self.assertEqual(recovered["status"], "ok")
        self.assertEqual(recovered["consecutiveViolations"], {})
        self.assertEqual(recovered["consecutiveSuccesses"], {})

    def test_public_monitor_requires_two_failures_and_two_successes(self) -> None:
        now = COLLECTOR.datetime(2026, 9, 28, 3, 0, tzinfo=COLLECTOR.timezone.utc)
        next_minute = now + timedelta(minutes=1)
        failed = {"public:ready": {"ok": False, "status": 530, "error": "http-530"}}
        recovered_probe = {"public:ready": {"ok": True, "status": 200, "error": None}}
        state, violations, recovered = COLLECTOR.advance_public_monitor(failed, {}, now=now)
        self.assertEqual(violations, [])
        self.assertEqual(recovered, [])
        self.assertEqual(state["checks"]["public:ready"]["consecutiveFailures"], 1)

        state, violations, recovered = COLLECTOR.advance_public_monitor(failed, {"publicMonitor": state}, now=next_minute)
        self.assertEqual([item["id"] for item in violations], ["public:ready"])
        self.assertEqual([item["id"] for item in recovered], [])
        self.assertEqual(
            state["checks"]["public:ready"]["startedAt"],
            now.isoformat(),
        )

        state, violations, recovered = COLLECTOR.advance_public_monitor(recovered_probe, {"publicMonitor": state}, now=next_minute + timedelta(minutes=1))
        self.assertEqual([item["id"] for item in violations], ["public:ready"])
        self.assertEqual(recovered, [])
        state, violations, recovered = COLLECTOR.advance_public_monitor(recovered_probe, {"publicMonitor": state}, now=next_minute + timedelta(minutes=2))
        self.assertEqual(violations, [])
        self.assertEqual([item["id"] for item in recovered], ["public:ready"])

    def test_unrun_probe_keeps_incident_active_without_counting_as_recovery(self) -> None:
        now = COLLECTOR.datetime(2026, 9, 28, 3, 0, tzinfo=COLLECTOR.timezone.utc)
        failed = {"public:health": {"ok": False, "status": 503, "error": "http-503"}}
        state, _, _ = COLLECTOR.advance_public_monitor(failed, {}, now=now)
        state, violations, _ = COLLECTOR.advance_public_monitor(
            failed, {"publicMonitor": state}, now=now
        )
        self.assertEqual([item["id"] for item in violations], ["public:health"])

        state, violations, recovered = COLLECTOR.advance_public_monitor(
            {"public:ready": {"ok": True, "status": 200}},
            {"publicMonitor": state},
            now=now,
        )
        self.assertEqual([item["id"] for item in violations], ["public:health"])
        self.assertEqual(recovered, [])
        self.assertEqual(state["checks"]["public:health"]["consecutiveSuccesses"], 0)

        healthy = {"public:health": {"ok": True, "status": 200, "error": None}}
        state, violations, recovered = COLLECTOR.advance_public_monitor(
            healthy, {"publicMonitor": state}, now=now
        )
        self.assertEqual([item["id"] for item in violations], ["public:health"])
        self.assertEqual(recovered, [])
        state, violations, recovered = COLLECTOR.advance_public_monitor(
            healthy, {"publicMonitor": state}, now=now
        )
        self.assertEqual(violations, [])
        self.assertEqual([item["id"] for item in recovered], ["public:health"])

    def test_audio_cache_retention_pressure_uses_incident_and_recovery_thresholds(self) -> None:
        failed = {"cache:audio-retention": {"ok": False, "status": "capacity_pressure"}}
        recovered_probe = {"cache:audio-retention": {"ok": True, "status": "success"}}
        state, violations, recovered = COLLECTOR.advance_public_monitor(failed, {}, now=datetime(2026, 9, 28, tzinfo=timezone.utc))
        self.assertEqual(violations, [])
        state, violations, recovered = COLLECTOR.advance_public_monitor(failed, {"publicMonitor": state}, now=datetime(2026, 9, 28, 0, 1, tzinfo=timezone.utc))
        self.assertEqual(violations[0]["id"], "cache:audio-retention")
        self.assertIn("cache retention", violations[0]["message"])
        state, violations, recovered = COLLECTOR.advance_public_monitor(recovered_probe, {"publicMonitor": state}, now=datetime(2026, 9, 28, 0, 2, tzinfo=timezone.utc))
        self.assertEqual(len(violations), 1)
        self.assertEqual(recovered, [])
        state, violations, recovered = COLLECTOR.advance_public_monitor(recovered_probe, {"publicMonitor": state}, now=datetime(2026, 9, 28, 0, 3, tzinfo=timezone.utc))
        self.assertEqual(violations, [])
        self.assertEqual([item["id"] for item in recovered], ["cache:audio-retention"])

    def test_audio_cache_probe_flags_capacity_and_ignores_missing_pre_first_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            status_path = Path(directory) / "retention.json"
            with mock.patch.dict(os.environ, {"DIVA_AUDIO_CACHE_RETENTION_STATUS_PATH": str(status_path)}, clear=True):
                self.assertIsNone(COLLECTOR._probe_audio_cache_retention())
                status_path.write_text(json.dumps({"status": "capacity_pressure", "remainingBytes": 5_000_000_000, "checkedAt": "2026-09-28T00:00:00Z"}), encoding="utf-8")
                probe = COLLECTOR._probe_audio_cache_retention()
        self.assertFalse(probe["ok"])
        self.assertEqual(probe["status"], "capacity_pressure")

    def test_audio_cache_probe_separates_log_budget_pressure_from_cache_pressure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            status_path = Path(directory) / "retention.json"
            status_path.write_text(json.dumps({
                "status": "success",
                "checkedAt": datetime.now(timezone.utc).isoformat(),
                "logRetention": {
                    "pipeline": {"totalBytes": 300 * 1024 * 1024},
                    "audio": {"totalBytes": 250 * 1024 * 1024},
                },
            }), encoding="utf-8")
            with mock.patch.dict(os.environ, {"DIVA_AUDIO_CACHE_RETENTION_STATUS_PATH": str(status_path)}, clear=True):
                probe = COLLECTOR._probe_audio_cache_retention()
        self.assertTrue(probe["ok"] is False)
        self.assertEqual(probe["status"], "success")
        self.assertTrue(probe["logCapacityPressure"])
        self.assertEqual(probe["error"], "operational-log-budget-exceeded")

    def test_local_and_public_inputs_are_collected_concurrently(self) -> None:
        public_started = threading.Event()
        local_wait_results: list[bool] = []
        now = datetime(2026, 9, 29, 0, 0, tzinfo=timezone.utc)
        local_snapshot = {"source": "local"}
        public_probes = {"public:root": {"ok": True}}

        def collect_local() -> dict[str, str]:
            local_wait_results.append(public_started.wait(timeout=1))
            return local_snapshot

        def collect_public(checked_at: datetime) -> dict[str, dict[str, bool]]:
            self.assertIs(checked_at, now)
            public_started.set()
            return public_probes

        with (
            mock.patch.object(COLLECTOR, "collect_snapshot", side_effect=collect_local),
            mock.patch.object(COLLECTOR, "collect_public_probes", side_effect=collect_public),
        ):
            actual_snapshot, actual_probes = COLLECTOR.collect_runtime_inputs(now)

        self.assertEqual(local_wait_results, [True])
        self.assertEqual(actual_snapshot, local_snapshot)
        self.assertEqual(actual_probes, public_probes)

    def test_public_probe_checks_json_dependencies_and_primary_route(self) -> None:
        payload = {
            "status": "ready",
            "dependencies": {"postgres": {"ok": True}, "qdrant": {"ok": True}},
            "warmup": {"completed": True},
        }
        response = mock.MagicMock()
        response.status = 200
        response.headers = {
            "Content-Length": str(len(json.dumps(payload))),
            "X-Diva-Origin-Role": "primary",
            "X-Diva-Standby-State": "missing",
        }
        response.read.return_value = json.dumps(payload).encode()
        context = mock.MagicMock()
        context.__enter__.return_value = response
        with mock.patch.object(COLLECTOR.urllib_request, "urlopen", return_value=context) as urlopen:
            result = COLLECTOR._probe_public_endpoint("public:ready", "/backend-api/api/ready")
        self.assertTrue(result["ok"])
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 15)
        self.assertEqual(urlopen.call_args.args[0].get_header("User-agent"), "DIVA-Player-Runtime-Health/1.0")
        response.headers["X-Diva-Origin-Role"] = "standby"
        with mock.patch.object(COLLECTOR.urllib_request, "urlopen", return_value=context):
            result = COLLECTOR._probe_public_endpoint("public:ready", "/backend-api/api/ready")
        self.assertFalse(result["ok"])

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

    def test_discord_notification_is_a_verified_message_and_bounded(self) -> None:
        snapshot = {
            "checkedAt": "2026-08-10T00:00:00.000Z",
            "status": "critical",
            "critical": [{"id": "disk:used", "message": "disk use exceeds 85%"}],
        }
        webhook = "https://discord.com/api/webhooks/123/token?thread_id=456&wait=false"
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = b'{"id":"123456789012345678"}'
        context = mock.MagicMock()
        context.__enter__.return_value = response
        with (
            mock.patch.dict(os.environ, {"DIVA_ALERT_WEBHOOK_URL": webhook}, clear=True),
            mock.patch.object(
                COLLECTOR.urllib_request, "urlopen", return_value=context
            ) as urlopen,
        ):
            delivered = COLLECTOR.apply_critical_notification(
                snapshot,
                {"notifiedCriticalIds": [], "lastDiscordMessageId": "111"},
            )

        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(
            request.get_header("User-agent"), "DIVA-Player-Runtime-Health/1.0"
        )
        self.assertIn("thread_id=456", request.full_url)
        self.assertIn("wait=true", request.full_url)
        payload = json.loads(request.data)
        self.assertIn("disk:used", payload["content"])
        self.assertIn("Started: 2026-08-10T00:00:00.000Z", payload["content"])
        self.assertIn(
            "Check: ~/.local/state/diva-player/runtime_health_latest.json (disk)",
            payload["content"],
        )
        self.assertEqual(payload["allowed_mentions"], {"parse": []})
        self.assertEqual(delivered["notificationStatus"], "sent")
        self.assertEqual(delivered["notifiedCriticalIds"], ["disk:used"])
        self.assertEqual(delivered["lastDiscordMessageId"], "123456789012345678")
        with mock.patch.dict(
            os.environ, {"DIVA_ALERT_WEBHOOK_URL": webhook}, clear=True
        ):
            repeated = COLLECTOR.apply_critical_notification(snapshot, delivered)
        self.assertEqual(repeated["notificationStatus"], "up-to-date")
        self.assertEqual(repeated["lastDiscordMessageId"], "123456789012345678")

        oversized_snapshot = {
            **snapshot,
            "critical": [
                {"id": "critical:" + str(index), "message": "long diagnostic " * 30}
                for index in range(80)
            ],
        }
        response.read.return_value = b'{"id":"222"}'
        with (
            mock.patch.dict(
                os.environ, {"DIVA_ALERT_WEBHOOK_URL": webhook}, clear=True
            ),
            mock.patch.object(
                COLLECTOR.urllib_request, "urlopen", return_value=context
            ) as oversized_urlopen,
        ):
            bounded = COLLECTOR.apply_critical_notification(oversized_snapshot, {})
        bounded_payload = json.loads(oversized_urlopen.call_args.args[0].data)
        self.assertLessEqual(len(bounded_payload["content"].encode("utf-16-le")) // 2, 1900)
        self.assertEqual(bounded["notificationStatus"], "sent")

    def test_discord_notification_requires_message_receipt_before_marking_sent(self) -> None:
        snapshot = {
            "checkedAt": "2026-08-10T00:00:00.000Z",
            "status": "critical",
            "critical": [{"id": "disk:used", "message": "disk use exceeds 85%"}],
        }
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = b'{"type":1}'
        context = mock.MagicMock()
        context.__enter__.return_value = response
        with (
            mock.patch.dict(
                os.environ,
                {"DIVA_ALERT_WEBHOOK_URL": "https://discord.com/api/webhooks/123/token"},
                clear=True,
            ),
            mock.patch.object(
                COLLECTOR.urllib_request, "urlopen", return_value=context
            ),
        ):
            failed = COLLECTOR.apply_critical_notification(
                snapshot,
                {"notifiedCriticalIds": [], "lastDiscordMessageId": "111"},
            )
        self.assertEqual(failed["notificationStatus"], "failed")
        self.assertEqual(failed["notifiedCriticalIds"], [])
        self.assertEqual(failed["pendingIncidentIds"], ["disk:used"])
        self.assertEqual(failed["lastDiscordMessageId"], "111")
        self.assertNotIn("token", failed["notificationError"])

    def test_notification_outbox_is_persisted_before_discord_delivery(self) -> None:
        webhook = "https://discord.com/api/webhooks/123/token"
        snapshot = {
            "checkedAt": "2026-09-29T00:00:00Z",
            "status": "critical",
            "critical": [{"id": "disk:used", "message": "disk use exceeds 85%"}],
        }
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = b'{"id":"333"}'
        context = mock.MagicMock()
        context.__enter__.return_value = response
        with tempfile.TemporaryDirectory(prefix="diva-runtime-health-") as directory:
            state_path = Path(directory) / "runtime_health_latest.json"

            def deliver_after_reading_outbox(*_args: Any, **_kwargs: Any) -> Any:
                persisted = json.loads(state_path.read_text(encoding="utf-8"))
                self.assertEqual(persisted["notificationStatus"], "pending")
                self.assertEqual(persisted["pendingIncidentIds"], ["disk:used"])
                return context

            with (
                mock.patch.dict(os.environ, {"DIVA_ALERT_WEBHOOK_URL": webhook}, clear=True),
                mock.patch.object(
                    COLLECTOR.urllib_request,
                    "urlopen",
                    side_effect=deliver_after_reading_outbox,
                ),
            ):
                delivered = COLLECTOR.apply_critical_notification(
                    snapshot, {}, state_path
                )
        self.assertEqual(delivered["notificationStatus"], "sent")
        self.assertEqual(delivered["lastDiscordMessageId"], "333")

    def test_outbox_replays_incident_and_recovery_after_process_exit(self) -> None:
        webhook = "https://discord.com/api/webhooks/123/token"
        active = {
            "checkedAt": "2026-09-29T00:00:00Z",
            "status": "critical",
            "critical": [{"id": "public:ready", "message": "HTTP 530"}],
            "publicMonitor": {"checks": {"public:ready": {"active": True}}},
        }
        healthy = {
            "checkedAt": "2026-09-29T00:02:00Z",
            "status": "ok",
            "critical": [],
            "publicMonitor": {"checks": {"public:ready": {"active": False}}},
        }
        with tempfile.TemporaryDirectory(prefix="diva-runtime-health-") as directory:
            state_path = Path(directory) / "runtime_health_latest.json"

            def accepted_then_process_exits(*_args: Any, **_kwargs: Any) -> Any:
                persisted = json.loads(state_path.read_text(encoding="utf-8"))
                self.assertEqual(persisted["pendingIncidentIds"], ["public:ready"])
                raise KeyboardInterrupt()

            with (
                mock.patch.dict(os.environ, {"DIVA_ALERT_WEBHOOK_URL": webhook}, clear=True),
                mock.patch.object(
                    COLLECTOR.urllib_request,
                    "urlopen",
                    side_effect=accepted_then_process_exits,
                ),
            ):
                with self.assertRaises(KeyboardInterrupt):
                    COLLECTOR.apply_critical_notification(active, {}, state_path)

            persisted_outbox = json.loads(state_path.read_text(encoding="utf-8"))
            response = mock.MagicMock()
            response.status = 200
            response.read.return_value = b'{"id":"444"}'
            context = mock.MagicMock()
            context.__enter__.return_value = response
            with (
                mock.patch.dict(os.environ, {"DIVA_ALERT_WEBHOOK_URL": webhook}, clear=True),
                mock.patch.object(
                    COLLECTOR.urllib_request, "urlopen", return_value=context
                ) as urlopen,
            ):
                delivered = COLLECTOR.apply_critical_notification(
                    healthy, persisted_outbox, state_path
                )

        content = json.loads(urlopen.call_args.args[0].data)["content"]
        self.assertIn("Confirmed incidents:", content)
        self.assertIn("public:ready", content)
        self.assertIn("Recovered after two consecutive healthy checks:", content)
        self.assertEqual(delivered["notificationStatus"], "sent")
        self.assertEqual(delivered["pendingIncidentIds"], [])
        self.assertEqual(delivered["pendingRecoveryIds"], [])

    def test_discord_recovery_is_sent_once_and_retried_if_delivery_fails(self) -> None:
        webhook = "https://discord.com/api/webhooks/123/token"
        healthy = {"checkedAt": "2026-08-10T00:02:00Z", "status": "ok", "critical": []}
        active = {"checkedAt": "2026-08-10T00:00:00Z", "status": "critical", "critical": [{"id": "disk:used", "message": "disk full"}]}
        previous = {
            "checkedAt": "2026-08-10T00:00:00Z",
            "notifiedCriticalIds": ["disk:used"],
            "incidentStartedAt": {"disk:used": "2026-08-10T00:00:00Z"},
            "notificationSchemaVersion": 2,
            "lastDiscordMessageId": "111",
        }
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = b'{"id":"222"}'
        context = mock.MagicMock()
        context.__enter__.return_value = response
        with (
            mock.patch.dict(os.environ, {"DIVA_ALERT_WEBHOOK_URL": webhook}, clear=True),
            mock.patch.object(COLLECTOR.urllib_request, "urlopen", return_value=context) as urlopen,
        ):
            sent = COLLECTOR.apply_critical_notification(healthy, previous)
        content = json.loads(urlopen.call_args.args[0].data)["content"]
        self.assertIn("Recovered after two consecutive healthy checks", content)
        self.assertIn("Incident started: 2026-08-10T00:00:00Z", content)
        self.assertIn(
            "Check: ~/.local/state/diva-player/runtime_health_latest.json (disk)",
            content,
        )
        self.assertEqual(sent["notifiedCriticalIds"], [])
        self.assertEqual(sent["pendingRecoveryIds"], [])
        with (
            mock.patch.dict(os.environ, {"DIVA_ALERT_WEBHOOK_URL": webhook}, clear=True),
            mock.patch.object(COLLECTOR.urllib_request, "urlopen", side_effect=TimeoutError("timeout")),
        ):
            retried = COLLECTOR.apply_critical_notification(healthy, previous)
        self.assertEqual(retried["notificationStatus"], "failed")
        self.assertEqual(retried["notifiedCriticalIds"], ["disk:used"])
        self.assertEqual(retried["pendingRecoveryIds"], ["disk:used"])

    def test_failed_incident_is_retried_with_recovery_until_acknowledged(self) -> None:
        webhook = "https://discord.com/api/webhooks/123/token"
        active = {
            "checkedAt": "2026-09-28T00:01:00Z",
            "status": "critical",
            "critical": [{"id": "public:ready", "message": "HTTP 530"}],
            "publicMonitor": {
                "checks": {
                    "public:ready": {
                        "active": True,
                        "startedAt": "2026-09-28T00:00:00Z",
                    }
                }
            },
        }
        with (
            mock.patch.dict(os.environ, {"DIVA_ALERT_WEBHOOK_URL": webhook}, clear=True),
            mock.patch.object(COLLECTOR.urllib_request, "urlopen", side_effect=TimeoutError("timeout")),
        ):
            pending = COLLECTOR.apply_critical_notification(active, {})
        self.assertEqual(pending["pendingIncidentIds"], ["public:ready"])

        healthy = {
            "checkedAt": "2026-09-28T00:03:00Z",
            "status": "ok",
            "critical": [],
            "publicMonitor": {"checks": {"public:ready": {"active": False}}},
        }
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = b'{"id":"222"}'
        context = mock.MagicMock()
        context.__enter__.return_value = response
        with (
            mock.patch.dict(os.environ, {"DIVA_ALERT_WEBHOOK_URL": webhook}, clear=True),
            mock.patch.object(COLLECTOR.urllib_request, "urlopen", return_value=context) as urlopen,
        ):
            delivered = COLLECTOR.apply_critical_notification(healthy, pending)
        content = json.loads(urlopen.call_args.args[0].data)["content"]
        self.assertIn("Confirmed incidents:", content)
        self.assertIn("public:ready", content)
        self.assertIn("Started: 2026-09-28T00:00:00Z", content)
        self.assertIn("Recovered after two consecutive healthy checks:", content)
        self.assertIn("Recovery confirmed: 2026-09-28T00:03:00Z", content)
        self.assertIn(
            "Check: https://diva-player.pages.dev/backend-api/api/ready", content
        )
        self.assertEqual(delivered["notifiedCriticalIds"], [])
        self.assertEqual(delivered["pendingIncidentIds"], [])
        self.assertEqual(delivered["pendingRecoveryIds"], [])
        with mock.patch.dict(os.environ, {"DIVA_ALERT_WEBHOOK_URL": webhook}, clear=True):
            stable = COLLECTOR.apply_critical_notification(healthy, delivered)
        self.assertEqual(stable["notificationStatus"], "up-to-date")


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
                mock.patch.object(COLLECTOR, "collect_public_probes", return_value={}),
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
                mock.patch.object(COLLECTOR, "collect_public_probes", return_value={}),
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
            "meminfo": (
                "MemTotal:       8000000 kB\nMemAvailable:   3200000 kB\n"
                "SwapTotal:     20000000 kB\nSwapFree:      12500000 kB\n"
            ),
            "vmstat": "pswpin 123\npswpout 45\n",
            "pressure": (
                "some avg10=1.50 avg60=2.50 avg300=3.50 total=1000\n"
                "full avg10=0.50 avg60=1.50 avg300=2.50 total=500\n"
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
  parseHostMemory,
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
  hostMemory: parseHostMemory(fixture.meminfo, fixture.vmstat, fixture.pressure),
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
            "hostMemory": COLLECTOR.parse_host_memory(
                fixture["meminfo"], fixture["vmstat"], fixture["pressure"]
            ),
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
