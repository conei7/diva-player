#!/usr/bin/env python3
"""Retire one stale bridge receipt after an exact manual forward recovery.

The command is deliberately read-heavy.  It proves the retained run, the
manual recovery completion record, the promoted Docker identities, readiness,
and the immutable bridge receipt before asking the crash-safe consumption
helper to archive that receipt.  It never edits a state document or removes a
Docker object.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any


STATE_ROOT = Path("/var/lib/diva-player-deploy")
BRIDGE_RECEIPT = STATE_ROOT / "api-bridge-receipt.json"
CONSUME_INTENT = STATE_ROOT / "api-bridge-consume-intent.json"
ACTIVE_JOURNAL = STATE_ROOT / "stateful-hardening-active"
LOCK_DIR = STATE_ROOT / "stateful-hardening.lock"
RUNTIME_CONTRACT = STATE_ROOT / "stateful-runtime-contract"
ROLLING_ACTIVE_JOURNAL = STATE_ROOT / "rolling-deployment-active"
DEPLOY_LOCK_DIR = STATE_ROOT / "deploy.lock"
DOCKER = Path("/usr/bin/docker")
RECEIPT_VERIFIER = Path(__file__).with_name("wsl-dr-api-bridge-receipt.py")
CONSUMPTION_HELPER = Path(__file__).with_name("sbc-api-bridge-consumption.py")


class RecoveryError(RuntimeError):
    pass


def _load_helper():
    spec = importlib.util.spec_from_file_location(
        "diva_sbc_api_bridge_consumption", CONSUMPTION_HELPER
    )
    if spec is None or spec.loader is None:
        raise RecoveryError("receipt consumption helper could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, separators=(",", ":"),
                       sort_keys=True) + "\n").encode("utf-8")


def _regular(path: Path, *, mode: int = 0o600, links: int | set[int] = 1,
             maximum: int = 8 * 1024 * 1024) -> bytes:
    try:
        info = path.lstat()
    except OSError as error:
        raise RecoveryError(f"required evidence is unavailable: {path}") from error
    allowed_links = links if isinstance(links, set) else {links}
    if (not path.is_file() or path.is_symlink() or info.st_nlink not in allowed_links
            or info.st_size <= 0 or info.st_size > maximum
            or (os.name != "nt" and (info.st_mode & 0o777) != mode)
            or (os.name != "nt" and (info.st_uid != 0 or info.st_gid != 0))):
        raise RecoveryError(f"unsafe evidence file: {path}")
    raw = path.read_bytes()
    if len(raw) != info.st_size:
        raise RecoveryError(f"evidence changed while reading: {path}")
    return raw


def _json(path: Path, *, links: int | set[int] = 1,
          maximum: int = 8 * 1024 * 1024) -> tuple[dict[str, Any], bytes]:
    raw = _regular(path, links=links, maximum=maximum)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RecoveryError(f"evidence JSON is invalid: {path}") from error
    if not isinstance(value, dict) or _canonical(value) != raw:
        raise RecoveryError(f"evidence JSON is not canonical: {path}")
    return value, raw


def _run(command: list[str], *, timeout: int = 20) -> str:
    try:
        result = subprocess.run(
            command, check=True, capture_output=True, text=True,
            timeout=timeout, env={"PATH": "/usr/bin:/bin"},
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RecoveryError("live recovery proof command failed") from error
    return result.stdout


def _docker_container(name: str) -> dict[str, Any]:
    raw = _run([str(DOCKER), "inspect", name], timeout=20)
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RecoveryError("Docker inspect output is invalid") from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise RecoveryError("Docker inspect identity is ambiguous")
    return value[0]


def _require_live_topology(state_values: dict[str, list[str]], old_qdrant_id: str) -> None:
    qdrant = _docker_container("vocadb_qdrant")
    postgres = _docker_container("vocadb_postgres")
    if not qdrant.get("State", {}).get("Running") \
            or qdrant.get("Image") != state_values["qdrant.new_image_id"][0] \
            or qdrant.get("Id") == old_qdrant_id:
        raise RecoveryError("live Qdrant identity is not the promoted candidate")
    mounts = qdrant.get("Mounts")
    if not isinstance(mounts, list) or len(mounts) != 1 \
            or mounts[0].get("Name") != state_values["qdrant.candidate_volume"][0] \
            or mounts[0].get("Destination") != "/qdrant/storage":
        raise RecoveryError("live Qdrant volume identity is not the promoted candidate")
    if not postgres.get("State", {}).get("Running") \
            or postgres.get("Image") != state_values["postgres.new_image_id"][0] \
            or (postgres.get("State", {}).get("Health") or {}).get("Status") != "healthy":
        raise RecoveryError("live PostgreSQL identity is not the promoted candidate")
    for name in ("vocadb_api_a", "vocadb_api_b", "vocadb_api_gateway", "vocadb_web"):
        service = _docker_container(name)
        if not service.get("State", {}).get("Running") \
                or (service.get("State", {}).get("Health") or {}).get("Status") != "healthy":
            raise RecoveryError(f"live service is not healthy: {name}")
    for url in (
        "http://127.0.0.1:5000/api/ready",
        "http://127.0.0.1:8080/backend-api/api/ready",
    ):
        try:
            with urllib.request.urlopen(url, timeout=10) as response:
                if response.status != 200:
                    raise RecoveryError("readiness endpoint did not return HTTP 200")
        except (OSError, RecoveryError) as error:
            raise RecoveryError("readiness proof failed") from error


def _state_values(helper, run_dir: Path, run_id: str, receipt_sha: str) -> dict[str, list[str]]:
    helper._validate_manual_forward_stage(
        run_dir, STATE_ROOT, ACTIVE_JOURNAL, LOCK_DIR, RUNTIME_CONTRACT,
        expected_receipt_sha=receipt_sha,
    )
    values = helper._state_values(run_dir)
    for path in (ROLLING_ACTIVE_JOURNAL, DEPLOY_LOCK_DIR):
        if os.path.lexists(path):
            raise RecoveryError(f"unrelated deployment interlock exists: {path.name}")
    return values


def reconcile(run_id: str, *, verify_only: bool = False) -> dict[str, object]:
    if os.name != "nt" and os.geteuid() != 0:
        raise RecoveryError("manual forward-recovery requires uid 0")
    if not RECEIPT_VERIFIER.is_file() or RECEIPT_VERIFIER.is_symlink():
        raise RecoveryError("trusted bridge receipt verifier is unavailable")
    if not CONSUMPTION_HELPER.is_file() or CONSUMPTION_HELPER.is_symlink():
        raise RecoveryError("trusted receipt consumption helper is unavailable")
    helper = _load_helper()
    run_dir = STATE_ROOT / ("stateful-" + run_id)
    if not run_id or helper.RUN_ID.fullmatch(run_id) is None:
        raise RecoveryError("run ID is invalid")
    receipt_path = BRIDGE_RECEIPT
    if os.path.lexists(BRIDGE_RECEIPT):
        receipt, receipt_raw = _json(BRIDGE_RECEIPT, links={1, 2})
    else:
        candidates = sorted(run_dir.glob(
            "api-bridge-receipt.manual-forward-recovery.*.json"
        ))
        candidates = [path for path in candidates
                      if not path.name.endswith(".consumption-settlement.json")]
        if len(candidates) != 1:
            raise RecoveryError("archived forward-recovery receipt is ambiguous")
        receipt_path = candidates[0]
        receipt, receipt_raw = _json(receipt_path)
    receipt_sha = hashlib.sha256(receipt_raw).hexdigest()
    old_qdrant = receipt.get("oldQdrant")
    if not isinstance(old_qdrant, dict) or not isinstance(old_qdrant.get("containerId"), str):
        raise RecoveryError("bridge receipt old Qdrant binding is absent")
    verifier = _run([
        sys.executable, "-I", "-B", str(RECEIPT_VERIFIER), "--path", str(receipt_path),
        "--expect-host-scope", "sbc-primary", "--verify-previous-api-rollback",
    ], timeout=30)
    if not verifier.strip():
        raise RecoveryError("bridge receipt verifier returned no proof")
    values = _state_values(helper, run_dir, run_id, receipt_sha)
    _require_live_topology(values, old_qdrant["containerId"])
    if verify_only:
        return {"runId": run_id, "receiptSha256": receipt_sha, "status": "verified"}
    settlement = helper.retire_manual_forward_recovery(
        canonical=BRIDGE_RECEIPT,
        intent_path=CONSUME_INTENT,
        state_root=STATE_ROOT,
        active=ACTIVE_JOURNAL,
        lock_dir=LOCK_DIR,
        runtime_contract=RUNTIME_CONTRACT,
        run_id=run_id,
        expected_sha=receipt_sha,
    )
    return {
        "runId": run_id,
        "receiptSha256": receipt_sha,
        "archivePath": settlement["archivePath"],
        "settlementPath": str(Path(str(settlement["archivePath"]) + ".consumption-settlement.json")),
        "status": "archived-single-link",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    print(json.dumps(reconcile(args.run_id, verify_only=args.verify_only),
                     ensure_ascii=True, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RecoveryError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"SBC manual forward-recovery reconciliation: {error}", file=sys.stderr)
        raise SystemExit(1)
