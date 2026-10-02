from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


cache = module('cache', 'prune-sbc-scan-cache.py')
health = module('health', 'collect-sbc-runtime-health.py')


class CacheRetentionTests(unittest.TestCase):
    def test_terminal_and_live_reference_protection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            for i in range(1, 5):
                run = root / f'2026100{i}T010203Z-{i}'
                p = run / 'image-scan/trivy-cache'
                p.mkdir(parents=True)
                (p / 'database.db').write_bytes(b'data')
                (run / 'state').write_text('deployment.status=completed\n')
            protected = root / '20261001T010203Z-1'
            result = cache.plan(root, [str(protected)])
            by_run = {x['run']: x for x in result['caches']}
            self.assertIsNotNone(by_run[protected.name]['protectedReason'])
            self.assertEqual(by_run['20261004T010203Z-4']['protectedReason'], 'latest-terminal-cache')
            self.assertIsNone(by_run['20261002T010203Z-2']['protectedReason'])

    def test_failed_and_unresolved_runs_are_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            run = root / '20261001T010203Z-1'
            p = run / 'trivy-cache'
            p.mkdir(parents=True)
            (run / 'state').write_text('deployment.status=failed\n')
            self.assertEqual(cache.plan(root, [])['caches'][0]['protectedReason'], 'nonterminal-or-unresolved')
            (run / 'state').write_text('deployment.status=completed\n')
            (run / 'daemon-mutation-unresolved').touch()
            self.assertEqual(cache.plan(root, [])['caches'][0]['protectedReason'], 'nonterminal-or-unresolved')

    def test_symlink_cache_is_never_selected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            run = root / '20261001T010203Z-1'
            run.mkdir()
            (run / 'state').write_text('deployment.status=completed\n')
            outside = root / 'unmanaged'
            outside.mkdir()
            try:
                (run / 'trivy-cache').symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest('symlinks unavailable')
            self.assertEqual(cache.plan(root, [])['caches'][0]['protectedReason'], 'unsafe-path')

    def test_failed_run_requires_every_final_release(self):
        releases = {
            'backend_env.private_cleanup': 'durable-exact-inode-unlink',
            'backend_env.private_runtime_cleanup': 'durable-tmpfs-dirfd-release',
            'deployment.journal_cleanup': 'durable-exact-inode-release',
            'deployment.lock_cleanup': 'durable-exact-inode-release',
        }
        with tempfile.TemporaryDirectory() as temp:
            run = Path(temp)
            state = run / 'state'
            def write(values):
                state.write_text('deployment.status=failed\n' + ''.join(f'{k}={v}\n' for k, v in values.items()))
            for missing in releases:
                write({k: v for k, v in releases.items() if k != missing})
                self.assertFalse(cache.terminal(run))
            write(releases)
            self.assertTrue(cache.terminal(run))
            with state.open('a') as stream:
                stream.write('deployment.lock_cleanup=failed\n')
            self.assertFalse(cache.terminal(run))

    def test_reconciled_marker_requires_matching_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            run = Path(temp) / '20261001T232943Z-167409'
            run.mkdir()
            (run / 'daemon-mutation-unresolved.reconciled').touch()
            receipt = run / 'gateway-validation-manual-reconciliation.json'
            self.assertTrue(cache.unresolved(run))
            data = {'runId': run.name, 'status': 'verified-terminal-before-migration-no-live-replacement',
                    'canonicalImages': 'exact-prestate-restored'}
            receipt.write_text(json.dumps(data))
            self.assertFalse(cache.unresolved(run))
            receipt.write_text(json.dumps({**data, 'runId': 'wrong'}))
            self.assertTrue(cache.unresolved(run))
            receipt.write_text(json.dumps(data))
            (run / 'another-unresolved').touch()
            self.assertTrue(cache.unresolved(run))

    def test_clean_failed_caches_converge_to_one(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            for i in range(1, 8):
                run = root / f'2026100{i}T010203Z-{i}'
                (run / 'trivy-cache').mkdir(parents=True)
                (run / 'state').write_text('deployment.status=failed\n'
                    'backend_env.private_cleanup=durable-exact-inode-unlink\n'
                    'backend_env.private_runtime_cleanup=durable-tmpfs-dirfd-release\n'
                    'deployment.journal_cleanup=durable-exact-inode-release\n'
                    'deployment.lock_cleanup=durable-exact-inode-release\n')
            rows = cache.plan(root, [])['caches']
            self.assertEqual(sum(row['protectedReason'] is not None for row in rows), 1)
            self.assertEqual(rows[0]['protectedReason'], 'latest-terminal-cache')

    def test_failure_retention_hook_requires_successful_recovery(self):
        source = Path(__file__).with_name('deploy-sbc-api-rolling.sh').read_text()
        hook = source[source.index('    if [ "$TEST_MODE" != "1" ] && [ "$recovery_result" -eq 0 ]'):]
        hook = hook[:hook.index('    exit "$original_exit_code"')]
        self.assertIn('"$SOURCE_SNAPSHOT_CAPTURED" = "true"', hook)
        self.assertIn('prune-sbc-scan-cache.py" --apply', hook)
        self.assertNotIn('"$original_exit_code" -eq 0', hook)


class CapacityMonitoringTests(unittest.TestCase):
    def info(self, now):
        return {'status': 'success', 'checkedAt': now.isoformat(), 'requiredFreeBytes': 20 * 1024**3,
                'managedTransientBytes': 5 * 1024**3}

    def disk(self, free):
        return {'disk': {'availableBytes': free, 'totalBytes': 100 * 1024**3}}

    def test_margin_and_unknown_forecast(self):
        with tempfile.TemporaryDirectory() as temp:
            now = datetime.now(timezone.utc)
            info, violations = health.operation_capacity(self.disk(25 * 1024**3), {'capacity': self.info(now)}, Path(temp), now)
            self.assertEqual(info['forecastStatus'], 'insufficient-samples')
            self.assertEqual(violations[0]['id'], 'capacity:operation-headroom')
            snap = health.evaluate_runtime_snapshot({'capacityViolations': violations}, {})
            self.assertTrue(any(x['id'] == 'capacity:operation-headroom' for x in snap['violations']))

    def test_seven_days_growth_and_cleanup_reset(self):
        with tempfile.TemporaryDirectory() as temp:
            start = datetime(2026, 10, 1, tzinfo=timezone.utc)
            for i in range(7):
                now = start + timedelta(days=i)
                info, violations = health.operation_capacity(self.disk((45 - i) * 1024**3), {'capacity': self.info(now)}, Path(temp), now)
            self.assertEqual(info['forecastStatus'], 'growing')
            self.assertAlmostEqual(info['estimatedDailyGrowthBytes'], 1024**3)
            self.assertTrue(any(x['id'] == 'capacity:forecast' for x in violations))
            info, _ = health.operation_capacity(self.disk(70 * 1024**3), {'capacity': self.info(now)}, Path(temp), now)
            self.assertEqual(info['growthSampleCount'], 1)

    def test_capacity_collection_failure_is_unknown(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(health, '_run_command', side_effect=RuntimeError('offline')):
            info, _ = health.operation_capacity(self.disk(40 * 1024**3), {}, Path(temp), datetime.now(timezone.utc))
            self.assertEqual(info['forecastStatus'], 'unknown')


if __name__ == '__main__':
    unittest.main()
