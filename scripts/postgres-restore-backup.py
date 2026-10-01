#!/usr/bin/env python3
"""Create a custom dump and verification baseline using one exported snapshot."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
import importlib.util

def load(name):
    spec=importlib.util.spec_from_file_location(name.replace("-","_"),Path(__file__).with_name(name+".py"))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def capture(directory, container, admin, database, run_id, timeout=300):
    verify=load("postgres-restore-verify")
    state=load("postgres-restore-state")
    if not re.fullmatch(r"postgres-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", run_id): raise ValueError("invalid backup run ID")
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}",admin) or database != verify.DATABASE_NAME: raise ValueError("invalid database identity")
    directory=Path(directory)
    if directory.name != run_id or directory.exists(): raise ValueError("backup directory must be new and match run ID")
    directory.mkdir(mode=0o700,parents=True)
    base=["docker","exec","-i",container,"psql","-X","-v","ON_ERROR_STOP=1","-U",admin,"-d",database,"-Atq"]
    with open(directory.parent/"backup-snapshot.log","ab") as log:
        session=subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
        try:
            session.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n");session.stdin.flush()
            snapshot=session.stdout.readline().strip()
            if not re.fullmatch(r"[0-9A-F]+-[0-9A-F]+-[0-9]+",snapshot): raise ValueError("snapshot export failed")
            def query(sql):
                prefix="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '"+snapshot+"'; "
                result=subprocess.run(base+["-c",prefix+sql+"; COMMIT;"],stdout=subprocess.PIPE,stderr=log,text=True,timeout=timeout,check=True)
                return result.stdout.strip()
            counts={}
            for name in verify.TABLES_TO_COUNT:
                counts[name]=int(query('SELECT count(*) FROM public."'+name+'"'))
            migrations=json.loads(query("SELECT coalesce(json_agg(json_build_object('id',migration_id,'sha256',content_sha256) ORDER BY migration_id),'[]'::json)::text FROM public.schema_migrations"))
            generation=query("SELECT value FROM public.sync_state WHERE key='recommendation_publication_generation'")
            logical=int(query("SELECT pg_database_size(current_database())"))
            extensions=json.loads(query("SELECT json_object_agg(extname,extversion ORDER BY extname)::text FROM pg_extension"))
            baseline={"schemaVersion":1,"snapshot":snapshot,"tableCounts":counts,"migrations":migrations,"extensions":extensions,"expectedRestoredExtensions":verify._expected_restored_extensions(extensions)}
            dump=directory/"postgres.dump"
            with open(dump,"xb") as output:
                os.chmod(dump,0o600)
                subprocess.run(["docker","exec",container,"pg_dump","-U",admin,"-d",database,"--format=custom","--compress=0","--no-owner","--no-privileges","--snapshot="+snapshot],stdout=output,stderr=log,check=True,timeout=timeout)
                output.flush();os.fsync(output.fileno())
            session.stdin.write("COMMIT;\n");session.stdin.close()
            session.wait(timeout=10)
            if session.returncode: raise ValueError("snapshot transaction failed")
            digest=hashlib.sha256()
            with dump.open("rb") as stream:
                for chunk in iter(lambda:stream.read(1024*1024),b""):digest.update(chunk)
            manifest={"schemaVersion":1,"status":"complete","runId":run_id,
                "createdAt":datetime.now(timezone.utc).isoformat(),
                "database":{"file":"postgres.dump","format":"pg_dump-custom","sizeBytes":dump.stat().st_size,"logicalSizeBytes":logical,"sha256":digest.hexdigest()},
                "publication":{"generation":generation},"validationBaseline":baseline}
            state.atomic_json(directory/"manifest.json",manifest)
            return manifest
        finally:
            if session.poll() is None:
                session.kill();session.wait(timeout=10)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory",required=True,type=Path)
    parser.add_argument("--container",default="vocadb_postgres")
    parser.add_argument("--admin-user",default="vocadb")
    parser.add_argument("--run-id",required=True)
    args=parser.parse_args()
    os.umask(0o077)
    capture(args.directory,args.container,args.admin_user,"vocadb_recommender",args.run_id)
    print(json.dumps({"status":"complete","runId":args.run_id}))
if __name__=="__main__": main()
