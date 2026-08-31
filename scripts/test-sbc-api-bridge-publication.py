#!/usr/bin/env python3
"""Fault tests for durable single-link SBC bridge receipt publication."""

from __future__ import annotations

import hashlib
import importlib.util
import os
import stat
import tempfile
from pathlib import Path


HELPER = Path(__file__).with_name("sbc-api-bridge-publication.py")


def load_helper():
    specification = importlib.util.spec_from_file_location("sbc_bridge_publication", HELPER)
    assert specification and specification.loader
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    # Windows does not provide Linux directory-fsync semantics.  Boundary
    # ordering and repair are still exercised; production uses the real call.
    if os.name == "nt":
        module._fsync_directory = lambda _path: None
        module._fsync_file = lambda _path: None
        def inspect_windows(path, *, links):
            info = Path(path).lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink not in links:
                raise RuntimeError(f"unsafe receipt inode: {path}")
            return info
        module._inspect_owner_file = inspect_windows
    return module


def write_prepared(path: Path, payload: bytes) -> str:
    path.write_bytes(payload)
    os.chmod(path, 0o600)
    return hashlib.sha256(payload).hexdigest()


def require_canonical(path: Path, expected: bytes) -> None:
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode)
    if os.name != "nt":
        assert stat.S_IMODE(info.st_mode) == 0o600
    assert info.st_nlink == 1
    assert path.read_bytes() == expected


def main() -> int:
    helper = load_helper()
    payload = b'{"receipt":"exact"}\n'
    phases = (
        "after-link",
        "after-canonical-file-fsync",
        "after-canonical-directory-fsync",
        "after-prepared-unlink",
        "after-prepared-directory-fsync",
        "completed",
    )
    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-publication.") as temporary:
        root = Path(temporary)
        for phase in phases:
            source = root / f"prepared-{phase}"
            canonical = root / f"canonical-{phase}"
            expected_sha = write_prepared(source, payload)

            def fail_at(observed: str, *, target: str = phase) -> None:
                if observed == target:
                    raise RuntimeError(f"injected fault at {target}")

            try:
                helper.publish(source, canonical, expected_sha, fail_at)
            except RuntimeError as error:
                assert "injected fault" in str(error)
            else:
                raise AssertionError(f"fault at {phase} did not interrupt publication")
            assert canonical.exists(), phase
            helper.reconcile(source, canonical, expected_sha)
            assert not os.path.lexists(source), phase
            require_canonical(canonical, payload)

        normal_source = root / "prepared-normal"
        normal_canonical = root / "canonical-normal"
        normal_sha = write_prepared(normal_source, payload)
        helper.publish(normal_source, normal_canonical, normal_sha)
        assert not normal_source.exists()
        require_canonical(normal_canonical, payload)

        occupied_source = root / "prepared-occupied"
        occupied_canonical = root / "canonical-occupied"
        occupied_sha = write_prepared(occupied_source, payload)
        occupied_canonical.write_bytes(b"third-party\n")
        os.chmod(occupied_canonical, 0o600)
        try:
            helper.publish(occupied_source, occupied_canonical, occupied_sha)
        except FileExistsError:
            pass
        else:
            raise AssertionError("publisher overwrote an existing canonical receipt")
        assert occupied_canonical.read_bytes() == b"third-party\n"
        assert occupied_source.exists()

        wrong_source = root / "prepared-wrong-digest"
        wrong_canonical = root / "canonical-wrong-digest"
        write_prepared(wrong_source, payload)
        try:
            helper.publish(wrong_source, wrong_canonical, "0" * 64)
        except RuntimeError:
            pass
        else:
            raise AssertionError("publisher accepted a wrong expected digest")
        assert not wrong_canonical.exists()

        rogue_source = root / "prepared-rogue"
        rogue_canonical = root / "canonical-rogue"
        rogue_sha = write_prepared(rogue_source, payload)
        try:
            helper.publish(
                rogue_source,
                rogue_canonical,
                rogue_sha,
                lambda phase: (_ for _ in ()).throw(RuntimeError("stop"))
                if phase == "after-link" else None,
            )
        except RuntimeError:
            pass
        rogue_source.unlink()
        write_prepared(rogue_source, b"unrelated\n")
        try:
            helper.reconcile(rogue_source, rogue_canonical, rogue_sha)
        except RuntimeError:
            pass
        else:
            raise AssertionError("reconciler unlinked an unrelated prepared path")
        assert rogue_source.read_bytes() == b"unrelated\n"
        assert rogue_canonical.read_bytes() == payload

    print("PASS SBC bridge receipt publication fault boundaries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
