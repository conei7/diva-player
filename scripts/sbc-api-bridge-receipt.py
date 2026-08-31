#!/usr/bin/env python3
"""Produce one exact SBC legacy-Qdrant API bridge receipt.

This helper is invoked only by deploy-sbc-api-rolling.sh's explicit one-time
bootstrap mode.  It performs read-only semantic probes through the existing
gateway container, consumes one-shot per-API tokens, and writes prepared
evidence below the run directory.  Publication of the canonical receipt is
left to the shell's durable no-overwrite state transition.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


HEX64 = re.compile(r"^[0-9a-f]{64}$")
ID64 = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")
GENERATION = re.compile(r"^[0-9a-f]{64}:[0-9a-f]{32}$")
TOKEN_PATH = "/tmp/.diva-qdrant-bridge-probe-token"
INDEX_DIGEST = "sha256:8f9011596cb03595a340cf2388083e36e38421eb49cb3fdc0ab7666cf14a90c1"
REQUIRED_ALIAS_NAMES = (
    "song_hybrid_active",
    "song_metadata_active",
    "songs_v2_active",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True,
                       separators=(",", ":")) + "\n").encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def compact_json_digest(value: Any) -> str:
    """Match the backup contract's newline-free canonical projection hash."""
    encoded = json.dumps(
        value, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def file_sha(path: Path) -> str:
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
            f"unsafe evidence file: {path}")
    data = path.read_bytes()
    after = path.lstat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
            f"evidence changed while hashing: {path}")
    return hashlib.sha256(data).hexdigest()


def run(command: list[str], *, stdin: bytes | None = None,
        check: bool = True, timeout: int = 60) -> bytes:
    result = subprocess.run(
        command, input=stdin, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=timeout,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"command failed ({result.returncode}): {command!r}: "
            f"{result.stderr.decode('utf-8', 'replace')[:1000]}"
        )
    return result.stdout


def inspect(docker: str, target: str, template: str) -> str:
    value = run([docker, "inspect", "--format", template, target], timeout=30)
    return value.decode("utf-8").strip()


def image_inspect(docker: str, target: str, template: str) -> str:
    value = run([docker, "image", "inspect", "--format", template, target], timeout=30)
    return value.decode("utf-8").strip()


def docker_json(docker: str, arguments: list[str]) -> Any:
    return json.loads(run([docker, *arguments], timeout=30))


def fetch_json(docker: str, gateway: str, url: str, *, token: str = "",
               body: str | None = None) -> Any:
    command = [docker, "exec", gateway, "wget", "-q", "-T", "30", "-O", "-"]
    if token:
        command += [f"--header=X-Diva-Qdrant-Bridge-Token: {token}"]
    if body is not None:
        command += ["--header=Content-Type: application/json", f"--post-data={body}"]
    raw = run([*command, url], timeout=45)
    require(0 < len(raw) <= 1024 * 1024, f"invalid response size from {url}")
    payload = json.loads(raw)
    require(isinstance(payload, dict), f"non-object response from {url}")
    return payload


def install_token(docker: str, container: str, token: str) -> None:
    user = inspect(docker, container, "{{.Config.User}}")
    require(bool(user) and user not in {"0", "0:0"}, "API container is not rootless")
    script = (
        "set -eu; umask 077; test ! -e '" + TOKEN_PATH + "'; "
        "IFS= read -r token; case \"$token\" in ''|*[!0-9a-f]* ) exit 2;; esac; "
        "test \"${#token}\" -eq 64; printf '%s' \"$token\" > '" + TOKEN_PATH + "'; "
        "chmod 600 '" + TOKEN_PATH + "'; test \"$(stat -c '%a' '" + TOKEN_PATH + "')\" = 600"
    )
    run([docker, "exec", "-i", "--user", user, container, "/bin/sh", "-ec", script],
        stdin=(token + "\n").encode("ascii"), timeout=30)


def token_absent(docker: str, container: str) -> bool:
    result = subprocess.run(
        [docker, "exec", container, "/bin/sh", "-ec", f"test ! -e '{TOKEN_PATH}'"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        check=False, timeout=30,
    )
    return result.returncode == 0


def select_seed(docker: str, gateway: str) -> tuple[int, str]:
    names = ("songs_v2_active", "song_hybrid_active", "song_metadata_active", "song_audio")
    rows: dict[str, list[int]] = {}
    for name in names:
        payload = fetch_json(
            docker, gateway, f"http://qdrant:6333/collections/{name}/points/scroll",
            body='{"limit":64,"with_payload":false,"with_vector":false}',
        )
        result = payload.get("result")
        require(isinstance(result, dict) and isinstance(result.get("points"), list),
                f"invalid legacy Qdrant seed response for {name}")
        values = sorted({row.get("id") for row in result["points"]
                         if isinstance(row, dict) and isinstance(row.get("id"), int)})
        require(values and len(values) <= 64 and values[0] > 0,
                f"invalid seed IDs for {name}")
        rows[name] = values
    common = sorted(set.intersection(*(set(value) for value in rows.values())))
    require(common, "legacy Qdrant collections have no common seed")
    return common[0], digest({"collectionPointIds": rows, "intersection": common})


def endpoint_semantics(payload: dict[str, Any], *, dig: bool = False) -> dict[str, Any]:
    items = payload.get("items")
    require(isinstance(items, list) and 1 <= len(items) <= 100, "endpoint items are invalid")
    require(payload.get("error") in (None, ""), "endpoint returned an error")
    ids: list[int] = []
    for item in items:
        require(isinstance(item, dict), "endpoint item is invalid")
        value = item.get("songId", item.get("id"))
        if value is None and isinstance(item.get("song"), dict):
            value = item["song"].get("id")
        require(isinstance(value, int) and value > 0, "endpoint song ID is invalid")
        ids.append(value)
    result = {
        "itemCount": len(ids), "responseKeys": sorted(payload),
        "responseSha256": digest(payload), "songIds": ids,
    }
    if dig:
        require(isinstance(payload.get("totalCount"), int)
                and payload["totalCount"] >= len(ids), "dig total is invalid")
        result["totalCount"] = payload["totalCount"]
    return result


def expected_publication_projection(generation: str) -> dict[str, Any]:
    if generation == "legacy":
        aliases = {
            "song_hybrid_active": "song_hybrid",
            "song_metadata_active": "song_metadata",
            "songs_v2_active": "songs_v2",
        }
    else:
        require(GENERATION.fullmatch(generation) is not None,
                "publication generation is invalid")
        basis_id, build_id = generation.split(":", 1)
        suffix = f"{basis_id[:12]}_{build_id[:8]}"
        aliases = {
            "song_hybrid_active": f"song_hybrid_basis_{suffix}",
            "song_metadata_active": f"song_metadata_basis_{suffix}",
            "songs_v2_active": f"songs_v2_basis_{suffix}",
        }
    return {
        "aliases": aliases,
        "collections": sorted({"song_audio", *aliases.values()}),
        "generation": generation,
    }


def validate_read_matrix(
    matrix: Any,
    seed: int,
    publication_generation: str,
) -> dict[str, Any]:
    require(isinstance(matrix, dict) and set(matrix) == {
        "aliases", "collectionInfo", "collections", "operations", "schemaVersion", "seedSongId"
    }, "read matrix schema is invalid")
    require(matrix["schemaVersion"] == 1 and matrix["seedSongId"] == seed,
            "read matrix identity is invalid")
    expected = {
        "named-audio": ("songs_v2_active", "audio"),
        "named-meta": ("songs_v2_active", "meta"),
        "hybrid-default": ("song_hybrid_active", "default"),
        "metadata-default": ("song_metadata_active", "default"),
        "audio-default": ("song_audio", "default"),
    }
    operations = matrix.get("operations")
    require(isinstance(operations, list)
            and [row.get("operation") for row in operations if isinstance(row, dict)]
            == list(expected), "read matrix operations are invalid")
    for row in operations:
        require(set(row) == {"collection", "hits", "operation", "payloadKeys", "queryPath",
                             "vectorDimensions", "vectorName", "withoutPayloadFieldCount"},
                "read operation schema is invalid")
        collection, vector = expected[row["operation"]]
        require(row["collection"] == collection and row["vectorName"] == vector
                and row["queryPath"] == "legacy-search-fallback"
                and isinstance(row["vectorDimensions"], int) and row["vectorDimensions"] > 0
                and row["withoutPayloadFieldCount"] == 0,
                "read operation contract is invalid")
    info = matrix.get("collectionInfo")
    require(isinstance(info, list) and {row.get("collection") for row in info}
            == {"song_audio", "song_hybrid_active", "song_metadata_active", "songs_v2_active"}
            and all(str(row.get("status", "")).lower() == "green"
                    and isinstance(row.get("pointsCount"), int) and row["pointsCount"] > 0
                    for row in info), "collection health matrix is invalid")
    expected_projection = expected_publication_projection(publication_generation)
    aliases = matrix.get("aliases")
    require(isinstance(aliases, list) and len(aliases) == len(REQUIRED_ALIAS_NAMES),
            "alias inventory is not exact")
    observed_aliases: dict[str, str] = {}
    for row in aliases:
        require(isinstance(row, dict) and set(row) == {"alias", "collection"},
                "alias row schema is invalid")
        alias = row.get("alias")
        collection = row.get("collection")
        require(isinstance(alias, str) and alias
                and isinstance(collection, str) and collection,
                "alias row value is invalid")
        require(alias not in observed_aliases, "duplicate alias is invalid")
        observed_aliases[alias] = collection
    require(observed_aliases == expected_projection["aliases"],
            "live aliases do not match the backed-up publication generation")
    collections = matrix.get("collections")
    require(isinstance(collections, list)
            and all(isinstance(value, str) and value for value in collections)
            and collections == expected_projection["collections"],
            "live collection inventory does not match the backed-up publication generation")
    return matrix


def validate_matching_slot_matrices(
    slot_a: Any,
    slot_b: Any,
    seed: int,
    publication_generation: str,
) -> dict[str, Any]:
    validated_a = validate_read_matrix(slot_a, seed, publication_generation)
    validated_b = validate_read_matrix(slot_b, seed, publication_generation)
    require(canonical(validated_a) == canonical(validated_b),
            "API A/B live publication matrices differ")
    return validated_a


def probe_read_matrix(
    docker: str,
    gateway: str,
    container: str,
    service: str,
    seed: int,
    publication_generation: str,
) -> dict[str, Any]:
    token = secrets.token_hex(32)
    install_token(docker, container, token)
    try:
        matrix = validate_read_matrix(fetch_json(
            docker, gateway,
            f"http://{service}:5000/api/internal/qdrant-compatibility-matrix?seedSongId={seed}",
            token=token,
        ), seed, publication_generation)
        require(token_absent(docker, container), "one-shot compatibility token was retained")
        return matrix
    finally:
        if not token_absent(docker, container):
            run([docker, "exec", container, "/bin/rm", "-f", TOKEN_PATH], check=False)


def probe_slot(docker: str, gateway: str, container: str, service: str,
               seed: int, publication_generation: str) -> dict[str, Any]:
    matrix = probe_read_matrix(
        docker, gateway, container, service, seed, publication_generation,
    )
    endpoints: dict[str, Any] = {}
    for name in ("recommend", "similar", "metadata", "audio", "multi", "dig"):
        body = None
        if name == "recommend":
            url = f"http://{service}:5000/api/recommend?songId={seed}&count=3&offset=0&sessionProgress=0"
        elif name in {"similar", "metadata", "audio"}:
            url = f"http://{service}:5000/api/recommend/{name}?songId={seed}&count=3&offset=0"
        elif name == "multi":
            url = f"http://{service}:5000/api/recommend/multi"
            body = json.dumps({"seeds": [{"songId": seed, "weight": 1.0}], "count": 3,
                               "sessionProgress": 0.0, "excludeSongIds": [], "offset": 0},
                              separators=(",", ":"))
        else:
            url = f"http://{service}:5000/api/recommend/dig"
            body = json.dumps({"seeds": [{"songId": seed, "weight": 1.0}], "count": 3,
                               "offset": 0, "generationSeed": 0, "excludeSongIds": [],
                               "vocalistMatchMode": "Any"}, separators=(",", ":"))
        endpoints[name] = endpoint_semantics(
            fetch_json(docker, gateway, url, body=body), dig=name == "dig"
        )
    return {"endpoints": endpoints, "readMatrix": matrix,
            "schemaVersion": 1, "seedSongId": seed}


def build_live_publication_contract(
    slot_a: Any,
    slot_b: Any,
    seed: int,
    publication_generation: str,
) -> dict[str, Any]:
    matrix = validate_matching_slot_matrices(
        slot_a, slot_b, seed, publication_generation,
    )
    projection = expected_publication_projection(publication_generation)
    read_matrix_sha = digest(matrix)
    return {
        "kind": "diva.sbc-api-bridge-live-publication.v1",
        "projection": projection,
        "projectionSha256": compact_json_digest(projection),
        "readMatrixSha256": read_matrix_sha,
        "schemaVersion": 1,
        "slots": {"api_a": read_matrix_sha, "api_b": read_matrix_sha},
    }


def verify_live_publication(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="sbc-api-bridge-receipt.py verify-live-publication"
    )
    parser.add_argument("--docker", required=True)
    parser.add_argument("--gateway-id", required=True)
    parser.add_argument("--api-a-id", required=True)
    parser.add_argument("--api-b-id", required=True)
    parser.add_argument("--publication-generation", required=True)
    args = parser.parse_args(argv)
    for value in (args.gateway_id, args.api_a_id, args.api_b_id):
        require(ID64.fullmatch(value) is not None, "container ID is invalid")
    expected_publication_projection(args.publication_generation)
    seed, _ = select_seed(args.docker, args.gateway_id)
    slot_a = probe_read_matrix(
        args.docker, args.gateway_id, args.api_a_id, "api_a", seed,
        args.publication_generation,
    )
    slot_b = probe_read_matrix(
        args.docker, args.gateway_id, args.api_b_id, "api_b", seed,
        args.publication_generation,
    )
    contract = build_live_publication_contract(
        slot_a, slot_b, seed, args.publication_generation,
    )
    os.sys.stdout.buffer.write(canonical(contract))
    return 0


def write_exclusive(path: Path, data: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        offset = 0
        while offset < len(data):
            offset += os.write(descriptor, data[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--docker", required=True)
    parser.add_argument("--gateway-id", required=True)
    parser.add_argument("--web-id", required=True)
    parser.add_argument("--api-a-id", required=True)
    parser.add_argument("--api-b-id", required=True)
    parser.add_argument("--old-api-a-id", required=True)
    parser.add_argument("--old-api-b-id", required=True)
    parser.add_argument("--qdrant-id", required=True)
    parser.add_argument("--deployment-id", required=True)
    parser.add_argument("--player-commit", required=True)
    parser.add_argument("--source-entries", required=True, type=Path)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--source-snapshot-sha256", required=True)
    parser.add_argument("--backup-binding", required=True)
    parser.add_argument("--publication-generation", required=True)
    parser.add_argument("--api-a-rollback-tag", required=True)
    parser.add_argument("--api-b-rollback-tag", required=True)
    parser.add_argument("--api-scan-receipt", required=True, type=Path)
    parser.add_argument("--api-scan-receipt-sha256", required=True)
    parser.add_argument("--gateway-scan-receipt", required=True, type=Path)
    parser.add_argument("--gateway-scan-receipt-sha256", required=True)
    parser.add_argument("--web-scan-receipt", required=True, type=Path)
    parser.add_argument("--web-scan-receipt-sha256", required=True)
    parser.add_argument("--previous-output", required=True, type=Path)
    parser.add_argument("--receipt-output", required=True, type=Path)
    args = parser.parse_args()
    for value in (args.gateway_id, args.web_id, args.api_a_id, args.api_b_id, args.old_api_a_id,
                   args.old_api_b_id, args.qdrant_id):
        require(ID64.fullmatch(value) is not None, "container ID is invalid")
    require(re.fullmatch(r"[0-9a-f]{40}", args.player_commit) is not None,
            "player commit is invalid")
    require(HEX64.fullmatch(args.source_snapshot_sha256) is not None,
            "source snapshot SHA is invalid")
    require(re.fullmatch(r"off-host-evidence-sha256-[0-9a-f]{64}", args.backup_binding)
            is not None, "backup binding is invalid")
    scan_receipts = {
        "api": (args.api_scan_receipt, args.api_scan_receipt_sha256),
        "gateway": (args.gateway_scan_receipt, args.gateway_scan_receipt_sha256),
        "web": (args.web_scan_receipt, args.web_scan_receipt_sha256),
    }
    for service, (path, expected_sha) in scan_receipts.items():
        require(HEX64.fullmatch(expected_sha) is not None,
                f"{service} scan receipt SHA is invalid")
        require(file_sha(path) == expected_sha,
                f"{service} scan receipt changed before bridge preparation")
    helper = args.source_root / "scripts" / "wsl-dr-api-bridge-receipt.py"
    helper_sha = file_sha(helper)
    source_manifest_sha = file_sha(args.source_entries)

    qdrant_image = inspect(args.docker, args.qdrant_id, "{{.Image}}")
    qdrant_reference = inspect(args.docker, args.qdrant_id, "{{.Config.Image}}")
    require(image_inspect(args.docker, qdrant_image, "{{.Os}}|{{.Architecture}}") == "linux|arm64",
            "old Qdrant image is not linux/arm64")
    repo_digests = json.loads(image_inspect(args.docker, qdrant_image, "{{json .RepoDigests}}"))
    matches = [value.split("@", 1)[1] for value in repo_digests
               if isinstance(value, str) and value.startswith("qdrant/qdrant@sha256:")]
    require(len(matches) == 1, "old Qdrant RepoDigest is ambiguous")
    version = run([args.docker, "exec", args.qdrant_id, "/qdrant/qdrant", "--version"],
                  timeout=30).decode("utf-8", "replace")
    require(re.search(r"(?:^|\s)1\.9\.4(?:\s|$)", version) is not None,
            "old Qdrant is not version 1.9.4")
    container_document = docker_json(args.docker, ["inspect", args.qdrant_id])
    require(isinstance(container_document, list) and len(container_document) == 1,
            "old Qdrant inspect is invalid")
    mounts = [row for row in container_document[0].get("Mounts", [])
              if row.get("Type") == "volume" and row.get("Destination") == "/qdrant/storage"]
    require(len(mounts) == 1 and isinstance(mounts[0].get("Name"), str),
            "old Qdrant named volume is invalid")
    volume_name = mounts[0]["Name"]
    volume_rows = docker_json(args.docker, ["volume", "inspect", volume_name])
    require(isinstance(volume_rows, list) and len(volume_rows) == 1,
            "old Qdrant volume inspect is invalid")
    volume = volume_rows[0]
    device_inode = run([args.docker, "exec", args.qdrant_id, "stat", "-c", "%d:%i",
                        "/qdrant/storage"], timeout=30).decode().strip()
    # Preserve Docker's exact Go-template JSON bytes.  The hardener independently
    # re-reads these projections and hashes the same newline-terminated output;
    # re-serializing the parsed object here would create a second, weaker
    # canonicalization contract.
    labels_raw = run([
        args.docker, "volume", "inspect", "--format", "{{json .Labels}}", volume_name,
    ], timeout=30).decode("utf-8").rstrip("\r\n")
    options_raw = run([
        args.docker, "volume", "inspect", "--format", "{{json .Options}}", volume_name,
    ], timeout=30).decode("utf-8").rstrip("\r\n")
    require(json.loads(labels_raw) == volume.get("Labels"),
            "Qdrant volume labels changed between inspect projections")
    require(json.loads(options_raw) == volume.get("Options"),
            "Qdrant volume options changed between inspect projections")

    seed, selection_sha = select_seed(args.docker, args.gateway_id)
    expected_publication_projection(args.publication_generation)
    slot_a = probe_slot(
        args.docker, args.gateway_id, args.api_a_id, "api_a", seed,
        args.publication_generation,
    )
    slot_b = probe_slot(
        args.docker, args.gateway_id, args.api_b_id, "api_b", seed,
        args.publication_generation,
    )
    require(canonical(slot_a) == canonical(slot_b), "API A/B semantics differ")
    read_hash = digest(slot_a["readMatrix"])
    endpoint_hash = digest(slot_a["endpoints"])
    semantic_hash = digest(slot_a)
    compatibility = {
        "endpoints": slot_a["endpoints"], "endpointResponsesSha256": endpoint_hash,
        "readMatrix": slot_a["readMatrix"], "readMatrixSha256": read_hash,
        "requiredQueryPath": "legacy-search-fallback", "schemaVersion": 1,
        "seedSelection": {"collectionNames": ["song_audio", "song_hybrid_active",
                                                "song_metadata_active", "songs_v2_active"],
                          "scanLimit": 64, "sha256": selection_sha},
        "seedSongId": seed, "semanticSha256": semantic_hash,
        "slots": {name: {"endpointResponsesSha256": endpoint_hash,
                          "readMatrixSha256": read_hash, "semanticSha256": semantic_hash}
                  for name in ("api_a", "api_b")},
    }
    compatibility_sha = digest(compatibility)

    def container_fact(container: str, name: str) -> dict[str, str]:
        image_id = inspect(args.docker, container, "{{.Image}}")
        require(image_inspect(args.docker, image_id, "{{.Os}}|{{.Architecture}}") == "linux|arm64",
                f"{name} image is not linux/arm64")
        config = inspect(args.docker, container,
                         '{{index .Config.Labels "com.docker.compose.config-hash"}}')
        require(HEX64.fullmatch(config) is not None, f"{name} config hash is invalid")
        return {"container": container, "image": image_id, "config": config,
                "reference": inspect(args.docker, container, "{{.Config.Image}}")}

    current = {"api_a": container_fact(args.api_a_id, "api_a"),
               "api_b": container_fact(args.api_b_id, "api_b")}
    previous = {"api_a": container_fact(args.old_api_a_id, "old api_a"),
                "api_b": container_fact(args.old_api_b_id, "old api_b")}
    stateless = {
        "api_gateway": container_fact(args.gateway_id, "api_gateway"),
        "web": container_fact(args.web_id, "web"),
    }
    previous_lines = ["schema\t2", "provenance\tlegacy-pre-contract-unattested"]
    for name, rollback in (("api_a", args.api_a_rollback_tag),
                           ("api_b", args.api_b_rollback_tag)):
        fact = previous[name]
        archive = f"diva_{name}_previous_{args.deployment_id}"
        previous_lines.append("\t".join([
            name, f"vocadb_{name}", archive, fact["container"], fact["image"],
            fact["reference"], fact["config"], rollback,
        ]))
    scan_images = {
        "api": current["api_a"]["image"],
        "gateway": stateless["api_gateway"]["image"],
        "web": stateless["web"]["image"],
    }
    for service in ("api", "gateway", "web"):
        previous_lines.append("\t".join([
            "scan", service, scan_images[service], scan_receipts[service][1],
        ]))
    for service in ("api_gateway", "web"):
        fact = stateless[service]
        previous_lines.append("\t".join([
            "stateless", service, f"vocadb_{service}", fact["container"],
            fact["image"], fact["reference"], fact["config"],
        ]))
    write_exclusive(args.previous_output, ("\n".join(previous_lines) + "\n").encode())
    previous_sha = file_sha(args.previous_output)

    operations = {row["operation"]: row for row in compatibility["readMatrix"]["operations"]}
    similar_count = compatibility["endpoints"]["similar"]["itemCount"]
    created = datetime.now(timezone.utc).replace(microsecond=0)
    valid_until = created + timedelta(hours=24)
    payload: dict[str, Any] = {
        "apiSlots": {
            name: {"clientPackageVersion": "1.19.0", "configHash": current[name]["config"],
                   "containerId": current[name]["container"], "containerName": f"vocadb_{name}",
                   "imageId": current[name]["image"], "sourceCommit": args.player_commit}
            for name in ("api_a", "api_b")
        },
        "clientPackageVersion": "1.19.0", "compatibilityMatrix": compatibility,
        "compatibilityMatrixSha256": compatibility_sha,
        "createdAt": created.isoformat().replace("+00:00", "Z"),
        "deploymentId": args.deployment_id, "helperSha256": helper_sha,
        "hostScope": "sbc-primary", "mode": "qdrant-legacy-api-bridge",
        "oldQdrant": {
            "backup": args.backup_binding, "containerId": args.qdrant_id,
            "containerName": "vocadb_qdrant", "imageId": qdrant_image,
            "imageIndexDigest": INDEX_DIGEST, "imageReference": qdrant_reference,
            "imageRepoDigest": matches[0], "publicationGeneration": args.publication_generation,
            "version": "1.9.4",
            "volume": {"createdAt": volume.get("CreatedAt"), "driver": volume.get("Driver"),
                       "labelsSha256": hashlib.sha256((labels_raw + "\n").encode()).hexdigest(),
                       "mountpoint": volume.get("Mountpoint"),
                       "mountpointDeviceInode": device_inode, "name": volume_name,
                       "optionsSha256": hashlib.sha256((options_raw + "\n").encode()).hexdigest(),
                       "scope": volume.get("Scope")},
        },
        "playerCommit": args.player_commit,
        "previousApiRollback": {"path": str(args.previous_output),
                                "provenance": "legacy-pre-contract-unattested",
                                "sha256": previous_sha},
        "schemaVersion": 3,
        "smoke": {"api_a": {"path": "retrieve-query-legacy-search-passed",
                              "resultCount": similar_count},
                  "api_b": {"path": "retrieve-query-legacy-search-passed",
                              "resultCount": similar_count},
                  "retrieveVectorDimensions": {
                      "audio": operations["named-audio"]["vectorDimensions"],
                      "meta": operations["named-meta"]["vectorDimensions"]},
                  "seedSongId": seed},
        "sourceManifestSha256": source_manifest_sha,
        "sourceSnapshotSha256": args.source_snapshot_sha256,
        "validOnlyWhileOldQExact": True,
        "validUntil": valid_until.isoformat().replace("+00:00", "Z"),
    }
    payload["payloadSha256"] = hashlib.sha256(canonical(payload)).hexdigest()
    write_exclusive(args.receipt_output, canonical(payload))
    return 0


if __name__ == "__main__":
    try:
        if len(os.sys.argv) > 1 and os.sys.argv[1] == "verify-live-publication":
            raise SystemExit(verify_live_publication(os.sys.argv[2:]))
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError, json.JSONDecodeError) as error:
        print(f"SBC bridge receipt: {error}", file=os.sys.stderr)
        raise SystemExit(1)
