#!/usr/bin/env python3
"""PostgreSQL-only journaled cutover; 12-minute rollback, 15-minute outage cap."""
from __future__ import annotations
import argparse
import copy
import fcntl
import hashlib
import http.client
import importlib.util
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import urllib.parse

SCRIPTS=Path(__file__).resolve().parent
STATE_ROOT=Path("/var/lib/diva-player/postgres-cutover")
DEPLOY_ROOT=Path("/var/lib/diva-player-deploy")
PLAYER=Path("/home/orangepi/diva-player")
PIPELINE=Path("/home/orangepi/diva-data-pipeline")
CONTRACT=DEPLOY_ROOT/"stateful-runtime-contract"
IMAGE="diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1"
DATABASE="vocadb_recommender"
DATA="/var/lib/postgresql/data"
ROLLBACK_AT=720
OUTAGE_CAP=900

def module(name):
    spec=importlib.util.spec_from_file_location(name.replace("-","_"),SCRIPTS/(name+".py"))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
STATE=module("postgres-restore-state")
VERIFY=module("postgres-restore-verify")

def now(): return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def require(condition,message):
    if not condition: raise RuntimeError(message)
def digest(payload): return hashlib.sha256(payload).hexdigest()
def private(path, directory=False):
    path=Path(path)
    for parent in [path,*path.parents]:
        require(not parent.is_symlink(),"private path contains a symlink")
    info=path.stat()
    require(info.st_uid==0 and (info.st_mode & 0o777)==(0o700 if directory else 0o600),"path is not root-private")
    return path
def bytes_atomic(path,payload):
    path=Path(path)
    require(not path.is_symlink(),"refusing symlink destination")
    old=path.stat() if path.exists() else None
    temp=path.with_name(path.name+"."+secrets.token_hex(4)+".tmp")
    fd=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    try:
        with os.fdopen(fd,"wb") as stream:
            stream.write(payload);stream.flush();os.fsync(stream.fileno())
        if old: os.chmod(temp,old.st_mode & 0o777);os.chown(temp,old.st_uid,old.st_gid)
        os.replace(temp,path)
        fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if temp.exists():temp.unlink()

def projection(configuration):
    services={}
    volumes=set();networks=set()
    for name in ("postgres","qdrant"):
        service=copy.deepcopy(configuration["services"][name])
        if service.get("environment") is not None:
            service["environment"]={k:digest(json.dumps([k,v],ensure_ascii=True,separators=(",",":")).encode()) for k,v in sorted(service["environment"].items())}
        for mount in service.get("volumes") or []:
            if mount.get("type")=="volume": volumes.add(mount["source"])
        networks.update(service.get("networks") or {})
        services[name]=service
    def selected(kind,refs):
        result={}
        for ref in sorted(refs):
            matches=[(k,v) for k,v in configuration.get(kind,{}).items() if k==ref or isinstance(v,dict) and v.get("name")==ref]
            require(len(matches)==1,"Compose resource projection is ambiguous")
            result.update(matches)
        return result
    return {"schema":1,"services":services,"volumes":selected("volumes",volumes),"networks":selected("networks",networks)}
def encoded(value): return (json.dumps(value,ensure_ascii=True,sort_keys=True,separators=(",",":"))+"\n").encode()
def estimate_outage(restore_seconds,backup_seconds,api_seconds=30):
    return restore_seconds+backup_seconds+api_seconds+60+60

def rollback_allowed(state): return not state.get("writerReleaseIntent",False) and not state.get("writersResumed",False)
def remaining(state):
    if state.get("outageStartedEpoch") is None: return 300
    return max(0,state.get("rollbackAfterSeconds",ROLLBACK_AT)-(time.time()-state["outageStartedEpoch"]))

class Engine(http.client.HTTPConnection):
    def __init__(self): super().__init__("localhost",timeout=30)
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout);self.sock.connect("/var/run/docker.sock")

def create_payload(old,volume):
    config=copy.deepcopy(old["Config"]);host=copy.deepcopy(old["HostConfig"])
    for key in ("Hostname","Domainname"): config[key]=""
    host["Binds"]=[volume+":"+DATA+":rw" if x.split(":")[1]==DATA else x for x in host.get("Binds") or []]
    host["RestartPolicy"]={"Name":"unless-stopped","MaximumRetryCount":0}
    networks=old["NetworkSettings"]["Networks"]
    require(set(networks)=={"backend_default"},"production PostgreSQL network changed")
    aliases=networks["backend_default"].get("Aliases") or []
    return {**config,"HostConfig":host,"NetworkingConfig":{"EndpointsConfig":{"backend_default":{"Aliases":sorted(set(aliases)|{"postgres","vocadb_postgres"})}}}}

class Controller:
    def __init__(self,path):
        self.path=Path(path);self.state_path=self.path/"state.json"
        self.state=json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.rollback_mode=False
    def mark(self,phase,**fields):
        self.state=STATE.checkpoint(self.state_path,phase,fields)
    def run(self,args,*,input=None,timeout=300,output=None):
        budget=timeout if self.rollback_mode or self.state.get("writerReleaseIntent") else min(timeout,remaining(self.state))
        require(budget>0,"cutover reached rollback deadline")
        with open(self.path/"commands.log","ab") as errors:
            process=subprocess.Popen(args,stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                stdout=output if output is not None else subprocess.PIPE,stderr=errors,start_new_session=True)
            try:
                result,_=process.communicate(input,timeout=budget)
            except BaseException:
                os.killpg(process.pid,signal.SIGKILL);process.wait();raise
            require(process.returncode==0,"cutover command failed; private commands.log retained")
            return result.decode() if result is not None else ""
    def inspect(self,name,optional=False):
        if optional:
            result=subprocess.run(["docker","inspect",name],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            return json.loads(result.stdout)[0] if result.returncode==0 else None
        return json.loads(self.run(["docker","inspect",name]))[0]
    def query(self,container,sql):
        return self.run(["docker","exec",container,"psql","-X","-v","ON_ERROR_STOP=1","-U",self.state["adminUser"],"-d",DATABASE,"-Atq","-c",sql]).strip()
    def sql(self,container,content):
        return self.run(["docker","exec","-i",container,"psql","-X","-v","ON_ERROR_STOP=1","-U",self.state["adminUser"],"-d",DATABASE,"-Atq","-v","token="+self.state["gateToken"]],input=content.encode()).strip()
    def gate(self,container,release=False):
        sql=(SCRIPTS/("postgres-cutover-writer-release.sql" if release else "postgres-cutover-writer-gate.sql")).read_text()
        result=self.sql(container,sql)
        require(result==self.state["gateToken"],"writer gate is busy or its ownership changed")
    def compose(self):
        value=json.loads(self.run(["docker","compose","--env-file",str(PLAYER/"backend/.env"),"--project-name","backend","-f",str(PLAYER/"backend/docker-compose.yml"),"config","--format","json"]))
        return projection(value)
    @contextmanager
    def locks(self):
        handles=[]
        lock=DEPLOY_ROOT/"deploy.lock"
        owned=False;owner_data=b""
        try:
            for path,shared in [(DEPLOY_ROOT/"stateful-hardening.lock",False),(PIPELINE/"ml_pipeline/.ml-runtime-use.lock",True),(STATE_ROOT/"cutover.lock",False)]:
                fd=os.open(path,os.O_RDONLY if shared else os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
                fcntl.flock(fd,(fcntl.LOCK_SH if shared else fcntl.LOCK_EX)|fcntl.LOCK_NB);handles.append(fd)
            try: lock.mkdir(mode=0o700)
            except FileExistsError:
                owner=(lock/"owner").read_text()
                old=dict(line.split("=",1) for line in owner.splitlines() if "=" in line)
                require(old.get("deployment_id")==self.state.get("runId"),"another deployment owns deploy.lock")
                pid=int(old["pid"])
                require(not Path("/proc/"+str(pid)).exists(),"previous deployment process is still running")
                (lock/"owner").unlink();lock.rmdir();lock.mkdir(mode=0o700)
            owner_data=("pid="+str(os.getpid())+"\ndeployment_id="+self.state["runId"]+"\ndeployment_dir="+str(self.path)+"\nprivate_runtime="+str(self.path)+"\nboot_id="+Path("/proc/sys/kernel/random/boot_id").read_text().strip()+"\nprocess_start_ticks="+Path("/proc/self/stat").read_text().split(") ",1)[1].split()[19]+"\nstarted="+now()+"\n").encode()
            bytes_atomic(lock/"owner",owner_data);owned=True
            yield
        finally:
            if owned and (lock/"owner").read_bytes()==owner_data:
                (lock/"owner").unlink();lock.rmdir()
            for fd in handles:os.close(fd)
    def ready(self,name,seconds=60):
        limit=time.monotonic()+seconds
        while time.monotonic()<limit:
            try:
                if self.query(name,"SELECT 1")=="1":return
            except RuntimeError: pass
            time.sleep(1)
        raise RuntimeError("PostgreSQL readiness timed out")
    def resume_api(self):
        for name,expected in self.state["apiSlotIds"].items():
            current=self.inspect(name)
            require(current["Id"]==expected,"API slot identity changed during maintenance")
            if current["State"].get("Paused"):self.run(["docker","unpause",expected],timeout=15)
            elif not current["State"]["Running"]:self.run(["docker","start",expected],timeout=15)
    def api_ready(self,smoke=True):
        limit=time.monotonic()+max(150,self.state.get("apiReadyBudgetSeconds",150))
        pending={"vocadb_api_a","vocadb_api_b"}
        while pending and time.monotonic()<limit:
            for name in list(pending):
                current=self.inspect(name)
                require(current["State"]["Running"],"API exited during readiness")
                if current["State"].get("Health",{}).get("Status")=="healthy":pending.remove(name)
            require(self.rollback_mode or self.state.get("writerReleaseIntent") or remaining(self.state)>5,"API readiness reached deadline")
            if pending:time.sleep(2)
        require(not pending,"API readiness timed out")
        available=False
        while time.monotonic()<limit:
            try:
                value=VERIFY._api_get("http://127.0.0.1:5000","/api/ready")
                if value.get("status")=="ready" and (not smoke or VERIFY._api_get("http://127.0.0.1:5000","/api/health").get("status")=="ok"):
                    available=True;break
            except VERIFY.VerificationError:pass
            require(self.rollback_mode or self.state.get("writerReleaseIntent") or remaining(self.state)>5,"API health refresh reached deadline")
            time.sleep(2)
        require(available,"fresh API readiness and health did not recover")
        if smoke:VERIFY._api_smoke("http://127.0.0.1:5000")
    def prepare(self,verified,reuse_rehearsal=False):
        previous=copy.deepcopy(self.state)
        if reuse_rehearsal:
            rejected=(previous.get("phase")=="preparation-failed" and previous.get("failedPhase")=="backup-rehearsal-complete") or (
                previous.get("phase")=="backup-rehearsal-complete" and previous.get("estimatedOutageSeconds",0)>=previous.get("rollbackAfterSeconds",ROLLBACK_AT))
            require(rejected,"only a budget-rejected rehearsal can be reused")
            require((PLAYER/"backend/.env").read_bytes()==(self.path/"backend.env.before").read_bytes()
                and CONTRACT.read_bytes()==(self.path/"runtime-contract.before").read_bytes(),"prepared configuration changed")
            require(self.inspect("vocadb_postgres")["Id"]==previous["oldContainerId"],"rehearsal source database changed")
            require(self.inspect(previous["candidateContainer"],True) is None,"candidate initialization already began")
            VERIFY._publication_alignment(previous["generation"])
        private(Path(verified).parent,True)
        source_state=json.loads(private(verified).read_text())
        require(source_state.get("apiVerificationComplete") is True and source_state["phase"]=="verification-complete","isolated API verification is incomplete")
        preflight=json.loads(private(Path(verified).parent/"preflight.json").read_text())
        evidence=module("postgres-restore-evidence").build_evidence(preflight,json.loads(private(Path(verified).parent/"verification.json").read_text()))
        recorded=json.loads(private(Path(verified).parent/"restore-evidence.json").read_text())
        evidence.pop("recordedAt",None);recorded.pop("recordedAt",None)
        require(evidence==recorded,"isolated evidence binding changed")
        VERIFY._publication_alignment(preflight["backup"]["publicationGeneration"])
        source_commit=self.run(["runuser","-u","orangepi","--","git","-C",str(PLAYER),"rev-parse","HEAD"]).strip()
        require(re.fullmatch(r"[0-9a-f]{40}",source_commit),"deployment source commit is invalid")
        self.mark("source-bound",sourceCommit=source_commit,controllerSha256=digest(Path(__file__).read_bytes()))
        old=self.inspect("vocadb_postgres")
        require(old["State"]["Running"] and old["Config"]["Image"] in (IMAGE,old["Image"]),"production PostgreSQL image reference changed")
        require(old["Image"]==preflight["postgres"]["imageId"],"production PostgreSQL image ID changed")
        mounts=[m for m in old["Mounts"] if m["Destination"]==DATA and m["Type"]=="volume"]
        require(len(mounts)==1,"production volume is ambiguous")
        env=dict(item.split("=",1) for item in old["Config"]["Env"])
        require("POSTGRES_PASSWORD" in env,"production admin secret source needs explicit support")
        api_ids={name:self.inspect(name)["Id"] for name in ("vocadb_api_a","vocadb_api_b")}
        self.mark("preparing",apiSlotIds=api_ids,apiQuiesceMode="pause",adminUser=env["POSTGRES_USER"],oldVolume=mounts[0]["Name"],oldContainerId=old["Id"],
            newVolume="backend_postgres_cutover_"+self.state["runId"],candidateContainer="vocadb_postgres_cutover_"+self.state["runId"],
            rollbackContainer="vocadb_postgres_rollback_"+self.state["runId"],imageId=old["Image"],
            generation=preflight["backup"]["publicationGeneration"],gateToken=secrets.token_hex(32),
            isolatedEvidenceSha256=digest(private(Path(verified).parent/"restore-evidence.json").read_bytes()))
        STATE.atomic_json(self.path/"old-postgres.inspect.json",old)
        STATE.atomic_json(self.path/"qdrant.inspect.json",self.inspect("vocadb_qdrant"))
        for name,target in [("backend.env",PLAYER/"backend/.env"),("runtime-contract",CONTRACT)]:
            require(target.is_file() and not target.is_symlink(),"configuration source is not a regular file")
            bytes_atomic(self.path/(name+".before"),target.read_bytes())
        before=self.compose()
        STATE.atomic_json(self.path/"compose-projection.before.json",before)
        contract=dict(line.split("=",1) for line in private(CONTRACT).read_text().splitlines())
        require(digest(encoded(before))==contract["stateful_compose_projection_sha256"],"current Compose projection disagrees with runtime contract")
        logical=int(self.query("vocadb_postgres","SELECT pg_database_size(current_database())"))
        require(__import__("shutil").disk_usage("/var/lib/docker").free>=2*logical+1024**3,"insufficient cutover capacity")
        # A consistent rehearsal backup measures both dump and comparison cost before outage.
        if reuse_rehearsal:
            rehearsal=previous["rehearsalRunId"]
            module("postgres-restore-preflight")._read_backup(self.path/rehearsal,rehearsal)
            measured=previous["backupRehearsalSeconds"]
        else:
            rehearsal="postgres-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")+"-"+secrets.token_hex(4)
            started=time.monotonic()
            module("postgres-restore-backup").capture(self.path/rehearsal,"vocadb_postgres",self.state["adminUser"],DATABASE,rehearsal)
            measured=time.monotonic()-started
        # Freeze API processes without losing their already-warmed read caches.
        # Original sockets are disconnected by PostgreSQL shutdown; unpause
        # opens fresh pools against the same schema/data/credentials.
        api_budget=30
        rollback_after=ROLLBACK_AT
        # One final snapshot backup follows pause; comparison/ACL/analyze receive
        # 60 seconds and a separate 60-second contingency before the 12m limit.
        estimate=estimate_outage(evidence["measurements"]["logicalPostgresRestoreDurationSeconds"],measured,api_budget)
        self.mark("backup-rehearsal-complete",rehearsalRunId=rehearsal,backupRehearsalSeconds=round(measured,3),estimatedOutageSeconds=round(estimate,3),apiReadyBudgetSeconds=api_budget,rollbackAfterSeconds=rollback_after)
        require(estimate<rollback_after,"measured backup/restore/verification budget exceeds 12-minute rollback threshold")
        self.run(["docker","volume","create","--label","com.diva.postgres-cutover.run-id="+self.state["runId"],"--label","com.diva.postgres-cutover.old-volume="+self.state["oldVolume"],self.state["newVolume"]])
        private_env=self.path/"candidate.env"
        bytes_atomic(private_env,("\n".join(k+"="+env[k] for k in ("POSTGRES_USER","POSTGRES_PASSWORD","POSTGRES_DB"))+"\n").encode())
        self.run(["docker","run","-d","--pull=never","--name",self.state["candidateContainer"],"--label","com.diva.postgres-cutover.run-id="+self.state["runId"],
            "--network","none","--restart","no","--shm-size","1gb","--pids-limit","512","--cap-drop","ALL",
            "--cap-add","CHOWN","--cap-add","DAC_OVERRIDE","--cap-add","FOWNER","--cap-add","SETGID","--cap-add","SETUID",
            "--security-opt","no-new-privileges=true","--tmpfs","/docker-entrypoint-initdb.d:rw,noexec,nosuid,size=1m",
            "--mount","type=volume,src="+self.state["newVolume"]+",dst="+DATA,
            "--mount","type=bind,src="+str(self.path)+",dst=/cutover,readonly",
            "--env-file",str(private_env),IMAGE])
        self.ready(self.state["candidateContainer"])
        self.mark("prepared",preparedAt=now(),candidateContainerId=self.inspect(self.state["candidateContainer"])["Id"])
    def validate_db(self,container,manifest):
        baseline=manifest["validationBaseline"]
        counts=VERIFY._table_counts(container,self.state["adminUser"])
        migrations=VERIFY._migrations(container,self.state["adminUser"])
        comparison=VERIFY._backup_comparison({"validationBaseline":baseline},counts,migrations)
        for database in (DATABASE,"postgres"):VERIFY._collation(container,self.state["adminUser"],database)
        indexes=VERIFY._indexes(container,self.state["adminUser"])
        extensions=VERIFY._extensions(container,self.state["adminUser"])
        require(extensions==baseline["expectedRestoredExtensions"],"restored extensions differ from final backup snapshot")
        sequences=VERIFY._sequence_state(container,self.state["adminUser"])
        role_sql=(SCRIPTS/"test-database-role-contract.sql").read_text().replace("NOT member.rolcanlogin","(NOT member.rolcanlogin AND parent.rolname <> 'diva_pipeline_runtime')")
        self.sql(container,role_sql)
        require(self.query(container,"SELECT value FROM sync_state WHERE key='diva_stateful_maintenance_gate'")==self.state["gateToken"],"restored gate token mismatch")
        require(self.query(container,"SELECT count(*) FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND pg_has_role(oid,'diva_pipeline_runtime','MEMBER')")=="0","pipeline login was enabled before validation")
        STATE.atomic_json(self.path/"database-verification.json",{"backupComparison":comparison,"indexes":indexes,"extensions":extensions,"sequences":sequences,"collationWarningsCleared":True})
    def publish_container(self,old):
        candidate=self.inspect(self.state["candidateContainer"])
        self.run(["docker","stop","--time","15",candidate["Id"]],timeout=30)
        self.mark("old-database-stopping")
        self.run(["docker","stop","--time","15",old["Id"]],timeout=30)
        self.run(["docker","rename",old["Id"],self.state["rollbackContainer"]])
        self.run(["docker","network","disconnect","backend_default",old["Id"]])
        self.mark("new-database-creating")
        payload=create_payload(old,self.state["newVolume"])
        payload.setdefault("Labels",{})["com.diva.postgres-cutover.run-id"]=self.state["runId"]
        engine=Engine()
        try:
            engine.request("POST","/containers/create?name=vocadb_postgres",body=json.dumps(payload),headers={"Content-Type":"application/json"})
            response=engine.getresponse();result=json.loads(response.read())
            require(response.status==201,"Docker refused production PostgreSQL creation")
        finally:engine.close()
        self.mark("new-database-created",newContainerId=result["Id"])
        self.run(["docker","start",result["Id"]]);self.ready("vocadb_postgres")
        actual=self.inspect("vocadb_postgres")
        expected=module("sbc-runtime-contract").runtime_projection(old)
        observed=module("sbc-runtime-contract").runtime_projection(actual)
        expected["HostConfig"]["Binds"]=observed["HostConfig"]["Binds"]
        require(observed["HostConfig"]["Binds"]==create_payload(old,self.state["newVolume"])["HostConfig"]["Binds"],"published PostgreSQL volume binding differs from prepared intent")
        require(expected==observed,"published PostgreSQL runtime configuration changed beyond the selected volume")
        require(actual["Image"]==old["Image"] and actual["Config"]["Image"]==old["Config"]["Image"],"published PostgreSQL image or pinned reference changed")
    def publish_configuration(self):
        env_path=PLAYER/"backend/.env"
        require(env_path.read_bytes()==(self.path/"backend.env.before").read_bytes(),"deployment environment changed during cutover")
        lines=[x for x in env_path.read_text().splitlines() if not re.match(r"\s*(?:export\s+)?DIVA_POSTGRES_VOLUME\s*=",x)]
        bytes_atomic(env_path,("\n".join(lines)+"\nDIVA_POSTGRES_VOLUME="+self.state["newVolume"]+"\n").encode())
        after=self.compose();before=json.loads((self.path/"compose-projection.before.json").read_text())
        require(after["services"]["qdrant"]==before["services"]["qdrant"],"Qdrant Compose definition changed")
        mounts=[m for m in after["services"]["postgres"].get("volumes",[]) if m.get("target")==DATA and m.get("type")=="volume"]
        require(len(mounts)==1 and after["volumes"].get(mounts[0]["source"],{}).get("name")==self.state["newVolume"],
            "Compose PostgreSQL volume does not match the promoted database")
        STATE.atomic_json(self.path/"compose-projection.after.json",after)
        require(CONTRACT.read_bytes()==(self.path/"runtime-contract.before").read_bytes(),"runtime contract changed during cutover")
        receipt={"schemaVersion":1,"runId":self.state["runId"],"previousContractSha256":digest(CONTRACT.read_bytes()),"oldVolume":self.state["oldVolume"],
            "newVolume":self.state["newVolume"],"imageId":self.state["imageId"],"newContainerId":self.state["newContainerId"],
            "databaseVerificationSha256":digest((self.path/"database-verification.json").read_bytes()),
            "finalBackupManifestSha256":digest((self.path/self.state["finalBackupRunId"]/"manifest.json").read_bytes()),
            "qdrantContainerId":json.loads((self.path/"qdrant.inspect.json").read_text())["Id"]}
        STATE.atomic_json(self.path/"postgres-promotion.json",receipt)
        updates={"stateful_compose_projection_sha256":digest(encoded(after)),"promotion_manifest_sha256":digest((self.path/"postgres-promotion.json").read_bytes())}
        lines=CONTRACT.read_text().splitlines()
        bytes_atomic(CONTRACT,("\n".join(k+"="+updates.get(k,v) for k,v in (x.split("=",1) for x in lines))+"\n").encode())
        self.mark("configuration-published")
    def recover(self):
        self.rollback_mode=True
        if not rollback_allowed(self.state):
            self.mark("forward-recovery")
            gate=self.query("vocadb_postgres","SELECT value FROM sync_state WHERE key='diva_stateful_maintenance_gate'")
            if gate:self.gate("vocadb_postgres",True)
            self.api_ready()
            self.mark("completed",writersResumed=True,completedAt=now())
            return
        self.mark("rollback-running")
        old=self.inspect(self.state["oldContainerId"])
        current=self.inspect("vocadb_postgres",True)
        if current and current["Id"]!=old["Id"]:
            require(current["Config"].get("Labels",{}).get("com.diva.postgres-cutover.run-id")==self.state["runId"],"foreign container replaced PostgreSQL")
            self.run(["docker","stop","--time","10",current["Id"]],timeout=20)
            self.run(["docker","rm",current["Id"]])
        if old["Name"]!="/vocadb_postgres": self.run(["docker","rename",old["Id"],"vocadb_postgres"])
        if "backend_default" not in old["NetworkSettings"]["Networks"]:
            self.run(["docker","network","connect","--alias","postgres","--alias","vocadb_postgres","backend_default",old["Id"]])
        self.run(["docker","start",old["Id"]]);self.ready("vocadb_postgres")
        for name,target in [("backend.env",PLAYER/"backend/.env"),("runtime-contract",CONTRACT)]:
            bytes_atomic(target,(self.path/(name+".before")).read_bytes())
        gate=self.query("vocadb_postgres","SELECT value FROM sync_state WHERE key='diva_stateful_maintenance_gate'")
        if gate: self.gate("vocadb_postgres",True)
        self.resume_api()
        self.api_ready(smoke=False)
        candidate=self.inspect(self.state["candidateContainer"],True)
        if candidate and candidate["State"]["Running"]:self.run(["docker","stop","--time","10",candidate["Id"]])
        duration=time.time()-self.state.get("outageStartedEpoch",time.time())
        self.mark("rolled-back",rollbackFinishedAt=now(),outageSeconds=round(duration,3),outageCapMet=duration<=OUTAGE_CAP)
    def worker(self):
        if self.state["phase"]!="prepared":
            if self.state["phase"] not in ("completed","rolled-back"):self.recover()
            return
        try:
            old=self.inspect("vocadb_postgres")
            require(old["Id"]==self.state["oldContainerId"],"production PostgreSQL identity changed after preparation")
            candidate_record=self.inspect(self.state["candidateContainer"])
            require(candidate_record["Id"]==self.state["candidateContainerId"] and candidate_record["Image"]==self.state["imageId"]
                and candidate_record["HostConfig"]["NetworkMode"]=="none"
                and candidate_record["Config"]["Labels"].get("com.diva.postgres-cutover.run-id")==self.state["runId"],"prepared candidate identity changed")
            require(any(m.get("Name")==self.state["newVolume"] and m["Destination"]==DATA for m in candidate_record["Mounts"]),"prepared candidate volume changed")
            VERIFY._publication_alignment(self.state["generation"])
            executing_commit=self.run(["runuser","-u","orangepi","--","git","-C",str(PLAYER),"rev-parse","HEAD"]).strip()
            require(re.fullmatch(r"[0-9a-f]{40}",executing_commit),"cutover execution source commit is invalid")
            self.mark("writer-gating",executingSourceCommit=executing_commit,
                executingControllerSha256=digest(Path(__file__).read_bytes()))
            for attempt in range(60):
                try:self.gate("vocadb_postgres");break
                except RuntimeError:
                    if attempt==59:raise
                    time.sleep(2)
            self.mark("writers-gated")
            roles=self.run(["docker","exec","vocadb_postgres","pg_dumpall","-U",self.state["adminUser"],"--roles-only"])
            roles=re.sub(r"^CREATE ROLE "+re.escape(self.state["adminUser"])+r";\n","",roles,flags=re.M)
            bytes_atomic(self.path/"roles.sql",roles.encode())
            self.mark("outage-starting",outageStartedAt=now(),outageStartedEpoch=time.time())
            self.run(["systemd-run","--unit",self.state["unit"]+"-deadline","--on-active="+str(self.state.get("rollbackAfterSeconds",ROLLBACK_AT))+"s",
                "/usr/bin/python3",str(SCRIPTS/"sbc-postgres-cutover.py"),"watchdog","--state-directory",str(self.path)],timeout=20)
            for name,expected in self.state["apiSlotIds"].items():
                current=self.inspect(name)
                require(current["Id"]==expected and current["State"]["Running"] and not current["State"].get("Paused"),"API slot is not ready for maintenance")
                self.run(["docker","pause",expected],timeout=15)
            final="postgres-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")+"-"+secrets.token_hex(4)
            self.mark("final-backup-running",finalBackupRunId=final)
            self.run(["python3",str(SCRIPTS/"postgres-restore-backup.py"),"--directory",str(self.path/final),"--run-id",final,
                "--container","vocadb_postgres","--admin-user",self.state["adminUser"]])
            manifest=json.loads((self.path/final/"manifest.json").read_text())
            require(manifest["publication"]["generation"]==self.state["generation"],"final backup generation changed")
            candidate=self.state["candidateContainer"]
            self.mark("final-restore-running")
            self.sql(candidate,roles)
            self.run(["docker","exec",candidate,"pg_restore","--exit-on-error","--no-owner","--no-privileges","--jobs=2",
                "--username",self.state["adminUser"],"--dbname",DATABASE,"/cutover/"+final+"/postgres.dump"],timeout=600)
            for path in [SCRIPTS.parent/"backend/database/migrations/0018_runtime_database_roles.sql",
                         SCRIPTS.parent/"backend/database/migrations/0025_reconcile_runtime_role_migration_history_acl.sql",
                         SCRIPTS/"postgres-restore-runtime-acls.sql"]:
                policy=path.read_text()
                if path.name=="0018_runtime_database_roles.sql":
                    # The final role dump deliberately preserves the writer gate.
                    policy=policy.replace("NOT member.rolcanlogin","(NOT member.rolcanlogin AND parent.rolname <> 'diva_pipeline_runtime')")
                self.sql(candidate,policy)
            self.mark("final-database-verifying")
            self.validate_db(candidate,manifest)
            self.mark("restored-database-analyzing")
            self.run(["docker","exec",candidate,"vacuumdb","--analyze-only","--jobs=2","-U",self.state["adminUser"],"-d",DATABASE],timeout=90)
            self.publish_container(old)
            self.publish_configuration()
            self.resume_api()
            self.api_ready()
            sessions=self.query("vocadb_postgres","SELECT count(DISTINCT application_name) FROM pg_stat_activity WHERE application_name IN ('diva-api-a','diva-api-b') AND backend_type='client backend'")
            require(int(sessions)>=2,"both API slots did not reconnect to the restored database")
            VERIFY._publication_alignment(self.state["generation"])
            require(self.inspect("vocadb_qdrant")["Id"]==json.loads((self.path/"qdrant.inspect.json").read_text())["Id"],"Qdrant identity changed")
            require(remaining(self.state)>0,"API verification exceeded rollback deadline")
            self.mark("writer-release-intent",writerReleaseIntent=True,apiVerifiedAt=now())
            self.gate("vocadb_postgres",True)
            duration=time.time()-self.state["outageStartedEpoch"]
            self.mark("completed",writersResumed=True,completedAt=now(),outageSeconds=round(duration,3),outageCapMet=duration<=OUTAGE_CAP)
            (self.path/"candidate.env").unlink(missing_ok=True)
            self.run(["systemctl","stop",self.state["unit"]+"-deadline.timer"],timeout=20)
        except BaseException:
            self.mark("cutover-interrupted",failedPhase=self.state["phase"],failedAt=now())
            self.recover()
            if self.state["phase"]=="completed":return
            print(json.dumps({"status":"rolled-back","state":str(self.state_path)}))
        finally:
            # The rollback container and both old/new volumes are retained.
            pass

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=("prepare","start","worker","recover","watchdog","status"))
    parser.add_argument("--state-directory",required=True,type=Path)
    parser.add_argument("--verified-state",type=Path)
    parser.add_argument("--reuse-rehearsal",action="store_true")
    args=parser.parse_args()
    os.umask(0o077)
    require(os.getuid()==0,"must run as root")
    path=args.state_directory.absolute()
    require(path.parent==STATE_ROOT and re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9]+",path.name),"state directory must be a run beneath the fixed root")
    STATE_ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
    if args.action=="prepare":
        if not args.reuse_rehearsal:
            require(not path.exists(),"cutover run already exists")
            path.mkdir(mode=0o700)
            STATE.atomic_json(path/"state.json",{"schemaVersion":1,"runId":path.name,"phase":"new","unit":"diva-postgres-cutover-"+path.name})
        else: require(path.exists(),"rehearsal state is missing")
    private(path,True);private(path/"state.json")
    controller=Controller(path)
    if args.action=="status":
        print(json.dumps(controller.state,sort_keys=True));return
    if args.action=="watchdog":
        if controller.state["phase"] in ("completed","rolled-back") or not rollback_allowed(controller.state):return
        subprocess.run(["systemctl","stop",controller.state["unit"]],timeout=30,check=False)
        controller=Controller(path)
        if controller.state["phase"] not in ("completed","rolled-back"):
            with controller.locks():controller.recover()
        return
    if args.action=="start":
        require(controller.state["phase"]=="prepared","cutover preparation is incomplete")
        subprocess.run(["systemd-run","--unit",controller.state["unit"],"--property=Type=exec","--property=Restart=on-failure",
            "--property=RestartSec=5","--property=TimeoutStopSec=15","/usr/bin/python3",str(Path(__file__).resolve()),"worker","--state-directory",str(path)],check=True)
        return
    with controller.locks():
        if args.action=="prepare":
            require(args.verified_state is not None,"--verified-state is required")
            try:
                controller.prepare(args.verified_state,args.reuse_rehearsal)
            except Exception as error:
                controller.mark("preparation-failed",failedPhase=controller.state["phase"],
                    failureClass=type(error).__name__,failureReason=str(error) if isinstance(error,RuntimeError) else type(error).__name__)
                raise
        elif args.action=="worker":controller.worker()
        elif args.action=="recover":controller.recover()
    print(json.dumps({"status":controller.state["phase"],"state":str(controller.state_path)}))
if __name__=="__main__":
    try:main()
    except Exception:
        # Raw exceptions/commands can contain secret-bearing Docker payloads.
        print("PostgreSQL cutover failed; inspect root-private state and commands.log.",file=sys.stderr)
        raise SystemExit(1)
