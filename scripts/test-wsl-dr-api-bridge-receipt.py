#!/usr/bin/env python3
"""Contract tests for the shared Qdrant API bridge receipt verifier."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
HELPER_PATH = SCRIPT_DIRECTORY / "wsl-dr-api-bridge-receipt.py"
PRODUCER_PATH = SCRIPT_DIRECTORY / "sbc-api-bridge-receipt.py"


def load_helper():
    specification = importlib.util.spec_from_file_location(
        "diva_wsl_dr_api_bridge_receipt_contract", HELPER_PATH
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load bridge receipt helper")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def load_producer():
    specification = importlib.util.spec_from_file_location(
        "diva_sbc_api_bridge_receipt_producer", PRODUCER_PATH
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load SBC bridge receipt producer")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def canonical(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
            + "\n").encode("utf-8")


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def build_compatibility(seed: int) -> dict[str, object]:
    read_matrix = {
        "aliases": [
            {"alias": "song_hybrid_active", "collection": "song_hybrid_generation_42"},
            {"alias": "song_metadata_active", "collection": "song_metadata_generation_42"},
            {"alias": "songs_v2_active", "collection": "songs_v2_generation_42"},
        ],
        "collectionInfo": [
            {"collection": name, "indexedVectorsCount": 100, "pointsCount": 120,
             "segmentsCount": 2, "status": "Green"}
            for name in (
                "song_audio", "song_hybrid_active", "song_metadata_active", "songs_v2_active"
            )
        ],
        "collections": [
            "song_audio", "song_hybrid_generation_42", "song_metadata_generation_42",
            "songs_v2_generation_42",
        ],
        "operations": [
            {
                "collection": collection, "hits": [{"score": 0.875, "songId": 3100}],
                "operation": operation, "payloadKeys": ["artist", "name"],
                "queryPath": "legacy-search-fallback", "vectorDimensions": dimensions,
                "vectorName": vector, "withoutPayloadFieldCount": 0,
            }
            for operation, collection, vector, dimensions in (
                ("named-audio", "songs_v2_active", "audio", 512),
                ("named-meta", "songs_v2_active", "meta", 384),
                ("hybrid-default", "song_hybrid_active", "default", 896),
                ("metadata-default", "song_metadata_active", "default", 384),
                ("audio-default", "song_audio", "default", 512),
            )
        ],
        "schemaVersion": 1,
        "seedSongId": seed,
    }
    endpoints: dict[str, object] = {}
    for name in ("audio", "dig", "metadata", "multi", "recommend", "similar"):
        raw = {"items": [{"songId": 3100}, {"songId": 3101}]}
        if name == "dig":
            raw["totalCount"] = 2
        endpoint: dict[str, object] = {
            "itemCount": 2,
            "responseKeys": sorted(raw),
            "responseSha256": digest(raw),
            "songIds": [3100, 3101],
        }
        if name == "dig":
            endpoint["totalCount"] = 2
        endpoints[name] = endpoint
    semantic = {
        "endpoints": endpoints,
        "readMatrix": read_matrix,
        "schemaVersion": 1,
        "seedSongId": seed,
    }
    read_hash = digest(read_matrix)
    endpoint_hash = digest(endpoints)
    semantic_hash = digest(semantic)
    return {
        "endpoints": endpoints,
        "endpointResponsesSha256": endpoint_hash,
        "readMatrix": read_matrix,
        "readMatrixSha256": read_hash,
        "requiredQueryPath": "legacy-search-fallback",
        "schemaVersion": 1,
        "seedSelection": {
            "collectionNames": [
                "song_audio", "song_hybrid_active", "song_metadata_active", "songs_v2_active"
            ],
            "scanLimit": 64,
            "sha256": "5" * 64,
        },
        "seedSongId": seed,
        "semanticSha256": semantic_hash,
        "slots": {
            service: {
                "endpointResponsesSha256": endpoint_hash,
                "readMatrixSha256": read_hash,
                "semanticSha256": semantic_hash,
            }
            for service in ("api_a", "api_b")
        },
    }


def build_producer_read_matrix(
    producer: object,
    seed: int,
    generation: str,
) -> dict[str, object]:
    matrix = json.loads(json.dumps(build_compatibility(seed)["readMatrix"]))
    projection = producer.expected_publication_projection(generation)
    matrix["aliases"] = [
        {"alias": alias, "collection": collection}
        for alias, collection in sorted(projection["aliases"].items())
    ]
    matrix["collections"] = projection["collections"]
    return matrix


def require_runtime_failure(action, label: str) -> None:
    try:
        action()
    except RuntimeError:
        return
    raise AssertionError(f"unsafe live publication matrix was accepted: {label}")


def test_live_publication_binding(producer: object) -> None:
    seed = 3022
    generation = f"{'a' * 64}:{'b' * 32}"
    next_generation = f"{'c' * 64}:{'d' * 32}"

    for accepted_generation in ("legacy", generation):
        matrix = build_producer_read_matrix(producer, seed, accepted_generation)
        assert producer.validate_read_matrix(
            matrix, seed, accepted_generation
        ) == matrix
        contract = producer.build_live_publication_contract(
            matrix, json.loads(json.dumps(matrix)), seed, accepted_generation
        )
        projection = producer.expected_publication_projection(accepted_generation)
        assert contract["projection"] == projection
        assert contract["projectionSha256"] == producer.compact_json_digest(projection)
        assert contract["slots"]["api_a"] == contract["slots"]["api_b"]

    exact = build_producer_read_matrix(producer, seed, generation)

    target_drift = json.loads(json.dumps(exact))
    target_drift["aliases"][0]["collection"] += "_drift"
    require_runtime_failure(
        lambda: producer.validate_read_matrix(target_drift, seed, generation),
        "alias target drift",
    )

    duplicate = json.loads(json.dumps(exact))
    duplicate["aliases"][-1] = json.loads(json.dumps(duplicate["aliases"][0]))
    require_runtime_failure(
        lambda: producer.validate_read_matrix(duplicate, seed, generation),
        "duplicate alias",
    )

    extra_alias = json.loads(json.dumps(exact))
    extra_alias["aliases"].append({"alias": "foreign", "collection": "foreign"})
    require_runtime_failure(
        lambda: producer.validate_read_matrix(extra_alias, seed, generation),
        "extra alias",
    )

    missing_alias = json.loads(json.dumps(exact))
    missing_alias["aliases"].pop()
    require_runtime_failure(
        lambda: producer.validate_read_matrix(missing_alias, seed, generation),
        "missing alias",
    )

    extra_collection = json.loads(json.dumps(exact))
    extra_collection["collections"].append("unused_collection")
    require_runtime_failure(
        lambda: producer.validate_read_matrix(extra_collection, seed, generation),
        "extra collection",
    )

    missing_collection = json.loads(json.dumps(exact))
    missing_collection["collections"].pop()
    require_runtime_failure(
        lambda: producer.validate_read_matrix(missing_collection, seed, generation),
        "missing collection",
    )

    next_matrix = build_producer_read_matrix(producer, seed, next_generation)
    require_runtime_failure(
        lambda: producer.validate_read_matrix(next_matrix, seed, generation),
        "coherent next generation",
    )

    slot_drift = json.loads(json.dumps(exact))
    slot_drift["collectionInfo"][0]["pointsCount"] += 1
    require_runtime_failure(
        lambda: producer.validate_matching_slot_matrices(
            exact, slot_drift, seed, generation
        ),
        "API slot drift",
    )


def build_fixture(root: Path, host_scope: str) -> tuple[Path, Path, dict[str, object]]:
    prefix = "diva_dr" if host_scope == "wsl-dr-standby" else "vocadb"
    qdrant_name = "diva_qdrant_standby" if host_scope == "wsl-dr-standby" else "vocadb_qdrant"
    prestate_path = root / "api-bridge-previous-api-prestate.receipt"
    previous_path = root / "api-bridge-previous-api-rollback.receipt"
    service_names = ("api_a", "api_b", "api_gateway", "web")
    old_container_ids = {name: str(index + 1) * 64 for index, name in enumerate(service_names)}
    old_image_ids = {name: f"sha256:{str(index + 5) * 64}" for index, name in enumerate(service_names)}
    old_config_hashes = {name: format(index + 10, "x") * 64 for index, name in enumerate(service_names)}
    bridge_container_ids = {
        "api_a": "8" * 64, "api_b": "c" * 64,
        "api_gateway": "d" * 64, "web": "e" * 64,
    }
    bridge_image_ids = {
        "api_a": f"sha256:{'9' * 64}", "api_b": f"sha256:{'9' * 64}",
        "api_gateway": f"sha256:{'a' * 64}", "web": f"sha256:{'b' * 64}",
    }
    bridge_config_hashes = {
        "api_a": "7" * 64, "api_b": "b" * 64,
        "api_gateway": "c" * 64, "web": "d" * 64,
    }
    pre_bridge_units = {
        name: {"active": active, "enabled": enabled, "load": "loaded", "sub": sub}
        for name, active, sub, enabled in (
            ("diva-wsl-dr-quick-tunnel.service", "active", "running", "enabled"),
            ("diva-wsl-dr-quick-tunnel-sync.service", "inactive", "dead", "static"),
            ("diva-wsl-dr-quick-tunnel-sync.timer", "active", "waiting", "enabled"),
            ("diva-wsl-dr-watchdog.service", "inactive", "dead", "static"),
            ("diva-wsl-dr-watchdog.timer", "active", "waiting", "enabled"),
        )
    }
    canonical_images = {
        kind: {
            "bridgeImageId": bridge_id,
            "previousImageId": f"sha256:{old_digit * 64}",
            "reference": f"legacy-{kind}:local",
            "rollbackTag": f"legacy-{kind}:rollback-contract",
        }
        for kind, bridge_id, old_digit in (
            ("api", f"sha256:{'9' * 64}", "1"),
            ("gateway", f"sha256:{'a' * 64}", "2"),
            ("web", f"sha256:{'b' * 64}", "3"),
        )
    }
    prestate_lines = ["schema\t2", "provenance\tlegacy-pre-contract-unattested"]
    for name in service_names:
        prestate_lines.append("\t".join((
            "service", name, f"{prefix}_{name}", f"{prefix}_{name}_before_contract",
            f"{prefix}_{name}_failed_contract", old_container_ids[name], old_image_ids[name],
            "legacy-api:old", old_config_hashes[name], f"legacy-api:rollback-{name}",
        )))
    for kind, contract in canonical_images.items():
        prestate_lines.append("\t".join((
            "canonical-image", kind, contract["reference"], contract["previousImageId"],
            contract["rollbackTag"],
        )))
    for name, state in pre_bridge_units.items():
        prestate_lines.append("\t".join((
            "unit", name, state["load"], state["active"], state["sub"], state["enabled"],
        )))
    prestate = ("\n".join(prestate_lines) + "\n").encode("utf-8")
    prestate_path.write_bytes(prestate)
    os.chmod(prestate_path, 0o600)
    previous_payload = {
        "bridgeApplication": {
            name: {
                "bridge": {
                    "configHash": bridge_config_hashes[name],
                    "containerId": bridge_container_ids[name],
                    "failedName": f"{prefix}_{name}_failed_contract",
                    "imageId": bridge_image_ids[name],
                    "imageReference": "bridge-api:candidate",
                },
                "canonicalName": f"{prefix}_{name}",
                "previous": {
                    "archiveName": f"{prefix}_{name}_before_contract",
                    "configHash": old_config_hashes[name],
                    "containerId": old_container_ids[name],
                    "imageId": old_image_ids[name],
                    "imageReference": "legacy-api:old",
                    "rollbackTag": f"legacy-api:rollback-{name}",
                },
            }
            for name in service_names
        },
        "bridgeProbeTokenSha256": "f" * 64,
        "canonicalImages": canonical_images,
        "deploymentId": "20260831T000000Z-contract",
        "preBridgePublicServiceState": pre_bridge_units,
        "prestate": {
            "path": str(prestate_path), "sha256": hashlib.sha256(prestate).hexdigest(),
        },
        "provenance": "legacy-pre-contract-unattested",
        "publicServiceState": pre_bridge_units,
        "recoveryPolicy": "old-api-old-q-pre-mutation-only",
        "schemaVersion": 3,
    }
    previous = canonical(previous_payload)
    previous_path.write_bytes(previous)
    os.chmod(previous_path, 0o600)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    compatibility = build_compatibility(3022)
    payload: dict[str, object] = {
        "apiSlots": {
            "api_a": {
                "clientPackageVersion": "1.19.0", "configHash": "7" * 64,
                "containerId": "8" * 64, "containerName": f"{prefix}_api_a",
                "imageId": f"sha256:{'9' * 64}", "sourceCommit": "a" * 40,
            },
            "api_b": {
                "clientPackageVersion": "1.19.0", "configHash": "b" * 64,
                "containerId": "c" * 64, "containerName": f"{prefix}_api_b",
                "imageId": f"sha256:{'9' * 64}", "sourceCommit": "a" * 40,
            },
        },
        "clientPackageVersion": "1.19.0",
        "compatibilityMatrix": compatibility,
        "compatibilityMatrixSha256": digest(compatibility),
        "createdAt": now.isoformat().replace("+00:00", "Z"),
        "deploymentId": "20260831T000000Z-contract",
        "helperSha256": hashlib.sha256(HELPER_PATH.read_bytes()).hexdigest(),
        "hostScope": host_scope,
        "mode": "qdrant-legacy-api-bridge",
        "oldQdrant": {
            "backup": (
                "off-host-evidence-sha256-" + "9" * 64
                if host_scope == "sbc-primary"
                else "qdrant-20260830T000000Z-1234abcd"
            ),
            "containerId": "d" * 64,
            "containerName": qdrant_name,
            "imageId": f"sha256:{'e' * 64}",
            "imageIndexDigest": "sha256:8f9011596cb03595a340cf2388083e36e38421eb49cb3fdc0ab7666cf14a90c1",
            "imageReference": "qdrant/qdrant:v1.9.4",
            "imageRepoDigest": f"sha256:{'f' * 64}",
            "publicationGeneration": "generation-42",
            "version": "1.9.4",
            "volume": {
                "createdAt": "2026-08-30T00:00:00Z", "driver": "local",
                "labelsSha256": "1" * 64, "mountpoint": "/var/lib/docker/volumes/legacy/_data",
                "mountpointDeviceInode": "2049:12345", "name": "legacy_qdrant_volume",
                "optionsSha256": "2" * 64, "scope": "local",
            },
        },
        "playerCommit": "a" * 40,
        "previousApiRollback": {
            "path": str(previous_path), "provenance": "legacy-pre-contract-unattested",
            "sha256": hashlib.sha256(previous).hexdigest(),
        },
        "schemaVersion": 3,
        "smoke": {
            "api_a": {"path": "retrieve-query-legacy-search-passed", "resultCount": 1},
            "api_b": {"path": "retrieve-query-legacy-search-passed", "resultCount": 2},
            "retrieveVectorDimensions": {"audio": 512, "meta": 384},
            "seedSongId": 3022,
        },
        "sourceManifestSha256": "3" * 64,
        "sourceSnapshotSha256": "4" * 64,
        "validOnlyWhileOldQExact": True,
        "validUntil": (now + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
    }
    payload["payloadSha256"] = hashlib.sha256(canonical(payload)).hexdigest()
    receipt_path = root / "api-bridge-receipt.json"
    receipt_path.write_bytes(canonical(payload))
    os.chmod(receipt_path, 0o600)
    return receipt_path, previous_path, payload


def convert_sbc_fixture_to_stateless_schema2(
    receipt_path: Path,
    previous_path: Path,
    payload: dict[str, object],
) -> dict[str, object]:
    """Replace the legacy JSON test sidecar with the exact SBC schema-2 form."""
    rows = [
        "schema\t2",
        "provenance\tlegacy-pre-contract-unattested",
        "\t".join((
            "api_a", "vocadb_api_a", "diva_api_a_previous_contract",
            "1" * 64, f"sha256:{'5' * 64}", "legacy-api:old",
            "a" * 64, "diva-player-api:bridge-rollback-api-a-contract",
        )),
        "\t".join((
            "api_b", "vocadb_api_b", "diva_api_b_previous_contract",
            "2" * 64, f"sha256:{'6' * 64}", "legacy-api:old",
            "b" * 64, "diva-player-api:bridge-rollback-api-b-contract",
        )),
        "\t".join(("scan", "api", f"sha256:{'9' * 64}", "1" * 64)),
        "\t".join(("scan", "gateway", f"sha256:{'a' * 64}", "2" * 64)),
        "\t".join(("scan", "web", f"sha256:{'b' * 64}", "3" * 64)),
        "\t".join((
            "stateless", "api_gateway", "vocadb_api_gateway", "d" * 64,
            f"sha256:{'a' * 64}", "diva-player-api-gateway:candidate-contract",
            "c" * 64,
        )),
        "\t".join((
            "stateless", "web", "vocadb_web", "e" * 64,
            f"sha256:{'b' * 64}", "diva-player-web:candidate-contract", "d" * 64,
        )),
    ]
    previous = ("\n".join(rows) + "\n").encode("utf-8")
    previous_path.write_bytes(previous)
    os.chmod(previous_path, 0o600)
    updated = json.loads(json.dumps(payload))
    updated["previousApiRollback"]["sha256"] = hashlib.sha256(previous).hexdigest()
    updated["payloadSha256"] = digest({
        key: value for key, value in updated.items() if key != "payloadSha256"
    })
    receipt_path.write_bytes(canonical(updated))
    os.chmod(receipt_path, 0o600)
    return updated


def main() -> int:
    helper = load_helper()
    producer = load_producer()
    test_live_publication_binding(producer)
    with tempfile.TemporaryDirectory(prefix="diva-wsl-dr-api-bridge-receipt.") as temporary:
        root = Path(temporary)
        for host_scope in ("wsl-dr-standby", "sbc-primary"):
            fixture = root / host_scope
            fixture.mkdir()
            receipt, previous, payload = build_fixture(fixture, host_scope)
            if host_scope == "sbc-primary":
                payload = convert_sbc_fixture_to_stateless_schema2(
                    receipt, previous, payload
                )
            assert helper.read_receipt(receipt, require_trusted_metadata=False) == payload
            previous_payload = helper.read_previous_api_rollback(
                payload, require_trusted_metadata=False
            )
            assert set(previous_payload["apiSlots"]) == {"api_a", "api_b"}
            if host_scope == "sbc-primary":
                assert previous_payload["schemaVersion"] == 2
                assert set(previous_payload["scanReceipts"]) == {
                    "api", "gateway", "web",
                }
                assert set(previous_payload["statelessServices"]) == {
                    "api_gateway", "web",
                }
            else:
                assert previous_payload["schemaVersion"] == 3
                assert set(previous_payload["bridgeApplication"]) == {
                    "api_a", "api_b", "api_gateway", "web",
                }
            command = [
                sys.executable, "-I", str(HELPER_PATH), "--path", str(receipt),
                "--allow-current-owner-for-test", "--expect-host-scope", host_scope,
                "--require-fresh", "--verify-previous-api-rollback",
            ]
            result = subprocess.run(command, check=False, text=True, capture_output=True, timeout=15)
            assert result.returncode == 0, result.stderr
            output = json.loads(result.stdout)
            assert output["receipt"] == payload
            assert output["previousApiRollback"] == previous_payload

            if host_scope == "sbc-primary":
                invalid_backup = json.loads(receipt.read_text(encoding="utf-8"))
                invalid_backup["oldQdrant"]["backup"] = "qdrant-20260830T000000Z-1234abcd"
                invalid_backup["payloadSha256"] = digest({
                    key: value for key, value in invalid_backup.items()
                    if key != "payloadSha256"
                })
                receipt.write_bytes(canonical(invalid_backup))
                try:
                    helper.read_receipt(receipt, require_trusted_metadata=False)
                except helper.ReceiptError:
                    pass
                else:
                    raise AssertionError("SBC receipt accepted a non-attested backup label")
                receipt.write_bytes(canonical(payload))

            expired = json.loads(receipt.read_text(encoding="utf-8"))
            expired_created = (
                datetime.fromisoformat(str(payload["createdAt"]).replace("Z", "+00:00"))
                - timedelta(hours=25)
            )
            expired["createdAt"] = expired_created.isoformat().replace("+00:00", "Z")
            expired["validUntil"] = (
                expired_created + timedelta(hours=24)
            ).isoformat().replace("+00:00", "Z")
            expired["payloadSha256"] = digest({
                key: value for key, value in expired.items() if key != "payloadSha256"
            })
            receipt.write_bytes(canonical(expired))
            no_fresh = subprocess.run(
                [part for part in command if part != "--require-fresh"],
                check=False,
                text=True,
                capture_output=True,
                timeout=15,
            )
            assert no_fresh.returncode == 0, no_fresh.stderr
            requires_fresh = subprocess.run(
                command, check=False, text=True, capture_output=True, timeout=15
            )
            assert requires_fresh.returncode != 0
            receipt.write_bytes(canonical(payload))

            raw = receipt.read_bytes()
            tampered = json.loads(raw)
            tampered["smoke"]["api_a"]["resultCount"] = 3
            receipt.write_bytes(canonical(tampered))
            try:
                helper.read_receipt(receipt, require_trusted_metadata=False)
            except helper.ReceiptError:
                pass
            else:
                raise AssertionError("tampered bridge receipt was accepted")
            receipt.write_bytes(raw)
            tampered = json.loads(raw)
            tampered["compatibilityMatrix"]["endpoints"]["similar"]["songIds"] = [9999]
            tampered["payloadSha256"] = digest({
                key: value for key, value in tampered.items() if key != "payloadSha256"
            })
            receipt.write_bytes(canonical(tampered))
            try:
                helper.read_receipt(receipt, require_trusted_metadata=False)
            except helper.ReceiptError:
                pass
            else:
                raise AssertionError("rehashed tampered compatibility matrix was accepted")
            receipt.write_bytes(raw)
            if host_scope == "sbc-primary":
                previous_raw = previous.read_bytes()
                semantic_tamper = previous_raw.replace(
                    f"scan\tgateway\tsha256:{'a' * 64}".encode("ascii"),
                    f"scan\tgateway\tsha256:{'c' * 64}".encode("ascii"),
                )
                assert semantic_tamper != previous_raw
                previous.write_bytes(semantic_tamper)
                rehashed = json.loads(raw)
                rehashed["previousApiRollback"]["sha256"] = hashlib.sha256(
                    semantic_tamper
                ).hexdigest()
                rehashed["payloadSha256"] = digest({
                    key: value for key, value in rehashed.items()
                    if key != "payloadSha256"
                })
                receipt.write_bytes(canonical(rehashed))
                rehashed_payload = helper.read_receipt(
                    receipt, require_trusted_metadata=False
                )
                try:
                    helper.read_previous_api_rollback(
                        rehashed_payload, require_trusted_metadata=False
                    )
                except helper.ReceiptError:
                    pass
                else:
                    raise AssertionError(
                        "rehashed stateless scan/image mismatch was accepted"
                    )
                previous.write_bytes(previous_raw)
                receipt.write_bytes(raw)
            previous.write_bytes(previous.read_bytes() + b"tamper\n")
            try:
                helper.read_previous_api_rollback(payload, require_trusted_metadata=False)
            except helper.ReceiptError:
                pass
            else:
                raise AssertionError("tampered previous API rollback receipt was accepted")

        symlink_source = root / "symlink-source"
        symlink_source.mkdir()
        source, _, _ = build_fixture(symlink_source, "wsl-dr-standby")
        link = root / "receipt-link"
        try:
            link.symlink_to(source)
        except OSError:
            # Non-elevated Windows commonly disables symlink creation; the
            # actual Linux/WSL fixture always executes this negative case.
            if os.name != "nt":
                raise
        else:
            try:
                helper.read_receipt(link, require_trusted_metadata=False)
            except helper.ReceiptError:
                pass
            else:
                raise AssertionError("symlink bridge receipt was accepted")

    print("PASS WSL/SBC Qdrant API bridge receipt contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
