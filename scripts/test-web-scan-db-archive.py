import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('archive', Path(__file__).with_name('archive-sbc-web-scan-db.py'))
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


@unittest.skipUnless(os.name == 'posix', 'SBC filesystem semantics require Linux')
class ArchiveTests(unittest.TestCase):
    def test_unique_and_already_shared_payloads_do_not_expand_archives(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(archive, 'offline'):
            root = Path(temp).resolve()
            first, raw, _ = self.fixture(root)
            archive.archive_release(first, True)
            with patch.object(archive, 'digest', side_effect=AssertionError('unnecessary hash')):
                self.assertEqual(archive.deduplicate(root, True), [])
            second, raw2, _ = self.fixture(root, 'web-release-abcdef0')
            raw2.unlink()
            os.link(raw.with_suffix('.db.gz'), raw2.with_suffix('.db.gz'))
            with patch.object(archive, 'digest', side_effect=AssertionError('unnecessary hash')):
                self.assertEqual(archive.deduplicate(root, True), [])

    def test_matching_receipts_never_allow_a_corrupt_candidate_to_replace_data(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(archive, 'offline'):
            root = Path(temp).resolve()
            first, raw, _ = self.fixture(root)
            second, raw2, _ = self.fixture(root, 'web-release-abcdef0')
            archive.archive_release(first, True)
            archive.archive_release(second, True)
            target = raw2.with_suffix('.db.gz')
            target.write_bytes(gzip.compress(b'corrupt payload'))
            original = raw.with_suffix('.db.gz').read_bytes()
            with self.assertRaisesRegex(RuntimeError, 'does not match receipt'):
                archive.deduplicate(root, True)
            self.assertEqual(raw.with_suffix('.db.gz').read_bytes(), original)
            self.assertFalse(raw.with_suffix('.db.gz').samefile(target))

    def fixture(self, root, name='web-release-1234567'):
        release = root / name
        db = release / 'runtime-scan-cache/db/trivy.db'
        db.parent.mkdir(parents=True)
        payload = b'exact database payload' * 1000
        db.write_bytes(payload)
        (release / 'runtime-receipt.json').write_text(json.dumps({
            'service': 'web', 'verdict': {'highCriticalCount': 0},
            'database': {'dbSha256': hashlib.sha256(payload).hexdigest(), 'dbSize': len(payload)}}))
        return release, db, payload

    def test_round_trip_dry_run_idempotence_and_deduplication(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(archive, 'offline'):
            root = Path(temp).resolve()
            first, raw, payload = self.fixture(root)
            self.assertEqual(archive.archive_release(first)['status'], 'planned')
            self.assertTrue(raw.exists())
            archive.archive_release(first, True)
            self.assertFalse(raw.exists())
            self.assertEqual(gzip.decompress(raw.with_suffix('.db.gz').read_bytes()), payload)
            self.assertEqual(archive.archive_release(first, True)['status'], 'already-archived')
            second, raw2, _ = self.fixture(root, 'web-release-abcdef0')
            archive.archive_release(second, True)
            # Different gzip headers must not prevent payload deduplication.
            raw2.with_suffix('.db.gz').write_bytes(gzip.compress(payload, mtime=42))
            self.assertEqual(len(archive.deduplicate(root)), 1)
            archive.deduplicate(root, True)
            self.assertTrue(raw.with_suffix('.db.gz').samefile(raw2.with_suffix('.db.gz')))
            self.assertEqual(archive.deduplicate(root, True), [])
            self.assertTrue((first / 'runtime-receipt.json').exists())

    def test_bad_hash_symlink_existing_archive_and_busy_release_preserve_raw(self):
        with tempfile.TemporaryDirectory() as temp:
            release, raw, payload = self.fixture(Path(temp).resolve())
            raw.write_bytes(b'wrong')
            with self.assertRaises(RuntimeError):
                archive.archive_release(release, True)
            raw.write_bytes(payload)
            with patch.object(archive, 'offline', side_effect=RuntimeError('busy')):
                with self.assertRaises(RuntimeError):
                    archive.archive_release(release, True)
            self.assertTrue(raw.exists())
            with patch.object(archive, 'offline'):
                raw.with_suffix('.db.gz').write_bytes(b'existing')
                with self.assertRaises(RuntimeError):
                    archive.archive_release(release, True)
            self.assertEqual(raw.read_bytes(), payload)
            raw.rename(raw.with_name('saved'))
            raw.symlink_to(raw.with_name('saved'))
            with self.assertRaises(RuntimeError):
                archive.archive_release(release)


if __name__ == '__main__':
    unittest.main()
