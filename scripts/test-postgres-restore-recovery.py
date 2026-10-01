#!/usr/bin/env python3
"""Executable checkpoint, snapshot equality and cutover rollback regression tests."""
from __future__ import annotations
import copy
import importlib.util
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent
def load(name):
    spec=importlib.util.spec_from_file_location(name.replace("-","_"),ROOT/(name+".py"))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
STATE=load("postgres-restore-state")
VERIFY=load("postgres-restore-verify")
BACKUP=load("postgres-restore-backup")
if sys.platform=="win32":
    sys.modules.setdefault("fcntl",types.SimpleNamespace())
CUTOVER=load("sbc-postgres-cutover")

class CheckpointTests(unittest.TestCase):
    def test_phase_updates_preserve_binding_and_restore_time(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/"state.json"
            STATE.checkpoint(p,"restoring",{"runId":"run","restoreStartedAt":"start","postgresImageId":"image"})
            value=STATE.checkpoint(p,"acl-failed",{"failureCode":7})
            self.assertEqual(value["runId"],"run")
            self.assertEqual(value["restoreStartedAt"],"start")
            self.assertEqual(value["previousPhase"],"restoring")
            self.assertEqual(len(value["phaseHistory"]),2)
    def test_interrupted_atomic_write_keeps_last_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/"state.json";STATE.atomic_json(p,{"phase":"valid"})
            with patch.object(STATE.os,"replace",side_effect=OSError("interrupted")):
                with self.assertRaises(OSError):STATE.atomic_json(p,{"phase":"invalid"})
            self.assertEqual(json.loads(p.read_text()),{"phase":"valid"})
            self.assertEqual(list(Path(directory).iterdir()),[p])

class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.counts={name:1 for name in VERIFY.TABLES_TO_COUNT}
        self.rows=[{"id":"0018_runtime_database_roles.sql","sha256":None}]
        self.backup={"validationBaseline":{"schemaVersion":1,"snapshot":"00000001-1-1","tableCounts":self.counts.copy(),"migrations":self.rows}}
    def test_legacy_backup_is_explicitly_not_compared(self):
        self.assertEqual(VERIFY._backup_comparison({},self.counts,{"rows":self.rows})["status"],"not-recorded-in-source-backup")
    def test_exact_snapshot_counts_and_migrations_pass(self):
        self.assertEqual(VERIFY._backup_comparison(self.backup,self.counts,{"rows":self.rows})["status"],"matched")
    def test_changed_count_is_rejected(self):
        counts=self.counts.copy();counts["songs"]+=1
        with self.assertRaisesRegex(VERIFY.VerificationError,"counts"):VERIFY._backup_comparison(self.backup,counts,{"rows":self.rows})
    def test_changed_migration_is_rejected(self):
        with self.assertRaisesRegex(VERIFY.VerificationError,"migrations"):VERIFY._backup_comparison(self.backup,self.counts,{"rows":[]})
    def test_missing_table_baseline_is_rejected(self):
        del self.backup["validationBaseline"]["tableCounts"]["songs"]
        with self.assertRaisesRegex(VERIFY.VerificationError,"incomplete"):VERIFY._backup_comparison(self.backup,self.counts,{"rows":self.rows})
    def test_qdrant_generation_mismatch_is_rejected(self):
        generation="a"*64+":"+"b"*32
        inspected=[{"Config":{"Env":["POSTGRES_USER=vocadb","POSTGRES_DB=vocadb_recommender"]}}]
        response=io.StringIO(json.dumps({"result":{"aliases":[]}}))
        with patch.object(VERIFY,"run_command",return_value=json.dumps(inspected)),patch.object(VERIFY,"_query",side_effect=[generation,"0"]),patch.object(VERIFY.urllib.request,"build_opener") as opener:
            opener.return_value.open.return_value.__enter__.return_value=response
            with self.assertRaisesRegex(VERIFY.VerificationError,"Qdrant"):VERIFY._publication_alignment(generation)

class SnapshotTests(unittest.TestCase):
    def test_dump_and_all_baseline_queries_share_exported_snapshot(self):
        session=types.SimpleNamespace(stdin=io.StringIO(),stdout=io.StringIO("00000001-00000001-1\n"),returncode=0,wait=lambda **kwargs:0,poll=lambda:0)
        calls=[]
        def run(args,**kwargs):
            calls.append(args)
            if "pg_dump" in args:
                kwargs["stdout"].write(b"custom-dump")
                return types.SimpleNamespace(stdout="",returncode=0)
            sql=args[-1]
            if "json_agg" in sql: result='[{"id":"0018_runtime_database_roles.sql","sha256":null}]'
            elif "recommendation_publication_generation" in sql: result="a"*64+":"+"b"*32
            else:result="1"
            return types.SimpleNamespace(stdout=result,returncode=0)
        with tempfile.TemporaryDirectory() as directory,patch.object(BACKUP.subprocess,"Popen",return_value=session),patch.object(BACKUP.subprocess,"run",side_effect=run):
            run_id="postgres-20261001T000000Z-12345678"
            manifest=BACKUP.capture(Path(directory)/run_id,"vocadb_postgres","vocadb","vocadb_recommender",run_id)
            self.assertEqual(manifest["status"],"complete")
            self.assertEqual(set(manifest["validationBaseline"]["tableCounts"]),set(VERIFY.TABLES_TO_COUNT))
            for args in calls:
                if "pg_dump" in args:self.assertIn("--snapshot=00000001-00000001-1",args)
                else:self.assertIn("SET TRANSACTION SNAPSHOT '00000001-00000001-1'",args[-1])

class CutoverTests(unittest.TestCase):
    def test_deadline_is_twelve_minutes_and_cap_fifteen(self):
        self.assertEqual(CUTOVER.ROLLBACK_AT,720);self.assertEqual(CUTOVER.OUTAGE_CAP,900)
        with patch.object(CUTOVER.time,"time",return_value=820):
            self.assertEqual(CUTOVER.remaining({"outageStartedEpoch":100}),0)
    def test_writer_release_intent_disables_old_volume_rollback(self):
        self.assertTrue(CUTOVER.rollback_allowed({}))
        self.assertFalse(CUTOVER.rollback_allowed({"writerReleaseIntent":True}))
        self.assertFalse(CUTOVER.rollback_allowed({"writersResumed":True}))
    def test_clone_preserves_configuration_and_changes_only_volume(self):
        old={"Image":"sha256:abc","Config":{"Image":"tag","Env":["SECRET=private"],"Hostname":"original","Labels":{}},
             "HostConfig":{"Binds":["old:/var/lib/postgresql/data:rw"],"Memory":123,"PortBindings":{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"5432"}]}},
             "NetworkSettings":{"Networks":{"backend_default":{"Aliases":["postgres","vocadb_postgres"]}}}}
        before=copy.deepcopy(old);payload=CUTOVER.create_payload(old,"new")
        self.assertEqual(old,before)
        self.assertEqual(payload["HostConfig"]["Binds"],["new:/var/lib/postgresql/data:rw"])
        self.assertEqual(payload["Env"],old["Config"]["Env"])
        self.assertEqual(payload["HostConfig"]["Memory"],123)
        self.assertEqual(payload["HostConfig"]["PortBindings"],old["HostConfig"]["PortBindings"])
    def test_forward_recovery_never_stops_old_database(self):
        with tempfile.TemporaryDirectory() as directory:
            controller=CUTOVER.Controller(Path(directory))
            controller.state={"phase":"writer-release-intent","writerReleaseIntent":True}
            calls=[]
            controller.mark=lambda phase,**fields:controller.state.update(phase=phase,**fields)
            controller.query=lambda *args:"owned-token"
            controller.gate=lambda container,release:calls.append((container,release))
            controller.api_ready=lambda:calls.append("api-ready")
            controller.run=lambda *args,**kwargs:self.fail("forward recovery must not stop/remove/start containers")
            controller.recover()
            self.assertEqual(calls,[("vocadb_postgres",True),"api-ready"])
            self.assertEqual(controller.state["phase"],"completed")
    def test_shell_is_postgres_only_and_watchdog_is_durable(self):
        text=(ROOT/"sbc-postgres-cutover.py").read_text()
        self.assertIn('"--on-active="+str(ROLLBACK_AT)',text)
        self.assertIn('"--property=Restart=on-failure"',text)
        self.assertNotIn('["docker","restart","vocadb_qdrant"]',text)
        self.assertNotIn('["docker","volume","rm"',text)
        self.assertNotIn("harden-sbc-stateful-services.sh",text)

if __name__=="__main__":unittest.main()
