#!/usr/bin/env python3
"""Retire only terminal, unreferenced Trivy cache directories; default is dry-run."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile

ROOT = Path('/var/lib/diva-player-deploy')
RUN = re.compile(r'^(?:stateful-)?\d{8}T\d{6}Z-\d+$')
TERMINAL = {'completed', 'completed-pre-stateful-stateless-bridge',
            'failed-manual-reconciliation-completed', 'rolled-back', 'rollback-completed'}
CONTROLS = ('stateful-runtime-contract', 'api-bridge-receipt.json',
            'rolling-deployment-active', 'stateful-hardening-active')


def size(path: Path) -> int:
    return sum(p.stat().st_blocks * 512 if hasattr(p.stat(), 'st_blocks') else p.stat().st_size
               for p in path.rglob('*') if p.is_file() and not p.is_symlink())


def terminal(run: Path) -> bool:
    state = run / 'state'
    if state.is_symlink() or not state.is_file():
        return False
    statuses = [line.split('=', 1)[1] for line in state.read_text().splitlines()
                if line.startswith('deployment.status=')]
    return bool(statuses and statuses[-1] in TERMINAL)


def plan(root: Path, references: list[str]) -> dict:
    if root.is_symlink() or root.resolve(strict=True) != root or not root.is_dir():
        raise RuntimeError('Cache root must be a canonical directory')
    caches = []
    for run in sorted(root.iterdir(), reverse=True):
        if not RUN.fullmatch(run.name):
            continue
        if run.is_symlink() or not run.is_dir():
            continue
        for cache in (run / 'image-scan' / 'trivy-cache', run / 'trivy-cache'):
            if not cache.exists() and not cache.is_symlink():
                continue
            reason = None
            if cache.is_symlink() or cache.parent.is_symlink() or cache.resolve() != cache:
                reason = 'unsafe-path'
            elif not terminal(run) or any(run.glob('*unresolved*')):
                reason = 'nonterminal-or-unresolved'
            elif any(str(run) in value or run.name in value for value in references):
                reason = 'runtime-process-mount-or-recovery-reference'
            elif any(p.is_symlink() or p.stat().st_dev != root.stat().st_dev for p in cache.rglob('*')):
                reason = 'symlink-in-cache'
            caches.append({'path': str(cache), 'run': run.name, 'bytes': size(cache) if not reason or reason != 'unsafe-path' else 0,
                           'protectedReason': reason})
    eligible = [row for row in caches if row['protectedReason'] is None]
    if eligible:
        eligible[0]['protectedReason'] = 'latest-terminal-cache'
    return {'schemaVersion': 1, 'checkedAt': datetime.now(timezone.utc).isoformat(),
            'status': 'planned', 'caches': caches,
            'protectedBytes': sum(x['bytes'] for x in caches if x['protectedReason']),
            'reclaimableBytes': sum(x['bytes'] for x in caches if not x['protectedReason'])}


def live_references(root: Path) -> list[str]:
    refs = []
    for name in CONTROLS:
        p = root / name
        if p.is_symlink():
            raise RuntimeError('Unsafe runtime control reference')
        if p.exists():
            refs.append(p.read_text())
    ids = subprocess.check_output(['docker', 'ps', '-aq'], text=True).split()
    if ids:
        containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], text=True))
        for container in containers:
            refs.extend(str(m.get('Source', '')) for m in container.get('Mounts', []))
            refs.extend(str(m.get('Destination', '')) for m in container.get('Mounts', []))
            refs.append(json.dumps((container.get('Config') or {}).get('Labels') or {}))
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            refs.append((proc / 'cmdline').read_bytes().decode(errors='replace').replace('\x00', ' '))
        except FileNotFoundError:
            pass
        except PermissionError as error:
            raise RuntimeError('Cannot inspect processes safely') from error
    return refs


@contextmanager
def deployment_lock(root: Path, parent_lock: bool = False):
    import fcntl
    if root.is_symlink() or root.resolve(strict=True) != root or not root.is_dir():
        raise RuntimeError('Unsafe cache root')
    if parent_lock:
        parent = os.getppid()
        for name in ('deploy.lock', 'stateful-hardening.lock'):
            directory = root / name
            owner = directory / 'owner'
            if directory.is_symlink() or owner.is_symlink():
                raise RuntimeError('Unsafe parent deployment lock')
            if directory.is_dir() and owner.is_file():
                text = owner.read_text()
                if re.search(r'(?:^|\s)pid=' + str(parent) + r'(?:\s|$)', text):
                    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
                    ticks = Path(f'/proc/{parent}/stat').read_text().rsplit(')', 1)[1].split()[19]
                    if boot not in text or ticks not in text:
                        raise RuntimeError('Parent lock process identity changed')
                    yield
                    return
    lock = root / 'deploy.lock'
    if lock.exists() or lock.is_symlink():
        raise RuntimeError('Deployment lock is busy; defer cache retention')
    lock.mkdir(mode=0o700)
    identity = lock.stat().st_ino
    owner = lock / 'owner'
    owner.write_text(f'pid={os.getpid()}\nkind=scan-cache-retention\n')
    os.chmod(owner, 0o600)
    owner_identity = owner.stat().st_ino
    try:
        # Stateful operations acquire the same deployment lock. Legacy flock
        # files are also checked without changing them.
        legacy = root / 'stateful-hardening.lock'
        if legacy.is_symlink() or legacy.is_dir():
            raise RuntimeError('Stateful operation is unresolved; defer retention')
        if legacy.is_file():
            with legacy.open('rb') as stream:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                yield
        else:
            yield
    finally:
        if not lock.is_symlink() and lock.stat().st_ino == identity:
            if owner.is_symlink() or owner.stat().st_ino != owner_identity:
                raise RuntimeError('Cache lock identity changed; preserve it')
            owner.unlink()
            lock.rmdir()


def atomic_json(path: Path, value: dict):
    if path.is_symlink():
        raise RuntimeError('Unsafe retention receipt')
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.cache-retention-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    def interrupted(signum, frame):
        raise RuntimeError(f'Cache retention interrupted by signal {signum}')
    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--parent-lock', action='store_true', help='verify and borrow the invoking deployment lock')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Run with sudo to inspect all protected references')
    with deployment_lock(ROOT, args.parent_lock):
        first = plan(ROOT, live_references(ROOT))
        if not args.apply:
            print(json.dumps(first, sort_keys=True))
            return
        second = plan(ROOT, live_references(ROOT))
        if first['caches'] != second['caches']:
            raise RuntimeError('Cache references or sizes changed; defer retention')
        receipt = ROOT / 'scan-cache-retention.json'
        second['status'] = 'deleting'
        second['removed'] = []
        atomic_json(receipt, second)
        for row in second['caches']:
            if row['protectedReason']:
                continue
            p = Path(row['path'])
            if p.is_symlink() or p.resolve(strict=True) != p or not p.is_relative_to(ROOT):
                raise RuntimeError('Deletion target escaped cache root')
            if any(str(ROOT / row['run']) in value or row['run'] in value for value in live_references(ROOT)):
                raise RuntimeError('Cache gained a live reference')
            shutil.rmtree(p)
            second['removed'].append(row)
            atomic_json(receipt, second)
        second['status'] = 'success'
        second['removedBytes'] = sum(row['bytes'] for row in second['removed'])
        atomic_json(receipt, second)
        public_root = Path('/var/lib/diva-player-capacity')
        public_root.mkdir(mode=0o755, exist_ok=True)
        if public_root.is_symlink() or public_root.stat().st_uid != 0 or public_root.stat().st_mode & 0o022:
            raise RuntimeError('Unsafe public capacity directory')
        os.chmod(public_root, 0o755)
        summary = public_root / 'scan-cache-capacity.json'
        atomic_json(summary, {'schemaVersion': 1, 'checkedAt': second['checkedAt'], 'status': 'success',
                              'retainedCount': len(second['caches']) - len(second['removed']),
                              'retainedBytes': second['protectedBytes'],
                              'protectedReasons': {row['run']: row['protectedReason'] for row in second['caches'] if row['protectedReason']},
                              'removedBytes': second['removedBytes']})
        os.chmod(summary, 0o644)
        print(json.dumps(second, sort_keys=True))


if __name__ == '__main__':
    main()
