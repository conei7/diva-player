#!/usr/bin/env python3
"""Publish the runtime contract after a completed forward recovery.

This is a read-heavy recovery path for the case where the stateful hardener
already promoted its candidate images and the forward-recovery record is
complete, but the final promotion/contract files were not published.  It
never starts, stops, retags, removes, or recreates a Docker object.  Every
proof is checked before any file is written; the final contract and promotion
manifest are created with exclusive, fsynced writes and are idempotent.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


STATE_ROOT = Path("/var/lib/diva-player-deploy")
PLAYER_ROOT = Path("/home/orangepi/diva-player")
PIPELINE_ROOT = Path("/home/orangepi/diva-data-pipeline")
COMPOSE_FILE = PLAYER_ROOT / "backend/docker-compose.yml"
BACKEND_ENV = PLAYER_ROOT / "backend/.env"
CONSUMPTION_HELPER = PLAYER_ROOT / "scripts/sbc-api-bridge-consumption.py"
RUN_ID_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9]+$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")


class FinalizationError(RuntimeError):
    pass


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True,
                       separators=(",", ":")) + "\n").encode("utf-8")


def regular(path: Path, *, mode: int = 0o600, links: set[int] | None = None,
            maximum: int = 64 * 1024 * 1024) -> bytes:
    links = {1} if links is None else links
    try:
        info = path.lstat()
    except OSError as error:
        raise FinalizationError(f"required evidence is unavailable: {path}") from error
    if (not path.is_file() or path.is_symlink() or info.st_nlink not in links
            or info.st_size <= 0 or info.st_size > maximum
            or (os.name != "nt" and (info.st_mode & 0o777) != mode)
            or (os.name != "nt" and (info.st_uid != 0 or info.st_gid != 0))):
        raise FinalizationError(f"unsafe evidence file: {path}")
    raw = path.read_bytes()
    if len(raw) != info.st_size:
        raise FinalizationError(f"evidence changed while reading: {path}")
    return raw


def read_json(path: Path, *, mode: int = 0o600,
              canonical_required: bool = True) -> tuple[dict[str, Any], bytes]:
    raw = regular(path, mode=mode)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FinalizationError(f"evidence JSON is invalid: {path}") from error
    if not isinstance(value, dict) or (canonical_required and canonical(value) != raw):
        raise FinalizationError(f"evidence JSON is not canonical: {path}")
    return value, raw


def run(command: list[str], *, timeout: int = 30) -> str:
    try:
        result = subprocess.run(command, check=True, capture_output=True,
                                text=True, timeout=timeout,
                                env={"PATH": "/usr/bin:/bin"})
    except (OSError, subprocess.SubprocessError) as error:
        raise FinalizationError("forward-recovery proof command failed") from error
    return result.stdout


def require_git_ancestor(repository: Path, ancestor: str, descendant: str,
                         label: str) -> None:
    try:
        run([
            "/usr/bin/git", "-c", f"safe.directory={repository}",
            "-C", str(repository), "merge-base", "--is-ancestor",
            ancestor, descendant,
        ])
    except FinalizationError as error:
        raise FinalizationError(f"{label} source commit is not an ancestor") from error


def docker_json(args: list[str]) -> Any:
    try:
        return json.loads(run(["/usr/bin/docker", *args]))
    except json.JSONDecodeError as error:
        raise FinalizationError("Docker JSON proof is invalid") from error


def docker_inspect(name: str) -> dict[str, Any]:
    value = docker_json(["inspect", name])
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise FinalizationError(f"Docker identity is ambiguous: {name}")
    return value[0]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise FinalizationError(message)


def state_map(path: Path) -> dict[str, list[str]]:
    raw = regular(path)
    result: dict[str, list[str]] = {}
    for line in raw.decode("utf-8").splitlines():
        if "=" not in line:
            raise FinalizationError("manual recovery state contains an invalid line")
        key, value = line.split("=", 1)
        if not key or not value or "\n" in value or "\r" in value:
            raise FinalizationError("manual recovery state contains an invalid value")
        result.setdefault(key, []).append(value)
    return result


def last(values: dict[str, list[str]], key: str) -> str:
    try:
        return values[key][-1]
    except (KeyError, IndexError) as error:
        raise FinalizationError(f"manual recovery state is missing: {key}") from error


def sha(path: Path) -> str:
    return hashlib.sha256(regular(path)).hexdigest()


def validate_digest(value: str, message: str) -> None:
    require(SHA256_RE.fullmatch(value) is not None, message)


def validate_freshness(value: str, max_seconds: int, label: str) -> None:
    try:
        timestamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise FinalizationError(f"{label} timestamp is invalid") from error
    require(timestamp.tzinfo is not None, f"{label} timestamp has no timezone")
    age = (dt.datetime.now(dt.timezone.utc) - timestamp.astimezone(dt.timezone.utc)).total_seconds()
    require(-900 <= age <= max_seconds, f"{label} evidence is stale or future-dated")


def publication_projection(document: dict[str, Any], label: str) -> tuple[str, dict[str, Any]]:
    publication = document.get("publication") or {}
    aliases = publication.get("aliases")
    generation = publication.get("generation")
    collections = publication.get("collections")
    require(isinstance(aliases, dict) and set(aliases) == {
        "song_hybrid_active", "song_metadata_active", "songs_v2_active"
    }, f"{label} publication aliases are incomplete")
    require(isinstance(generation, str) and generation, f"{label} publication generation is invalid")
    require(isinstance(collections, list) and len(collections) == len(set(collections)),
            f"{label} collection inventory is invalid")
    projected = {name: aliases[name] for name in sorted(aliases)}
    require(all(isinstance(value, str) and value for value in projected.values())
            and len(set(projected.values())) == 3
            and "song_audio" not in projected.values(),
            f"{label} publication aliases are invalid")
    active = {"song_audio", *projected.values()}
    require(set(collections) == active, f"{label} publication contains inactive collections")
    if generation == "legacy":
        expected = {
            "song_hybrid_active": "song_hybrid",
            "song_metadata_active": "song_metadata",
            "songs_v2_active": "songs_v2",
        }
    else:
        require(re.fullmatch(r"[0-9a-f]{64}:[0-9a-f]{32}", generation) is not None,
                f"{label} publication generation is malformed")
        basis, build = generation.split(":", 1)
        suffix = f"{basis[:12]}_{build[:8]}"
        expected = {
            "song_hybrid_active": f"song_hybrid_basis_{suffix}",
            "song_metadata_active": f"song_metadata_basis_{suffix}",
            "songs_v2_active": f"songs_v2_basis_{suffix}",
        }
    require(projected == expected, f"{label} aliases do not match generation")
    projection = {"generation": generation, "aliases": projected,
                   "collections": sorted(active)}
    return hashlib.sha256(json.dumps(
        projection, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    ).encode()).hexdigest(), projection


def validate_evidence(args: argparse.Namespace, live_qdrant_version: str) -> tuple[str, dict[str, Any]]:
    paths = {
        "postgres_status": Path(args.postgres_status),
        "postgres_manifest": Path(args.postgres_manifest),
        "qdrant_status": Path(args.qdrant_status),
        "qdrant_manifest": Path(args.qdrant_manifest),
        "attestation": Path(args.attestation),
    }
    expected = {
        "postgres_status": args.postgres_status_sha,
        "postgres_manifest": args.postgres_manifest_sha,
        "qdrant_status": args.qdrant_status_sha,
        "qdrant_manifest": args.qdrant_manifest_sha,
        "attestation": args.attestation_sha,
    }
    documents: dict[str, dict[str, Any]] = {}
    raws: dict[str, bytes] = {}
    for name, path in paths.items():
        documents[name], raws[name] = read_json(path, canonical_required=False)
        require(hashlib.sha256(raws[name]).hexdigest() == expected[name],
                f"{name} digest does not match the supplied evidence binding")
    postgres_status = documents["postgres_status"]
    postgres_manifest = documents["postgres_manifest"]
    qdrant_status = documents["qdrant_status"]
    qdrant_manifest = documents["qdrant_manifest"]
    for kind, key, status, manifest, execution, maximum in (
        ("PostgreSQL", "postgres", postgres_status, postgres_manifest, args.postgres_run, 48 * 3600),
        ("Qdrant", "qdrant", qdrant_status, qdrant_manifest, args.qdrant_run, 192 * 3600),
    ):
        require(status.get("schemaVersion") == 1 and manifest.get("schemaVersion") == 1,
                f"{kind} evidence schema is invalid")
        require(status.get("status") == "success" and status.get("exitCode") == 0
                and status.get("remoteCleanup") == "confirmed",
                f"{kind} backup was not completely successful")
        require(status.get("runId") == execution and status.get("publication") == manifest.get("publication")
                and status.get("manifestSha256") == expected[key + "_manifest"],
                f"{kind} status/manifest binding is invalid")
        require(manifest.get("status") == "complete", f"{kind} manifest is incomplete")
        validate_freshness(str(status.get("finishedAt") or ""), maximum, f"{kind} status")
        validate_freshness(str(manifest.get("completedAt") or ""), maximum, f"{kind} manifest")
        require((manifest.get("source") or {}).get("host") == args.source_host,
                f"{kind} source host does not match the command binding")
        source = manifest.get("source") or {}
        for field in ("pipelineCommit", "playerCommit"):
            require(COMMIT_RE.fullmatch(str(source.get(field) or "")) is not None,
                    f"{kind} source commit is invalid")
        projection_sha, projection = publication_projection(manifest, kind)
        manifest["_projection_sha"] = projection_sha
        manifest["_projection"] = projection
    require(postgres_manifest["_projection"] == qdrant_manifest["_projection"],
            "PostgreSQL and Qdrant evidence do not bind one publication")
    require((qdrant_manifest.get("publication") or {}).get("qdrantVersion") == live_qdrant_version,
            "Qdrant evidence version does not match the promoted runtime")
    attestation = documents["attestation"]
    require(attestation.get("schemaVersion") == 2
            and attestation.get("challenge") == args.challenge
            and attestation.get("verifierHost") == args.verifier_host
            and attestation.get("allowedWriterSids") == [],
            "backup attestation identity/security contract is invalid")
    validate_freshness(str(attestation.get("verifiedAt") or ""), 900, "backup attestation")
    backups = attestation.get("backups")
    require(isinstance(backups, dict) and set(backups) == {"postgres", "qdrant"},
            "backup attestation set is not exact")
    for kind, execution in (("postgres", args.postgres_run), ("qdrant", args.qdrant_run)):
        record = backups[kind]
        manifest = documents[kind + "_manifest"]
        require(isinstance(record, dict) and record.get("payloadBytesRehashed") is True
                and record.get("directoryInventoryStable") is True
                and record.get("executionRunId") == execution
                and record.get("manifestSha256") == expected[kind + "_manifest"]
                and record.get("statusSha256") == expected[kind + "_status"],
                f"{kind} attestation binding is invalid")
    return qdrant_manifest["_projection_sha"], qdrant_manifest["_projection"]


def qdrant_version() -> str:
    output = run(["/usr/bin/docker", "exec", "vocadb_qdrant", "/qdrant/qdrant", "--version"])
    match = re.search(r"(?:^|\s)qdrant\s+([0-9]+(?:\.[0-9]+){1,2})(?:\s|$)", output)
    require(match is not None, "promoted Qdrant version is unavailable")
    return match.group(1)


def check_http(url: str) -> None:
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            require(response.status == 200, f"readiness endpoint did not return HTTP 200: {url}")
    except (OSError, urllib.error.URLError) as error:
        raise FinalizationError(f"readiness proof failed: {url}") from error


def compose_projection_sha() -> str:
    output = run([
        "/usr/bin/docker", "compose", "--env-file", str(BACKEND_ENV),
        "--project-name", "backend", "-f", str(COMPOSE_FILE), "config", "--format", "json",
    ], timeout=60)
    try:
        configuration = json.loads(output)
    except json.JSONDecodeError as error:
        raise FinalizationError("resolved Compose configuration is invalid") from error
    services_source = configuration.get("services")
    all_volumes = configuration.get("volumes") or {}
    all_networks = configuration.get("networks") or {}
    require(isinstance(services_source, dict) and isinstance(all_volumes, dict)
            and isinstance(all_networks, dict), "Compose projection shape is invalid")
    services: dict[str, Any] = {}
    volume_sources: set[str] = set()
    network_sources: set[str] = set()
    for service_name in ("postgres", "qdrant"):
        service = services_source.get(service_name)
        require(isinstance(service, dict), f"Compose service is missing: {service_name}")
        service = copy.deepcopy(service)
        environment = service.get("environment")
        if environment is not None:
            require(isinstance(environment, dict), "Compose environment shape is invalid")
            service["environment"] = {
                key: hashlib.sha256(json.dumps([key, value], ensure_ascii=True,
                                               separators=(",", ":")).encode()).hexdigest()
                for key, value in sorted(environment.items())
            }
        mounts = service.get("volumes") or []
        require(isinstance(mounts, list), "Compose volume shape is invalid")
        for mount in mounts:
            require(isinstance(mount, dict), "Compose mount shape is invalid")
            if mount.get("type") == "volume":
                source = mount.get("source")
                require(isinstance(source, str) and source, "Compose volume source is invalid")
                volume_sources.add(source)
        networks = service.get("networks") or {}
        if isinstance(networks, dict):
            network_sources.update(networks)
        elif isinstance(networks, list) and all(isinstance(value, str) for value in networks):
            network_sources.update(networks)
        else:
            raise FinalizationError("Compose network shape is invalid")
        services[service_name] = service

    def definitions(source_map: dict[str, Any], sources: set[str]) -> dict[str, Any]:
        selected: dict[str, Any] = {}
        for source in sorted(sources):
            matches = [key for key, value in source_map.items()
                       if key == source or (isinstance(value, dict) and value.get("name") == source)]
            require(len(set(matches)) == 1, "Compose referenced definition is ambiguous")
            selected[matches[0]] = source_map[matches[0]]
        return selected

    projection = {"schema": 1, "services": services,
                  "volumes": definitions(all_volumes, volume_sources),
                  "networks": definitions(all_networks, network_sources)}
    return hashlib.sha256(canonical(projection)).hexdigest()


def write_exclusive(path: Path, payload: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        written = 0
        while written < len(payload):
            count = os.write(descriptor, payload[written:])
            if count <= 0:
                raise FinalizationError(f"durable write failed: {path}")
            written += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    if path.stat().st_mode & 0o777 != 0o600 or path.stat().st_nlink != 1:
        raise FinalizationError(f"durable file contract is invalid: {path}")
    directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def finalize(args: argparse.Namespace) -> dict[str, str]:
    require(os.name == "nt" or os.geteuid() == 0, "forward-recovery finalization requires uid 0")
    require(RUN_ID_RE.fullmatch(args.run_id) is not None, "run ID is invalid")
    run_dir = STATE_ROOT / ("stateful-" + args.run_id)
    state = state_map(run_dir / "state")
    receipt_archive = sorted(run_dir.glob("api-bridge-receipt.manual-forward-recovery.*.json"))
    receipt_archive = [path for path in receipt_archive
                       if not path.name.endswith(".consumption-settlement.json")]
    require(len(receipt_archive) == 1, "manual forward-recovery receipt archive is ambiguous")
    receipt, receipt_raw = read_json(receipt_archive[0])
    receipt_sha = hashlib.sha256(receipt_raw).hexdigest()
    helper_spec = importlib.util.spec_from_file_location("diva_sbc_api_bridge_consumption", CONSUMPTION_HELPER)
    require(helper_spec is not None and helper_spec.loader is not None,
            "receipt consumption helper cannot be loaded")
    helper = importlib.util.module_from_spec(helper_spec)
    helper_spec.loader.exec_module(helper)
    helper._validate_manual_forward_stage(
        run_dir, STATE_ROOT, STATE_ROOT / "stateful-hardening-active",
        STATE_ROOT / "stateful-hardening.lock", STATE_ROOT / "stateful-runtime-contract",
        expected_receipt_sha=receipt_sha,
    )
    require(not any((STATE_ROOT / name).exists() or (STATE_ROOT / name).is_symlink()
                    for name in ("stateful-hardening-active", "stateful-hardening.lock",
                                 "api-bridge-receipt.json", "deploy.lock",
                                 "rolling-deployment-active")),
            "deployment interlock is still present")
    require(last(state, "deployment.status") == "failed"
            and last(state, "pipeline_writer.status") == "gated",
            "manual forward-recovery did not stop after the gated failure boundary")
    # The exact completion contract is checked by the shared helper above; the
    # state values below are independently bound to the live containers.
    qdrant_image = last(state, "qdrant.new_image_id")
    postgres_image = last(state, "postgres.new_image_id")
    migrate_image = last(state, "postgres_migrate.new_image_id")
    candidate_volume = last(state, "qdrant.candidate_volume")
    require(IMAGE_RE.fullmatch(qdrant_image) and IMAGE_RE.fullmatch(postgres_image)
            and IMAGE_RE.fullmatch(migrate_image), "candidate image IDs are invalid")
    qdrant = docker_inspect("vocadb_qdrant")
    postgres = docker_inspect("vocadb_postgres")
    require(qdrant.get("Id") and qdrant.get("Image") == qdrant_image
            and qdrant.get("State", {}).get("Running") is True,
            "live Qdrant is not the promoted candidate")
    mounts = qdrant.get("Mounts") or []
    require(len(mounts) == 1 and mounts[0].get("Name") == candidate_volume
            and mounts[0].get("Destination") == "/qdrant/storage",
            "live Qdrant volume is not the promoted candidate")
    require(postgres.get("Image") == postgres_image
            and postgres.get("State", {}).get("Running") is True
            and (postgres.get("State", {}).get("Health") or {}).get("Status") == "healthy",
            "live PostgreSQL is not the promoted candidate")
    for name in ("vocadb_api_a", "vocadb_api_b", "vocadb_api_gateway", "vocadb_web"):
        service = docker_inspect(name)
        require(service.get("State", {}).get("Running") is True
                and (service.get("State", {}).get("Health") or {}).get("Status") == "healthy",
                f"live service is not healthy: {name}")
    check_http("http://127.0.0.1:5000/api/ready")
    check_http("http://127.0.0.1:8080/backend-api/api/ready")
    live_version = qdrant_version()
    check_http("http://127.0.0.1:6333/healthz")
    evidence_projection_sha, evidence_projection = validate_evidence(args, live_version)
    # The proof runner deliberately supplies a minimal environment and runs as
    # root.  The checkouts are owned by the deployment user, so Git's dubious
    # ownership guard must be scoped to these exact repositories rather than
    # disabled globally or persisted in root's config.
    postgres_evidence, _ = read_json(Path(args.postgres_manifest), canonical_required=False)
    qdrant_evidence, _ = read_json(Path(args.qdrant_manifest), canonical_required=False)
    postgres_source = postgres_evidence.get("source") or {}
    source_evidence = qdrant_evidence.get("source") or {}
    expected_player = (last(state, "git.commit") if "git.commit" in state
                       else str(postgres_source.get("playerCommit") or ""))
    current_player = run([
        "/usr/bin/git", "-c", f"safe.directory={PLAYER_ROOT}",
        "-C", str(PLAYER_ROOT), "rev-parse", "HEAD",
    ]).strip()
    current_pipeline = run([
        "/usr/bin/git", "-c", f"safe.directory={PIPELINE_ROOT}",
        "-C", str(PIPELINE_ROOT), "rev-parse", "HEAD",
    ]).strip()
    require(current_player == expected_player and COMMIT_RE.fullmatch(current_player),
            "player checkout changed after forward recovery")
    require(COMMIT_RE.fullmatch(current_pipeline) and COMMIT_RE.fullmatch(current_player),
            "live checkout commit is invalid")
    for label, source in (("PostgreSQL", postgres_source), ("Qdrant", source_evidence)):
        source_player = str(source.get("playerCommit") or "")
        source_pipeline = str(source.get("pipelineCommit") or "")
        require(COMMIT_RE.fullmatch(source_player) and COMMIT_RE.fullmatch(source_pipeline),
                f"{label} source commit is invalid")
        require_git_ancestor(PLAYER_ROOT, source_player, current_player,
                             f"{label} player")
        require_git_ancestor(PIPELINE_ROOT, source_pipeline, current_pipeline,
                             f"{label} pipeline")
    require(sha(run_dir / "qdrant-build-context/Dockerfile") ==
            docker_inspect("vocadb_qdrant").get("Config", {}).get("Labels", {})
            .get("com.diva.qdrant.dockerfile-sha256"),
            "promoted Qdrant Dockerfile provenance is not bound")
    compose_digest = compose_projection_sha()
    compose_output = run(["/usr/bin/docker", "compose", "--env-file", str(BACKEND_ENV),
                                 "--project-name", "backend", "-f", str(COMPOSE_FILE),
                                 "config", "--format", "json"])
    try:
        image_refs = json.loads(compose_output)["services"]
    except (json.JSONDecodeError, KeyError) as error:
        raise FinalizationError("resolved Compose services are invalid") from error
    qdrant_ref = image_refs["qdrant"]["image"]
    postgres_ref = image_refs["postgres"]["image"]
    migrate_ref = image_refs["migrate"]["image"]
    require(run(["/usr/bin/docker", "image", "inspect", "--format", "{{.Id}}", qdrant_ref]).strip()
            == qdrant_image and run(["/usr/bin/docker", "image", "inspect", "--format", "{{.Id}}", postgres_ref]).strip()
            == postgres_image and run(["/usr/bin/docker", "image", "inspect", "--format", "{{.Id}}", migrate_ref]).strip()
            == migrate_image, "stable Compose image tags do not bind the promoted images")
    qdrant_after = run(["/usr/bin/docker", "inspect", "vocadb_qdrant"])
    postgres_after = run(["/usr/bin/docker", "inspect", "vocadb_postgres"])
    qdrant_after_path = run_dir / "qdrant-after.json"
    postgres_after_path = run_dir / "postgres-after.json"
    for path, output in ((qdrant_after_path, qdrant_after), (postgres_after_path, postgres_after)):
        if path.exists() or path.is_symlink():
            require(regular(path) == output.encode(), f"existing fingerprint changed: {path}")
        else:
            write_exclusive(path, output.encode())
    gate_path = run_dir / "pipeline-writer-gate"
    gate_result = run_dir / "pipeline-writer-gate-result"
    gate_sha = sha(gate_path)
    require(gate_sha and gate_result.is_file(), "writer gate evidence is missing")
    scan_names = {
        "qdrant": "image-scan-qdrant-runtime.receipt.json",
        "qdrant_audit": "image-scan-qdrant-audit.receipt.json",
        "postgres": "image-scan-postgres-runtime.receipt.json",
        "migrate": "image-scan-postgres-migrate.receipt.json",
    }
    scan_shas = {key: sha(run_dir / "evidence" / filename)
                 for key, filename in scan_names.items()}
    promotion_lines = [
        "schema=1", "status=completed-forward-recovery", f"run={args.run_id}",
        f"qdrant_image_id={qdrant_image}", f"qdrant_stable_tag={qdrant_ref}",
        f"qdrant_volume={candidate_volume}", f"qdrant_fingerprint_sha256={sha(qdrant_after_path)}",
        f"postgres_image_id={postgres_image}", f"postgres_stable_tag={postgres_ref}",
        f"postgres_fingerprint_sha256={sha(postgres_after_path)}",
        f"postgres_migrate_image_id={migrate_image}", f"postgres_migrate_stable_tag={migrate_ref}",
        f"pipeline_writer_gate_sha256={gate_sha}", f"evidence_projection_sha256={evidence_projection_sha}",
        f"qdrant_scan_receipt_sha256={scan_shas['qdrant']}",
        f"qdrant_audit_scan_receipt_sha256={scan_shas['qdrant_audit']}",
        f"postgres_scan_receipt_sha256={scan_shas['postgres']}",
        f"postgres_migrate_image_scan_receipt_sha256={scan_shas['migrate']}",
        "recovery=validated-promoted-topology-no-docker-mutation",
    ]
    promotion_path = run_dir / "promotion-transaction"
    promotion_payload = ("\n".join(promotion_lines) + "\n").encode()
    if promotion_path.exists() or promotion_path.is_symlink():
        require(regular(promotion_path) == promotion_payload, "promotion manifest changed")
    else:
        write_exclusive(promotion_path, promotion_payload)
    promotion_sha = hashlib.sha256(promotion_payload).hexdigest()
    qdrant_dockerfile_sha = sha(run_dir / "qdrant-build-context/Dockerfile")
    contract_lines = [
        "schema=1", "status=completed", f"run={args.run_id}",
        f"qdrant_stable_tag={qdrant_ref}", f"qdrant_image_id={qdrant_image}",
        f"qdrant_source_commit={current_player}", f"qdrant_dockerfile_sha256={qdrant_dockerfile_sha}",
        f"postgres_image_reference={postgres_ref}", f"postgres_image_id={postgres_image}",
        f"postgres_migrate_image_reference={migrate_ref}", f"postgres_migrate_image_id={migrate_image}",
        f"qdrant_image_scan_receipt_sha256={scan_shas['qdrant']}",
        f"qdrant_audit_image_scan_receipt_sha256={scan_shas['qdrant_audit']}",
        f"postgres_image_scan_receipt_sha256={scan_shas['postgres']}",
        f"postgres_migrate_image_scan_receipt_sha256={scan_shas['migrate']}",
        f"postgres_dockerfile_sha256={last(state, 'postgres.dockerfile_sha256')}",
        f"postgres_schema_sha256={last(state, 'postgres.schema_sha256')}",
        f"postgres_source_bundle_sha256={last(state, 'postgres.source_bundle_sha256')}",
        f"postgres_migrate_dockerfile_sha256={last(state, 'postgres_migrate.dockerfile_sha256')}",
        f"stateful_compose_projection_sha256={compose_digest}",
        f"promotion_manifest_sha256={promotion_sha}",
        f"player_commit={current_player}", f"pipeline_commit={current_pipeline}",
    ]
    contract_payload = ("\n".join(contract_lines) + "\n").encode()
    contract_path = STATE_ROOT / "stateful-runtime-contract"
    if contract_path.exists() or contract_path.is_symlink():
        require(regular(contract_path) == contract_payload, "published runtime contract changed")
        status = "already-published"
    else:
        write_exclusive(contract_path, contract_payload)
        status = "published"
    return {"runId": args.run_id, "status": status,
            "promotionManifestSha256": promotion_sha,
            "runtimeContractSha256": hashlib.sha256(contract_payload).hexdigest()}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    env_names = {
        "source_host": "DIVA_EXPECTED_BACKUP_SOURCE_HOST",
        "postgres_run": "DIVA_VERIFIED_POSTGRES_BACKUP_RUN_ID",
        "qdrant_run": "DIVA_VERIFIED_QDRANT_BACKUP_RUN_ID",
        "postgres_status": "DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_FILE",
        "postgres_manifest": "DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_FILE",
        "qdrant_status": "DIVA_VERIFIED_QDRANT_BACKUP_STATUS_FILE",
        "qdrant_manifest": "DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_FILE",
        "attestation": "DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_FILE",
        "postgres_status_sha": "DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_SHA256",
        "postgres_manifest_sha": "DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_SHA256",
        "qdrant_status_sha": "DIVA_VERIFIED_QDRANT_BACKUP_STATUS_SHA256",
        "qdrant_manifest_sha": "DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_SHA256",
        "attestation_sha": "DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_SHA256",
        "challenge": "DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_CHALLENGE",
        "verifier_host": "DIVA_EXPECTED_BACKUP_VERIFIER_HOST",
    }
    for name, env_name in env_names.items():
        parser.add_argument("--" + name.replace("_", "-"), default=os.environ.get(env_name))
    args = parser.parse_args()
    for name in env_names:
        require(bool(getattr(args, name)), f"required evidence binding is missing: {name}")
    print(json.dumps(finalize(args), ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, FinalizationError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"SBC forward-recovery finalization: {error}", file=sys.stderr)
        raise SystemExit(1)
