#!/usr/bin/env python3
"""Create a fresh, content-bound attestation for off-host DR payloads."""

from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import functools
import hashlib
import json
import os
import re
import socket
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import AbstractSet, Any


SCHEMA_VERSION = 1
REPARSE_POINT = 0x400
CHUNK_SIZE = 8 * 1024 * 1024
WINDOWS_SYSTEM_SID = "S-1-5-18"
WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544"
WINDOWS_OWNER_RIGHTS_SID = "S-1-3-4"
WINDOWS_TRUSTED_INSTALLER_SID = (
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
)
WINDOWS_ALLOWED_WRITER_SIDS: frozenset[str] = frozenset()
WINDOWS_UNTRUSTED_FILE_WRITE_MASK = (
    0x10000000  # GENERIC_ALL
    | 0x40000000  # GENERIC_WRITE
    | 0x02000000  # MAXIMUM_ALLOWED
    | 0x00010000  # DELETE
    | 0x00040000  # WRITE_DAC
    | 0x00080000  # WRITE_OWNER
    | 0x00000002  # FILE_WRITE_DATA
    | 0x00000004  # FILE_APPEND_DATA
    | 0x00000010  # FILE_WRITE_EA
    | 0x00000100  # FILE_WRITE_ATTRIBUTES
)
WINDOWS_UNTRUSTED_DIRECTORY_REPLACEMENT_MASK = (
    0x10000000  # GENERIC_ALL
    | 0x02000000  # MAXIMUM_ALLOWED
    | 0x00010000  # DELETE
    | 0x00040000  # WRITE_DAC
    | 0x00080000  # WRITE_OWNER
    | 0x00000040  # FILE_DELETE_CHILD
)
WINDOWS_BROAD_PRINCIPAL_SIDS = frozenset({
    "S-1-1-0",       # Everyone
    "S-1-2-0",       # Local
    "S-1-5-2",       # Network
    "S-1-5-3",       # Batch
    "S-1-5-4",       # Interactive
    "S-1-5-6",       # Service
    "S-1-5-7",       # Anonymous
    "S-1-5-11",      # Authenticated Users
    "S-1-5-12",      # Restricted Code
    "S-1-5-13",      # Terminal Server Users
    "S-1-5-14",      # Remote Interactive Logon
    "S-1-5-19",      # Local Service
    "S-1-5-20",      # Network Service
    "S-1-5-32-545",  # Builtin Users
    "S-1-5-32-546",  # Builtin Guests
    "S-1-5-32-547",  # Power Users
    "S-1-5-32-548",  # Account Operators
    "S-1-5-32-549",  # Server Operators
    "S-1-5-32-550",  # Print Operators
    "S-1-5-32-551",  # Backup Operators
    "S-1-15-2-1",    # All application packages
    "S-1-15-2-2",    # All restricted application packages
})


@dataclass(frozen=True)
class PathBinding:
    identity: tuple[int, ...]
    ancestors: tuple[tuple[str, tuple[int, ...]], ...]
    security_sha256: str


def _identity(value: os.stat_result) -> tuple[int, ...]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_uid,
        value.st_gid,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
        getattr(value, "st_file_attributes", 0),
    )


def _object_identity(value: os.stat_result) -> tuple[int, int, int]:
    return value.st_dev, value.st_ino, stat.S_IFMT(value.st_mode)


def _handle_identity(value: os.stat_result) -> tuple[int, ...]:
    """Fields represented consistently by Windows path and handle stat calls."""
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_uid,
        value.st_gid,
        value.st_size,
        value.st_mtime_ns,
        getattr(value, "st_file_attributes", 0),
    )


def _reject_reparse_ancestors(path: Path) -> tuple[tuple[str, tuple[int, ...]], ...]:
    absolute = path.absolute()
    if not absolute.is_absolute() or not absolute.anchor:
        raise RuntimeError(f"Backup path is not absolute: {path}")
    current = Path(absolute.anchor)
    bindings: list[tuple[str, tuple[int, ...]]] = []
    components = absolute.parts[1:-1]
    anchor_state = current.lstat()
    if not stat.S_ISDIR(anchor_state.st_mode):
        raise RuntimeError(f"Backup path anchor is not a directory: {current}")
    bindings.append((str(current), _object_identity(anchor_state)))
    for part in components:
        current /= part
        value = current.lstat()
        if stat.S_ISLNK(value.st_mode) or getattr(value, "st_file_attributes", 0) & REPARSE_POINT:
            raise RuntimeError(f"Backup path contains a link or reparse point: {current}")
        if not stat.S_ISDIR(value.st_mode):
            raise RuntimeError(f"Backup path ancestor is not a directory: {current}")
        bindings.append((str(current), _object_identity(value)))
    return tuple(bindings)


def _sid_text(sid: ctypes.c_void_p) -> str:
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32.IsValidSid.argtypes = [wintypes.LPVOID]
    advapi32.IsValidSid.restype = wintypes.BOOL
    advapi32.ConvertSidToStringSidW.argtypes = [wintypes.LPVOID, ctypes.POINTER(wintypes.LPWSTR)]
    advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [wintypes.LPVOID]
    kernel32.LocalFree.restype = wintypes.LPVOID
    if not advapi32.IsValidSid(sid):
        raise RuntimeError("Windows security descriptor contains an invalid SID")
    text = wintypes.LPWSTR()
    if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return str(text.value).upper()
    finally:
        kernel32.LocalFree(ctypes.cast(text, wintypes.LPVOID))


@functools.lru_cache(maxsize=1)
def _windows_task_sid() -> str:
    from ctypes import wintypes

    class SidAndAttributes(ctypes.Structure):
        _fields_ = [("sid", wintypes.LPVOID), ("attributes", wintypes.DWORD)]

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.OpenProcessToken.restype = wintypes.BOOL
    advapi32.GetTokenInformation.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    advapi32.GetTokenInformation.restype = wintypes.BOOL
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        required = wintypes.DWORD()
        advapi32.GetTokenInformation(token, 1, None, 0, ctypes.byref(required))
        if ctypes.get_last_error() != 122 or required.value <= 0:
            raise ctypes.WinError(ctypes.get_last_error())
        buffer = ctypes.create_string_buffer(required.value)
        if not advapi32.GetTokenInformation(
            token, 1, buffer, required.value, ctypes.byref(required)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        token_user = ctypes.cast(buffer, ctypes.POINTER(SidAndAttributes)).contents
        return _sid_text(token_user.sid)
    finally:
        kernel32.CloseHandle(token)


def _normalize_allowed_writer_sid(value: str) -> str:
    sid = value.strip().upper()
    if not re.fullmatch(r"S-[0-9]+(?:-[0-9]+)+", sid):
        raise RuntimeError(f"Allowed writer SID is malformed: {value!r}")
    if sid.startswith("S-1-3-"):
        raise RuntimeError(f"Allowed writer SID names a dynamic principal: {sid}")
    if sid in WINDOWS_BROAD_PRINCIPAL_SIDS:
        raise RuntimeError(f"Allowed writer SID names a broad principal: {sid}")
    if sid in {
        WINDOWS_SYSTEM_SID,
        WINDOWS_ADMINISTRATORS_SID,
        WINDOWS_TRUSTED_INSTALLER_SID,
    }:
        raise RuntimeError(f"Allowed writer SID is already trusted without an override: {sid}")
    if os.name == "nt":
        from ctypes import wintypes

        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        advapi32.ConvertStringSidToSidW.argtypes = [
            wintypes.LPCWSTR,
            ctypes.POINTER(wintypes.LPVOID),
        ]
        advapi32.ConvertStringSidToSidW.restype = wintypes.BOOL
        kernel32.LocalFree.argtypes = [wintypes.LPVOID]
        kernel32.LocalFree.restype = wintypes.LPVOID
        native_sid = wintypes.LPVOID()
        if not advapi32.ConvertStringSidToSidW(sid, ctypes.byref(native_sid)):
            raise RuntimeError(f"Allowed writer SID is invalid: {sid}") from ctypes.WinError(
                ctypes.get_last_error()
            )
        try:
            if _sid_text(native_sid) != sid:
                raise RuntimeError(f"Allowed writer SID is not canonical: {sid}")
        finally:
            kernel32.LocalFree(native_sid)
    return sid


def _windows_owner_is_trusted(
    owner_sid: str,
    trusted_sids: AbstractSet[str],
) -> bool:
    if owner_sid.startswith("S-1-3-"):
        return False
    return owner_sid in trusted_sids


def _windows_grantee_is_trusted(
    grantee_sid: str,
    *,
    owner_sid: str,
    trusted_sids: AbstractSet[str],
) -> bool:
    # OWNER RIGHTS is a dynamic trustee for this object's actual owner.  It is
    # safe only after that owner has passed the same explicit trusted-owner
    # policy as every other managed backup path.  Other S-1-3-* creator or
    # dynamic trustees must never become trusted merely by entering a caller's
    # allow-list because they do not identify a stable account.
    if grantee_sid == WINDOWS_OWNER_RIGHTS_SID:
        return _windows_owner_is_trusted(owner_sid, trusted_sids)
    if grantee_sid.startswith("S-1-3-"):
        return False
    return grantee_sid in trusted_sids


def _windows_security_descriptor(
    path: Path,
    *,
    reject_broad_access: bool,
    reject_untrusted_writes: bool,
    require_protected_dacl: bool,
    include_allowed_writers: bool,
    directory: bool,
) -> str:
    from ctypes import wintypes

    class AclHeader(ctypes.Structure):
        _fields_ = [
            ("revision", ctypes.c_ubyte),
            ("reserved1", ctypes.c_ubyte),
            ("size", ctypes.c_ushort),
            ("ace_count", ctypes.c_ushort),
            ("reserved2", ctypes.c_ushort),
        ]

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    security_information = 0x00000001 | 0x00000002 | 0x00000004
    advapi32.GetFileSecurityW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    advapi32.GetFileSecurityW.restype = wintypes.BOOL
    advapi32.IsValidSecurityDescriptor.argtypes = [wintypes.LPVOID]
    advapi32.IsValidSecurityDescriptor.restype = wintypes.BOOL
    advapi32.GetSecurityDescriptorOwner.argtypes = [
        wintypes.LPVOID,
        ctypes.POINTER(wintypes.LPVOID),
        ctypes.POINTER(wintypes.BOOL),
    ]
    advapi32.GetSecurityDescriptorOwner.restype = wintypes.BOOL
    advapi32.GetSecurityDescriptorDacl.argtypes = [
        wintypes.LPVOID,
        ctypes.POINTER(wintypes.BOOL),
        ctypes.POINTER(wintypes.LPVOID),
        ctypes.POINTER(wintypes.BOOL),
    ]
    advapi32.GetSecurityDescriptorDacl.restype = wintypes.BOOL
    advapi32.GetSecurityDescriptorControl.argtypes = [
        wintypes.LPVOID,
        ctypes.POINTER(ctypes.c_ushort),
        ctypes.POINTER(wintypes.DWORD),
    ]
    advapi32.GetSecurityDescriptorControl.restype = wintypes.BOOL
    advapi32.GetAce.argtypes = [
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.LPVOID),
    ]
    advapi32.GetAce.restype = wintypes.BOOL

    required = wintypes.DWORD()
    advapi32.GetFileSecurityW(str(path), security_information, None, 0, ctypes.byref(required))
    if ctypes.get_last_error() != 122 or required.value <= 0:
        raise ctypes.WinError(ctypes.get_last_error())
    buffer = ctypes.create_string_buffer(required.value)
    descriptor = ctypes.cast(buffer, wintypes.LPVOID)
    if not advapi32.GetFileSecurityW(
        str(path), security_information, descriptor, required.value, ctypes.byref(required)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    if not advapi32.IsValidSecurityDescriptor(descriptor):
        raise RuntimeError(f"Windows security descriptor is invalid: {path}")

    owner = wintypes.LPVOID()
    owner_defaulted = wintypes.BOOL()
    if not advapi32.GetSecurityDescriptorOwner(
        descriptor, ctypes.byref(owner), ctypes.byref(owner_defaulted)
    ) or not owner:
        raise RuntimeError(f"Windows backup path has no owner: {path}")
    owner_sid = _sid_text(owner)
    trusted_sids = {
        _windows_task_sid(),
        WINDOWS_SYSTEM_SID,
        WINDOWS_ADMINISTRATORS_SID,
        WINDOWS_TRUSTED_INSTALLER_SID,
    }
    if include_allowed_writers:
        trusted_sids.update(WINDOWS_ALLOWED_WRITER_SIDS)
    owner_is_trusted = _windows_owner_is_trusted(owner_sid, trusted_sids)
    if (reject_broad_access or reject_untrusted_writes) and not owner_is_trusted:
        raise RuntimeError(f"Windows backup path has an unexpected owner {owner_sid}: {path}")

    dacl_present = wintypes.BOOL()
    dacl_defaulted = wintypes.BOOL()
    dacl = wintypes.LPVOID()
    if not advapi32.GetSecurityDescriptorDacl(
        descriptor, ctypes.byref(dacl_present), ctypes.byref(dacl), ctypes.byref(dacl_defaulted)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    if not dacl_present.value or not dacl:
        raise RuntimeError(f"Windows backup path has a null or missing DACL: {path}")

    control = ctypes.c_ushort()
    revision = wintypes.DWORD()
    if not advapi32.GetSecurityDescriptorControl(
        descriptor, ctypes.byref(control), ctypes.byref(revision)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    if require_protected_dacl and not control.value & 0x1000:
        raise RuntimeError(f"Windows backup root DACL still inherits broad access: {path}")

    if reject_broad_access or reject_untrusted_writes:
        allow_types = {0, 5, 9, 11}
        deny_types = {1, 6, 10, 12}
        header = ctypes.cast(dacl, ctypes.POINTER(AclHeader)).contents
        if header.ace_count <= 0:
            raise RuntimeError(f"Windows backup path DACL has no allow entries: {path}")
        trusted_allow_count = 0
        write_mask = (
            WINDOWS_UNTRUSTED_DIRECTORY_REPLACEMENT_MASK
            if directory
            else WINDOWS_UNTRUSTED_FILE_WRITE_MASK
        )
        for index in range(header.ace_count):
            ace = wintypes.LPVOID()
            if not advapi32.GetAce(dacl, index, ctypes.byref(ace)) or not ace:
                raise ctypes.WinError(ctypes.get_last_error())
            address = int(ace.value)
            ace_type = ctypes.c_ubyte.from_address(address).value
            ace_flags = ctypes.c_ubyte.from_address(address + 1).value
            ace_size = ctypes.c_ushort.from_address(address + 2).value
            if ace_type in deny_types:
                continue
            if ace_type not in allow_types:
                raise RuntimeError(f"Windows backup path has an unsupported granting ACE: {path}")
            sid_offset = 8
            if ace_type in {5, 11}:
                object_flags = ctypes.c_uint32.from_address(address + 8).value
                sid_offset = 12
                if object_flags & 0x1:
                    sid_offset += 16
                if object_flags & 0x2:
                    sid_offset += 16
            if sid_offset >= ace_size:
                raise RuntimeError(f"Windows backup path has a malformed allow ACE: {path}")
            sid = _sid_text(wintypes.LPVOID(address + sid_offset))
            access_mask = ctypes.c_uint32.from_address(address + 4).value
            # An inherit-only ACE is not effective on this object.  Its
            # effective descendants are inspected from their own materialized
            # DACLs, so treating it as a grant here would both be inaccurate
            # and make a protected child unusable because of a harmless
            # inheritance template on its parent.
            if ace_flags & 0x08:  # INHERIT_ONLY_ACE
                continue
            grantee_is_trusted = _windows_grantee_is_trusted(
                sid,
                owner_sid=owner_sid,
                trusted_sids=trusted_sids,
            )
            if not grantee_is_trusted and reject_broad_access:
                raise RuntimeError(
                    f"Windows backup path grants access to a broad or unexpected principal {sid}: {path}"
                )
            if (
                not grantee_is_trusted
                and reject_untrusted_writes
                and access_mask & write_mask
            ):
                raise RuntimeError(
                    f"Windows trusted path grants write access to an unexpected principal {sid}: {path}"
                )
            if grantee_is_trusted:
                trusted_allow_count += 1
        if reject_broad_access and trusted_allow_count <= 0:
            raise RuntimeError(f"Windows backup path DACL has no trusted allow entry: {path}")

    return hashlib.sha256(buffer.raw[:required.value]).hexdigest()


def _trusted_directory_security(path: Path, metadata: os.stat_result) -> str:
    attributes = getattr(metadata, "st_file_attributes", 0)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or attributes & REPARSE_POINT
    ):
        raise RuntimeError(f"Verifier ancestor is not a safe directory: {path}")
    if os.name == "nt":
        return _windows_security_descriptor(
            path,
            reject_broad_access=False,
            reject_untrusted_writes=True,
            require_protected_dacl=False,
            include_allowed_writers=False,
            directory=True,
        )

    mode = stat.S_IMODE(metadata.st_mode)
    if metadata.st_uid not in {0, os.geteuid()}:
        raise RuntimeError(f"Verifier ancestor has an untrusted owner: {path}")
    if mode & 0o022 and not mode & stat.S_ISVTX:
        raise RuntimeError(f"Verifier ancestor is writable without sticky protection: {path}")
    payload = f"posix:{metadata.st_uid}:{metadata.st_gid}:{mode:o}".encode("ascii")
    return hashlib.sha256(payload).hexdigest()


def _trusted_ancestor_security(path: Path) -> tuple[tuple[str, tuple[int, ...], str], ...]:
    current = path.parent
    captured: list[tuple[str, tuple[int, ...], str]] = []
    while True:
        before = current.lstat()
        security = _trusted_directory_security(current, before)
        after = current.lstat()
        if _object_identity(before) != _object_identity(after):
            raise RuntimeError(
                f"Verifier ancestor changed while its security state was read: {current}"
            )
        captured.append((str(current), _object_identity(before), security))
        parent = current.parent
        if parent == current:
            break
        current = parent

    # Revalidate the complete chain after its first pass.  This closes a
    # rotation where one ancestor is restored before the next one is read.
    for path_text, expected_identity, expected_security in captured:
        ancestor = Path(path_text)
        before = ancestor.lstat()
        security = _trusted_directory_security(ancestor, before)
        after = ancestor.lstat()
        if (
            _object_identity(before) != expected_identity
            or _object_identity(before) != _object_identity(after)
            or security != expected_security
        ):
            raise RuntimeError(
                f"Verifier ancestor identity or security changed during verification: {ancestor}"
            )
    return tuple(captured)


def _security_sha256(path: Path, metadata: os.stat_result, policy: str) -> str:
    trusted_file = policy == "trusted-file"
    if os.name == "nt":
        primary_security = _windows_security_descriptor(
            path,
            reject_broad_access=policy != "binding" and not trusted_file,
            reject_untrusted_writes=trusted_file,
            require_protected_dacl=policy == "managed-root",
            include_allowed_writers=not trusted_file,
            directory=stat.S_ISDIR(metadata.st_mode),
        )
    else:
        mode = stat.S_IMODE(metadata.st_mode)
        if policy != "binding":
            if metadata.st_uid != os.geteuid():
                raise RuntimeError(f"Backup path is not owned by the verifier identity: {path}")
            if policy in {"managed-root", "managed-directory"} and mode & 0o077:
                raise RuntimeError(f"Backup directory is not owner-only: {path}")
            if policy in {"managed-file", "trusted-file"} and mode & 0o022:
                raise RuntimeError(f"Backup file is writable by another identity: {path}")
        payload = f"posix:{metadata.st_uid}:{metadata.st_gid}:{mode:o}".encode("ascii")
        primary_security = hashlib.sha256(payload).hexdigest()

    if not trusted_file:
        return primary_security

    ancestor_security = _trusted_ancestor_security(path)
    trusted_payload = json.dumps(
        {
            "fileSecuritySha256": primary_security,
            "ancestorSecurity": ancestor_security,
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")
    return hashlib.sha256(trusted_payload).hexdigest()


def _capture_file_binding(path: Path, *, policy: str) -> PathBinding:
    ancestors = _reject_reparse_ancestors(path)
    before = path.lstat()
    attributes = getattr(before, "st_file_attributes", 0)
    if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or attributes & REPARSE_POINT:
        raise RuntimeError(f"Backup payload is not a safe regular file: {path}")
    security_sha = _security_sha256(path, before, policy)
    after = path.lstat()
    if _identity(before) != _identity(after) or ancestors != _reject_reparse_ancestors(path):
        raise RuntimeError(f"Backup payload changed while its security state was read: {path}")
    return PathBinding(_identity(before), ancestors, security_sha)


def _capture_directory_binding(path: Path, *, policy: str) -> PathBinding:
    ancestors = _reject_reparse_ancestors(path)
    before = path.lstat()
    attributes = getattr(before, "st_file_attributes", 0)
    if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode) or attributes & REPARSE_POINT:
        raise RuntimeError(f"Backup path is not a safe directory: {path}")
    security_sha = _security_sha256(path, before, policy)
    after = path.lstat()
    if _identity(before) != _identity(after) or ancestors != _reject_reparse_ancestors(path):
        raise RuntimeError(f"Backup directory changed while its security state was read: {path}")
    return PathBinding(_identity(before), ancestors, security_sha)


def _assert_file_binding(path: Path, binding: PathBinding, *, policy: str) -> None:
    if _capture_file_binding(path, policy=policy) != binding:
        raise RuntimeError(f"Backup payload identity or security changed during verification: {path}")


def _assert_directory_binding(path: Path, binding: PathBinding, *, policy: str) -> None:
    if _capture_directory_binding(path, policy=policy) != binding:
        raise RuntimeError(f"Backup directory identity or security changed during verification: {path}")


def _binding_record(binding: PathBinding) -> dict[str, str]:
    identity_bytes = json.dumps(
        {"identity": binding.identity, "ancestors": binding.ancestors},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")
    return {
        "identitySha256": hashlib.sha256(identity_bytes).hexdigest(),
        "securityStateSha256": binding.security_sha256,
    }


def _read_stable_file(
    path: Path,
    *,
    retain_bytes: bool,
    policy: str = "binding",
) -> tuple[str, int, bytes | None, PathBinding]:
    ancestors_before = _reject_reparse_ancestors(path)
    path_before = path.lstat()
    attributes = getattr(path_before, "st_file_attributes", 0)
    if not stat.S_ISREG(path_before.st_mode) or stat.S_ISLNK(path_before.st_mode) or attributes & REPARSE_POINT:
        raise RuntimeError(f"Backup payload is not a safe regular file: {path}")
    security_before = _security_sha256(path, path_before, policy)
    digest = hashlib.sha256()
    size = 0
    chunks: list[bytes] | None = [] if retain_bytes else None
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        descriptor_before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(descriptor_before.st_mode)
            or _handle_identity(descriptor_before) != _handle_identity(path_before)
        ):
            raise RuntimeError(f"Backup payload changed before it was opened: {path}")
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            while chunk := handle.read(CHUNK_SIZE):
                digest.update(chunk)
                size += len(chunk)
                if chunks is not None:
                    chunks.append(chunk)
            descriptor_after = os.fstat(handle.fileno())
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    path_after = path.lstat()
    security_after = _security_sha256(path, path_after, policy)
    ancestors_after = _reject_reparse_ancestors(path)
    if (
        _handle_identity(descriptor_before) != _handle_identity(descriptor_after)
        or _handle_identity(path_before) != _handle_identity(descriptor_after)
        or _identity(path_before) != _identity(path_after)
        or size != descriptor_after.st_size
        or security_before != security_after
        or ancestors_before != ancestors_after
    ):
        raise RuntimeError(f"Backup payload changed while it was being verified: {path}")
    binding = PathBinding(_identity(path_before), ancestors_before, security_before)
    return digest.hexdigest(), size, b"".join(chunks) if chunks is not None else None, binding


def _sha256_file(path: Path) -> tuple[str, int]:
    digest, size, _, _ = _read_stable_file(path, retain_bytes=False)
    return digest, size


def _read_json(
    path: Path,
    label: str,
    *,
    policy: str = "binding",
) -> tuple[dict[str, Any], str, PathBinding]:
    digest, _, raw, binding = _read_stable_file(path, retain_bytes=True, policy=policy)
    try:
        value = json.loads((raw or b"").decode("utf-8"))
    except (UnicodeError, ValueError) as error:
        raise RuntimeError(f"{label} is unreadable") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must be a JSON object")
    return value, digest, binding


def _safe_export(
    path_text: str,
    expected_name: str,
    allowed_root: Path,
) -> tuple[Path, Path, PathBinding, PathBinding]:
    path = Path(path_text)
    if not path.is_absolute() or not allowed_root.is_absolute():
        raise RuntimeError("Backup export and allowed root paths must be absolute")
    root = allowed_root.absolute()
    export = path.absolute()
    root_binding = _capture_directory_binding(root, policy="managed-root")
    export_binding = _capture_directory_binding(export, policy="managed-directory")
    resolved_root = root.resolve(strict=True)
    resolved_export = export.resolve(strict=True)
    if not resolved_root.is_dir() or not resolved_export.is_dir() \
            or resolved_export.parent != resolved_root:
        raise RuntimeError("Backup export is not a direct child of the allowed root")
    if export.name != expected_name:
        raise RuntimeError("Backup export basename does not match its manifest run ID")
    _assert_directory_binding(export, export_binding, policy="managed-directory")
    _assert_directory_binding(root, root_binding, policy="managed-root")
    return export, root, export_binding, root_binding


def _attest_one(
    kind: str,
    status_path: Path,
    manifest_path: Path,
    allowed_root: Path,
) -> dict[str, Any]:
    status, status_sha, status_binding = _read_json(
        status_path, f"{kind} status", policy="managed-file"
    )
    manifest, manifest_sha, manifest_binding = _read_json(
        manifest_path, f"{kind} manifest", policy="managed-file"
    )
    execution_id = str(status.get("runId") or "")
    export_id = str(manifest.get("runId") or "")
    prefix = "postgres" if kind == "postgres" else "qdrant"
    if not re.fullmatch(r"[0-9a-f]{32}", execution_id):
        raise RuntimeError(f"{kind} execution run ID is invalid")
    if not re.fullmatch(prefix + r"-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", export_id):
        raise RuntimeError(f"{kind} export run ID is invalid")
    if status.get("status") != "success" or status.get("exitCode") != 0:
        raise RuntimeError(f"{kind} backup status is not successful")
    if status.get("manifestSha256") != manifest_sha:
        raise RuntimeError(f"{kind} status does not bind the manifest")
    export, root, export_binding, root_binding = _safe_export(
        str(status.get("backupPath") or ""), export_id, allowed_root
    )
    if manifest_path.resolve(strict=True) != (export / "manifest.json").resolve(strict=True):
        raise RuntimeError(f"{kind} manifest is not inside the declared export")

    if kind == "postgres":
        database = manifest.get("database") or {}
        records = [{
            "file": database.get("file"),
            "sha256": database.get("sha256"),
            "sizeBytes": database.get("sizeBytes"),
        }]
        expected_files = {"manifest.json", "postgres.dump"}
    else:
        records = manifest.get("snapshots") or []
        expected_files = {
            "manifest.json",
            "song_audio.snapshot",
            "song_hybrid.snapshot",
            "song_metadata.snapshot",
            "songs_v2.snapshot",
        }
    if not isinstance(records, list) or not records or not all(isinstance(item, dict) for item in records):
        raise RuntimeError(f"{kind} payload records are invalid")
    if {item.get("file") for item in records} != expected_files - {"manifest.json"}:
        raise RuntimeError(f"{kind} payload set is not exact")
    if {item.name for item in export.iterdir()} != expected_files:
        raise RuntimeError(f"{kind} export directory inventory is not exact")

    payloads: list[dict[str, Any]] = []
    payload_bindings: dict[str, PathBinding] = {}
    for record in sorted(records, key=lambda item: str(item.get("file"))):
        filename = str(record.get("file") or "")
        if Path(filename).name != filename:
            raise RuntimeError(f"{kind} payload filename is unsafe")
        digest, size, _, binding = _read_stable_file(
            export / filename, retain_bytes=False, policy="managed-file"
        )
        if digest != record.get("sha256") or size != record.get("sizeBytes") or size <= 0:
            raise RuntimeError(f"{kind} payload does not match its manifest: {filename}")
        payloads.append({"file": filename, "sha256": digest, "sizeBytes": size})
        payload_bindings[filename] = binding
    if {item.name for item in export.iterdir()} != expected_files:
        raise RuntimeError(f"{kind} export inventory changed during verification")
    _assert_file_binding(status_path, status_binding, policy="managed-file")
    _assert_file_binding(manifest_path, manifest_binding, policy="managed-file")
    for filename, binding in payload_bindings.items():
        _assert_file_binding(export / filename, binding, policy="managed-file")
    _assert_directory_binding(export, export_binding, policy="managed-directory")
    _assert_directory_binding(root, root_binding, policy="managed-root")
    return {
        "executionRunId": execution_id,
        "exportRunId": export_id,
        "statusSha256": status_sha,
        "manifestSha256": manifest_sha,
        "payloads": payloads,
        "payloadBytesRehashed": True,
        "directoryInventoryStable": True,
        "securityBindings": {
            "allowedRoot": _binding_record(root_binding),
            "export": _binding_record(export_binding),
            "status": _binding_record(status_binding),
            "manifest": _binding_record(manifest_binding),
            "payloads": {
                name: _binding_record(binding)
                for name, binding in sorted(payload_bindings.items())
            },
        },
    }


def _write_attestation(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _reject_reparse_ancestors(path)
    try:
        existing = path.lstat()
    except FileNotFoundError:
        existing = None
    if existing is not None and (
        not stat.S_ISREG(existing.st_mode)
        or stat.S_ISLNK(existing.st_mode)
        or getattr(existing, "st_file_attributes", 0) & REPARSE_POINT
    ):
        raise RuntimeError(f"Attestation output is not a safe regular file: {path}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=True, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        try:
            directory = os.open(path.parent, os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    global WINDOWS_ALLOWED_WRITER_SIDS

    parser = argparse.ArgumentParser()
    parser.add_argument("--postgres-status", type=Path, required=True)
    parser.add_argument("--postgres-manifest", type=Path, required=True)
    parser.add_argument("--postgres-root", type=Path, required=True)
    parser.add_argument("--qdrant-status", type=Path, required=True)
    parser.add_argument("--qdrant-manifest", type=Path, required=True)
    parser.add_argument("--qdrant-root", type=Path, required=True)
    parser.add_argument("--challenge", required=True)
    parser.add_argument(
        "--allowed-writer-sid",
        action="append",
        default=[],
        help=(
            "Windows SID of an expected non-owner backup writer; repeat for each "
            "dedicated writer identity"
        ),
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    WINDOWS_ALLOWED_WRITER_SIDS = frozenset(
        _normalize_allowed_writer_sid(value) for value in args.allowed_writer_sid
    )
    if not re.fullmatch(r"[0-9a-f]{64}", args.challenge):
        raise RuntimeError("Attestation challenge must be 64 lowercase hexadecimal characters")
    for label, path in (
        ("PostgreSQL status", args.postgres_status),
        ("PostgreSQL manifest", args.postgres_manifest),
        ("PostgreSQL root", args.postgres_root),
        ("Qdrant status", args.qdrant_status),
        ("Qdrant manifest", args.qdrant_manifest),
        ("Qdrant root", args.qdrant_root),
    ):
        if not path.is_absolute():
            raise RuntimeError(f"{label} path must be absolute")
    args.output = args.output.absolute()
    verifier = Path(__file__).resolve(strict=True)
    output_resolved = args.output.resolve(strict=False)
    protected_files = {
        verifier,
        args.postgres_status.resolve(strict=True),
        args.postgres_manifest.resolve(strict=True),
        args.qdrant_status.resolve(strict=True),
        args.qdrant_manifest.resolve(strict=True),
    }
    if output_resolved in protected_files:
        raise RuntimeError("Attestation output must not replace verifier or backup evidence")
    for root_path in (args.postgres_root, args.qdrant_root):
        root = root_path.resolve(strict=True)
        try:
            output_resolved.relative_to(root)
        except ValueError:
            continue
        raise RuntimeError("Attestation output must be outside the verified backup roots")

    verifier_digest, verifier_size, _, verifier_binding = _read_stable_file(
        verifier, retain_bytes=False, policy="trusted-file"
    )
    backups = {
        "postgres": _attest_one(
            "postgres", args.postgres_status, args.postgres_manifest, args.postgres_root
        ),
        "qdrant": _attest_one(
            "qdrant", args.qdrant_status, args.qdrant_manifest, args.qdrant_root
        ),
    }
    verifier_digest_after, verifier_size_after, _, verifier_binding_after = _read_stable_file(
        verifier, retain_bytes=False, policy="trusted-file"
    )
    if (
        verifier_digest_after != verifier_digest
        or verifier_size_after != verifier_size
        or verifier_binding_after != verifier_binding
    ):
        raise RuntimeError("Attestation verifier changed while backup payloads were being checked")
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "challenge": args.challenge,
        "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "verifierHost": socket.gethostname(),
        "verifierSha256": verifier_digest,
        "verifierSecurityBinding": _binding_record(verifier_binding),
        "allowedWriterSids": sorted(WINDOWS_ALLOWED_WRITER_SIDS),
        "backups": backups,
    }
    _write_attestation(args.output, payload)
    print(json.dumps({
        "attestation": str(args.output),
        "sha256": _sha256_file(args.output)[0],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
