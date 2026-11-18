#!/usr/bin/env python3
"""Preserve exact Web and PostgreSQL scan databases; dry-run by default."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zlib
from datetime import datetime, timezone


def digest(path, compressed=False):
    before = identity(path)
    result = hashlib.sha256()
    length = 0
    try:
        with (gzip.open(path, 'rb') if compressed else path.open('rb')) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                result.update(chunk)
                length += len(chunk)
    except (gzip.BadGzipFile, EOFError, zlib.error) as error:
        raise RuntimeError(f'Invalid compressed evidence: {path}') from error
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


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish_receipt(path, data):
    fd, name = tempfile.mkstemp(prefix='.scan-db-receipt-', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(data, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


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


def archive_identity(release):
    """Read receipt metadata without expanding a DB; never authorizes a mutation."""
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
    return databases[0]


def postgres_archive_identity(stage):
    if (not re.fullmatch(r'postgres-\d+\.\d+-[0-9a-f]{7,40}', stage.name)
            or stage.resolve() != stage or stage.is_symlink()):
        raise RuntimeError('Expected an exact PostgreSQL scan stage')
    databases = set()
    for component, service in (('postgres', 'pgvector-runtime'), ('migrate', 'postgres-migrate-helper')):
        receipt = stage / f'{component}-receipt.json'
        image = stage / f'{component}-image-id'
        safe_file(receipt, stage)
        safe_file(image, stage)
        data = json.loads(receipt.read_text())
        if (data.get('service') != service or data.get('verdict', {}).get('highCriticalCount') != 0
                or data['image']['id'] != image.read_text().strip()):
            raise RuntimeError('Invalid PostgreSQL scan receipt')
        database = data['database']
        databases.add((database['dbSha256'], database['dbSize']))
    if len(databases) != 1:
        raise RuntimeError('Receipts refer to different databases')
    return databases.pop()


def matching_archive(root, expected, target):
    for pattern, relative, receipt_reader in (
        ('web-release-*', 'runtime-scan-cache/db/trivy.db.gz', archive_identity),
        ('postgres-*', 'scan-cache/db/trivy.db.gz', postgres_archive_identity),
    ):
        for release in sorted(root.glob(pattern)):
            candidate = release / relative
            if candidate == target or not candidate.is_file():
                continue
            if receipt_reader(release) == expected:
                safe_file(candidate, root)
                if digest(candidate, True) != expected:
                    raise RuntimeError('Shared archive does not match receipt')
                return candidate
    return None


def archive_database(release, raw, receipt_identity, apply=False, share=False):
    root = release.parent
    expected = receipt_identity(release)
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
    receipt_path = release / 'scan-db-compaction.json'
    temporary = None
    try:
        if target.exists() or target.is_symlink():
            safe_file(target, root)
        else:
            shared = matching_archive(root, expected, target) if share else None
            if shared is not None:
                os.link(shared, target)
                result['sharedFrom'] = str(shared)
            else:
                fd, name = tempfile.mkstemp(prefix='.scan-db-', dir=raw.parent)
                temporary = Path(name)
                with os.fdopen(fd, 'wb') as output, raw.open('rb') as source:
                    with gzip.GzipFile(filename='', mode='wb', fileobj=output, compresslevel=6, mtime=0) as packed:
                        shutil.copyfileobj(source, packed, 1024 * 1024)
                    output.flush()
                    os.fsync(output.fileno())
                if digest(temporary, True) != expected:
                    raise RuntimeError('Compression verification failed')
                os.link(temporary, target)
            sync_directory(raw.parent)
        if digest(target, True) != expected or receipt_identity(release) != expected:
            raise RuntimeError('Archive or receipts changed before retirement')
        result.update(status='archived', archivePath=str(target), archiveSha256=digest(target)[0],
                      archiveBytes=target.stat().st_size, checkedAt=datetime.now(timezone.utc).isoformat())
        if receipt_path.exists() or receipt_path.is_symlink():
            safe_file(receipt_path, root)
            previous = json.loads(receipt_path.read_text())
            if any(previous.get(k) != result[k] for k in ('payloadSha256', 'payloadBytes')):
                raise RuntimeError('Conflicting compaction receipt')
            if previous.get('archiveSha256') != result['archiveSha256']:
                # Historical deduplication can replace gzip encoding while
                # preserving the exact payload. Keep both representations' receipts.
                receipt_path = release / f"scan-db-compaction-{result['archiveSha256']}.json"
                if receipt_path.exists() or receipt_path.is_symlink():
                    safe_file(receipt_path, root)
                    record = json.loads(receipt_path.read_text())
                    if any(record.get(k) != result[k] for k in ('payloadSha256', 'payloadBytes', 'archiveSha256')):
                        raise RuntimeError('Conflicting archive representation receipt')
        if not receipt_path.exists():
            publish_receipt(receipt_path, result)
        sync_directory(release)
        offline(release)
        if identity(raw) != before:
            raise RuntimeError('DB changed before retirement')
        raw.unlink()
        sync_directory(raw.parent)
        return result
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def archive_release(release, apply=False, *, share=True):
    return archive_database(release, release / 'runtime-scan-cache/db/trivy.db', archive_identity,
                            apply=apply, share=share)


def archive_postgres(stage, apply=False):
    return archive_database(stage, stage / 'scan-cache/db/trivy.db', postgres_archive_identity,
                            apply=apply, share=True)


def restore_database(release, raw, receipt_identity, apply=False):
    expected = receipt_identity(release)
    source = raw.with_suffix('.db.gz')
    safe_file(source, release)
    if digest(source, True) != expected:
        raise RuntimeError('Archived DB does not match receipt')
    if raw.exists() or raw.is_symlink():
        safe_file(raw, release)
        if digest(raw) != expected:
            raise RuntimeError('Existing plain DB does not match receipt')
        return {'status': 'already-restored'}
    if not apply:
        return {'status': 'planned-restore', 'payloadBytes': expected[1]}
    offline(release)
    report = json.loads((release.parent / 'runtime_health_latest.json').read_text())
    if shutil.disk_usage(raw.parent).free < report['capacity']['reserveRequiredBytes'] + expected[1]:
        raise RuntimeError('Restore would consume the operational reserve')
    fd, name = tempfile.mkstemp(prefix='.scan-db-restore-', dir=raw.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'wb') as output, gzip.open(source, 'rb') as packed:
            remaining = expected[1]
            for chunk in iter(lambda: packed.read(1024 * 1024), b''):
                remaining -= len(chunk)
                if remaining < 0:
                    raise RuntimeError('Restored DB exceeds receipt size')
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if digest(temporary) != expected or receipt_identity(release) != expected:
            raise RuntimeError('Restored DB does not match receipt')
        offline(release)
        os.link(temporary, raw)
        sync_directory(raw.parent)
        return {'status': 'restored', 'payloadBytes': expected[1]}
    finally:
        temporary.unlink(missing_ok=True)


def deduplicate(root, apply=False):
    """Share archives with identical verified payloads; preserve re-encoding history."""
    candidates = {}
    inodes = {}
    for release in sorted(root.glob('web-release-*')):
        target = release / 'runtime-scan-cache/db/trivy.db.gz'
        if not target.exists():
            continue
        key = archive_identity(release)
        safe_file(target, root)
        inode = identity(target)[:2]
        if inode in inodes and inodes[inode] != key:
            raise RuntimeError('Linked archives have inconsistent receipts')
        inodes[inode] = key
        candidates.setdefault(key, {}).setdefault(inode, target)
    known = {}
    results = []
    # Unique payloads and already-shared inodes need no mutation or decompression.
    # Metadata only selects candidates: every distinct candidate's full payload is
    # still hashed against its scan receipt before it can be linked or replaced.
    for key, distinct in candidates.items():
        if len(distinct) < 2:
            continue
        for target in distinct.values():
            if digest(target, True) != key:
                raise RuntimeError('Archived DB does not match receipt')
    for release in sorted(root.glob('web-release-*')):
        target = release / 'runtime-scan-cache/db/trivy.db.gz'
        if not target.exists():
            continue
        key = archive_identity(release)
        if len(candidates[key]) < 2:
            continue
        archive_release(release)  # Validate the decompressed payload against all receipts.
        if key not in known:
            known[key] = target
            continue
        source = known[key]
        if source.samefile(target):
            continue
        before, source_before = identity(target), identity(source)
        if digest(target, True) != key or digest(source, True) != key:
            raise RuntimeError('Candidate payload changed before deduplication')
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
    parser.add_argument('--postgres-stage', type=Path)
    parser.add_argument('--deduplicate-root', type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--restore', action='store_true')
    parser.add_argument('--after', nargs=argparse.REMAINDER,
                        help='run an explicitly supplied deployment command and archive only after it succeeds')
    args = parser.parse_args()
    if sum(p is not None for p in (args.release, args.postgres_stage, args.deduplicate_root)) != 1:
        parser.error('Choose exactly one evidence target')
    if args.after is not None:
        if not args.after or not args.apply or args.restore or args.deduplicate_root:
            parser.error('--after requires a command, one evidence target and --apply')
        target = args.release or args.postgres_stage
        pattern = (r'web-release-[0-9a-f]{7,40}(?:-parallel)?' if args.release
                   else r'postgres-\d+\.\d+-[0-9a-f]{7,40}')
        if not re.fullmatch(pattern, target.name) or target.resolve() != target:
            parser.error('--after requires a canonical release or scan-stage path')
        child = subprocess.run(args.after)
        if child.returncode != 0:
            raise SystemExit(child.returncode)
        print('Deployment command succeeded; finalizing scan evidence.', flush=True)
    if args.restore and args.deduplicate_root:
        parser.error('--restore requires one evidence target')
    if args.deduplicate_root:
        root = args.deduplicate_root
        if root.resolve() != root or root.is_symlink() or root.stat().st_uid != os.getuid():
            raise RuntimeError('Unsafe root')
        result = deduplicate(root, args.apply)
    elif args.restore:
        if args.postgres_stage:
            target = args.postgres_stage
            result = restore_database(target, target / 'scan-cache/db/trivy.db',
                                      postgres_archive_identity, args.apply)
        else:
            target = args.release
            result = restore_database(target, target / 'runtime-scan-cache/db/trivy.db',
                                      archive_identity, args.apply)
    elif args.postgres_stage:
        result = archive_postgres(args.postgres_stage, args.apply)
    else:
        result = archive_release(args.release, args.apply)
    print(json.dumps(result, ensure_ascii=False, indent=2))
