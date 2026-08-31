#!/usr/bin/env python3
"""Validate the immutable WSL Qdrant API bridge receipt.

The deployment shell emits a fixed-order canonical JSON document so it can do
so without importing ambient Python modules.  This isolated verifier is copied
from the same official player snapshot and is the consumer contract used by
the stateful Qdrant migration.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


MAX_RECEIPT_BYTES = 128 * 1024
HEX64 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
SAFE_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$")
GENERATION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\-]{0,159}$")
IMAGE_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class ReceiptError(RuntimeError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ReceiptError(message)


def _exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    _require(set(value) == expected, f"{label} key set is invalid")
    return value


def _safe_string(value: Any, label: str, pattern: re.Pattern[str] = SAFE_TOKEN) -> str:
    _require(isinstance(value, str) and pattern.fullmatch(value) is not None,
             f"{label} is invalid")
    return value


def _canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
            + "\n").encode("utf-8")


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _validate_compatibility_matrix(value: Any, smoke_seed: int) -> dict[str, Any]:
    matrix = _exact_keys(value, {
        "endpoints", "endpointResponsesSha256", "readMatrix", "readMatrixSha256",
        "requiredQueryPath", "schemaVersion", "seedSelection", "seedSongId",
        "semanticSha256", "slots",
    }, "compatibilityMatrix")
    _require(matrix["schemaVersion"] == 1,
             "compatibilityMatrix schemaVersion is invalid")
    _require(matrix["seedSongId"] == smoke_seed,
             "compatibilityMatrix seedSongId does not match smoke")
    _require(matrix["requiredQueryPath"] == "legacy-search-fallback",
             "compatibilityMatrix query path is invalid")
    for key in ("endpointResponsesSha256", "readMatrixSha256", "semanticSha256"):
        _safe_string(matrix[key], f"compatibilityMatrix.{key}", HEX64)

    selection = _exact_keys(matrix["seedSelection"], {
        "collectionNames", "scanLimit", "sha256",
    }, "compatibilityMatrix.seedSelection")
    _require(selection["collectionNames"] == [
        "song_audio", "song_hybrid_active", "song_metadata_active", "songs_v2_active",
    ], "compatibilityMatrix seed collection names are invalid")
    _require(selection["scanLimit"] == 64,
             "compatibilityMatrix seed scan limit is invalid")
    _safe_string(selection["sha256"],
                 "compatibilityMatrix.seedSelection.sha256", HEX64)

    read_matrix = _exact_keys(matrix["readMatrix"], {
        "aliases", "collectionInfo", "collections", "operations", "schemaVersion",
        "seedSongId",
    }, "compatibilityMatrix.readMatrix")
    _require(read_matrix["schemaVersion"] == 1
             and read_matrix["seedSongId"] == smoke_seed,
             "compatibilityMatrix read matrix identity is invalid")
    collections = read_matrix["collections"]
    _require(isinstance(collections, list)
             and collections == sorted(set(collections))
             and all(isinstance(item, str) and item for item in collections),
             "compatibilityMatrix collections are invalid")
    aliases = read_matrix["aliases"]
    _require(isinstance(aliases, list) and len(aliases) <= 1000,
             "compatibilityMatrix aliases are invalid")
    alias_names: set[str] = set()
    for index, item in enumerate(aliases):
        alias = _exact_keys(item, {"alias", "collection"},
                            f"compatibilityMatrix.aliases[{index}]")
        alias_names.add(_safe_string(alias["alias"], "compatibility alias"))
        _safe_string(alias["collection"], "compatibility alias collection")
    _require({"songs_v2_active", "song_hybrid_active", "song_metadata_active"}
             <= alias_names, "compatibilityMatrix required aliases are absent")
    expected_collections = {
        "songs_v2_active", "song_hybrid_active", "song_metadata_active", "song_audio",
    }
    collection_info = read_matrix["collectionInfo"]
    _require(isinstance(collection_info, list) and len(collection_info) == 4,
             "compatibilityMatrix collectionInfo is invalid")
    seen_collections: set[str] = set()
    for index, item in enumerate(collection_info):
        info = _exact_keys(item, {
            "collection", "indexedVectorsCount", "pointsCount", "segmentsCount", "status",
        }, f"compatibilityMatrix.collectionInfo[{index}]")
        name = _safe_string(info["collection"], "compatibility collection")
        seen_collections.add(name)
        _require(str(info["status"]).lower() == "green",
                 "compatibility collection is not green")
        _require(isinstance(info["pointsCount"], int) and info["pointsCount"] > 0,
                 "compatibility collection point count is invalid")
        for key in ("indexedVectorsCount", "segmentsCount"):
            _require(isinstance(info[key], int) and info[key] >= 0,
                     f"compatibility collection {key} is invalid")
    _require(seen_collections == expected_collections,
             "compatibilityMatrix collectionInfo set is invalid")

    expected_operations = {
        "named-audio": ("songs_v2_active", "audio"),
        "named-meta": ("songs_v2_active", "meta"),
        "hybrid-default": ("song_hybrid_active", "default"),
        "metadata-default": ("song_metadata_active", "default"),
        "audio-default": ("song_audio", "default"),
    }
    operations = read_matrix["operations"]
    _require(isinstance(operations, list)
             and [item.get("operation") for item in operations
                  if isinstance(item, dict)] == list(expected_operations),
             "compatibilityMatrix operation order is invalid")
    for index, item in enumerate(operations):
        operation = _exact_keys(item, {
            "collection", "hits", "operation", "payloadKeys", "queryPath",
            "vectorDimensions", "vectorName", "withoutPayloadFieldCount",
        }, f"compatibilityMatrix.operations[{index}]")
        expected_collection, expected_vector = expected_operations[operation["operation"]]
        _require(operation["collection"] == expected_collection
                 and operation["vectorName"] == expected_vector
                 and operation["queryPath"] == "legacy-search-fallback",
                 "compatibilityMatrix operation contract is invalid")
        _require(isinstance(operation["vectorDimensions"], int)
                 and operation["vectorDimensions"] > 0
                 and operation["withoutPayloadFieldCount"] == 0,
                 "compatibilityMatrix retrieve contract is invalid")
        keys = operation["payloadKeys"]
        _require(isinstance(keys, list) and keys == sorted(set(keys)) and bool(keys),
                 "compatibilityMatrix payload keys are invalid")
        hits = operation["hits"]
        _require(isinstance(hits, list) and 1 <= len(hits) <= 5,
                 "compatibilityMatrix hits are invalid")
        for hit_index, hit_value in enumerate(hits):
            hit = _exact_keys(hit_value, {"score", "songId"},
                              f"compatibilityMatrix operation hit {hit_index}")
            _require(isinstance(hit["songId"], int) and hit["songId"] > 0
                     and isinstance(hit["score"], (int, float))
                     and not isinstance(hit["score"], bool)
                     and math.isfinite(hit["score"]),
                     "compatibilityMatrix operation hit is invalid")

    endpoints = _exact_keys(matrix["endpoints"], {
        "audio", "dig", "metadata", "multi", "recommend", "similar",
    }, "compatibilityMatrix.endpoints")
    for name, raw in endpoints.items():
        expected_keys = {"itemCount", "responseKeys", "responseSha256", "songIds"}
        if name == "dig":
            expected_keys.add("totalCount")
        endpoint = _exact_keys(raw, expected_keys,
                               f"compatibilityMatrix.endpoints.{name}")
        ids = endpoint["songIds"]
        _require(isinstance(ids, list) and 1 <= len(ids) <= 100
                 and all(isinstance(identifier, int) and identifier > 0 for identifier in ids)
                 and endpoint["itemCount"] == len(ids),
                 f"compatibilityMatrix endpoint {name} item contract is invalid")
        response_keys = endpoint["responseKeys"]
        _require(isinstance(response_keys, list)
                 and response_keys == sorted(set(response_keys))
                 and all(isinstance(key, str) and key for key in response_keys),
                 f"compatibilityMatrix endpoint {name} response keys are invalid")
        _safe_string(endpoint["responseSha256"],
                     f"compatibilityMatrix.endpoints.{name}.responseSha256", HEX64)
        if name == "dig":
            _require(isinstance(endpoint["totalCount"], int)
                     and endpoint["totalCount"] >= len(ids),
                     "compatibilityMatrix dig totalCount is invalid")

    _require(matrix["readMatrixSha256"] == _digest(read_matrix),
             "compatibilityMatrix read matrix digest is invalid")
    _require(matrix["endpointResponsesSha256"] == _digest(endpoints),
             "compatibilityMatrix endpoint digest is invalid")
    semantic_payload = {
        "endpoints": endpoints,
        "readMatrix": read_matrix,
        "schemaVersion": 1,
        "seedSongId": smoke_seed,
    }
    _require(matrix["semanticSha256"] == _digest(semantic_payload),
             "compatibilityMatrix semantic digest is invalid")
    slots = _exact_keys(matrix["slots"], {"api_a", "api_b"},
                        "compatibilityMatrix.slots")
    for name in ("api_a", "api_b"):
        slot = _exact_keys(slots[name], {
            "endpointResponsesSha256", "readMatrixSha256", "semanticSha256",
        }, f"compatibilityMatrix.slots.{name}")
        _require(slot == {
            "endpointResponsesSha256": matrix["endpointResponsesSha256"],
            "readMatrixSha256": matrix["readMatrixSha256"],
            "semanticSha256": matrix["semanticSha256"],
        }, f"compatibilityMatrix slot {name} digest contract is invalid")
    return matrix


def validate_payload(payload: Any) -> dict[str, Any]:
    root = _exact_keys(payload, {
        "apiSlots", "clientPackageVersion", "createdAt", "deploymentId",
        "compatibilityMatrix", "compatibilityMatrixSha256",
        "helperSha256", "hostScope", "mode", "oldQdrant", "payloadSha256", "playerCommit",
        "previousApiRollback", "schemaVersion", "smoke",
        "sourceManifestSha256", "sourceSnapshotSha256", "validOnlyWhileOldQExact",
        "validUntil",
    }, "receipt")
    _require(root["schemaVersion"] == 3, "receipt schemaVersion is unsupported")
    _require(root["hostScope"] in {"wsl-dr-standby", "sbc-primary"},
             "receipt hostScope is invalid")
    _require(root["mode"] == "qdrant-legacy-api-bridge", "receipt mode is invalid")
    _require(root["validOnlyWhileOldQExact"] is True,
             "receipt old-Q identity lifetime marker is invalid")
    _require(root["clientPackageVersion"] == "1.19.0",
             "bridge client package version is invalid")
    _safe_string(root["deploymentId"], "deploymentId")
    _safe_string(root["playerCommit"], "playerCommit", COMMIT)
    for key in ("helperSha256", "payloadSha256", "sourceManifestSha256",
                "sourceSnapshotSha256", "compatibilityMatrixSha256"):
        _safe_string(root[key], key, HEX64)
    try:
        created = datetime.fromisoformat(str(root["createdAt"]).replace("Z", "+00:00"))
        valid_until = datetime.fromisoformat(str(root["validUntil"]).replace("Z", "+00:00"))
    except ValueError as error:
        raise ReceiptError("receipt timestamps are invalid") from error
    _require(created.tzinfo is not None and created.utcoffset() == timezone.utc.utcoffset(created),
             "createdAt must be UTC")
    _require(valid_until.tzinfo is not None
             and valid_until.utcoffset() == timezone.utc.utcoffset(valid_until),
             "validUntil must be UTC")
    _require(valid_until - created == timedelta(hours=24),
             "receipt validity interval must be exactly 24 hours")

    qdrant = _exact_keys(root["oldQdrant"], {
        "backup", "containerId", "containerName", "imageId", "imageIndexDigest",
        "imageReference", "imageRepoDigest", "publicationGeneration", "version", "volume",
    }, "oldQdrant")
    _require(qdrant["version"] == "1.9.4", "old Qdrant version is not 1.9.4")
    expected_qdrant_name = ("diva_qdrant_standby"
                            if root["hostScope"] == "wsl-dr-standby"
                            else "vocadb_qdrant")
    _require(qdrant["containerName"] == expected_qdrant_name,
             "old Qdrant container name is invalid")
    _safe_string(qdrant["containerId"], "oldQdrant.containerId")
    _safe_string(qdrant["imageId"], "oldQdrant.imageId")
    _safe_string(qdrant["imageRepoDigest"], "oldQdrant.imageRepoDigest", IMAGE_DIGEST)
    _safe_string(qdrant["imageIndexDigest"], "oldQdrant.imageIndexDigest", IMAGE_DIGEST)
    _safe_string(qdrant["imageReference"], "oldQdrant.imageReference")
    _safe_string(qdrant["backup"], "oldQdrant.backup")
    if root["hostScope"] == "sbc-primary":
        _require(re.fullmatch(r"off-host-evidence-sha256-[0-9a-f]{64}",
                              qdrant["backup"]) is not None,
                 "SBC oldQdrant backup must bind verified off-host evidence")
    _safe_string(qdrant["publicationGeneration"], "oldQdrant.publicationGeneration", GENERATION)
    volume = _exact_keys(qdrant["volume"], {
        "createdAt", "driver", "labelsSha256", "mountpoint",
        "mountpointDeviceInode", "name", "optionsSha256", "scope",
    }, "oldQdrant.volume")
    for key in ("name", "driver", "scope", "createdAt"):
        _safe_string(volume[key], f"oldQdrant.volume.{key}")
    _require(isinstance(volume["mountpoint"], str)
             and volume["mountpoint"].startswith("/")
             and "\x00" not in volume["mountpoint"]
             and "\n" not in volume["mountpoint"], "oldQdrant volume mountpoint is invalid")
    _require(re.fullmatch(r"[0-9]+:[0-9]+", str(volume["mountpointDeviceInode"])) is not None,
             "oldQdrant volume device/inode is invalid")
    for key in ("labelsSha256", "optionsSha256"):
        _safe_string(volume[key], f"oldQdrant.volume.{key}", HEX64)

    slots = _exact_keys(root["apiSlots"], {"api_a", "api_b"}, "apiSlots")
    prefix = "diva_dr" if root["hostScope"] == "wsl-dr-standby" else "vocadb"
    for service, expected_name in (("api_a", f"{prefix}_api_a"),
                                   ("api_b", f"{prefix}_api_b")):
        slot = _exact_keys(slots[service], {
            "clientPackageVersion", "configHash", "containerId", "containerName",
            "imageId", "sourceCommit",
        }, f"apiSlots.{service}")
        _require(slot["containerName"] == expected_name,
                 f"apiSlots.{service}.containerName is invalid")
        _require(slot["clientPackageVersion"] == "1.19.0",
                 f"apiSlots.{service}.clientPackageVersion is invalid")
        _safe_string(slot["containerId"], f"apiSlots.{service}.containerId")
        _safe_string(slot["imageId"], f"apiSlots.{service}.imageId")
        _safe_string(slot["configHash"], f"apiSlots.{service}.configHash", HEX64)
        _safe_string(slot["sourceCommit"], f"apiSlots.{service}.sourceCommit", COMMIT)
        _require(slot["sourceCommit"] == root["playerCommit"],
                 f"apiSlots.{service}.sourceCommit is not the player commit")

    previous = _exact_keys(root["previousApiRollback"], {
        "path", "provenance", "sha256",
    }, "previousApiRollback")
    _require(previous["provenance"] == "legacy-pre-contract-unattested",
             "previous API provenance marker is invalid")
    _require(isinstance(previous["path"], str)
             and (previous["path"].startswith("/")
                  or (os.name == "nt" and Path(previous["path"]).is_absolute()))
             and "\x00" not in previous["path"] and "\n" not in previous["path"],
             "previous API rollback path is invalid")
    _safe_string(previous["sha256"], "previousApiRollback.sha256", HEX64)

    smoke = _exact_keys(root["smoke"], {
        "api_a", "api_b", "retrieveVectorDimensions", "seedSongId",
    }, "smoke")
    _require(isinstance(smoke["seedSongId"], int) and 1 <= smoke["seedSongId"] <= 2_147_483_647,
             "smoke seedSongId is invalid")
    dimensions = _exact_keys(smoke["retrieveVectorDimensions"], {"audio", "meta"},
                             "smoke.retrieveVectorDimensions")
    for name in ("audio", "meta"):
        _require(isinstance(dimensions[name], int) and 1 <= dimensions[name] <= 1_000_000,
                 f"smoke retrieve vector dimension {name} is invalid")
    for service in ("api_a", "api_b"):
        result = _exact_keys(smoke[service], {"path", "resultCount"},
                             f"smoke.{service}")
        _require(result["path"] == "retrieve-query-legacy-search-passed",
                 f"smoke path for {service} is invalid")
        _require(isinstance(result["resultCount"], int)
                 and 1 <= result["resultCount"] <= 100,
                 f"smoke result count for {service} is invalid")

    compatibility = _validate_compatibility_matrix(
        root["compatibilityMatrix"], smoke["seedSongId"])
    _require(root["compatibilityMatrixSha256"] == _digest(compatibility),
             "compatibilityMatrixSha256 is invalid")

    without_hash = dict(root)
    claimed_hash = without_hash.pop("payloadSha256")
    actual_hash = hashlib.sha256(_canonical(without_hash)).hexdigest()
    _require(claimed_hash == actual_hash, "receipt payloadSha256 is invalid")
    _require(_canonical(root) == _canonical(payload), "receipt is not canonical")
    return root


def read_receipt(path: Path, *, require_trusted_metadata: bool) -> dict[str, Any]:
    metadata = os.lstat(path)
    _require(stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode),
             "receipt must be a regular non-symlink file")
    _require(metadata.st_nlink == 1 and metadata.st_size <= MAX_RECEIPT_BYTES,
             "receipt metadata is invalid")
    if require_trusted_metadata:
        _require(metadata.st_uid == 0 and metadata.st_gid == 0
                 and stat.S_IMODE(metadata.st_mode) == 0o600,
                 "receipt must be root:root mode 0600")
    raw = path.read_bytes()
    _require(len(raw) == metadata.st_size and raw.endswith(b"\n"),
             "receipt read was incomplete")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ReceiptError("receipt JSON is invalid") from error
    validated = validate_payload(payload)
    _require(raw == _canonical(validated), "receipt bytes are not canonical JSON")
    return validated


def _read_digest_bound_file(
    path: Path,
    expected_sha256: str,
    *,
    require_trusted_metadata: bool,
    label: str,
) -> bytes:
    metadata = os.lstat(path)
    _require(stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode)
             and metadata.st_nlink == 1 and 0 < metadata.st_size <= 128 * 1024,
             f"{label} metadata is invalid")
    if require_trusted_metadata:
        _require(metadata.st_uid == 0 and metadata.st_gid == 0
                 and stat.S_IMODE(metadata.st_mode) == 0o600,
                 f"{label} must be root:root mode 0600")
    raw = path.read_bytes()
    _require(len(raw) == metadata.st_size and raw.endswith(b"\n"),
             f"{label} read was incomplete")
    _require(hashlib.sha256(raw).hexdigest() == expected_sha256,
             f"{label} digest is invalid")
    return raw


def _metadata_path(path_text: str, *, require_trusted_metadata: bool) -> Path:
    """Resolve the deterministic Git-Bash spelling only in explicit tests."""
    path = Path(path_text)
    # Production receipts are consumed on Linux and retain their exact absolute
    # path.  The Windows contract fixture uses native isolated Python but emits
    # the same /c/... bytes as Git Bash; translate only when the caller has
    # explicitly disabled trusted-metadata enforcement for that fixture.
    if not require_trusted_metadata and os.name == "nt":
        drive_path = re.fullmatch(r"/([A-Za-z])/(.+)", path_text)
        if drive_path is not None:
            path = Path(f"{drive_path.group(1).upper()}:/{drive_path.group(2)}")
    return path


def _validate_public_unit_state(value: Any, label: str) -> dict[str, Any]:
    units = _exact_keys(value, {
        "diva-wsl-dr-quick-tunnel.service",
        "diva-wsl-dr-quick-tunnel-sync.service",
        "diva-wsl-dr-quick-tunnel-sync.timer",
        "diva-wsl-dr-watchdog.service",
        "diva-wsl-dr-watchdog.timer",
    }, label)
    for name, raw_state in units.items():
        state = _exact_keys(raw_state, {"active", "enabled", "load", "sub"}, f"{label}.{name}")
        _require(state["load"] in {"loaded", "not-found"},
                 f"{label}.{name}.load is invalid")
        if state["load"] == "not-found":
            _require(state["active"] == "not-found"
                     and state["sub"] == "not-found"
                     and state["enabled"] == "not-found",
                     f"{label}.{name} missing state is inconsistent")
        else:
            _require(state["active"] in {"active", "inactive"}
                     and isinstance(state["sub"], str)
                     and re.fullmatch(r"[A-Za-z0-9_.:-]+", state["sub"]) is not None
                     and state["enabled"] in {"enabled", "disabled", "static"},
                     f"{label}.{name} loaded state is invalid")
    return units


def _read_previous_api_rollback_v1(
    raw: bytes, receipt: dict[str, Any]
) -> dict[str, Any]:
    reference = receipt["previousApiRollback"]
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeError as error:
        raise ReceiptError("previous API rollback receipt is not UTF-8") from error
    _require(lines[:2] == ["schema\t1", "provenance\tlegacy-pre-contract-unattested"]
             and len(lines) == 4,
             "previous API rollback receipt header is invalid")
    expected_prefix = "diva_dr" if receipt["hostScope"] == "wsl-dr-standby" else "vocadb"
    slots: dict[str, Any] = {}
    for line, expected_service in zip(lines[2:], ("api_a", "api_b"), strict=True):
        fields = line.split("\t")
        _require(len(fields) == 8 and fields[0] == expected_service,
                 "previous API rollback receipt slot row is invalid")
        _, canonical_name, archive_name, container_id, image_id, image_reference, config_hash, rollback_tag = fields
        _require(canonical_name == f"{expected_prefix}_{expected_service}",
                 "previous API rollback canonical name is invalid")
        for value, label in (
            (archive_name, "archiveName"), (container_id, "containerId"),
            (image_id, "imageId"), (image_reference, "imageReference"),
            (rollback_tag, "rollbackTag"),
        ):
            _safe_string(value, f"previousApiRollback.{expected_service}.{label}")
        _safe_string(config_hash, f"previousApiRollback.{expected_service}.configHash", HEX64)
        slots[expected_service] = {
            "archiveName": archive_name,
            "canonicalName": canonical_name,
            "configHash": config_hash,
            "containerId": container_id,
            "imageId": image_id,
            "imageReference": image_reference,
            "rollbackTag": rollback_tag,
        }
    return {
        "apiSlots": slots,
        "provenance": "legacy-pre-contract-unattested",
        "schemaVersion": 1,
    }


def _read_previous_api_rollback_v2(
    raw: bytes,
    receipt: dict[str, Any],
    *,
    require_trusted_metadata: bool,
) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ReceiptError("previous API rollback JSON is invalid") from error
    root = _exact_keys(value, {
        "bridgeApplication", "bridgeProbeTokenSha256", "canonicalImages",
        "deploymentId", "preBridgePublicServiceState", "prestate", "provenance",
        "publicServiceState", "recoveryPolicy", "schemaVersion",
    }, "previousApiRollback")
    _require(root["schemaVersion"] == 3,
             "previous API rollback schemaVersion is invalid")
    _require(root["provenance"] == "legacy-pre-contract-unattested"
             and root["recoveryPolicy"] == "old-api-old-q-pre-mutation-only",
             "previous API rollback policy is invalid")
    _require(root["deploymentId"] == receipt["deploymentId"],
             "previous API rollback deploymentId is inconsistent")
    _safe_string(root["bridgeProbeTokenSha256"],
                 "previousApiRollback.bridgeProbeTokenSha256", HEX64)
    prefix = "diva_dr" if receipt["hostScope"] == "wsl-dr-standby" else "vocadb"
    expected_services = {"api_a", "api_b", "api_gateway", "web"}
    application = _exact_keys(
        root["bridgeApplication"], expected_services,
        "previousApiRollback.bridgeApplication",
    )
    for service, raw_contract in application.items():
        contract = _exact_keys(
            raw_contract, {"bridge", "canonicalName", "previous"},
            f"previousApiRollback.bridgeApplication.{service}",
        )
        _require(contract["canonicalName"] == f"{prefix}_{service}",
                 f"previousApiRollback {service} canonical name is invalid")
        bridge = _exact_keys(
            contract["bridge"],
            {"configHash", "containerId", "failedName", "imageId", "imageReference"},
            f"previousApiRollback.bridgeApplication.{service}.bridge",
        )
        previous = _exact_keys(
            contract["previous"],
            {"archiveName", "configHash", "containerId", "imageId", "imageReference", "rollbackTag"},
            f"previousApiRollback.bridgeApplication.{service}.previous",
        )
        for side, payload in (("bridge", bridge), ("previous", previous)):
            _safe_string(payload["containerId"],
                         f"previousApiRollback.{service}.{side}.containerId")
            _safe_string(payload["imageId"],
                         f"previousApiRollback.{service}.{side}.imageId")
            _safe_string(payload["imageReference"],
                         f"previousApiRollback.{service}.{side}.imageReference")
            _safe_string(payload["configHash"],
                         f"previousApiRollback.{service}.{side}.configHash", HEX64)
        _safe_string(bridge["failedName"],
                     f"previousApiRollback.{service}.bridge.failedName")
        _safe_string(previous["archiveName"],
                     f"previousApiRollback.{service}.previous.archiveName")
        _safe_string(previous["rollbackTag"],
                     f"previousApiRollback.{service}.previous.rollbackTag")
        if service in {"api_a", "api_b"}:
            live = receipt["apiSlots"][service]
            _require(
                contract["canonicalName"] == live["containerName"]
                and bridge["containerId"] == live["containerId"]
                and bridge["imageId"] == live["imageId"]
                and bridge["configHash"] == live["configHash"],
                f"previous API rollback {service} bridge identity differs from the main receipt",
            )

    canonical = _exact_keys(
        root["canonicalImages"], {"api", "gateway", "web"},
        "previousApiRollback.canonicalImages",
    )
    for kind, raw_contract in canonical.items():
        contract = _exact_keys(
            raw_contract,
            {"bridgeImageId", "previousImageId", "reference", "rollbackTag"},
            f"previousApiRollback.canonicalImages.{kind}",
        )
        for key in contract:
            _safe_string(contract[key],
                         f"previousApiRollback.canonicalImages.{kind}.{key}")
    pre_bridge_units = _validate_public_unit_state(
        root["preBridgePublicServiceState"],
        "previousApiRollback.preBridgePublicServiceState",
    )
    public_units = _validate_public_unit_state(
        root["publicServiceState"], "previousApiRollback.publicServiceState"
    )
    _require(
        public_units == pre_bridge_units,
        "previous API rollback public service state changed during the bridge",
    )
    prestate = _exact_keys(root["prestate"], {"path", "sha256"},
                           "previousApiRollback.prestate")
    _require(isinstance(prestate["path"], str)
             and (prestate["path"].startswith("/")
                  or (os.name == "nt" and Path(prestate["path"]).is_absolute()))
             and "\x00" not in prestate["path"] and "\n" not in prestate["path"],
             "previous API rollback prestate path is invalid")
    _safe_string(prestate["sha256"], "previousApiRollback.prestate.sha256", HEX64)
    prestate_raw = _read_digest_bound_file(
        _metadata_path(
            prestate["path"], require_trusted_metadata=require_trusted_metadata
        ),
        prestate["sha256"],
        require_trusted_metadata=require_trusted_metadata,
        label="previous API rollback prestate",
    )
    try:
        lines = prestate_raw.decode("utf-8").splitlines()
    except UnicodeError as error:
        raise ReceiptError("previous API rollback prestate is not UTF-8") from error
    _require(lines[:2] == ["schema\t2", "provenance\tlegacy-pre-contract-unattested"],
             "previous API rollback prestate header is invalid")
    observed_services: set[str] = set()
    observed_images: set[str] = set()
    observed_units: set[str] = set()
    for line in lines[2:]:
        fields = line.split("\t")
        if fields[0] == "service":
            _require(len(fields) == 10 and fields[1] in expected_services
                     and fields[1] not in observed_services,
                     "previous API rollback prestate service row is invalid")
            service = fields[1]
            observed_services.add(service)
            previous = application[service]["previous"]
            _require(fields[2:] == [
                application[service]["canonicalName"], previous["archiveName"],
                application[service]["bridge"]["failedName"], previous["containerId"],
                previous["imageId"], previous["imageReference"],
                previous["configHash"], previous["rollbackTag"],
            ], "previous API rollback prestate service evidence changed")
        elif fields[0] == "canonical-image":
            _require(len(fields) == 5 and fields[1] in canonical
                     and fields[1] not in observed_images,
                     "previous API rollback prestate image row is invalid")
            kind = fields[1]
            observed_images.add(kind)
            _require(fields[2:] == [
                canonical[kind]["reference"], canonical[kind]["previousImageId"],
                canonical[kind]["rollbackTag"],
            ], "previous API rollback prestate image evidence changed")
        elif fields[0] == "unit":
            _require(len(fields) == 6 and fields[1] in pre_bridge_units
                     and fields[1] not in observed_units,
                     "previous API rollback prestate unit row is invalid")
            unit = fields[1]
            observed_units.add(unit)
            state = pre_bridge_units[unit]
            _require(fields[2:] == [
                state["load"], state["active"], state["sub"], state["enabled"]
            ],
                     "previous API rollback prestate unit evidence changed")
        else:
            raise ReceiptError("previous API rollback prestate row type is invalid")
    _require(observed_services == expected_services
             and observed_images == set(canonical)
             and observed_units == set(pre_bridge_units),
             "previous API rollback prestate inventory is incomplete")
    _require(raw == _canonical(root),
             "previous API rollback bytes are not canonical JSON")
    return {
        "apiSlots": {
            service: application[service]["previous"]
            for service in ("api_a", "api_b")
        },
        "bridgeApplication": application,
        "bridgeProbeTokenSha256": root["bridgeProbeTokenSha256"],
        "canonicalImages": canonical,
        "preBridgePublicServiceState": pre_bridge_units,
        "provenance": root["provenance"],
        "publicServiceState": public_units,
        "recoveryPolicy": root["recoveryPolicy"],
        "schemaVersion": 3,
    }


def read_previous_api_rollback(
    receipt: dict[str, Any], *, require_trusted_metadata: bool
) -> dict[str, Any]:
    reference = receipt["previousApiRollback"]
    path = _metadata_path(
        reference["path"], require_trusted_metadata=require_trusted_metadata
    )
    raw = _read_digest_bound_file(
        path, reference["sha256"],
        require_trusted_metadata=require_trusted_metadata,
        label="previous API rollback receipt",
    )
    if raw.startswith(b"{"):
        return _read_previous_api_rollback_v2(
            raw, receipt, require_trusted_metadata=require_trusted_metadata
        )
    _require(receipt["hostScope"] == "sbc-primary",
             "WSL previous API rollback evidence requires schemaVersion 3")
    return _read_previous_api_rollback_v1(raw, receipt)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True, type=Path)
    parser.add_argument("--allow-current-owner-for-test", action="store_true")
    parser.add_argument("--expect-host-scope", choices=("wsl-dr-standby", "sbc-primary"))
    parser.add_argument("--require-fresh", action="store_true")
    parser.add_argument("--verify-previous-api-rollback", action="store_true")
    parser.add_argument("--field")
    args = parser.parse_args()
    payload = read_receipt(
        args.path,
        require_trusted_metadata=not args.allow_current_owner_for_test,
    )
    if args.expect_host_scope:
        _require(payload["hostScope"] == args.expect_host_scope,
                 "receipt hostScope does not match this host")
    if args.require_fresh:
        now = datetime.now(timezone.utc)
        created = datetime.fromisoformat(payload["createdAt"].replace("Z", "+00:00"))
        valid_until = datetime.fromisoformat(payload["validUntil"].replace("Z", "+00:00"))
        _require(created <= now <= valid_until, "receipt is not currently fresh")
    previous = None
    if args.verify_previous_api_rollback:
        previous = read_previous_api_rollback(
            payload,
            require_trusted_metadata=not args.allow_current_owner_for_test,
        )
    if args.field:
        value: Any = payload
        for component in args.field.split("."):
            _require(isinstance(value, dict) and component in value,
                     "requested receipt field is missing")
            value = value[component]
        _require(isinstance(value, (str, int)), "requested receipt field is not scalar")
        print(value)
    elif previous is not None:
        print(json.dumps(
            {"previousApiRollback": previous, "receipt": payload},
            ensure_ascii=True, separators=(",", ":"), sort_keys=True,
        ))
    else:
        print(json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ReceiptError) as error:
        print(f"bridge receipt: {error}", file=sys.stderr)
        raise SystemExit(1)
