#!/usr/bin/env python3
"""Durable additive checkpoints and strictly bound isolated candidate resume."""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

def module(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

def atomic_json(path, value):
    path = Path(path)
    if path.is_symlink(): raise ValueError("refusing symlink state")
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(fd)
            finally: os.close(fd)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def checkpoint(path, phase, fields=None):
    path = Path(path)
    state = json.loads(path.read_text()) if path.exists() else {"schemaVersion": 1}
    previous = state.get("phase")
    state.update(fields or {})
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    state.update(phase=phase, phaseEnteredAt=now)
    state.setdefault("phaseHistory", []).append({"phase": phase, "at": now})
    if previous: state["previousPhase"] = previous
    atomic_json(path, state)
    return state

def resume(path):
    path = Path(path)
    if path.is_symlink() or path.parent.is_symlink(): raise ValueError("restore state must not be a symlink")
    if os.getuid() != 0 or path.stat().st_uid != 0 or path.stat().st_mode & 0o777 != 0o600 or path.parent.stat().st_uid != 0 or path.parent.stat().st_mode & 0o777 != 0o700:
        raise ValueError("resume requires root-private state")
    state = json.loads(path.read_text())
    preflight = json.loads((path.parent / "preflight.json").read_text())
    pre = module("postgres-restore-preflight")
    verify = module("postgres-restore-verify")
    backup = pre._read_backup(Path(preflight["backup"]["manifestPath"]).parent, state["runId"])
    for key in ("manifestSha256", "dumpSha256", "publicationGeneration"):
        if backup[key] != state[key] or backup[key] != preflight["backup"][key]: raise ValueError("resume backup binding changed")
    verify._publication_alignment(state["publicationGeneration"])
    if state["phase"] == "verification-complete":
        evidence = module("postgres-restore-evidence").build_evidence(preflight, json.loads((path.parent/"verification.json").read_text()))
        recorded = json.loads((path.parent/"restore-evidence.json").read_text())
        recorded.pop("recordedAt", None); evidence.pop("recordedAt", None)
        if recorded != evidence: raise ValueError("completed receipt changed")
        volume = json.loads(subprocess.check_output(["docker","volume","inspect",state["candidateVolume"]]))[0]
        if volume["Labels"].get("com.diva.postgres-restore.run-id") != state["runId"]: raise ValueError("completed candidate volume binding changed")
        print(json.dumps({"status": "already-verified", "runId": state["runId"]}))
        return
    if state.get("databasePort") is None or state.get("logicalRestoreFinishedAt") is None:
        raise ValueError("DB is not ready for API resume; inspect incomplete restore rather than restoring twice")
    verify._inspect_candidate(state["candidateContainer"], state["candidateVolume"], preflight, state["databasePort"], allow_stopped=True)
    subprocess.run(["docker", "start", state["candidateContainer"]], check=True, stdout=subprocess.DEVNULL)
    checkpoint(path, "database-ready-loopback-port-" + str(state["databasePort"]), {"suspendedAtUserRequest": False, "lastResumeAt": datetime.now(timezone.utc).isoformat()})

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("resume", "update"))
    parser.add_argument("--state-file", required=True, type=Path)
    parser.add_argument("--phase")
    parser.add_argument("--fields-json", default="{}")
    args = parser.parse_args()
    try:
        if args.action == "resume": resume(args.state_file)
        else:
            if not args.phase: parser.error("--phase is required")
            checkpoint(args.state_file, args.phase, json.loads(args.fields_json))
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}), file=__import__("sys").stderr)
        return 1
    return 0
if __name__ == "__main__": raise SystemExit(main())
