#!/usr/bin/env python3
"""Fail-closed validation and attestation for a Trivy container image scan."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat as stat_module
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


RECEIPT_SCHEMA_VERSION = 1
RECEIPT_KIND = "diva-container-image-vulnerability-scan"
TRIVY_SCHEMA_VERSION = 2
TRIVY_ARTIFACT_TYPE = "container_image"
TRIVY_DB_VERSION = 2
MAX_REPORT_BYTES = 128 * 1024 * 1024
MAX_METADATA_BYTES = 1024 * 1024
MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024
MAX_RECEIPT_BYTES = 1024 * 1024
MAX_RESULTS = 10_000
MAX_PACKAGES = 250_000
MAXIMUM_DB_AGE_SECONDS = 86_400
MAXIMUM_SCAN_AGE_SECONDS = 3_600
MAXIMUM_SCAN_DURATION_SECONDS = 7_200
MAXIMUM_CLOCK_SKEW_SECONDS = 300
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class ValidationError(RuntimeError):
    """The candidate scan cannot be trusted."""


@dataclass(frozen=True)
class SafeBlob:
    path: Path
    size: int
    sha256: str
    identity: tuple[int, int]
    data: bytes | None


@dataclass(frozen=True)
class ScanPolicy:
    maximum_db_age_seconds: int
    maximum_scan_age_seconds: int
    maximum_scan_duration_seconds: int
    clock_skew_seconds: int


@dataclass(frozen=True)
class ScanTimes:
    started: datetime
    completed: datetime


def _is_reparse_point(file_stat: os.stat_result) -> bool:
    attributes = getattr(file_stat, "st_file_attributes", 0)
    reparse_flag = getattr(stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _snapshot(file_stat: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (
        file_stat.st_dev,
        file_stat.st_ino,
        file_stat.st_mode,
        file_stat.st_nlink,
        file_stat.st_size,
        file_stat.st_mtime_ns,
    )


def read_plain_file(
    value: str | os.PathLike[str],
    *,
    label: str,
    maximum_size: int,
    capture: bool,
) -> SafeBlob:
    path = Path(value)
    try:
        before = os.lstat(path)
    except OSError as exc:
        raise ValidationError(f"{label} cannot be inspected: {exc}") from exc
    if not stat_module.S_ISREG(before.st_mode):
        raise ValidationError(f"{label} must be a regular file")
    if _is_reparse_point(before):
        raise ValidationError(f"{label} must not be a reparse point")
    if before.st_nlink != 1:
        raise ValidationError(f"{label} must have exactly one filesystem link")
    if before.st_size <= 0:
        raise ValidationError(f"{label} must not be empty")
    if before.st_size > maximum_size:
        raise ValidationError(f"{label} exceeds the maximum allowed size")

    flags = os.O_RDONLY
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ValidationError(f"{label} cannot be opened safely: {exc}") from exc

    digest = hashlib.sha256()
    captured = bytearray() if capture else None
    try:
        opened = os.fstat(descriptor)
        if not stat_module.S_ISREG(opened.st_mode):
            raise ValidationError(f"{label} changed to a non-regular file")
        if _is_reparse_point(opened) or opened.st_nlink != 1:
            raise ValidationError(f"{label} has an unsafe link or reparse state")
        if _snapshot(opened) != _snapshot(before):
            raise ValidationError(f"{label} changed while it was opened")

        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise ValidationError(f"{label} was truncated while being read")
            digest.update(chunk)
            if captured is not None:
                captured.extend(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise ValidationError(f"{label} grew while being read")
        after = os.fstat(descriptor)
        if _snapshot(after) != _snapshot(opened):
            raise ValidationError(f"{label} changed while being hashed")
    except OSError as exc:
        raise ValidationError(f"{label} could not be read safely: {exc}") from exc
    finally:
        os.close(descriptor)

    return SafeBlob(
        path=path,
        size=before.st_size,
        sha256=digest.hexdigest(),
        identity=(before.st_dev, before.st_ino),
        data=bytes(captured) if captured is not None else None,
    )


def _reject_constant(value: str) -> None:
    raise ValidationError(f"non-finite JSON number is forbidden: {value}")


def _unique_object(pairs: Iterable[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError(f"duplicate JSON key is forbidden: {key}")
        result[key] = value
    return result


def parse_json(blob: SafeBlob, *, label: str) -> dict[str, Any]:
    if blob.data is None:
        raise ValidationError(f"{label} was not captured for JSON parsing")
    try:
        text = blob.data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValidationError(f"{label} is not UTF-8") from exc
    if text.startswith("\ufeff"):
        raise ValidationError(f"{label} must not contain a UTF-8 byte-order mark")
    try:
        document = json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except (ValueError, RecursionError) as exc:
        raise ValidationError(f"{label} is not complete valid JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise ValidationError(f"{label} root must be an object")
    return document


def _required_string(value: Any, *, label: str, maximum: int = 512) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValidationError(f"{label} must be a non-empty bounded string")
    return value


def _required_int(value: Any, *, label: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ValidationError(f"{label} must be an integer >= {minimum}")
    return value


def _validate_token(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not TOKEN_RE.fullmatch(value):
        raise ValidationError(f"{label} is not a safe token")
    return value


def _validate_sha256(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise ValidationError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _validate_image_id(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not IMAGE_ID_RE.fullmatch(value):
        raise ValidationError(f"{label} must be an immutable sha256 image ID")
    return value


def parse_inventory_bounds(
    values: Sequence[str],
) -> tuple[tuple[str, str, int, int, int], ...]:
    if not values:
        raise ValidationError("at least one inventory bound must be specified")
    parsed: list[tuple[str, str, int, int, int]] = []
    for value in values:
        components = value.split(":")
        if len(components) != 5:
            raise ValidationError(
                "inventory bound must use CLASS:TYPE:MINIMUM:MAXIMUM:RESULT_COUNT"
            )
        (
            inventory_class,
            inventory_type,
            minimum_text,
            maximum_text,
            result_count_text,
        ) = components
        try:
            minimum = int(minimum_text)
            maximum = int(maximum_text)
            result_count = int(result_count_text)
        except ValueError as exc:
            raise ValidationError("inventory bounds must be integers") from exc
        if (
            minimum <= 0
            or maximum < minimum
            or maximum > MAX_PACKAGES
            or result_count <= 0
            or result_count > MAX_RESULTS
        ):
            raise ValidationError("inventory bounds are outside the safety range")
        parsed.append(
            (
                _validate_token(inventory_class, label="inventory class"),
                _validate_token(inventory_type, label="inventory type"),
                minimum,
                maximum,
                result_count,
            )
        )
    keys = [(item[0], item[1]) for item in parsed]
    if len(set(keys)) != len(keys):
        raise ValidationError("inventory bound entries must be unique")
    return tuple(parsed)


def validate_report(
    document: dict[str, Any],
    *,
    expected_image_id: str,
    expected_architecture: str,
    expected_os: str,
    expected_os_family: str,
    inventory_bounds: tuple[tuple[str, str, int, int, int], ...],
) -> tuple[int, dict[tuple[str, str], int]]:
    if document.get("SchemaVersion") != TRIVY_SCHEMA_VERSION:
        raise ValidationError("Trivy report SchemaVersion is not exactly 2")
    if document.get("ArtifactType") != TRIVY_ARTIFACT_TYPE:
        raise ValidationError("Trivy report ArtifactType is not container_image")
    metadata = document.get("Metadata")
    if not isinstance(metadata, dict):
        raise ValidationError("Trivy report Metadata must be an object")
    if metadata.get("ImageID") != expected_image_id:
        raise ValidationError("Trivy report ImageID does not match the candidate image")
    image_config = metadata.get("ImageConfig")
    if not isinstance(image_config, dict):
        raise ValidationError("Trivy report Metadata.ImageConfig must be present")
    if image_config.get("architecture") != expected_architecture:
        raise ValidationError("Trivy report architecture does not match the candidate")
    if image_config.get("os") != expected_os:
        raise ValidationError("Trivy report operating system does not match the candidate")
    operating_system = metadata.get("OS")
    if not isinstance(operating_system, dict):
        raise ValidationError("Trivy report Metadata.OS must be present")
    if operating_system.get("Family") != expected_os_family:
        raise ValidationError("Trivy report OS family does not match the candidate")
    _required_string(operating_system.get("Name"), label="Trivy report OS name", maximum=128)

    results = document.get("Results")
    if not isinstance(results, list) or not results or len(results) > MAX_RESULTS:
        raise ValidationError("Trivy report Results must be a non-empty bounded array")
    bounds_by_key = {
        (inventory_class, inventory_type): (minimum, maximum, result_count)
        for inventory_class, inventory_type, minimum, maximum, result_count in inventory_bounds
    }
    inventory_counts = {key: 0 for key in bounds_by_key}
    inventory_result_counts = {key: 0 for key in bounds_by_key}
    total_packages = 0
    vulnerability_count = 0

    for result_index, result in enumerate(results):
        if not isinstance(result, dict):
            raise ValidationError(f"Trivy result {result_index} must be an object")
        result_class = _validate_token(
            result.get("Class"), label=f"Trivy result {result_index} class"
        )
        result_type = _validate_token(
            result.get("Type"), label=f"Trivy result {result_index} type"
        )
        key = (result_class, result_type)
        if key not in inventory_counts:
            raise ValidationError("Trivy report contains an unreviewed result class or type")
        packages = result.get("Packages")
        if not isinstance(packages, list) or not packages:
            raise ValidationError(
                f"Trivy result {result_index} must contain a non-empty package inventory"
            )
        total_packages += len(packages)
        if total_packages > MAX_PACKAGES:
            raise ValidationError("Trivy package inventory exceeds the safety limit")
        for package_index, package in enumerate(packages):
            if not isinstance(package, dict):
                raise ValidationError(
                    f"Trivy package {result_index}:{package_index} must be an object"
                )
            _required_string(
                package.get("Name"),
                label=f"Trivy package {result_index}:{package_index} name",
            )
            _required_string(
                package.get("Version"),
                label=f"Trivy package {result_index}:{package_index} version",
            )

        vulnerabilities = result.get("Vulnerabilities")
        if vulnerabilities is not None:
            if not isinstance(vulnerabilities, list):
                raise ValidationError(
                    f"Trivy result {result_index} Vulnerabilities must be an array or null"
                )
            vulnerability_count += len(vulnerabilities)

        inventory_result_counts[key] += 1
        inventory_counts[key] += len(packages)

    if vulnerability_count:
        raise ValidationError("Trivy report contains a vulnerability finding")
    for key, (minimum, maximum, expected_result_count) in bounds_by_key.items():
        if inventory_result_counts[key] != expected_result_count:
            raise ValidationError(
                f"required inventory {key[0]}:{key[1]} result count does not match "
                f"the reviewed value {expected_result_count}"
            )
        if not minimum <= inventory_counts[key] <= maximum:
            raise ValidationError(
                f"required inventory {key[0]}:{key[1]} package count is outside "
                f"the reviewed range {minimum}..{maximum}"
            )
    if total_packages <= 0:
        raise ValidationError("Trivy report contains no packages")
    return total_packages, inventory_counts


def parse_rfc3339(value: Any, *, label: str) -> datetime:
    text = _required_string(value, label=label, maximum=64)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValidationError(f"{label} is not RFC3339") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValidationError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def format_rfc3339(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def validate_scan_times(
    started_value: Any,
    completed_value: Any,
    *,
    policy: ScanPolicy,
    now: datetime,
) -> ScanTimes:
    started = parse_rfc3339(started_value, label="scan startedAt")
    completed = parse_rfc3339(completed_value, label="scan completedAt")
    skew = timedelta(seconds=policy.clock_skew_seconds)
    if started > completed:
        raise ValidationError("scan completedAt precedes startedAt")
    if completed - started > timedelta(seconds=policy.maximum_scan_duration_seconds):
        raise ValidationError("scan duration exceeds the allowed maximum")
    if completed > now + skew:
        raise ValidationError("scan completedAt is unreasonably in the future")
    if now - completed > timedelta(seconds=policy.maximum_scan_age_seconds):
        raise ValidationError("scan result is older than the allowed maximum")
    return ScanTimes(started=started, completed=completed)


def validate_database_metadata(
    document: dict[str, Any],
    *,
    scan_times: ScanTimes,
    policy: ScanPolicy,
    now: datetime,
) -> dict[str, Any]:
    if document.get("Version") != TRIVY_DB_VERSION:
        raise ValidationError("Trivy DB metadata Version is not exactly 2")
    updated = parse_rfc3339(document.get("UpdatedAt"), label="DB UpdatedAt")
    downloaded = parse_rfc3339(document.get("DownloadedAt"), label="DB DownloadedAt")
    next_update = parse_rfc3339(document.get("NextUpdate"), label="DB NextUpdate")
    skew = timedelta(seconds=policy.clock_skew_seconds)
    if updated > now + skew:
        raise ValidationError("Trivy DB UpdatedAt is unreasonably in the future")
    if downloaded < updated:
        raise ValidationError("Trivy DB DownloadedAt precedes UpdatedAt")
    if next_update <= updated:
        raise ValidationError("Trivy DB NextUpdate must be later than UpdatedAt")
    if scan_times.completed - updated > timedelta(seconds=policy.maximum_db_age_seconds):
        raise ValidationError("Trivy DB is older than the allowed maximum")
    if downloaded < scan_times.started - skew:
        raise ValidationError("Trivy DB was not downloaded for this bounded scan run")
    if downloaded > scan_times.completed + skew:
        raise ValidationError("Trivy DB DownloadedAt is later than the scan")
    if next_update + timedelta(seconds=policy.maximum_db_age_seconds) < scan_times.completed:
        raise ValidationError("Trivy DB NextUpdate is implausibly stale")
    return {
        "version": TRIVY_DB_VERSION,
        "updatedAt": format_rfc3339(updated),
        "downloadedAt": format_rfc3339(downloaded),
        "nextUpdate": format_rfc3339(next_update),
    }


def _canonical_json(document: dict[str, Any]) -> bytes:
    return (
        json.dumps(document, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def _validate_output_parent(path: Path) -> None:
    try:
        parent_stat = os.lstat(path.parent)
    except OSError as exc:
        raise ValidationError(f"receipt parent cannot be inspected: {exc}") from exc
    if not stat_module.S_ISDIR(parent_stat.st_mode) or _is_reparse_point(parent_stat):
        raise ValidationError("receipt parent must be a real directory")
    if os.path.lexists(path):
        raise ValidationError("receipt path already exists")


def write_receipt(path_value: str | os.PathLike[str], payload: bytes) -> SafeBlob:
    path = Path(path_value)
    _validate_output_parent(path)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as exc:
        raise ValidationError(f"receipt cannot be created exclusively: {exc}") from exc
    try:
        written = 0
        while written < len(payload):
            count = os.write(descriptor, payload[written:])
            if count <= 0:
                raise ValidationError("receipt write was incomplete")
            written += count
        os.fsync(descriptor)
        file_stat = os.fstat(descriptor)
        if (
            not stat_module.S_ISREG(file_stat.st_mode)
            or _is_reparse_point(file_stat)
            or file_stat.st_nlink != 1
            or file_stat.st_size != len(payload)
        ):
            raise ValidationError("receipt output has an unsafe filesystem state")
    except OSError as exc:
        raise ValidationError(f"receipt could not be written durably: {exc}") from exc
    finally:
        os.close(descriptor)
    if os.name == "posix":
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    return read_plain_file(
        path,
        label="receipt",
        maximum_size=MAX_RECEIPT_BYTES,
        capture=True,
    )


def _ensure_distinct(blobs: Sequence[SafeBlob]) -> None:
    identities = [blob.identity for blob in blobs]
    if len(set(identities)) != len(identities):
        raise ValidationError("report, metadata, database, and receipt files must be distinct")


def _positive_argument(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _policy_from_args(args: argparse.Namespace) -> ScanPolicy:
    return validate_policy(ScanPolicy(
        maximum_db_age_seconds=args.maximum_db_age_seconds,
        maximum_scan_age_seconds=args.maximum_scan_age_seconds,
        maximum_scan_duration_seconds=args.maximum_scan_duration_seconds,
        clock_skew_seconds=args.clock_skew_seconds,
    ))


def validate_policy(policy: ScanPolicy) -> ScanPolicy:
    if not 1 <= policy.maximum_db_age_seconds <= MAXIMUM_DB_AGE_SECONDS:
        raise ValidationError("maximum DB age exceeds the fail-closed policy ceiling")
    if not 1 <= policy.maximum_scan_age_seconds <= MAXIMUM_SCAN_AGE_SECONDS:
        raise ValidationError("maximum scan age exceeds the fail-closed policy ceiling")
    if not 1 <= policy.maximum_scan_duration_seconds <= MAXIMUM_SCAN_DURATION_SECONDS:
        raise ValidationError("maximum scan duration exceeds the fail-closed policy ceiling")
    if not 0 <= policy.clock_skew_seconds <= MAXIMUM_CLOCK_SKEW_SECONDS:
        raise ValidationError("clock skew exceeds the fail-closed policy ceiling")
    return policy


def _inventory_receipt(
    inventories: tuple[tuple[str, str, int, int, int], ...],
    counts: dict[tuple[str, str], int],
) -> list[dict[str, Any]]:
    return [
        {
            "class": inventory_class,
            "type": inventory_type,
            "minimumPackages": minimum,
            "maximumPackages": maximum,
            "expectedResultCount": expected_result_count,
            "resultCount": expected_result_count,
            "packageCount": counts[(inventory_class, inventory_type)],
        }
        for inventory_class, inventory_type, minimum, maximum, expected_result_count in inventories
    ]


def build_receipt(args: argparse.Namespace, *, now: datetime) -> tuple[dict[str, Any], list[SafeBlob]]:
    service = _validate_token(args.service, label="service")
    image_id = _validate_image_id(args.expected_image_id, label="expected image ID")
    architecture = _validate_token(args.expected_architecture, label="expected architecture")
    expected_os = _validate_token(args.expected_os, label="expected OS")
    os_family = _validate_token(args.expected_os_family, label="expected OS family")
    scanner_version = _validate_token(args.scanner_version, label="scanner version")
    scanner_sha256 = _validate_sha256(args.scanner_sha256, label="scanner SHA-256")
    inventories = parse_inventory_bounds(args.inventory_bound)
    policy = _policy_from_args(args)
    scan_times = validate_scan_times(
        args.scan_started_at,
        args.scan_completed_at,
        policy=policy,
        now=now,
    )

    report_blob = read_plain_file(
        args.report,
        label="Trivy report",
        maximum_size=MAX_REPORT_BYTES,
        capture=True,
    )
    metadata_blob = read_plain_file(
        args.db_metadata,
        label="Trivy DB metadata",
        maximum_size=MAX_METADATA_BYTES,
        capture=True,
    )
    database_blob = read_plain_file(
        args.db,
        label="Trivy DB",
        maximum_size=MAX_DATABASE_BYTES,
        capture=False,
    )
    _ensure_distinct([report_blob, metadata_blob, database_blob])
    package_count, inventory_counts = validate_report(
        parse_json(report_blob, label="Trivy report"),
        expected_image_id=image_id,
        expected_architecture=architecture,
        expected_os=expected_os,
        expected_os_family=os_family,
        inventory_bounds=inventories,
    )
    database_metadata = validate_database_metadata(
        parse_json(metadata_blob, label="Trivy DB metadata"),
        scan_times=scan_times,
        policy=policy,
        now=now,
    )

    receipt = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "kind": RECEIPT_KIND,
        "service": service,
        "image": {
            "id": image_id,
            "architecture": architecture,
            "os": expected_os,
            "osFamily": os_family,
        },
        "scanner": {
            "name": "trivy",
            "version": scanner_version,
            "binarySha256": scanner_sha256,
        },
        "scan": {
            "startedAt": format_rfc3339(scan_times.started),
            "completedAt": format_rfc3339(scan_times.completed),
            "reportSha256": report_blob.sha256,
            "reportSize": report_blob.size,
        },
        "database": {
            **database_metadata,
            "metadataSha256": metadata_blob.sha256,
            "metadataSize": metadata_blob.size,
            "dbSha256": database_blob.sha256,
            "dbSize": database_blob.size,
        },
        "inventory": _inventory_receipt(inventories, inventory_counts),
        "verdict": {
            "highCriticalCount": 0,
            "packageCount": package_count,
        },
        "policy": {
            "maximumDbAgeSeconds": policy.maximum_db_age_seconds,
            "maximumScanAgeSeconds": policy.maximum_scan_age_seconds,
            "maximumScanDurationSeconds": policy.maximum_scan_duration_seconds,
            "clockSkewSeconds": policy.clock_skew_seconds,
        },
    }
    return receipt, [report_blob, metadata_blob, database_blob]


def _exact_keys(document: dict[str, Any], expected: set[str], *, label: str) -> None:
    if set(document) != expected:
        raise ValidationError(f"{label} has unexpected or missing fields")


def _parse_receipt_contract(
    receipt: dict[str, Any],
    *,
    args: argparse.Namespace,
) -> tuple[
    str,
    str,
    str,
    str,
    str,
    tuple[tuple[str, str, int, int, int], ...],
    ScanPolicy,
    ScanTimes,
]:
    _exact_keys(
        receipt,
        {
            "schemaVersion",
            "kind",
            "service",
            "image",
            "scanner",
            "scan",
            "database",
            "inventory",
            "verdict",
            "policy",
        },
        label="receipt",
    )
    if receipt.get("schemaVersion") != RECEIPT_SCHEMA_VERSION or receipt.get("kind") != RECEIPT_KIND:
        raise ValidationError("receipt schema or kind is not supported")
    service = _validate_token(_required_string(receipt.get("service"), label="receipt service"), label="receipt service")
    if service != args.service:
        raise ValidationError("receipt service does not match the expected service")

    image = receipt.get("image")
    scanner = receipt.get("scanner")
    scan = receipt.get("scan")
    database = receipt.get("database")
    inventory = receipt.get("inventory")
    verdict = receipt.get("verdict")
    policy_document = receipt.get("policy")
    for value, label in (
        (image, "receipt image"),
        (scanner, "receipt scanner"),
        (scan, "receipt scan"),
        (database, "receipt database"),
        (verdict, "receipt verdict"),
        (policy_document, "receipt policy"),
    ):
        if not isinstance(value, dict):
            raise ValidationError(f"{label} must be an object")
    if not isinstance(inventory, list) or not inventory:
        raise ValidationError("receipt inventory must be a non-empty array")

    _exact_keys(image, {"id", "architecture", "os", "osFamily"}, label="receipt image")
    image_id = _validate_image_id(image.get("id"), label="receipt image ID")
    architecture = _validate_token(_required_string(image.get("architecture"), label="receipt architecture"), label="receipt architecture")
    expected_os = _validate_token(_required_string(image.get("os"), label="receipt OS"), label="receipt OS")
    os_family = _validate_token(_required_string(image.get("osFamily"), label="receipt OS family"), label="receipt OS family")
    if (
        image_id != args.expected_image_id
        or architecture != args.expected_architecture
        or expected_os != args.expected_os
        or os_family != args.expected_os_family
    ):
        raise ValidationError("receipt image identity, architecture, or OS contract does not match")

    _exact_keys(scanner, {"name", "version", "binarySha256"}, label="receipt scanner")
    if scanner.get("name") != "trivy":
        raise ValidationError("receipt scanner is not Trivy")
    _validate_token(_required_string(scanner.get("version"), label="receipt scanner version"), label="receipt scanner version")
    _validate_sha256(scanner.get("binarySha256"), label="receipt scanner SHA-256")

    _exact_keys(
        scan,
        {"startedAt", "completedAt", "reportSha256", "reportSize"},
        label="receipt scan",
    )
    _exact_keys(
        database,
        {
            "version",
            "updatedAt",
            "downloadedAt",
            "nextUpdate",
            "metadataSha256",
            "metadataSize",
            "dbSha256",
            "dbSize",
        },
        label="receipt database",
    )
    _exact_keys(verdict, {"highCriticalCount", "packageCount"}, label="receipt verdict")
    _exact_keys(
        policy_document,
        {
            "maximumDbAgeSeconds",
            "maximumScanAgeSeconds",
            "maximumScanDurationSeconds",
            "clockSkewSeconds",
        },
        label="receipt policy",
    )
    policy = validate_policy(ScanPolicy(
        maximum_db_age_seconds=_required_int(policy_document.get("maximumDbAgeSeconds"), label="receipt maximum DB age", minimum=1),
        maximum_scan_age_seconds=_required_int(policy_document.get("maximumScanAgeSeconds"), label="receipt maximum scan age", minimum=1),
        maximum_scan_duration_seconds=_required_int(policy_document.get("maximumScanDurationSeconds"), label="receipt maximum scan duration", minimum=1),
        clock_skew_seconds=_required_int(policy_document.get("clockSkewSeconds"), label="receipt clock skew", minimum=0),
    ))
    scan_times = validate_scan_times(
        scan.get("startedAt"),
        scan.get("completedAt"),
        policy=policy,
        now=datetime.now(timezone.utc),
    )
    if _required_int(verdict.get("highCriticalCount"), label="receipt vulnerability count") != 0:
        raise ValidationError("receipt does not record a clean vulnerability verdict")
    _required_int(verdict.get("packageCount"), label="receipt package count", minimum=1)
    if database.get("version") != TRIVY_DB_VERSION:
        raise ValidationError("receipt database version is not supported")
    for field in ("reportSha256",):
        _validate_sha256(scan.get(field), label=f"receipt {field}")
    for field in ("metadataSha256", "dbSha256"):
        _validate_sha256(database.get(field), label=f"receipt {field}")
    for field in ("reportSize",):
        _required_int(scan.get(field), label=f"receipt {field}", minimum=1)
    for field in ("metadataSize", "dbSize"):
        _required_int(database.get(field), label=f"receipt {field}", minimum=1)

    inventory_specs: list[str] = []
    seen_inventory: set[tuple[str, str]] = set()
    for index, item in enumerate(inventory):
        if not isinstance(item, dict):
            raise ValidationError(f"receipt inventory {index} must be an object")
        _exact_keys(
            item,
            {
                "class",
                "type",
                "minimumPackages",
                "maximumPackages",
                "expectedResultCount",
                "resultCount",
                "packageCount",
            },
            label=f"receipt inventory {index}",
        )
        inventory_class = _validate_token(_required_string(item.get("class"), label="receipt inventory class"), label="receipt inventory class")
        inventory_type = _validate_token(_required_string(item.get("type"), label="receipt inventory type"), label="receipt inventory type")
        minimum_packages = _required_int(
            item.get("minimumPackages"),
            label="receipt inventory minimum packages",
            minimum=1,
        )
        maximum_packages = _required_int(
            item.get("maximumPackages"),
            label="receipt inventory maximum packages",
            minimum=minimum_packages,
        )
        package_count = _required_int(
            item.get("packageCount"),
            label="receipt inventory package count",
            minimum=minimum_packages,
        )
        if package_count > maximum_packages or maximum_packages > MAX_PACKAGES:
            raise ValidationError("receipt inventory package count exceeds its bound")
        expected_result_count = _required_int(
            item.get("expectedResultCount"),
            label="receipt inventory expected result count",
            minimum=1,
        )
        result_count = _required_int(
            item.get("resultCount"),
            label="receipt inventory result count",
            minimum=1,
        )
        if result_count != expected_result_count or result_count > MAX_RESULTS:
            raise ValidationError("receipt inventory result count is outside its contract")
        key = (inventory_class, inventory_type)
        if key in seen_inventory:
            raise ValidationError("receipt inventory contains a duplicate")
        seen_inventory.add(key)
        inventory_specs.append(
            f"{inventory_class}:{inventory_type}:{minimum_packages}:"
            f"{maximum_packages}:{expected_result_count}"
        )
    inventories = parse_inventory_bounds(inventory_specs)
    return service, image_id, architecture, expected_os, os_family, inventories, policy, scan_times


def command_validate(args: argparse.Namespace) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    receipt, source_blobs = build_receipt(args, now=now)
    receipt_payload = _canonical_json(receipt)
    receipt_blob = write_receipt(args.receipt, receipt_payload)
    if receipt_blob.data != receipt_payload:
        raise ValidationError("receipt changed immediately after its durable write")
    _ensure_distinct([*source_blobs, receipt_blob])
    return {
        "ok": True,
        "service": receipt["service"],
        "imageId": receipt["image"]["id"],
        "architecture": receipt["image"]["architecture"],
        "receiptSha256": receipt_blob.sha256,
        "reportSha256": receipt["scan"]["reportSha256"],
        "databaseSha256": receipt["database"]["dbSha256"],
        "packageCount": receipt["verdict"]["packageCount"],
    }


def command_verify(args: argparse.Namespace) -> dict[str, Any]:
    expected_receipt_sha256 = _validate_sha256(
        args.expected_receipt_sha256,
        label="expected receipt SHA-256",
    )
    receipt_blob = read_plain_file(
        args.receipt,
        label="receipt",
        maximum_size=MAX_RECEIPT_BYTES,
        capture=True,
    )
    if receipt_blob.sha256 != expected_receipt_sha256:
        raise ValidationError("receipt SHA-256 does not match the trusted journal value")
    receipt = parse_json(receipt_blob, label="receipt")
    (
        service,
        image_id,
        architecture,
        expected_os,
        os_family,
        inventories,
        policy,
        scan_times,
    ) = _parse_receipt_contract(receipt, args=args)
    now = datetime.now(timezone.utc)
    maximum_receipt_age = timedelta(seconds=args.maximum_receipt_age_seconds)
    if now - scan_times.completed > maximum_receipt_age:
        raise ValidationError("receipt is older than the promotion window")

    report_blob = read_plain_file(
        args.report,
        label="Trivy report",
        maximum_size=MAX_REPORT_BYTES,
        capture=True,
    )
    metadata_blob = read_plain_file(
        args.db_metadata,
        label="Trivy DB metadata",
        maximum_size=MAX_METADATA_BYTES,
        capture=True,
    )
    database_blob = read_plain_file(
        args.db,
        label="Trivy DB",
        maximum_size=MAX_DATABASE_BYTES,
        capture=False,
    )
    _ensure_distinct([receipt_blob, report_blob, metadata_blob, database_blob])

    scan_document = receipt["scan"]
    database_document = receipt["database"]
    if (
        report_blob.sha256 != scan_document["reportSha256"]
        or report_blob.size != scan_document["reportSize"]
        or metadata_blob.sha256 != database_document["metadataSha256"]
        or metadata_blob.size != database_document["metadataSize"]
        or database_blob.sha256 != database_document["dbSha256"]
        or database_blob.size != database_document["dbSize"]
    ):
        raise ValidationError("scan report or database artifact changed after attestation")

    package_count, inventory_counts = validate_report(
        parse_json(report_blob, label="Trivy report"),
        expected_image_id=image_id,
        expected_architecture=architecture,
        expected_os=expected_os,
        expected_os_family=os_family,
        inventory_bounds=inventories,
    )
    if package_count != receipt["verdict"]["packageCount"]:
        raise ValidationError("package count no longer matches the receipt")
    expected_inventory_counts = {
        (item["class"], item["type"]): item["packageCount"]
        for item in receipt["inventory"]
    }
    if inventory_counts != expected_inventory_counts:
        raise ValidationError("required inventory no longer matches the receipt")
    database_metadata = validate_database_metadata(
        parse_json(metadata_blob, label="Trivy DB metadata"),
        scan_times=scan_times,
        policy=policy,
        now=now,
    )
    for field in ("version", "updatedAt", "downloadedAt", "nextUpdate"):
        if database_metadata[field] != database_document[field]:
            raise ValidationError("Trivy DB metadata no longer matches the receipt")
    return {
        "ok": True,
        "service": service,
        "imageId": image_id,
        "architecture": architecture,
        "receiptSha256": receipt_blob.sha256,
        "reportSha256": report_blob.sha256,
        "databaseSha256": database_blob.sha256,
        "packageCount": package_count,
    }


def add_image_contract_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--service", required=True)
    parser.add_argument("--expected-image-id", required=True)
    parser.add_argument("--expected-architecture", required=True)
    parser.add_argument("--expected-os", default="linux")
    parser.add_argument("--expected-os-family", required=True)


def add_artifact_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--report", required=True)
    parser.add_argument("--db-metadata", required=True)
    parser.add_argument("--db", required=True)
    parser.add_argument("--receipt", required=True)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate a Trivy image scan and bind it to immutable artifact hashes.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser(
        "validate",
        help="validate scan artifacts and create an exclusive receipt",
    )
    add_image_contract_arguments(validate_parser)
    add_artifact_arguments(validate_parser)
    validate_parser.add_argument(
        "--inventory-bound",
        action="append",
        required=True,
        metavar="CLASS:TYPE:MINIMUM:MAXIMUM:RESULT_COUNT",
    )
    validate_parser.add_argument("--scanner-version", required=True)
    validate_parser.add_argument("--scanner-sha256", required=True)
    validate_parser.add_argument("--scan-started-at", required=True)
    validate_parser.add_argument("--scan-completed-at", required=True)
    validate_parser.add_argument("--maximum-db-age-seconds", type=_positive_argument, default=86_400)
    validate_parser.add_argument("--maximum-scan-age-seconds", type=_positive_argument, default=3_600)
    validate_parser.add_argument("--maximum-scan-duration-seconds", type=_positive_argument, default=7_200)
    validate_parser.add_argument("--clock-skew-seconds", type=_positive_argument, default=300)
    validate_parser.set_defaults(handler=command_validate)

    verify_parser = subparsers.add_parser(
        "verify",
        help="revalidate artifacts against a trusted receipt SHA-256 before promotion",
    )
    add_image_contract_arguments(verify_parser)
    add_artifact_arguments(verify_parser)
    verify_parser.add_argument("--expected-receipt-sha256", required=True)
    verify_parser.add_argument(
        "--maximum-receipt-age-seconds",
        type=_positive_argument,
        default=3_600,
    )
    verify_parser.set_defaults(handler=command_verify)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        result = args.handler(args)
    except (ValidationError, MemoryError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(_canonical_json(result).decode("utf-8"), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
