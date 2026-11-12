import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployment_archive', Path(__file__).with_name('archive-sbc-deployment-scan-db.py'))
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


@unittest.skipUnless(os.name == 'posix', 'SBC filesystem semantics require Linux')
class DeploymentArchiveTests(unittest.TestCase):
    def setUp(self):
        self.previous_umask = os.umask(0o022)

    def tearDown(self):
        os.umask(self.previous_umask)

    def fixture(self, root):
        run = root / '20261101T010203Z-123'
        raw = run / 'image-scan/trivy-cache/db/trivy.db'
        raw.parent.mkdir(parents=True)
        payload = b'exact historical scan database' * 1000
        raw.write_bytes(payload)
        (run / 'state').write_text('deployment.status=completed\n')
        receipt = run / 'image-scan/api.receipt.json'
        receipt.write_text(json.dumps({'image': {'id': 'sha256:' + 'a' * 64},
                                     'verdict': {'highCriticalCount': 0},
                                     'database': {'dbSha256': hashlib.sha256(payload).hexdigest(), 'dbSize': len(payload)}}))
        return run, raw, payload, receipt

    def test_verified_roundtrip_resume_and_preserved_receipts(self):
        with tempfile.TemporaryDirectory() as t, patch.object(archive, 'available_for_archive'), patch.object(archive.web, 'offline'), patch.object(archive, 'check_restore_capacity'):
            root = Path(t).resolve()
            run, raw, payload, receipt = self.fixture(root)
            before = receipt.read_bytes()
            self.assertEqual(archive.transform(run, root=root)['status'], 'planned-archive')
            self.assertTrue(raw.exists())
            result = archive.transform(run, root=root, apply=True)
            self.assertEqual(result['status'], 'archived')
            self.assertFalse(raw.exists())
            packed = raw.with_suffix('.db.gz')
            self.assertEqual(gzip.decompress(packed.read_bytes()), payload)
            self.assertEqual(archive.transform(run, root=root, apply=True)['status'], 'already-archived')
            self.assertEqual(archive.transform(run, root=root, apply=True, restore=True)['status'], 'restored')
            self.assertEqual(raw.read_bytes(), payload)
            self.assertEqual(raw.stat().st_nlink, 1)
            self.assertEqual(receipt.read_bytes(), before)
            # Both copies left by a restore or an interrupted compression remain resumable.
            archive.transform(run, root=root, apply=True)
            self.assertFalse(raw.exists())
            self.assertTrue(packed.exists())

    def test_nonterminal_unsafe_and_busy_runs_preserve_plain_db(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t).resolve()
            run, raw, payload, _ = self.fixture(root)
            (run / 'state').write_text('deployment.status=failed\n')
            with self.assertRaisesRegex(RuntimeError, 'terminal'):
                archive.transform(run, root=root, apply=True)
            (run / 'state').write_text('deployment.status=completed\n')
            with patch.object(archive, 'available_for_archive', side_effect=RuntimeError('busy')):
                with self.assertRaisesRegex(RuntimeError, 'busy'):
                    archive.transform(run, root=root, apply=True)
            raw.rename(raw.with_name('saved'))
            raw.symlink_to(raw.with_name('saved'))
            with self.assertRaises(RuntimeError):
                archive.transform(run, root=root, apply=True)
            self.assertEqual(raw.read_bytes(), payload)

    def test_corrupt_payload_and_conflicting_receipt_never_retire_plain_db(self):
        with tempfile.TemporaryDirectory() as t, patch.object(archive, 'available_for_archive'):
            root = Path(t).resolve()
            run, raw, payload, _ = self.fixture(root)
            packed = raw.with_suffix('.db.gz')
            packed.write_bytes(gzip.compress(b'wrong'))
            with self.assertRaisesRegex(RuntimeError, 'Compressed DB'):
                archive.transform(run, root=root, apply=True)
            packed.unlink()
            (run / 'scan-db-compaction.json').write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'Conflicting'):
                archive.transform(run, root=root, apply=True)
            self.assertEqual(raw.read_bytes(), payload)

    def test_contract_and_running_image_references_block_archiving(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t).resolve()
            run, raw, _, _ = self.fixture(root)
            contract = root / archive.cache.CONTROLS[0]
            contract.write_text(run.name)
            with self.assertRaisesRegex(RuntimeError, 'contract'):
                archive.available_for_archive(run, set(), root)
            contract.unlink()
            with patch.object(archive.subprocess, 'check_output', side_effect=['ref abc\n', 'sha256:' + 'a' * 64 + '\n']):
                with self.assertRaisesRegex(RuntimeError, 'running image'):
                    archive.available_for_archive(run, {'sha256:' + 'a' * 64}, root)
            self.assertTrue(raw.exists())

    def test_restore_capacity_failure_keeps_archive(self):
        with tempfile.TemporaryDirectory() as t, patch.object(archive, 'available_for_archive'), patch.object(archive.web, 'offline'):
            root = Path(t).resolve()
            run, raw, _, _ = self.fixture(root)
            archive.transform(run, root=root, apply=True)
            with patch.object(archive, 'check_restore_capacity', side_effect=RuntimeError('reserve')):
                with self.assertRaisesRegex(RuntimeError, 'reserve'):
                    archive.transform(run, root=root, apply=True, restore=True)
            self.assertFalse(raw.exists())
            self.assertTrue(raw.with_suffix('.db.gz').exists())


if __name__ == '__main__':
    unittest.main()
