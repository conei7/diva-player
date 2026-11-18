import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
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
            archive.archive_release(second, True, share=False)
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
            archive.archive_release(second, True, share=False)
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

    def test_new_web_and_postgres_archives_reuse_the_existing_payload(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(archive, 'offline'):
            root = Path(temp).resolve()
            first, raw, payload = self.fixture(root)
            archive.archive_release(first, True)
            web, web_raw, _ = self.fixture(root, 'web-release-abcdef0')
            stage = root / 'postgres-16.16-abcdef0'
            pg_raw = stage / 'scan-cache/db/trivy.db'
            pg_raw.parent.mkdir(parents=True)
            pg_raw.write_bytes(payload)
            for component, service in (('postgres', 'pgvector-runtime'), ('migrate', 'postgres-migrate-helper')):
                (stage / f'{component}-image-id').write_text('sha256:' + 'a' * 64)
                data = json.loads((first / 'runtime-receipt.json').read_text())
                data.update(service=service, image={'id': 'sha256:' + 'a' * 64})
                (stage / f'{component}-receipt.json').write_text(json.dumps(data))
            self.assertIn('sharedFrom', archive.archive_release(web, True))
            self.assertIn('sharedFrom', archive.archive_postgres(stage, True))
            for db in (web_raw, pg_raw):
                self.assertFalse(db.exists())
                self.assertTrue(db.with_suffix('.db.gz').samefile(raw.with_suffix('.db.gz')))
            (root / 'runtime_health_latest.json').write_text('{"capacity":{"reserveRequiredBytes":0}}')
            result = archive.restore_database(stage, pg_raw, archive.postgres_archive_identity, True)
            self.assertEqual(result['status'], 'restored')
            self.assertEqual(pg_raw.read_bytes(), payload)
            self.assertEqual(archive.archive_postgres(stage, True)['status'], 'archived')
            self.assertFalse(pg_raw.exists())

    def test_failed_deployment_command_does_not_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            release, raw, _ = self.fixture(Path(temp).resolve())
            run = subprocess.run([sys.executable, '-I', '-B', archive.__file__, '--release', str(release),
                                  '--apply', '--after', sys.executable, '-c', 'raise SystemExit(19)'],
                                 capture_output=True)
            self.assertNotEqual(run.returncode, 0)
            self.assertTrue(raw.exists())

    def test_retry_after_receipt_write_failure_preserves_original(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(archive, 'offline'):
            release, raw, payload = self.fixture(Path(temp).resolve())
            with patch.object(archive, 'publish_receipt', side_effect=OSError('disk full')):
                with self.assertRaisesRegex(OSError, 'disk full'):
                    archive.archive_release(release, True)
            self.assertEqual(raw.read_bytes(), payload)
            self.assertTrue(raw.with_suffix('.db.gz').exists())
            archive.archive_release(release, True)
            self.assertFalse(raw.exists())
            self.assertTrue((release / 'scan-db-compaction.json').exists())


if __name__ == '__main__':
    unittest.main()
