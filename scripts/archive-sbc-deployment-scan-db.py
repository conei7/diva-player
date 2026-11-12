#!/usr/bin/env python3
"""Compress historical deployment scan DBs without discarding rollback evidence.

Explicit run only; dry-run by default. Restore before using a frozen verifier
that expects the original plain DB. Neither image tags nor scan receipts change.
"""
import argparse
from datetime import datetime, timezone
import gzip
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cache = sibling('scan_cache_retention', 'prune-sbc-scan-cache.py')
web = sibling('web_scan_archive', 'archive-sbc-web-scan-db.py')
ROOT = cache.ROOT


def regular(path, root):
    web.safe_file(path, root)
    s = path.stat()
    if s.st_nlink != 1 or s.st_mode & 0o022:
        raise RuntimeError('Evidence must be single-link and not group/world writable')


def describe(run, root=ROOT):
    if (not cache.RUN.fullmatch(run.name) or run.parent != root
            or run.resolve() != run or run.is_symlink()):
        raise RuntimeError('Expected an exact canonical deployment run')
    if not cache.terminal(run) or cache.unresolved(run):
        raise RuntimeError('Deployment is not safely terminal')
    raw = run / 'image-scan/trivy-cache/db/trivy.db'
    if raw.parent.resolve() != raw.parent:
        raise RuntimeError('Noncanonical database directory')
    receipts = sorted((run / 'image-scan').glob('*.receipt.json'))
    if not receipts:
        raise RuntimeError('No immutable scan receipts')
    databases = set()
    images = set()
    receipt_hashes = {}
    for receipt in receipts:
        regular(receipt, root)
        d = json.loads(receipt.read_text())
        if d.get('verdict', {}).get('highCriticalCount') != 0:
            raise RuntimeError('Receipt does not attest a clean scan')
        database = d['database']
        sha, size = database['dbSha256'], database['dbSize']
        if not cache.re.fullmatch(r'[0-9a-f]{64}', sha) or not 0 < size <= 4 * 1024**3:
            raise RuntimeError('Invalid bounded database identity')
        databases.add((sha, size))
        images.add(d['image']['id'])
        receipt_hashes[receipt.name] = web.digest(receipt)[0]
    if len(databases) != 1:
        raise RuntimeError('Receipts refer to different databases')
    return raw, databases.pop(), images, receipt_hashes


def available_for_archive(run, images, root=ROOT):
    for name in cache.CONTROLS:
        control = root / name
        if control.is_symlink():
            raise RuntimeError('Unsafe runtime control')
        if control.exists():
            text = control.read_text()
            if run.name in text or any(image in text for image in images):
                raise RuntimeError('Run is referenced by the active runtime contract')
    running = subprocess.check_output(['docker', 'ps', '--no-trunc', '--format', '{{.Image}} {{.ID}}'], text=True)
    ids = [line.split()[-1] for line in running.splitlines()]
    if ids:
        live_images = set(subprocess.check_output(['docker', 'inspect', '--format', '{{.Image}}', *ids], text=True).split())
        if live_images & images:
            raise RuntimeError('Run attests a currently running image')
    web.offline(run)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def check_restore_capacity(root, size):
    report = Path('/home/orangepi/.local/state/diva-player/runtime_health_latest.json')
    capacity = json.loads(report.read_text())['capacity']
    if shutil.disk_usage(root).free < capacity['reserveRequiredBytes'] + size:
        raise RuntimeError('Restore would consume the operational reserve')


def transform(run, *, apply=False, restore=False, root=ROOT):
    raw, expected, images, receipts = describe(run, root)
    archive = raw.with_suffix('.db.gz')
    receipt = run / 'scan-db-compaction.json'
    if raw.exists():
        regular(raw, root)
        if web.digest(raw) != expected:
            raise RuntimeError('Plain DB does not match receipts')
        if restore:
            return {'run': run.name, 'status': 'already-restored'}
    if archive.exists():
        regular(archive, root)
        if web.digest(archive, True) != expected:
            raise RuntimeError('Compressed DB does not match receipts')
    if not raw.exists() and not archive.exists():
        raise RuntimeError('Both database representations are absent')
    if not restore:
        available_for_archive(run, images, root)
        if not raw.exists():
            return {'run': run.name, 'status': 'already-archived'}
    else:
        web.offline(run)
    result = {'run': run.name, 'status': 'planned-restore' if restore else 'planned-archive',
              'payloadSha256': expected[0], 'payloadBytes': expected[1]}
    if not apply:
        return result
    source = archive if restore else raw
    target = raw if restore else archive
    before = web.identity(source)
    # Preserve the normal operational reserve while restoring a historical DB.
    if restore:
        check_restore_capacity(root, expected[1])
    temporary = None
    try:
        if not target.exists():
            fd, name = tempfile.mkstemp(prefix='.scan-db-', dir=raw.parent)
            temporary = Path(name)
            with os.fdopen(fd, 'wb') as output:
                if restore:
                    with gzip.open(source, 'rb') as stream:
                        shutil.copyfileobj(stream, output, 1024 * 1024)
                else:
                    with source.open('rb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=output, compresslevel=6, mtime=0) as packed:
                        shutil.copyfileobj(stream, packed, 1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
            if web.digest(temporary, not restore) != expected:
                raise RuntimeError('Transformed payload does not match receipts')
            os.link(temporary, target)  # Exclusive publication; never replace evidence.
            temporary.unlink()
            sync_directory(raw.parent)
        if web.identity(source) != before or describe(run, root)[3] != receipts:
            raise RuntimeError('Evidence changed during transformation')
        if restore:
            web.offline(run)
            # Keep the compressed copy as well, including after an interrupted restore.
            result['status'] = 'restored'
        else:
            available_for_archive(run, images, root)
            result.update(status='archived', archiveSha256=web.digest(archive)[0],
                          archiveBytes=archive.stat().st_size, rawMode=raw.stat().st_mode & 0o777,
                          receiptSha256=receipts, checkedAt=datetime.now(timezone.utc).isoformat())
            # Durable receipt precedes unlink. A crash with both copies is resumable.
            if receipt.exists():
                regular(receipt, root)
                previous = json.loads(receipt.read_text())
                if (previous.get('payloadSha256') != expected[0]
                        or previous.get('archiveSha256') != result['archiveSha256']):
                    raise RuntimeError('Conflicting compaction receipt')
            else:
                cache.atomic_json(receipt, result)
                sync_directory(run)
            if web.identity(source) != before:
                raise RuntimeError('DB changed before retirement')
            raw.unlink()
            sync_directory(raw.parent)
        return result
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--restore', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run with sudo to inspect protected references')
    with cache.deployment_lock(ROOT):
        print(json.dumps(transform(ROOT / args.run, apply=args.apply, restore=args.restore), sort_keys=True))
