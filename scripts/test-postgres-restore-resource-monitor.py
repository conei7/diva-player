#!/usr/bin/env python3
"""Tests for isolated PostgreSQL restore resource sampling."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("postgres-restore-resource-monitor.py")
SPEC = importlib.util.spec_from_file_location("postgres_restore_resource_monitor", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ResourceMonitorTests(unittest.TestCase):
    def test_parses_docker_volume_and_filesystem_usage(self) -> None:
        sample = MODULE.parse_sample(
            "2048\t/var/lib/postgresql/data\n"
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
            "/dev/root 100000 25000 75000 25% /var/lib/postgresql/data\n",
            sampled_at="2026-09-30T01:00:00+00:00",
        )
        self.assertEqual(sample["candidateVolumeBytes"], 2 * 1024 * 1024)
        self.assertEqual(sample["filesystemUsedBytes"], 25_000 * 1024)
        self.assertEqual(sample["filesystemAvailableBytes"], 75_000 * 1024)

    def test_rejects_incomplete_or_inconsistent_filesystem_output(self) -> None:
        with self.assertRaisesRegex(MODULE.ResourceMonitorError, "incomplete"):
            MODULE.parse_sample("2048 /var/lib/postgresql/data\n")
        with self.assertRaisesRegex(MODULE.ResourceMonitorError, "inconsistent"):
            MODULE.parse_sample(
                "2048 /var/lib/postgresql/data\n"
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
                "/dev/root 100000 80000 30000 80% /var/lib/postgresql/data\n"
            )

    def test_keeps_maximum_sampled_volume_and_filesystem_usage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "resource-usage.json"
            summary = MODULE._read_summary(path, append=False)
            MODULE._record_sample(path, summary, {
                "sampledAt": "2026-09-30T01:00:00+00:00",
                "candidateVolumeBytes": 2_000_000,
                "filesystemTotalBytes": 10_000_000,
                "filesystemUsedBytes": 5_000_000,
                "filesystemAvailableBytes": 5_000_000,
            })
            summary = MODULE._read_summary(path, append=True)
            MODULE._record_sample(path, summary, {
                "sampledAt": "2026-09-30T01:00:10+00:00",
                "candidateVolumeBytes": 3_000_000,
                "filesystemTotalBytes": 10_000_000,
                "filesystemUsedBytes": 6_000_000,
                "filesystemAvailableBytes": 4_000_000,
            })
            summary = MODULE._read_summary(path, append=True)

        self.assertEqual(summary["sampleCount"], 2)
        self.assertEqual(summary["peakCandidateVolumeBytes"], 3_000_000)
        self.assertEqual(summary["peakFilesystemUsedBytes"], 6_000_000)
        self.assertEqual(summary["firstSampleAt"], "2026-09-30T01:00:00+00:00")
        self.assertEqual(summary["lastSampleAt"], "2026-09-30T01:00:10+00:00")


if __name__ == "__main__":
    unittest.main()
