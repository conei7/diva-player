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

def validated_receipt(directory, preflight):
    directory=Path(directory)
    verification=directory/"verification.json";receipt=directory/"restore-evidence.json"
    if not verification.exists() or not receipt.exists(): return None
    for path in (verification,receipt):
        if path.is_symlink() or path.stat().st_uid!=0 or path.stat().st_mode & 0o777!=0o600:raise ValueError("receipt must be root-private")
    expected=module("postgres-restore-evidence").build_evidence(preflight,json.loads(verification.read_text()))
    recorded=json.loads(receipt.read_text())
    expected.pop("recordedAt",None);recorded.pop("recordedAt",None)
    if expected!=recorded:raise ValueError("completed receipt changed")
    return recorded

def finish_verified_cleanup(path,state,preflight):
    path=Path(path)
    if validated_receipt(path.parent,preflight) is None:return False
    volume=json.loads(subprocess.check_output(["docker","volume","inspect",state["candidateVolume"]]))[0]
    for key,value in {"com.diva.postgres-restore.run-id":state["runId"],"com.diva.postgres-restore.manifest-sha256":state["manifestSha256"],"com.diva.postgres-restore.dump-sha256":state["dumpSha256"]}.items():
        if volume.get("Labels",{}).get(key)!=value:raise ValueError("verified volume binding changed")
    for name in (state["candidateContainer"]+"_api",state["candidateContainer"]):
        result=subprocess.run(["docker","inspect",name],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        if result.returncode==0:
            container=json.loads(result.stdout)[0]
            labels=container["Config"].get("Labels",{})
            if labels.get("com.diva.postgres-restore.run-id")!=state["runId"] or labels.get("com.diva.postgres-restore.purpose")!="isolated-verification":
                raise ValueError("cleanup target is not owned by this restore run")
            if name==state["candidateContainer"] and not any(m.get("Name")==state["candidateVolume"] and m["Destination"]=="/var/lib/postgresql/data" for m in container["Mounts"]):
                raise ValueError("verified database volume changed")
            subprocess.run(["docker","rm","-f",container["Id"]],check=True,stdout=subprocess.DEVNULL)
    for name in ("api.env","admin-password","api-password","pipeline-password"):
        target=path.parent/name
        if target.exists():
            if target.is_symlink() or target.stat().st_uid!=0 or target.stat().st_mode & 0o777!=0o600:raise ValueError("transient credential changed")
            target.unlink()
    checkpoint(path,"verification-complete",{"apiVerificationComplete":True,"apiContainerStoppedAndRemoved":True,"databaseContainerStoppedAndRemoved":True,
        "candidateVolumeRetained":True,"adminPasswordRemoved":True,"suspendedAtUserRequest":False,"evidenceFile":"restore-evidence.json"})
    return True

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
    if finish_verified_cleanup(path,state,preflight):
        print(json.dumps({"status":"already-verified","runId":state["runId"]}))
        return
    verify._publication_alignment(state["publicationGeneration"])
    production=json.loads(subprocess.check_output(["docker","inspect","vocadb_postgres"]))[0]
    if production["Image"]!=state["postgresImageId"] or not any(m.get("Name")==state["oldVolume"] and m["Destination"]=="/var/lib/postgresql/data" for m in production["Mounts"]):
        raise ValueError("production image or volume changed since preflight")
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
