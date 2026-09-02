#!/usr/bin/env python3
"""Deterministic contract tests for the offline SBC Qdrant upgrade controller."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import stat
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("sbc-qdrant-storage-upgrade.py")
SPEC = importlib.util.spec_from_file_location("sbc_qdrant_storage_upgrade", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load Qdrant upgrade controller")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
SOURCE = MODULE_PATH.read_text(encoding="utf-8")


class UpgradeContractTests(unittest.TestCase):
    def initial(self) -> dict:
        return {
            "runId": "20260831T010203Z-123",
            "old": {
                "containerId": "a" * 64,
                "containerName": "vocadb_qdrant",
                "imageId": "sha256:" + "b" * 64,
                "volume": "backend_qdrant_data",
                "volumeIdentity": {"name": "backend_qdrant_data"},
            },
            "candidate": {
                "volume": "diva_qdrant_candidate_20260831T010203Z-123",
                "network": "diva_qdrant_upgrade_20260831T010203Z-123",
            },
            "expected": {"fingerprintSha256": "c" * 64, "hops": []},
            "probe": {
                "apiImages": {
                    "api_a": "sha256:" + "d" * 64,
                    "api_b": "sha256:" + "e" * 64,
                },
                "seedSongId": 42,
            },
        }

    def test_helper_capabilities_accept_exact_docker_engine_name_formats(self) -> None:
        expected = ("CHOWN", "DAC_OVERRIDE")
        for capabilities in (
            ["CHOWN", "DAC_OVERRIDE"],
            ["CAP_CHOWN", "CAP_DAC_OVERRIDE"],
            ["CAP_DAC_OVERRIDE", "CHOWN"],
        ):
            with self.subTest(capabilities=capabilities):
                self.assertTrue(
                    MODULE.has_exact_linux_capabilities(capabilities, expected)
                )

    def test_helper_capabilities_reject_ambiguous_or_expanded_inventory(self) -> None:
        expected = ("CHOWN", "DAC_OVERRIDE")
        for capabilities in (
            None,
            "CAP_CHOWN",
            {},
            [],
            ["CAP_CHOWN"],
            ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_SYS_ADMIN"],
            ["CHOWN", "CAP_CHOWN", "DAC_OVERRIDE"],
            ["CAP_", "CAP_DAC_OVERRIDE"],
            ["CAP_CAP_CHOWN", "CAP_DAC_OVERRIDE"],
            ["cap_chown", "CAP_DAC_OVERRIDE"],
            [1, "CAP_DAC_OVERRIDE"],
        ):
            with self.subTest(capabilities=capabilities):
                self.assertFalse(
                    MODULE.has_exact_linux_capabilities(capabilities, expected)
                )

    def test_volume_inspect_treats_exact_lowercase_engine_absence_as_missing(self) -> None:
        volume = "diva_qdrant_candidate_20260902T112002Z-1063826"

        class MissingVolumeRunner:
            def __init__(self, detail: str) -> None:
                self.detail = detail

            def docker_read(self, *arguments: str) -> str:
                self.arguments = arguments
                raise MODULE.UpgradeError(
                    f"command failed (1): /usr/bin/docker: {self.detail}"
                )

        absences = (
            f"Error response from daemon: get {volume}: no such volume",
            f"Error response from daemon: No such volume: {volume}",
            f"Error: No such volume: {volume}",
        )
        for detail in absences:
            runner = MissingVolumeRunner(detail)
            with self.subTest(detail=detail):
                self.assertIsNone(MODULE.inspect_one(runner, "volume", volume))
                self.assertEqual(runner.arguments, ("volume", "inspect", volume))

    def test_volume_inspect_does_not_hide_unbound_lowercase_errors(self) -> None:
        volume = "diva_qdrant_candidate_20260902T112002Z-1063826"

        class FailingRunner:
            def __init__(self, detail: str) -> None:
                self.detail = detail

            def docker_read(self, *_arguments: str) -> str:
                raise MODULE.UpgradeError(
                    f"command failed (1): /usr/bin/docker: {self.detail}"
                )

        failures = (
            "Error response from daemon: get another_volume: no such volume",
            "exec /usr/bin/docker: no such file or directory",
            "exec /usr/bin/docker: No such file or directory",
            "Error response from daemon: endpoint not found",
            "Error response from daemon: No such volume: another_volume",
            "Error: No such volume: DIVA_QDRANT_CANDIDATE_20260902T112002Z-1063826",
        )
        for detail in failures:
            with self.subTest(detail=detail), self.assertRaises(MODULE.UpgradeError):
                MODULE.inspect_one(FailingRunner(detail), "volume", volume)

    def test_standalone_process_boundary_is_root_only_and_rejects_docker_routing(self) -> None:
        for key in (
            "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
            "DOCKER_TLS_FUTURE_ENDPOINT",
        ):
            with self.subTest(key=key), self.assertRaises(MODULE.UpgradeError):
                MODULE.establish_standalone_boundary(
                    {key: ""}, effective_uid=0, effective_gid=0
                )
        with self.assertRaises(MODULE.UpgradeError):
            MODULE.establish_standalone_boundary({}, effective_uid=1000, effective_gid=1000)
        with self.assertRaises(MODULE.UpgradeError):
            MODULE.establish_standalone_boundary(
                {MODULE.TEST_MODE_ENV: "1", MODULE.TEST_STATE_ROOT_ENV: "/tmp/qdrant-test"},
                effective_uid=0,
                effective_gid=0,
            )
        for incomplete in (
            {MODULE.TEST_MODE_ENV: "1"},
            {MODULE.TEST_STATE_ROOT_ENV: "/tmp/qdrant-test"},
            {MODULE.TEST_MODE_ENV: "0", MODULE.TEST_STATE_ROOT_ENV: "/tmp/qdrant-test"},
        ):
            with self.subTest(incomplete=incomplete), self.assertRaises(MODULE.UpgradeError):
                MODULE.establish_standalone_boundary(
                    incomplete, effective_uid=1000, effective_gid=1000
                )

    def test_standalone_paths_are_exact_and_never_create_or_chmod_the_parent(self) -> None:
        run_id = "20260831T010203Z-123"
        with tempfile.TemporaryDirectory() as temporary:
            state_root = Path(temporary) / "state"
            run_directory = state_root / f"stateful-{run_id}"
            state_root.mkdir(mode=0o700)
            run_directory.mkdir(mode=0o700)
            fixture_uid = getattr(os, "geteuid", lambda: 1000)()
            fixture_gid = getattr(os, "getegid", lambda: 1000)()
            if os.name == "posix" and fixture_uid == 0:
                fixture_uid = 1000
                fixture_gid = 1000
                os.chown(state_root, fixture_uid, fixture_gid)
                os.chown(run_directory, fixture_uid, fixture_gid)
            os.chmod(state_root, 0o700)
            os.chmod(run_directory, 0o700)
            if os.name == "posix":
                for path in (state_root, run_directory):
                    info = path.stat()
                    self.assertEqual((info.st_uid, info.st_gid), (fixture_uid, fixture_gid))
                    self.assertEqual(stat.S_IMODE(info.st_mode), 0o700)
            boundary = MODULE.establish_standalone_boundary(
                {
                    MODULE.TEST_MODE_ENV: "1",
                    MODULE.TEST_STATE_ROOT_ENV: str(state_root),
                },
                effective_uid=fixture_uid,
                effective_gid=fixture_gid,
            )
            arguments = types.SimpleNamespace(
                run_id=run_id,
                journal=str(run_directory / MODULE.JOURNAL_BASENAME),
                output=str(run_directory / MODULE.RESULT_BASENAME),
                docker="fake-docker",
            )
            MODULE.validate_standalone_paths(arguments, boundary)
            if os.name == "posix":
                wrong_owner = MODULE.StandaloneBoundary(
                    state_root, fixture_uid + 1, fixture_gid, True
                )
                with self.assertRaisesRegex(
                    MODULE.UpgradeError, "private state directory metadata is unsafe"
                ):
                    MODULE.validate_standalone_paths(arguments, wrong_owner)
            before_mode = stat.S_IMODE(run_directory.stat().st_mode)
            arguments.output = str(state_root / MODULE.RESULT_BASENAME)
            with self.assertRaises(MODULE.UpgradeError):
                MODULE.validate_standalone_paths(arguments, boundary)
            self.assertEqual(stat.S_IMODE(run_directory.stat().st_mode), before_mode)

        controller_init = SOURCE[
            SOURCE.index("    def __init__(self, arguments: argparse.Namespace) -> None:"):
            SOURCE.index("    def mutation(")
        ]
        self.assertNotIn("mkdir", controller_init)
        self.assertNotIn("chmod", controller_init)

    def test_production_standalone_paths_use_only_the_fixed_root_and_children(self) -> None:
        run_id = "20260831T010203Z-123"
        run_directory = MODULE.PRODUCTION_STATE_ROOT / f"stateful-{run_id}"
        boundary = MODULE.establish_standalone_boundary(
            {}, effective_uid=0, effective_gid=0
        )
        arguments = types.SimpleNamespace(
            run_id=run_id,
            journal=str(run_directory / MODULE.JOURNAL_BASENAME),
            output=str(run_directory / MODULE.RESULT_BASENAME),
            docker="/usr/bin/docker",
        )
        with mock.patch.object(MODULE, "_require_trusted_system_directory") as ancestry, \
                mock.patch.object(MODULE, "_require_secure_directory") as directory, \
                mock.patch.object(MODULE, "_require_secure_regular_or_absent") as output:
            MODULE.validate_standalone_paths(arguments, boundary)
        self.assertEqual(
            [call.args[0] for call in ancestry.call_args_list],
            [Path("/"), Path("/var"), Path("/var/lib")],
        )
        self.assertEqual(
            [call.args[0] for call in directory.call_args_list],
            [MODULE.PRODUCTION_STATE_ROOT, run_directory],
        )
        self.assertEqual(
            [call.args[0] for call in output.call_args_list],
            [
                run_directory / MODULE.JOURNAL_BASENAME,
                run_directory / MODULE.RESULT_BASENAME,
            ],
        )
        for changed in (
            {"journal": "/tmp/qdrant-storage-upgrade.json"},
            {"output": "/tmp/qdrant-storage-upgrade-result.json"},
            {"docker": "docker"},
        ):
            candidate = types.SimpleNamespace(**vars(arguments))
            for key, value in changed.items():
                setattr(candidate, key, value)
            with self.subTest(changed=changed), self.assertRaises(MODULE.UpgradeError):
                MODULE.validate_standalone_paths(candidate, boundary)

        main_source = SOURCE[SOURCE.index("def main("):SOURCE.index("if __name__ ==")]
        self.assertLess(
            main_source.index("boundary = establish_standalone_boundary()"),
            main_source.index("build_parser().parse_args(argv)"),
        )

    def test_upgrade_chain_is_exact_and_cannot_skip_a_minor(self) -> None:
        self.assertEqual(
            [hop.version for hop in MODULE.HOPS],
            [
                "1.10.1", "1.11.5", "1.12.6", "1.13.6", "1.14.1",
                "1.15.5", "1.16.3", "1.17.1", "1.18.3", "1.19.0",
            ],
        )
        expected = {
            "1.10.1": "f0c9863ac7a98b8a8b01db259de35ae0ae79580bb2ccc685e848db3be9c1879e",
            "1.11.5": "4d7cb5cd2948b61d083581bc1c0a3509ce60ba8eb42e11fd54350d015ea403f6",
            "1.12.6": "b1a8dda0efdfe1443d3ab1847ade77c128af1d6f324af3de8bf6fbd3bd2d3ea2",
            "1.13.6": "d0de18974353178cb0a9bbfe4129e4268122d949a3bd89925fffb9bcfc5b8c1e",
            "1.14.1": "fc59f0ade2574cd64d15888a1095e6991e95ad25d4dd53733aa260c160fab6ac",
            "1.15.5": "48c12634a17d8d54f4e3fb95c2b081668039e6e4517ebba57be1882109199ae7",
            "1.16.3": "9dfabc51ededc48158899a288a19a04de1ab54a11d8c512e1c40eebbd5e2bc92",
            "1.17.1": "9ccb41c57d4297b082bfadeeb985359234c0497e6456a11b824a63a0e7a9cf65",
            "1.18.3": "affb67e1d6f2f93d7d20b90d238a7d4b974d36351c162e73bda794e4b2e03483",
            "1.19.0": "a0e04fe623cb064502cd869cefc1dc7ce359d8edd481063b5bd351c0a0a2c91e",
        }
        self.assertEqual({hop.version: hop.digest for hop in MODULE.HOPS}, expected)
        vulnerable = next(hop for hop in MODULE.HOPS if hop.version == "1.15.5")
        self.assertFalse(vulnerable.unprivileged)

    def test_journal_is_canonical_owner_only_and_resumable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "journal.json"
            initial = self.initial()
            journal = MODULE.DurableJournal(path, copy.deepcopy(initial))
            if os.name == "posix":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.read_bytes(), MODULE.canonical_bytes(json.loads(path.read_bytes())))
            journal.intent("volume.create", "volume-create", "candidate", ["docker", "volume", "create"])
            journal.receipt("volume.create", {"name": "candidate", "driver": "local"})
            resumed = MODULE.DurableJournal(path, copy.deepcopy(initial))
            self.assertTrue(resumed.has_receipt("volume.create"))

    def test_journal_rejects_parameter_drift_tamper_and_receipt_without_intent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "journal.json"
            initial = self.initial()
            journal = MODULE.DurableJournal(path, copy.deepcopy(initial))
            with self.assertRaises(MODULE.UpgradeError):
                journal.receipt("missing", {"status": "impossible"})
            changed = copy.deepcopy(initial)
            changed["old"]["containerId"] = "f" * 64
            with self.assertRaises(MODULE.UpgradeError):
                MODULE.DurableJournal(path, changed)
            document = json.loads(path.read_text(encoding="utf-8"))
            path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
            os.chmod(path, 0o600)
            with self.assertRaises(MODULE.UpgradeError):
                MODULE.DurableJournal(path, copy.deepcopy(initial))

    def test_root_attested_runtime_is_bounded_canonical_and_never_spawns_a_venv(self) -> None:
        document = {
            "baseExecutable": "/usr/bin/python3.10",
            "contract": "linux-aarch64",
            "executable": "/srv/diva-data-pipeline/ml_pipeline/.venv/bin/python",
            "gid": 1000,
            "lockSha256": "1" * 64,
            "patcherSha256": "2" * 64,
            "privilegeBoundary": "uid-gid-no-groups-no-caps-nnp",
            "qdrantClientVersion": "1.19.0",
            "qdrantModule": "/srv/diva-data-pipeline/ml_pipeline/.venv/lib/qdrant_client/__init__.py",
            "runtimeReceiptSha256": "3" * 64,
            "schema": "diva.pipeline-qdrant-probe-runtime.v1",
            "uid": 1000,
            "verifierSha256": "4" * 64,
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime-attestation.json"
            path.write_bytes(MODULE.canonical_bytes(document))
            os.chmod(path, 0o600)
            loaded, digest = MODULE.load_runtime_attestation(str(path))
            self.assertEqual(loaded, document)
            self.assertEqual(digest, MODULE.sha256_bytes(MODULE.canonical_bytes(document)))
            path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
            os.chmod(path, 0o600)
            with self.assertRaises(MODULE.UpgradeError):
                MODULE.load_runtime_attestation(str(path))
        self.assertIn('parser.add_argument("--runtime-attestation", required=True)', SOURCE)
        self.assertNotIn("pipeline_python", SOURCE)
        self.assertNotIn("pipeline_venv", SOURCE)
        self.assertNotIn("qdrant_client", SOURCE)

    def test_volume_projection_binds_storage_identity(self) -> None:
        item = {
            "Name": "candidate",
            "Driver": "local",
            "Scope": "local",
            "Mountpoint": "/var/lib/docker/volumes/candidate/_data",
            "CreatedAt": "2026-08-31T01:02:03Z",
            "Labels": {"com.diva.run": "run"},
            "Options": {},
        }
        projection = MODULE.volume_projection(item)
        self.assertEqual(projection["name"], "candidate")
        self.assertRegex(projection["labelsSha256"], r"^[0-9a-f]{64}$")
        tampered = copy.deepcopy(item)
        tampered["Labels"]["com.diva.run"] = "other"
        self.assertNotEqual(
            MODULE.volume_projection(tampered)["labelsSha256"],
            projection["labelsSha256"],
        )

    def test_hop_runtime_rejects_ports_second_network_and_old_volume(self) -> None:
        image_id = "sha256:" + "a" * 64
        item = {
            "Id": "b" * 64,
            "Image": image_id,
            "Config": {"User": "1000:1000"},
            "HostConfig": {
                "PortBindings": {},
                "ReadonlyRootfs": True,
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges"],
            },
            "Mounts": [{
                "Type": "volume", "Name": "candidate", "Destination": "/qdrant/storage",
            }],
            "NetworkSettings": {"Networks": {"upgrade": {}}},
            "State": {"Running": True},
        }
        projection = MODULE.container_projection(item, "candidate", "upgrade", image_id)
        self.assertTrue(projection["running"])
        mutations = {
            "public-port": lambda value: value["HostConfig"].__setitem__(
                "PortBindings", {"6333/tcp": [{"HostIp": "0.0.0.0", "HostPort": "6333"}]}
            ),
            "second-network": lambda value: value["NetworkSettings"]["Networks"].__setitem__(
                "backend_default", {}
            ),
            "old-volume": lambda value: value["Mounts"][0].__setitem__("Name", "backend_qdrant_data"),
            "root": lambda value: value["Config"].__setitem__("User", "0:0"),
        }
        for label, mutation in mutations.items():
            with self.subTest(label=label):
                changed = copy.deepcopy(item)
                mutation(changed)
                with self.assertRaises(MODULE.UpgradeError):
                    MODULE.container_projection(changed, "candidate", "upgrade", image_id)

    def test_run_unique_names_and_ids_are_fail_closed(self) -> None:
        self.assertEqual(MODULE.require_name("diva_qdrant_candidate_run-1", "test"), "diva_qdrant_candidate_run-1")
        for value in ("", "../candidate", "candidate/name", "candidate name", "-candidate"):
            with self.subTest(value=value), self.assertRaises(MODULE.UpgradeError):
                MODULE.require_name(value, "test")
        with self.assertRaises(MODULE.UpgradeError):
            MODULE.require_image_id("sha256:" + "g" * 64, "test")

    def test_upgrade_hops_have_no_public_port_or_implicit_cleanup(self) -> None:
        start_hop = SOURCE[SOURCE.index("    def start_hop("):SOURCE.index("    def probe_curl(")]
        self.assertIn('"--network", self.network', start_hop)
        self.assertIn('"--restart", "no"', start_hop)
        self.assertNotIn("--publish", start_hop)
        self.assertNotIn('"--rm"', SOURCE)
        clone = SOURCE[
            SOURCE.index("    def clone_volume("):
            SOURCE.index("    def chown_candidate_fd_safe(")
        ]
        self.assertIn('(self.old["volume"], "/source", True)', clone)
        self.assertNotIn('(self.old["volume"], "/source", False)', clone)

    def test_candidate_ownership_is_fd_safe_separate_and_content_checked(self) -> None:
        ownership = SOURCE[
            SOURCE.index("    def chown_candidate_fd_safe("):
            SOURCE.index("    def hop_name(")
        ]
        self.assertIn('getattr(os, "O_NOFOLLOW", 0)', ownership)
        self.assertIn("os.scandir(directory_fd)", ownership)
        self.assertIn("opened.st_dev, opened.st_ino", ownership)
        self.assertIn("candidate ownership walk crossed a device boundary", ownership)
        self.assertIn("os.fchown(file_fd, 1000, 1000)", ownership)
        self.assertIn('"oldVolumeUntouched": self.old["volume"]', ownership)
        self.assertNotIn("chown -R", ownership)
        run_body = SOURCE[SOURCE.index("    def run(self) -> dict[str, Any]:"):]
        self.assertIn('old_before["nonRootOwned"] != "0"', run_body)
        self.assertIn('candidate_owned["logicalStructure"] != candidate_clone["logicalStructure"]', run_body)
        self.assertIn('candidate_owned["content"] != candidate_clone["content"]', run_body)
        self.assertIn('candidate_owned["nonRootlessOwned"] != "0"', run_body)
        self.assertIn("if old_after_chown != old_before", run_body)

    def test_scratch_runtime_and_offline_audit_images_are_distinct_and_attested(self) -> None:
        self.assertIn('parser.add_argument("--audit-image-id", required=True)', SOURCE)
        self.assertIn('RUNTIME_CONTRACT = "rootless-readonly-scratch-v3"', SOURCE)
        self.assertEqual(
            MODULE.RUNTIME_COMMAND,
            ["--config-path", "/qdrant/config/production.yaml"],
        )
        self.assertEqual(
            MODULE.RUNTIME_ENV,
            [
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "QDRANT__STORAGE__SNAPSHOTS_PATH=/qdrant/storage/snapshots",
                "QDRANT__TELEMETRY_DISABLED=true",
            ],
        )
        self.assertIn('"offline-storage-audit-v3-alpine"', SOURCE)
        self.assertIn('parser.add_argument("--audit-architecture", required=True)', SOURCE)
        self.assertIn('parser.add_argument("--audit-contract-helper-sha256", required=True)', SOURCE)
        self.assertIn('"x86_64": {', SOURCE)
        self.assertIn('"aarch64": {', SOURCE)
        self.assertIn('AUDIT_INVENTORY_SHA256', SOURCE)
        self.assertIn('audit_labels.get("com.diva.qdrant.busybox-binary-sha256")', SOURCE)
        self.assertIn('final_config.get("Entrypoint") != ["/qdrant/qdrant"]', SOURCE)
        self.assertIn('final_config.get("Cmd") != RUNTIME_COMMAND', SOURCE)
        self.assertIn('final_config.get("Env") != RUNTIME_ENV', SOURCE)
        self.assertIn('final_config.get("WorkingDir") != "/qdrant"', SOURCE)
        self.assertIn('final_config.get("Volumes") not in (None, {})', SOURCE)
        self.assertIn('audit_config.get("User") != "65534:65534"', SOURCE)
        self.assertIn('audit_config.get("Entrypoint") != ["/bin/sh"]', SOURCE)
        self.assertIn("def attest_audit_filesystem(self)", SOURCE)
        self.assertIn("'0:0:755:12'", SOURCE)
        self.assertIn('[ -L /bin/sh ] && [ "$(readlink /bin/sh)" = /bin/busybox ]', SOURCE)
        self.assertIn("/lib/apk/db/installed", SOURCE)
        self.assertIn('[ -x "$directory" ] && [ ! -w "$directory" ]', SOURCE)
        self.assertIn('"binarySha256"', SOURCE)
        self.assertIn('"configTreeSha256"', SOURCE)
        self.assertIn('"linksSha256"', SOURCE)
        self.assertIn('parser.add_argument("--runtime-links-sha256", required=True)', SOURCE)

    def test_audit_attester_projection_rejects_runtime_boundary_drift(self) -> None:
        image_id = "sha256:" + "a" * 64
        script = "set -eu\nprintf ok\\n"
        item = {
            "Id": "b" * 64,
            "Image": image_id,
            "Config": {
                "User": "65534:65534",
                "Entrypoint": ["/bin/sh"],
                "Cmd": ["-ec", script],
            },
            "HostConfig": {
                "NetworkMode": "none",
                "PortBindings": {},
                "ReadonlyRootfs": True,
                "CapDrop": ["ALL"],
                "CapAdd": [],
                "Privileged": False,
                "AutoRemove": False,
                "RestartPolicy": {"Name": "no"},
                "SecurityOpt": ["no-new-privileges"],
            },
            "Mounts": [],
            "State": {"Running": False, "ExitCode": 0},
        }
        observed = MODULE.audit_container_projection(item, image_id, script)
        self.assertEqual(observed["user"], "65534:65534")
        mutations = {
            "network": lambda value: value["HostConfig"].__setitem__("NetworkMode", "bridge"),
            "writable-root": lambda value: value["HostConfig"].__setitem__("ReadonlyRootfs", False),
            "root-user": lambda value: value["Config"].__setitem__("User", "0:0"),
            "mount": lambda value: value.__setitem__("Mounts", [{"Source": "/tmp"}]),
            "capability": lambda value: value["HostConfig"].__setitem__("CapAdd", ["CHOWN"]),
            "command": lambda value: value["Config"].__setitem__("Cmd", ["-ec", "true"]),
            "running": lambda value: value["State"].__setitem__("Running", True),
            "failed": lambda value: value["State"].__setitem__("ExitCode", 1),
        }
        for label, mutation in mutations.items():
            with self.subTest(label=label):
                changed = copy.deepcopy(item)
                mutation(changed)
                with self.assertRaises(MODULE.UpgradeError):
                    MODULE.audit_container_projection(changed, image_id, script)

    @unittest.skipUnless(os.name == "posix" and os.geteuid() == 0, "requires POSIX uid 0")
    def test_fd_safe_chown_resumes_partial_candidate_without_touching_old(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old_path = root / "old"
            candidate_path = root / "candidate"
            old_path.mkdir()
            candidate_path.mkdir()
            (old_path / "nested").mkdir()
            (candidate_path / "nested").mkdir()
            payload = b"qdrant-storage-byte-contract\x00"
            (old_path / "nested" / "point.bin").write_bytes(payload)
            (candidate_path / "nested" / "point.bin").write_bytes(payload)
            os.symlink("nested/point.bin", old_path / "point.link")
            os.symlink("nested/point.bin", candidate_path / "point.link")
            for tree in (old_path, candidate_path):
                for directory, names, files in os.walk(tree):
                    os.chown(directory, 0, 0)
                    for name in names + files:
                        os.chown(Path(directory) / name, 0, 0, follow_symlinks=False)
            # Simulate power loss after only one candidate inode was converted.
            os.chown(candidate_path / "nested" / "point.bin", 1000, 1000)

            def volume_item(name: str, mountpoint: Path, role: str) -> dict:
                return {
                    "Name": name,
                    "Driver": "local",
                    "Scope": "local",
                    "Mountpoint": str(mountpoint),
                    "CreatedAt": "2026-08-31T00:00:00Z",
                    "Labels": {"com.diva.role": role},
                    "Options": {},
                }

            old_item = volume_item("old_volume", old_path, "rollback")
            candidate_item = volume_item("candidate_volume", candidate_path, "candidate")
            old_projection = MODULE.volume_projection(old_item)
            candidate_projection = MODULE.volume_projection(candidate_item)
            initial = self.initial()
            initial["old"]["volume"] = "old_volume"
            initial["old"]["volumeIdentity"] = old_projection
            initial["candidate"]["volume"] = "candidate_volume"
            journal = MODULE.DurableJournal(root / "journal.json", initial)
            journal.intent("volume.create", "volume-create", "candidate_volume", ["docker", "volume", "create"])
            journal.receipt("volume.create", candidate_projection)
            controller = object.__new__(MODULE.UpgradeController)
            controller.runner = object()
            controller.journal = journal
            controller.old = {"volume": "old_volume", "volumeIdentity": old_projection}
            controller.candidate_volume = "candidate_volume"

            def inspect_volume(_runner: object, kind: str, reference: str) -> dict | None:
                self.assertEqual(kind, "volume")
                return {"candidate_volume": candidate_item, "old_volume": old_item}.get(reference)

            with mock.patch.object(MODULE, "inspect_one", side_effect=inspect_volume):
                controller.chown_candidate_fd_safe()
                # Re-reading the durable receipt must be a no-op and retain identity.
                controller.chown_candidate_fd_safe()
            self.assertEqual((old_path / "nested" / "point.bin").read_bytes(), payload)
            self.assertEqual((candidate_path / "nested" / "point.bin").read_bytes(), payload)
            for directory, names, files in os.walk(old_path):
                for name in [".", *names, *files]:
                    path = Path(directory) if name == "." else Path(directory) / name
                    info = os.lstat(path)
                    self.assertEqual((info.st_uid, info.st_gid), (0, 0))
            for directory, names, files in os.walk(candidate_path):
                for name in [".", *names, *files]:
                    path = Path(directory) if name == "." else Path(directory) / name
                    info = os.lstat(path)
                    self.assertEqual((info.st_uid, info.st_gid), (1000, 1000))

    def test_intent_receipt_reconcile_does_not_repeat_exact_mutation(self) -> None:
        class FakeRunner:
            def __init__(self) -> None:
                self.calls: list[tuple[str, ...]] = []

            def docker_mutation(self, *arguments: str) -> str:
                self.calls.append(arguments)
                return ""

        with tempfile.TemporaryDirectory() as temporary:
            journal = MODULE.DurableJournal(
                Path(temporary) / "journal.json", copy.deepcopy(self.initial())
            )
            controller = object.__new__(MODULE.UpgradeController)
            controller.arguments = type("Arguments", (), {"docker": "docker"})()
            controller.runner = FakeRunner()
            controller.journal = journal
            state: dict[str, str] = {}

            def observe() -> dict[str, str] | None:
                return {"id": state["id"]} if "id" in state else None

            original_mutation = controller.runner.docker_mutation

            def create(*arguments: str) -> str:
                original_mutation(*arguments)
                state["id"] = "exact"
                return ""

            controller.runner.docker_mutation = create
            first = controller.mutation(
                "candidate.create", "create", "candidate", ("volume", "create", "candidate"), observe
            )
            self.assertEqual(first, {"id": "exact"})
            self.assertEqual(len(controller.runner.calls), 1)
            second = controller.mutation(
                "candidate.create", "create", "candidate", ("volume", "create", "candidate"), observe
            )
            self.assertEqual(second, first)
            self.assertEqual(len(controller.runner.calls), 1)
            with self.assertRaises(MODULE.UpgradeError):
                controller.mutation(
                    "candidate.create", "create", "candidate", ("volume", "rm", "candidate"), observe
                )

    def make_resume_controller(
        self, temporary: str,
    ) -> tuple[object, dict[str, str]]:
        controller = object.__new__(MODULE.UpgradeController)
        controller.arguments = type("Arguments", (), {
            "docker": "docker",
            "run_id": "20260831T010203Z-123",
            "publication_generation": "20260831T000000Z-abc123",
        })()
        controller.candidate_volume = "diva_qdrant_candidate_20260831T010203Z-123"
        controller.network = "diva_qdrant_upgrade_20260831T010203Z-123"
        controller.journal = MODULE.DurableJournal(
            Path(temporary) / "resume-journal.json", copy.deepcopy(self.initial())
        )
        image_ids = {
            hop.version: "sha256:" + format(index + 1, "x") * 64
            for index, hop in enumerate(MODULE.HOPS)
        }
        return controller, image_ids

    def record_completed_hop(
        self, controller: object, hop: object, image_id: str, container_id: str,
    ) -> None:
        records = (
            (
                f"hop.{hop.key}.start", "container-run",
                {
                    "containerId": container_id,
                    "imageId": image_id,
                    "volume": controller.candidate_volume,
                    "network": controller.network,
                    "running": True,
                },
            ),
            (
                f"hop.{hop.key}.validated", "logical-validation",
                {
                    "containerId": container_id,
                    "imageId": image_id,
                    "version": hop.version,
                    "fingerprintSha256": "f" * 64,
                    "publicationGeneration": controller.arguments.publication_generation,
                },
            ),
            (
                f"hop.{hop.key}.stop", "container-stop",
                {"containerId": container_id, "running": False},
            ),
            (
                f"hop.{hop.key}.remove", "container-remove",
                {"containerId": container_id, "absent": True},
            ),
        )
        for key, operation, receipt in records:
            controller.journal.intent(key, operation, container_id, ["docker", operation, container_id])
            controller.journal.receipt(key, receipt)

    def test_resume_skips_completed_prefix_and_never_restarts_older_binary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            controller, image_ids = self.make_resume_controller(temporary)
            for index, hop in enumerate(MODULE.HOPS[:2]):
                self.record_completed_hop(
                    controller, hop, image_ids[hop.version], format(index + 1, "x") * 64
                )
            controller.runner = object()
            controller.assert_hop_receipt_order(image_ids)
            with mock.patch.object(MODULE, "inspect_one", return_value=None), mock.patch.object(
                MODULE, "container_by_name", return_value=None
            ):
                self.assertTrue(controller.completed_hop(MODULE.HOPS[0], image_ids["1.10.1"]))
                self.assertTrue(controller.completed_hop(MODULE.HOPS[1], image_ids["1.11.5"]))
                self.assertFalse(controller.completed_hop(MODULE.HOPS[2], image_ids["1.12.6"]))

    def test_resume_restarts_only_exact_interrupted_hop_container(self) -> None:
        class FakeRunner:
            def __init__(self, item: dict) -> None:
                self.item = item
                self.calls: list[tuple[str, ...]] = []

            def docker_mutation(self, *arguments: str) -> str:
                self.calls.append(arguments)
                if arguments[0] != "start" or arguments[1] != self.item["Id"]:
                    raise AssertionError(f"unexpected mutation: {arguments}")
                self.item["State"]["Running"] = True
                return self.item["Id"]

        with tempfile.TemporaryDirectory() as temporary:
            controller, image_ids = self.make_resume_controller(temporary)
            first = MODULE.HOPS[0]
            image_id = image_ids[first.version]
            container_id = "a" * 64
            item = {
                "Id": container_id,
                "Image": image_id,
                "Config": {"User": "1000:1000"},
                "HostConfig": {
                    "PortBindings": {}, "ReadonlyRootfs": True, "CapDrop": ["ALL"],
                    "SecurityOpt": ["no-new-privileges"],
                },
                "Mounts": [{
                    "Type": "volume", "Name": controller.candidate_volume,
                    "Destination": "/qdrant/storage",
                }],
                "NetworkSettings": {"Networks": {controller.network: {}}},
                "State": {"Running": True},
            }
            controller.runner = FakeRunner(item)
            with mock.patch.object(MODULE, "container_by_name", return_value=item), mock.patch.object(
                MODULE, "inspect_one", side_effect=lambda *_arguments: item
            ):
                initial = controller.start_hop(first, image_id)
                self.assertTrue(initial["running"])
                item["State"]["Running"] = False
                resumed = controller.start_hop(first, image_id)
            self.assertTrue(resumed["running"])
            self.assertEqual(controller.runner.calls, [("start", container_id)])
            self.assertIsNotNone(
                controller.journal.receipt_payload(f"hop.{first.key}.start.restart.1")
            )

    def test_resume_rejects_out_of_order_later_hop_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            controller, image_ids = self.make_resume_controller(temporary)
            second = MODULE.HOPS[1]
            key = f"hop.{second.key}.start"
            container_id = "b" * 64
            controller.journal.intent(key, "container-run", controller.hop_name(second), ["docker", "run"])
            controller.journal.receipt(key, {
                "containerId": container_id,
                "imageId": image_ids[second.version],
                "volume": controller.candidate_volume,
                "network": controller.network,
                "running": True,
            })
            with self.assertRaises(MODULE.UpgradeError):
                controller.assert_hop_receipt_order(image_ids)

    def test_resume_validated_hop_stops_and_removes_without_revalidation(self) -> None:
        class FakeRunner:
            def __init__(self, item: dict) -> None:
                self.item: dict | None = item
                self.calls: list[tuple[str, ...]] = []

            def docker_mutation(self, *arguments: str) -> str:
                self.calls.append(arguments)
                if self.item is None:
                    raise AssertionError("mutation targeted an absent hop")
                if arguments[0] == "stop":
                    self.item["State"]["Running"] = False
                elif arguments[0] == "rm":
                    self.item = None
                else:
                    raise AssertionError(f"unexpected mutation: {arguments}")
                return ""

        for stopped_before_resume in (False, True):
            with self.subTest(stopped_before_resume=stopped_before_resume), tempfile.TemporaryDirectory() as temporary:
                controller, image_ids = self.make_resume_controller(temporary)
                hop = MODULE.HOPS[0]
                image_id = image_ids[hop.version]
                container_id = "c" * 64
                for key, operation, receipt in (
                    (
                        f"hop.{hop.key}.start", "container-run",
                        {
                            "containerId": container_id, "imageId": image_id,
                            "volume": controller.candidate_volume, "network": controller.network,
                            "running": True,
                        },
                    ),
                    (
                        f"hop.{hop.key}.validated", "logical-validation",
                        {
                            "containerId": container_id, "imageId": image_id,
                            "version": hop.version, "fingerprintSha256": "d" * 64,
                            "publicationGeneration": controller.arguments.publication_generation,
                        },
                    ),
                ):
                    controller.journal.intent(key, operation, container_id, ["docker", operation])
                    controller.journal.receipt(key, receipt)
                if stopped_before_resume:
                    stop_key = f"hop.{hop.key}.stop"
                    controller.journal.intent(stop_key, "container-stop", container_id, ["docker", "stop"])
                    controller.journal.receipt(stop_key, {"containerId": container_id, "running": False})
                item = {
                    "Id": container_id, "Image": image_id, "Config": {"User": "1000:1000"},
                    "HostConfig": {
                        "PortBindings": {}, "ReadonlyRootfs": True, "CapDrop": ["ALL"],
                        "SecurityOpt": ["no-new-privileges"],
                    },
                    "Mounts": [{
                        "Type": "volume", "Name": controller.candidate_volume,
                        "Destination": "/qdrant/storage",
                    }],
                    "NetworkSettings": {"Networks": {controller.network: {}}},
                    "State": {"Running": not stopped_before_resume},
                }
                controller.runner = FakeRunner(item)

                def inspect_current(*_arguments: object) -> dict | None:
                    return controller.runner.item

                with mock.patch.object(MODULE, "inspect_one", side_effect=inspect_current), mock.patch.object(
                    MODULE, "container_by_name", side_effect=lambda *_arguments: controller.runner.item
                ):
                    self.assertTrue(controller.reconcile_validated_hop(hop, image_id))
                expected = [("rm", container_id)] if stopped_before_resume else [
                    ("stop", "--time", "120", container_id), ("rm", container_id),
                ]
                self.assertEqual(controller.runner.calls, expected)
                self.assertEqual(
                    controller.journal.receipt_payload(f"hop.{hop.key}.validated")["fingerprintSha256"],
                    "d" * 64,
                )
                self.assertIsNotNone(controller.journal.receipt_payload(f"hop.{hop.key}.remove"))

    def test_resume_hardened_final_keeps_original_mutable_fingerprint_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            controller, _ = self.make_resume_controller(temporary)
            image_id = "sha256:" + "e" * 64
            container_id = "f" * 64
            key = "final.hardened.validated"
            controller.journal.intent(key, "logical-validation", container_id, ["validate"])
            controller.journal.receipt(key, {
                "containerId": container_id,
                "imageId": image_id,
                "version": MODULE.HOPS[-1].version,
                "fingerprintSha256": "1" * 64,
                "publicationGeneration": controller.arguments.publication_generation,
            })
            self.assertTrue(controller.validate_hardened_final_receipt(
                {
                    "containerId": container_id, "imageId": image_id,
                    "volume": controller.candidate_volume, "network": controller.network,
                    "running": True,
                },
                image_id,
            ))
            self.assertEqual(
                controller.journal.receipt_payload(key)["fingerprintSha256"], "1" * 64
            )


if __name__ == "__main__":
    unittest.main()
