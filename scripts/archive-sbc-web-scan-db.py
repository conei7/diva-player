#!/usr/bin/env python3
"""Preserve exact Web scan databases in verified gzip archives; dry-run by default."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from datetime import datetime, timezone


def digest(path, compressed=False):
    before = identity(path)
    result = hashlib.sha256()
    length = 0
    with (gzip.open(path, 'rb') if compressed else path.open('rb')) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
            length += len(chunk)
    if identity(path) != before:
        raise RuntimeError(f'Evidence changed while hashing: {path}')
    return result.hexdigest(), length


def identity(path):
    s = path.stat()
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def safe_file(path, root):
    if not path.is_file() or path.is_symlink() or path.resolve() != path or not path.is_relative_to(root):
        raise RuntimeError(f'Unsafe evidence path: {path}')
    if path.stat().st_uid != os.getuid():
        raise RuntimeError(f'Unexpected owner: {path}')


def offline(release):
    ancestors = set()
    pid = os.getpid()
    while pid > 1:
        ancestors.add(pid)
        status = Path(f'/proc/{pid}/status').read_text()
        pid = int(next(line.split()[1] for line in status.splitlines() if line.startswith('PPid:')))
    ids = subprocess.check_output(['docker', 'ps', '-aq'], text=True).split()
    if ids:
        containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], text=True))
        for container in containers:
            for mount in container.get('Mounts', []):
                source = mount.get('Source', '')
                if source and (Path(source).is_relative_to(release) or release.is_relative_to(Path(source))):
                    raise RuntimeError('Release is referenced by a container mount')
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            command = (proc / 'cmdline').read_bytes()
            if int(proc.name) not in ancestors and str(release).encode() in command:
                raise RuntimeError('Release is referenced by a live process')
            # Also catch an already-open database with no path in argv.
            for fd in (proc / 'fd').iterdir():
                target = os.readlink(fd)
                if target.startswith(str(release) + '/'):
                    raise RuntimeError('Release has an open file')
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue


def archive_release(release, apply=False):
    root = release.parent
    if not re.fullmatch(r'web-release-[0-9a-f]{7,40}(?:-parallel)?', release.name):
        raise RuntimeError('Expected an exact Web release directory')
    if release.resolve() != release or release.is_symlink():
        raise RuntimeError('Noncanonical release directory')
    receipts = sorted(release.glob('runtime-receipt*.json'))
    if not receipts:
        raise RuntimeError('No runtime receipt')
    databases = []
    for receipt in receipts:
        safe_file(receipt, root)
        data = json.loads(receipt.read_text())
        if data.get('service') != 'web' or data.get('verdict', {}).get('highCriticalCount') != 0:
            raise RuntimeError('Invalid Web scan receipt')
        database = data['database']
        databases.append((database['dbSha256'], database['dbSize']))
    if len(set(databases)) != 1:
        raise RuntimeError('Receipts refer to different databases')
    expected = databases[0]
    raw = release / 'runtime-scan-cache/db/trivy.db'
    target = raw.with_suffix('.db.gz')
    if not raw.exists():
        safe_file(target, root)
        if digest(target, True) != expected:
            raise RuntimeError('Archived DB does not match receipt')
        return {'release': release.name, 'status': 'already-archived', 'archiveSha256': digest(target)[0]}
    safe_file(raw, root)
    before = identity(raw)
    if digest(raw) != expected:
        raise RuntimeError('DB does not match receipt')
    result = {'release': release.name, 'status': 'planned', 'payloadSha256': expected[0], 'payloadBytes': expected[1]}
    if not apply:
        return result
    offline(release)
    if target.exists() or target.is_symlink():
        raise RuntimeError('Archive already exists; preserve both files for review')
    fd, temporary = tempfile.mkstemp(prefix='.scan-db-', dir=raw.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(fd, 'wb') as output, raw.open('rb') as source:
            with gzip.GzipFile(filename='', mode='wb', fileobj=output, compresslevel=6, mtime=0) as packed:
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    packed.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if digest(temporary, True) != expected or identity(raw) != before:
            raise RuntimeError('DB changed or compression verification failed')
        offline(release)
        os.link(temporary, target)  # Never replace a pre-existing archive.
        temporary.unlink()
        directory = os.open(raw.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
            if identity(raw) != before:
                raise RuntimeError('DB changed before retirement')
            raw.unlink()
            os.fsync(directory)
        finally:
            os.close(directory)
        result.update(status='archived', archivePath=str(target), archiveSha256=digest(target)[0],
                      archiveBytes=target.stat().st_size, checkedAt=datetime.now(timezone.utc).isoformat())
        receipt_path = release / 'scan-db-compaction.json'
        with receipt_path.open('x') as output:
            json.dump(result, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        return result
    finally:
        temporary.unlink(missing_ok=True)


def deduplicate(root, apply=False):
    """Share archives with identical verified payloads; preserve re-encoding history."""
    known = {}
    results = []
    for release in sorted(root.glob('web-release-*')):
        target = release / 'runtime-scan-cache/db/trivy.db.gz'
        if not target.exists():
            continue
        archive_release(release)  # Validate the decompressed payload against all receipts.
        key = digest(target, True)
        if key not in known:
            known[key] = target
            continue
        source = known[key]
        if source.samefile(target):
            continue
        before, source_before = identity(target), identity(source)
        old_hash, old_size = digest(target)
        new_hash, new_size = digest(source)
        results.append({'release': release.name, 'duplicateOf': str(source), 'bytes': old_size})
        if apply:
            offline(release)
            offline(source.parents[2])
            temporary = target.with_name('.trivy.db.gz.deduplicate')
            linked = False
            try:
                # Keep the original archive receipt untouched. This append-only
                # transformation receipt explains the current gzip byte hash;
                # the scan receipt's uncompressed DB hash remains unchanged.
                journal = release / f'scan-db-deduplication-{old_hash}-{new_hash}.json'
                with journal.open('x') as output:
                    json.dump({'payloadSha256': key[0], 'previousArchiveSha256': old_hash,
                               'archiveSha256': new_hash, 'archiveBytes': new_size,
                               'duplicateOf': str(source), 'archivePath': str(target)}, output, indent=2)
                    output.flush()
                    os.fsync(output.fileno())
                fd = os.open(release, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
                os.link(source, temporary)
                linked = True
                if identity(target) != before or identity(source)[:4] != source_before[:4]:
                    raise RuntimeError('Archive changed during deduplication')
                os.replace(temporary, target)
                fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            finally:
                if linked:
                    temporary.unlink(missing_ok=True)
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path)
    parser.add_argument('--deduplicate-root', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if bool(args.release) == bool(args.deduplicate_root):
        parser.error('Choose exactly one of --release and --deduplicate-root')
    if args.deduplicate_root:
        root = args.deduplicate_root
        if root.resolve() != root or root.is_symlink() or root.stat().st_uid != os.getuid():
            raise RuntimeError('Unsafe root')
        result = deduplicate(root, args.apply)
    else:
        result = archive_release(args.release, args.apply)
    print(json.dumps(result, ensure_ascii=False, indent=2))
