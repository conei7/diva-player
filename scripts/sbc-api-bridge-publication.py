#!/usr/bin/env python3
"""Durably publish or reconcile the one-time SBC API bridge receipt.

The canonical path is created without overwrite by hard-linking the prepared
owner-only file.  Publication then converges to a single-link canonical inode.
If a process stops at any boundary, ``reconcile`` may only finish that exact
same inode/digest transition; it never replaces or removes an unrelated path.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
import sys
from pathlib import Path
from typing import Callable


HEX64 = re.compile(r"^[0-9a-f]{64}$")
Checkpoint = Callable[[str], None]


def _noop(_phase: str) -> None:
    return None


def _inspect_owner_file(path: Path, *, links: set[int]) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError(f"unsafe receipt inode: {path}")
    if info.st_nlink not in links:
        raise RuntimeError(f"unexpected receipt link count: {path}")
    if hasattr(os, "geteuid") and info.st_uid != os.geteuid():
        raise RuntimeError(f"receipt owner mismatch: {path}")
    return info


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_file(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _validate_digest(path: Path, expected_sha256: str, *, links: set[int]) -> os.stat_result:
    if HEX64.fullmatch(expected_sha256) is None:
        raise RuntimeError("expected receipt digest is invalid")
    info = _inspect_owner_file(path, links=links)
    if _sha256(path) != expected_sha256:
        raise RuntimeError(f"receipt digest mismatch: {path}")
    return info


def publish(prepared: Path, canonical: Path, expected_sha256: str,
            checkpoint: Checkpoint = _noop) -> None:
    prepared = prepared.absolute()
    canonical = canonical.absolute()
    prepared_info = _validate_digest(prepared, expected_sha256, links={1})
    if os.path.lexists(canonical):
        raise FileExistsError(f"canonical receipt already exists: {canonical}")
    os.link(prepared, canonical, follow_symlinks=False)
    checkpoint("after-link")
    canonical_info = _validate_digest(canonical, expected_sha256, links={2})
    if ((prepared_info.st_dev, prepared_info.st_ino)
            != (canonical_info.st_dev, canonical_info.st_ino)):
        raise RuntimeError("canonical receipt is not the prepared inode")
    _fsync_file(canonical)
    checkpoint("after-canonical-file-fsync")
    _fsync_directory(canonical.parent)
    checkpoint("after-canonical-directory-fsync")
    os.unlink(prepared)
    checkpoint("after-prepared-unlink")
    _fsync_directory(prepared.parent)
    checkpoint("after-prepared-directory-fsync")
    _validate_digest(canonical, expected_sha256, links={1})
    _fsync_file(canonical)
    _fsync_directory(canonical.parent)
    checkpoint("completed")


def reconcile(prepared: Path, canonical: Path, expected_sha256: str,
              checkpoint: Checkpoint = _noop) -> None:
    prepared = prepared.absolute()
    canonical = canonical.absolute()
    canonical_info = _validate_digest(canonical, expected_sha256, links={1, 2})
    if os.path.lexists(prepared):
        prepared_info = _validate_digest(prepared, expected_sha256, links={2})
        if ((prepared_info.st_dev, prepared_info.st_ino)
                != (canonical_info.st_dev, canonical_info.st_ino)):
            raise RuntimeError("prepared path is not the canonical receipt inode")
        os.unlink(prepared)
        checkpoint("after-prepared-unlink")
        _fsync_directory(prepared.parent)
        checkpoint("after-prepared-directory-fsync")
    _validate_digest(canonical, expected_sha256, links={1})
    _fsync_file(canonical)
    checkpoint("after-canonical-file-fsync")
    _fsync_directory(canonical.parent)
    checkpoint("completed")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("publish", "reconcile"))
    parser.add_argument("--prepared", required=True, type=Path)
    parser.add_argument("--canonical", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    arguments = parser.parse_args()
    operation = publish if arguments.mode == "publish" else reconcile
    operation(arguments.prepared, arguments.canonical, arguments.expected_sha256)
    print(arguments.mode + "ed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"SBC bridge receipt publication: {error}", file=sys.stderr)
        raise SystemExit(1)
