#!/usr/bin/env python3
"""Fault tests for crash-safe SBC API bridge receipt consumption."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path


HELPER = Path(__file__).with_name("sbc-api-bridge-consumption.py")
HARDENER = Path(__file__).with_name("harden-sbc-stateful-services.sh")
TEST_BOOT_ID = "00000000-0000-4000-8000-000000000001"
TEST_START_TICKS = 424242


def load_helper():
    specification = importlib.util.spec_from_file_location(
        "sbc_api_bridge_consumption", HELPER
    )
    assert specification and specification.loader
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    if os.name == "nt":
        module._fsync_directory = lambda _path: None
        module._fsync_file = lambda _path: None
        module._current_boot_id = lambda: TEST_BOOT_ID
        module._process_start_ticks = (
            lambda pid: TEST_START_TICKS if pid == os.getpid() else None
        )
    return module


def write_owner_file(path: Path, payload: bytes) -> None:
    path.write_bytes(payload)
    os.chmod(path, 0o600)


def dead_pid(module) -> int:
    candidate = 900_000
    while module._process_start_ticks(candidate) is not None:
        candidate += 1
    return candidate


def build_fixture(module, root: Path, *, reason: str, owner_pid: int | None = None,
                  owner_boot_id: str | None = None,
                  owner_start_ticks: int | None = None,
                  incomplete: bool = False,
                  calibration_status: str | None = None) -> dict[str, object]:
    assert reason in {"calibration", "completed"}
    state_root = root / "state"
    state_root.mkdir(mode=0o700)
    os.chmod(state_root, 0o700)
    run_id = "20260831T000000Z-12345"
    run_dir = state_root / f"stateful-{run_id}"
    run_dir.mkdir(mode=0o700)
    os.chmod(run_dir, 0o700)
    receipt = state_root / "api-bridge-receipt.json"
    receipt_payload = b'{"receipt":"frozen"}\n'
    write_owner_file(receipt, receipt_payload)
    receipt_sha = hashlib.sha256(receipt_payload).hexdigest()
    active = state_root / "stateful-hardening-active"
    write_owner_file(active, (str(run_dir) + "\n").encode("utf-8"))
    lock_dir = state_root / "stateful-hardening.lock"
    lock_dir.mkdir(mode=0o700)
    os.chmod(lock_dir, 0o700)
    pid = dead_pid(module) if owner_pid is None else owner_pid
    boot_id = module._current_boot_id() if owner_boot_id is None else owner_boot_id
    observed_start = module._process_start_ticks(pid)
    start_ticks = owner_start_ticks or observed_start or 1
    write_owner_file(
        lock_dir / "owner",
        module._owner_payload(module.OwnerIdentity(
            pid=pid,
            run_id=run_id,
            boot_id=boot_id,
            start_ticks=start_ticks,
        )),
    )
    state_lines = [
        f"run.id={run_id}",
        f"api_bridge.receipt_sha256={receipt_sha}",
    ]
    runtime_contract = state_root / "stateful-runtime-contract"
    if incomplete:
        state_lines.append("deployment.status=preflight")
    elif reason == "calibration":
        if calibration_status is None:
            calibration_status = module.CURRENT_CALIBRATION_IMAGE_SCAN_STATUS
        state_lines.extend((
            "deployment.status=preflight",
            f"image_scan.status={calibration_status}",
        ))
    else:
        state_lines.extend((
            "deployment.status=verified",
            "promotion.status=durable-promoted",
            "pipeline_writer.status=released",
        ))
        write_owner_file(
            run_dir / "promoted",
            f"status=promoted\nrun={run_id}\n".encode("ascii"),
        )
        write_owner_file(
            run_dir / "completed",
            f"status=completed\nrun={run_id}\n".encode("ascii"),
        )
        write_owner_file(
            runtime_contract,
            f"schema=1\nstatus=completed\nrun={run_id}\n".encode("ascii"),
        )
    write_owner_file(
        run_dir / "state", ("\n".join(state_lines) + "\n").encode("utf-8")
    )
    archive = run_dir / f"api-bridge-receipt.{reason}.{receipt_sha}.json"
    return {
        "state_root": state_root,
        "run_id": run_id,
        "run_dir": run_dir,
        "receipt": receipt,
        "receipt_payload": receipt_payload,
        "receipt_sha": receipt_sha,
        "active": active,
        "lock_dir": lock_dir,
        "runtime_contract": runtime_contract,
        "archive": archive,
        "intent": state_root / "api-bridge-consume-intent.json",
        "reason": reason,
    }


def pre_mutation_state_payload(run_id: str, receipt_sha: str, *extra: str) -> bytes:
    lines = [
        f"run.id={run_id}",
        "deployment.status=preflight",
        f"api_bridge.receipt_sha256={receipt_sha}",
        "api_bridge.attestation_anchor_created_at=2026-09-02T05:52:40Z",
        f"api_bridge.receipt_sha256={receipt_sha}",
        "api_bridge.verify_count=1",
        "deployment.status=building-qdrant",
        "deployment.status=preparing-postgres",
        "deployment.status=scanning-all-runtime-images",
        "image_scan.status=all-exact-receipts-verified",
        "deployment.status=quiescing-pipeline-writers",
        "backup.freshness=revalidated-before-writer-quiescence",
        "pipeline_writer.status=gating",
        "pipeline_writer.status=refused-busy",
        *extra,
        "deployment.status=failed",
    ]
    return ("\n".join(lines) + "\n").encode("utf-8")


def rollback_scan_failure_state_payload(
    run_id: str,
    receipt_sha: str,
    candidate_receipts: dict[str, str],
    *extra: str,
) -> bytes:
    lines = [
        f"run.id={run_id}",
        "deployment.status=preflight",
        f"api_bridge.receipt_sha256={receipt_sha}",
        "api_bridge.attestation_anchor_created_at=2026-09-02T23:35:01Z",
        f"api_bridge.receipt_sha256={receipt_sha}",
        "api_bridge.verify_count=1",
        "deployment.status=building-qdrant",
        "deployment.status=preparing-postgres",
        "deployment.status=scanning-all-runtime-images",
        *(
            f"image_scan.{service}.receipt_sha256={candidate_receipts[service]}"
            for service in (
                "qdrant-runtime",
                "qdrant-audit",
                "postgres-runtime",
                "postgres-migrate",
            )
        ),
        *extra,
        "deployment.status=failed",
    ]
    return ("\n".join(lines) + "\n").encode("utf-8")


def install_rollback_scan_failure_evidence(run_dir: Path) -> dict[str, str]:
    evidence = run_dir / "evidence"
    evidence.mkdir(mode=0o700)
    os.chmod(evidence, 0o700)
    candidate_receipts: dict[str, str] = {}
    for service in (
        "qdrant-runtime",
        "qdrant-audit",
        "postgres-runtime",
        "postgres-migrate",
    ):
        receipt_payload = (
            '{"service":"' + service + '","status":"verified"}\n'
        ).encode("ascii")
        candidate_receipts[service] = hashlib.sha256(receipt_payload).hexdigest()
        write_owner_file(
            evidence / f"image-scan-{service}.json",
            (f'{{"report":"{service}"}}\n').encode("ascii"),
        )
        write_owner_file(
            evidence / f"image-scan-{service}.receipt.json",
            receipt_payload,
        )
        write_owner_file(
            evidence / f"image-scan-{service}.validation.json",
            b'{"status":"validated"}\n',
        )
        write_owner_file(
            evidence / f"image-scan-{service}.verification.json",
            b'{"status":"verified"}\n',
        )
    write_owner_file(
        evidence / "image-scan-qdrant-rollback.json",
        b'{"report":"qdrant-rollback","vulnerabilities":1}\n',
    )
    write_owner_file(
        evidence / "image-scan-qdrant-rollback.validation.json",
        b"",
    )
    return candidate_receipts


def build_pre_mutation_fixture(
    module,
    root: Path,
    *,
    rollback_scan_failure_indices: tuple[int, ...] = (),
    run_count: int = 2,
) -> dict[str, object]:
    assert 1 <= run_count <= module.MAX_PRE_MUTATION_RELATED_RUNS + 1
    state_root = root / "state"
    state_root.mkdir(mode=0o700)
    os.chmod(state_root, 0o700)
    receipt = state_root / "api-bridge-receipt.json"
    receipt_payload = b'{"receipt":"pre-mutation-frozen"}\n'
    write_owner_file(receipt, receipt_payload)
    receipt_sha = hashlib.sha256(receipt_payload).hexdigest()
    baseline_run_ids = (
        "20260902T060832Z-614808",
        "20260902T064512Z-620001",
    )
    run_ids = baseline_run_ids[:run_count]
    if run_count > len(baseline_run_ids):
        run_ids += tuple(
            f"20260902T07{index:04d}Z-{630000 + index}"
            for index in range(run_count - len(baseline_run_ids))
        )
    bindings = []
    run_dirs = []
    state_payloads = []
    for index, run_id in enumerate(run_ids):
        run_dir = state_root / ("stateful-" + run_id)
        run_dir.mkdir(mode=0o700)
        os.chmod(run_dir, 0o700)
        if index in rollback_scan_failure_indices:
            candidate_receipts = install_rollback_scan_failure_evidence(run_dir)
            state_payload = rollback_scan_failure_state_payload(
                run_id, receipt_sha, candidate_receipts
            )
        else:
            state_payload = pre_mutation_state_payload(run_id, receipt_sha)
        write_owner_file(run_dir / "state", state_payload)
        bindings.append(module.RunBinding(
            run_id=run_id,
            state_sha256=hashlib.sha256(state_payload).hexdigest(),
        ))
        run_dirs.append(run_dir)
        state_payloads.append(state_payload)
    archive_run_id = run_ids[-1]
    archive = (
        run_dirs[-1]
        / f"api-bridge-receipt.{module.PRE_MUTATION_REASON}.{receipt_sha}.json"
    )
    return {
        "state_root": state_root,
        "receipt": receipt,
        "receipt_payload": receipt_payload,
        "receipt_sha": receipt_sha,
        "active": state_root / "stateful-hardening-active",
        "lock_dir": state_root / "stateful-hardening.lock",
        "runtime_contract": state_root / "stateful-runtime-contract",
        "intent": state_root / "api-bridge-consume-intent.json",
        "run_ids": run_ids,
        "run_dirs": tuple(run_dirs),
        "state_payloads": tuple(state_payloads),
        "related_runs": tuple(bindings),
        "archive_run_id": archive_run_id,
        "archive": archive,
        "settlement": Path(str(archive) + ".consumption-settlement.json"),
    }


def retire_pre_mutation(module, fixture: dict[str, object],
                        checkpoint=lambda _phase: None, **overrides):
    arguments = {
        "canonical": fixture["receipt"],
        "intent_path": fixture["intent"],
        "state_root": fixture["state_root"],
        "active": fixture["active"],
        "lock_dir": fixture["lock_dir"],
        "runtime_contract": fixture["runtime_contract"],
        "archive_run_id": fixture["archive_run_id"],
        "expected_sha": fixture["receipt_sha"],
        "related_runs": fixture["related_runs"],
        "checkpoint": checkpoint,
    }
    arguments.update(overrides)
    return module.retire_pre_mutation(
        **arguments,
    )


def refresh_pre_mutation_binding(module, fixture: dict[str, object], index: int) -> None:
    state = fixture["run_dirs"][index] / "state"
    payload = state.read_bytes()
    bindings = list(fixture["related_runs"])
    bindings[index] = module.RunBinding(
        run_id=fixture["run_ids"][index],
        state_sha256=hashlib.sha256(payload).hexdigest(),
    )
    fixture["related_runs"] = tuple(bindings)


def assert_pre_mutation_settled(module, fixture: dict[str, object]) -> None:
    assert not os.path.lexists(fixture["receipt"])
    assert not os.path.lexists(fixture["intent"])
    assert not os.path.lexists(Path(str(fixture["intent"]) + ".prepared"))
    archive = fixture["archive"]
    assert archive.read_bytes() == fixture["receipt_payload"]
    assert archive.lstat().st_nlink == 1
    settlement = module._validate_settlement(fixture["settlement"])
    assert settlement["schemaVersion"] == 2
    assert settlement["reason"] == module.PRE_MUTATION_REASON
    assert settlement["runId"] == fixture["archive_run_id"]
    assert settlement["receiptSha256"] == fixture["receipt_sha"]
    assert settlement["relatedRuns"] == module._run_binding_documents(
        fixture["related_runs"]
    )
    for run_dir, expected in zip(
        fixture["run_dirs"], fixture["state_payloads"], strict=True
    ):
        assert (run_dir / "state").read_bytes() == expected
    repeated = retire_pre_mutation(module, fixture)
    assert repeated == settlement


def consume(module, fixture: dict[str, object], checkpoint=lambda _phase: None):
    return module.consume(
        canonical=fixture["receipt"],
        archive=fixture["archive"],
        intent_path=fixture["intent"],
        reason=fixture["reason"],
        run_id=fixture["run_id"],
        state_root=fixture["state_root"],
        active=fixture["active"],
        lock_dir=fixture["lock_dir"],
        expected_sha=fixture["receipt_sha"],
        checkpoint=checkpoint,
    )


def exercise_consume_cli(module) -> None:
    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-consume-cli.") as temporary:
        fixture = build_fixture(module, Path(temporary), reason="calibration")
        previous_argv = sys.argv
        output = io.StringIO()
        try:
            sys.argv = [
                str(HELPER),
                "consume",
                "--canonical", str(fixture["receipt"]),
                "--archive", str(fixture["archive"]),
                "--intent", str(fixture["intent"]),
                "--reason", str(fixture["reason"]),
                "--run-id", str(fixture["run_id"]),
                "--state-root", str(fixture["state_root"]),
                "--active-journal", str(fixture["active"]),
                "--lock-dir", str(fixture["lock_dir"]),
                "--expected-sha256", str(fixture["receipt_sha"]),
            ]
            with redirect_stdout(output):
                assert module.main() == 0
        finally:
            sys.argv = previous_argv
        settlement = json.loads(output.getvalue())
        assert settlement["receiptSha256"] == fixture["receipt_sha"]
        assert settlement["status"] == "consumed-single-link-archive"
        assert reconcile(module, fixture) == "calibration"
        assert_settled(module, fixture)


def reconcile(module, fixture: dict[str, object], checkpoint=lambda _phase: None) -> str:
    return module.startup_reconcile(
        state_root=fixture["state_root"],
        canonical=fixture["receipt"],
        intent_path=fixture["intent"],
        active=fixture["active"],
        lock_dir=fixture["lock_dir"],
        runtime_contract=fixture["runtime_contract"],
        checkpoint=checkpoint,
    )


def assert_settled(module, fixture: dict[str, object]) -> None:
    archive = fixture["archive"]
    settlement = Path(str(archive) + ".consumption-settlement.json")
    assert not os.path.lexists(fixture["receipt"])
    archive_info = archive.lstat()
    assert stat.S_ISREG(archive_info.st_mode)
    assert archive_info.st_nlink == 1
    assert archive.read_bytes() == fixture["receipt_payload"]
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == fixture["receipt_sha"]
    module._validate_settlement(settlement)
    assert not os.path.lexists(fixture["intent"])
    assert not os.path.lexists(Path(str(fixture["intent"]) + ".prepared"))
    assert not os.path.lexists(fixture["active"])
    assert not os.path.lexists(fixture["lock_dir"])
    assert reconcile(module, fixture) == "none"


def exercise_fault_matrix(module) -> None:
    phases = (
        "intent-after-prepared-write",
        "intent-after-prepared-file-fsync",
        "intent-after-link",
        "intent-after-canonical-file-fsync",
        "intent-after-canonical-directory-fsync",
        "intent-after-prepared-unlink",
        "intent-after-prepared-directory-fsync",
        "receipt-after-archive-link",
        "receipt-after-archive-file-fsync",
        "receipt-after-archive-directory-fsync",
        "receipt-after-canonical-unlink",
        "receipt-after-canonical-directory-fsync",
        "receipt-after-single-link-file-fsync",
        "receipt-after-final-archive-directory-fsync",
        "settlement-after-prepared-write",
        "settlement-after-prepared-file-fsync",
        "settlement-after-link",
        "settlement-after-canonical-file-fsync",
        "settlement-after-canonical-directory-fsync",
        "settlement-after-prepared-unlink",
        "settlement-after-prepared-directory-fsync",
        "intent-after-unlink",
        "intent-after-unlink-directory-fsync",
    )
    for index, phase in enumerate(phases):
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-consume-{index}."
        ) as temporary:
            fixture = build_fixture(module, Path(temporary), reason="calibration")

            def fail_at(observed: str, *, expected: str = phase) -> None:
                if observed == expected:
                    raise RuntimeError(f"injected fault at {expected}")

            try:
                consume(module, fixture, fail_at)
            except RuntimeError as error:
                assert "injected fault" in str(error), (phase, error)
            else:
                raise AssertionError(f"fault at {phase} did not interrupt consumption")
            try:
                reconciliation = reconcile(module, fixture)
            except RuntimeError as error:
                raise AssertionError(
                    f"reconciliation failed after injected phase {phase}: {error}"
                ) from error
            assert reconciliation == "calibration", phase
            assert_settled(module, fixture)


def exercise_empty_prepared_recovery(module) -> None:
    discard_phases = (
        "after-empty-prepared-unlink",
        "after-empty-prepared-directory-fsync",
    )
    for index, suffix in enumerate(discard_phases):
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-empty-intent-{index}."
        ) as temporary:
            fixture = build_fixture(module, Path(temporary), reason="calibration")
            prepared = Path(str(fixture["intent"]) + ".prepared")
            write_owner_file(prepared, b"")
            expected = "intent-" + suffix

            def fail_at(observed: str, *, target: str = expected) -> None:
                if observed == target:
                    raise RuntimeError(f"injected empty intent fault at {target}")

            try:
                reconcile(module, fixture, fail_at)
            except RuntimeError as error:
                assert "injected empty intent fault" in str(error), error
            else:
                raise AssertionError(f"empty intent fault at {expected} did not interrupt")
            assert not os.path.lexists(prepared)
            assert reconcile(module, fixture) == "calibration"
            assert_settled(module, fixture)

    for index, suffix in enumerate(discard_phases):
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-empty-settlement-{index}."
        ) as temporary:
            fixture = build_fixture(module, Path(temporary), reason="calibration")

            def stop_after_receipt(phase: str) -> None:
                if phase == "receipt-after-final-archive-directory-fsync":
                    raise RuntimeError("pause before settlement publication")

            try:
                consume(module, fixture, stop_after_receipt)
            except RuntimeError as error:
                assert "pause before settlement publication" in str(error)
            else:
                raise AssertionError("settlement staging setup did not interrupt")
            prepared = Path(
                str(fixture["archive"])
                + ".consumption-settlement.json.prepared"
            )
            write_owner_file(prepared, b"")
            expected = "settlement-" + suffix

            def fail_at(observed: str, *, target: str = expected) -> None:
                if observed == target:
                    raise RuntimeError(
                        f"injected empty settlement fault at {target}"
                    )

            try:
                reconcile(module, fixture, fail_at)
            except RuntimeError as error:
                assert "injected empty settlement fault" in str(error), error
            else:
                raise AssertionError(
                    f"empty settlement fault at {expected} did not interrupt"
                )
            assert not os.path.lexists(prepared)
            assert reconcile(module, fixture) == "calibration"
            assert_settled(module, fixture)


def exercise_completed_boundary(module) -> None:
    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-completed.") as temporary:
        fixture = build_fixture(module, Path(temporary), reason="completed")
        consume(module, fixture)
        assert reconcile(module, fixture) == "completed"
        assert_settled(module, fixture)


def exercise_calibration_status_contract(module) -> None:
    hardener = HARDENER.read_text(encoding="utf-8")
    assert (
        "record_state image_scan.status "
        + module.CURRENT_CALIBRATION_IMAGE_SCAN_STATUS
    ) in hardener

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-current-calibration."
    ) as temporary:
        fixture = build_fixture(module, Path(temporary), reason="calibration")
        assert reconcile(module, fixture) == "calibration"
        assert_settled(module, fixture)

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-legacy-calibration."
    ) as temporary:
        fixture = build_fixture(
            module,
            Path(temporary),
            reason="calibration",
            calibration_status="requires-reviewed-exact-inventory-bounds",
        )
        assert reconcile(module, fixture) == "calibration"
        assert_settled(module, fixture)

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-unknown-calibration."
    ) as temporary:
        fixture = build_fixture(
            module,
            Path(temporary),
            reason="calibration",
            calibration_status="requires-reviewed-unknown-contract",
        )
        try:
            reconcile(module, fixture)
        except RuntimeError as error:
            assert "consumable" in str(error)
        else:
            raise AssertionError("an unknown calibration status was accepted")
        assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]

    ambiguous_statuses = (
        (
            "recognized-plus-unknown",
            ("requires-reviewed-unknown-contract",),
        ),
        (
            "current-plus-legacy",
            ("requires-reviewed-exact-inventory-bounds",),
        ),
        (
            "duplicate-current",
            (module.CURRENT_CALIBRATION_IMAGE_SCAN_STATUS,),
        ),
    )
    for label, extra_statuses in ambiguous_statuses:
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-{label}."
        ) as temporary:
            fixture = build_fixture(
                module, Path(temporary), reason="calibration"
            )
            state = fixture["run_dir"] / "state"
            with state.open("ab") as handle:
                for status_value in extra_statuses:
                    handle.write(
                        f"image_scan.status={status_value}\n".encode("ascii")
                    )
            try:
                reconcile(module, fixture)
            except RuntimeError as error:
                assert "ambiguous or divergent" in str(error), (label, error)
            else:
                raise AssertionError(
                    f"ambiguous calibration status was accepted: {label}"
                )
            assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]
            assert os.path.lexists(fixture["active"])
            assert os.path.lexists(fixture["lock_dir"])


def remove_lock(fixture: dict[str, object]) -> None:
    owner = fixture["lock_dir"] / "owner"
    if os.path.lexists(owner):
        owner.unlink()
    fixture["lock_dir"].rmdir()


def append_failed_status(fixture: dict[str, object]) -> None:
    state = fixture["run_dir"] / "state"
    with state.open("ab") as handle:
        handle.write(b"deployment.status=failed\n")


def exercise_release_fault_matrix(module) -> None:
    phases = (
        "lock-after-owner-unlink",
        "lock-after-owner-directory-fsync",
        "lock-after-directory-rmdir",
        "lock-after-state-root-fsync",
        "active-after-unlink",
        "active-after-state-root-fsync",
    )
    for index, phase in enumerate(phases):
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-release-{index}."
        ) as temporary:
            fixture = build_fixture(module, Path(temporary), reason="completed")
            consume(module, fixture)

            def fail_at(observed: str, *, expected: str = phase) -> None:
                if observed == expected:
                    raise RuntimeError(f"injected release fault at {expected}")

            try:
                reconcile(module, fixture, fail_at)
            except RuntimeError as error:
                assert "injected release fault" in str(error), (phase, error)
            else:
                raise AssertionError(f"release fault at {phase} did not interrupt")
            assert reconcile(module, fixture) in {"completed", "none"}, phase
            assert_settled(module, fixture)


def exercise_live_intent_ordering(module) -> None:
    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-live-intent.") as temporary:
        fixture = build_fixture(
            module, Path(temporary), reason="calibration", owner_pid=os.getpid()
        )

        def pause_after_intent(phase: str) -> None:
            if phase == "intent-after-prepared-directory-fsync":
                raise RuntimeError("pause after durable intent")

        try:
            consume(module, fixture, pause_after_intent)
        except RuntimeError as error:
            assert "pause after durable intent" in str(error)
        else:
            raise AssertionError("durable intent pause did not interrupt consumption")
        try:
            reconcile(module, fixture)
        except RuntimeError as error:
            assert "still alive" in str(error)
        else:
            raise AssertionError("a live owner intent was reconciled")
        assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]
        assert not os.path.lexists(fixture["archive"])
        assert os.path.lexists(fixture["intent"])


def exercise_settlement_binding(module) -> None:
    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-settlement-path.") as temporary:
        fixture = build_fixture(module, Path(temporary), reason="calibration")
        unrelated_archive = Path(temporary) / "unrelated-archive.json"
        write_owner_file(unrelated_archive, fixture["receipt_payload"])
        forged_intent = {
            "archivePath": str(unrelated_archive),
            "reason": fixture["reason"],
            "receiptSha256": fixture["receipt_sha"],
            "runId": fixture["run_id"],
        }
        forged_settlement = Path(
            str(fixture["archive"]) + ".consumption-settlement.json"
        )
        write_owner_file(
            forged_settlement,
            module._encode(module._settlement_document(
                forged_intent, unrelated_archive.lstat()
            )),
        )
        try:
            module._validate_settlement(forged_settlement)
        except RuntimeError as error:
            assert "path binding" in str(error)
        else:
            raise AssertionError("an externally bound settlement was accepted")
        assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]
        assert os.path.lexists(fixture["active"])
        assert os.path.lexists(fixture["lock_dir"])

    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-settlement-source.") as temporary:
        fixture = build_fixture(module, Path(temporary), reason="calibration")
        consume(module, fixture)
        write_owner_file(fixture["receipt"], fixture["receipt_payload"])
        try:
            reconcile(module, fixture)
        except RuntimeError as error:
            assert "canonical bridge receipt" in str(error)
        else:
            raise AssertionError("a settlement beside a canonical receipt was accepted")
        assert os.path.lexists(fixture["active"])
        assert os.path.lexists(fixture["lock_dir"])


def exercise_calibration_cleanup_recovery(module) -> None:
    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-calibration-release.") as temporary:
        fixture = build_fixture(module, Path(temporary), reason="calibration")
        consume(module, fixture)
        append_failed_status(fixture)
        remove_lock(fixture)
        assert reconcile(module, fixture) == "calibration"
        assert_settled(module, fixture)

    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-calibration-intent.") as temporary:
        fixture = build_fixture(module, Path(temporary), reason="calibration")

        def stop_after_intent(phase: str) -> None:
            if phase == "intent-after-prepared-directory-fsync":
                raise RuntimeError("injected calibration intent fault")

        try:
            consume(module, fixture, stop_after_intent)
        except RuntimeError as error:
            assert "injected calibration intent fault" in str(error)
        else:
            raise AssertionError("calibration intent fault did not interrupt")
        append_failed_status(fixture)
        remove_lock(fixture)
        fixture["active"].unlink()
        assert reconcile(module, fixture) == "calibration"
        assert_settled(module, fixture)


def exercise_owner_identity_and_acquire_fail_safe(module) -> None:
    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-pid-reuse.") as temporary:
        observed_start = module._process_start_ticks(os.getpid())
        assert observed_start is not None
        fixture = build_fixture(
            module,
            Path(temporary),
            reason="calibration",
            owner_pid=os.getpid(),
            owner_start_ticks=observed_start + 1,
        )
        assert reconcile(module, fixture) == "calibration"
        assert_settled(module, fixture)

    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-prior-boot.") as temporary:
        prior_boot = "00000000-0000-4000-8000-000000000002"
        if module._current_boot_id() == prior_boot:
            prior_boot = "00000000-0000-4000-8000-000000000003"
        fixture = build_fixture(
            module,
            Path(temporary),
            reason="calibration",
            owner_pid=os.getpid(),
            owner_boot_id=prior_boot,
        )
        assert reconcile(module, fixture) == "calibration"
        assert_settled(module, fixture)

    for partial in (False, True):
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-acquire-{int(partial)}."
        ) as temporary:
            fixture = build_fixture(module, Path(temporary), reason="calibration")
            fixture["active"].unlink()
            (fixture["lock_dir"] / "owner").unlink()
            if partial:
                write_owner_file(fixture["lock_dir"] / "owner", b"pid=partial\n")
            try:
                reconcile(module, fixture)
            except RuntimeError as error:
                assert any(word in str(error) for word in ("owner", "unsafe"))
            else:
                raise AssertionError("an ambiguous acquire boundary was removed")
            assert os.path.lexists(fixture["lock_dir"])


def exercise_fail_closed_cases(module) -> None:
    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-live.") as temporary:
        fixture = build_fixture(
            module, Path(temporary), reason="calibration", owner_pid=os.getpid()
        )
        try:
            reconcile(module, fixture)
        except RuntimeError as error:
            assert "still alive" in str(error)
        else:
            raise AssertionError("live lock owner was accepted")
        assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]

    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-incomplete.") as temporary:
        fixture = build_fixture(
            module, Path(temporary), reason="calibration", incomplete=True
        )
        try:
            reconcile(module, fixture)
        except RuntimeError as error:
            assert "consumable" in str(error)
        else:
            raise AssertionError("incomplete stale run was consumed")
        assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]

    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-unrelated.") as temporary:
        fixture = build_fixture(module, Path(temporary), reason="calibration")
        write_owner_file(fixture["archive"], b'{"receipt":"unrelated"}\n')
        try:
            consume(module, fixture)
        except RuntimeError as error:
            assert any(word in str(error) for word in ("digest", "inode", "link"))
        else:
            raise AssertionError("unrelated archive path was accepted")
        assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]
        assert fixture["archive"].read_bytes() == b'{"receipt":"unrelated"}\n'


def exercise_pre_mutation_cli(module) -> None:
    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-cli."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        previous_argv = sys.argv
        output = io.StringIO()
        arguments = [
            str(HELPER),
            "retire-pre-mutation",
            "--canonical", str(fixture["receipt"]),
            "--intent", str(fixture["intent"]),
            "--state-root", str(fixture["state_root"]),
            "--active-journal", str(fixture["active"]),
            "--lock-dir", str(fixture["lock_dir"]),
            "--runtime-contract", str(fixture["runtime_contract"]),
            "--archive-run-id", str(fixture["archive_run_id"]),
            "--expected-sha256", str(fixture["receipt_sha"]),
        ]
        for binding in fixture["related_runs"]:
            arguments.extend((
                "--related-run",
                f"{binding.run_id}:{binding.state_sha256}",
            ))
        try:
            sys.argv = arguments
            with redirect_stdout(output):
                assert module.main() == 0
        finally:
            sys.argv = previous_argv
        settlement = json.loads(output.getvalue())
        assert settlement["reason"] == module.PRE_MUTATION_REASON
        assert settlement["relatedRuns"] == module._run_binding_documents(
            fixture["related_runs"]
        )
        assert_pre_mutation_settled(module, fixture)


def exercise_pre_mutation_fault_matrix(
    module, *, rollback_scan_failure: bool = False, run_count: int = 2
) -> None:
    phases = (
        "intent-after-prepared-write",
        "intent-after-prepared-file-fsync",
        "intent-after-link",
        "intent-after-canonical-file-fsync",
        "intent-after-canonical-directory-fsync",
        "intent-after-prepared-unlink",
        "intent-after-prepared-directory-fsync",
        "receipt-after-archive-link",
        "receipt-after-archive-file-fsync",
        "receipt-after-archive-directory-fsync",
        "receipt-after-canonical-unlink",
        "receipt-after-canonical-directory-fsync",
        "receipt-after-single-link-file-fsync",
        "receipt-after-final-archive-directory-fsync",
        "settlement-after-prepared-write",
        "settlement-after-prepared-file-fsync",
        "settlement-after-link",
        "settlement-after-canonical-file-fsync",
        "settlement-after-canonical-directory-fsync",
        "settlement-after-prepared-unlink",
        "settlement-after-prepared-directory-fsync",
        "intent-after-unlink",
        "intent-after-unlink-directory-fsync",
    )
    for index, phase in enumerate(phases):
        with tempfile.TemporaryDirectory(
            prefix=(
                "diva-sbc-bridge-rollback-scan-fault-"
                if rollback_scan_failure
                else "diva-sbc-bridge-pre-mutation-fault-"
            ) + f"{index}."
        ) as temporary:
            fixture = build_pre_mutation_fixture(
                module,
                Path(temporary),
                rollback_scan_failure_indices=(run_count - 1,)
                if rollback_scan_failure else (),
                run_count=run_count,
            )

            def fail_at(observed: str, *, expected: str = phase) -> None:
                if observed == expected:
                    raise RuntimeError(f"injected pre-mutation fault at {expected}")

            try:
                retire_pre_mutation(module, fixture, fail_at)
            except RuntimeError as error:
                assert "injected pre-mutation fault" in str(error), (phase, error)
            else:
                raise AssertionError(
                    f"pre-mutation fault at {phase} did not interrupt retirement"
                )
            try:
                retire_pre_mutation(module, fixture)
            except RuntimeError as error:
                raise AssertionError(
                    f"pre-mutation reconciliation failed after {phase}: {error}"
                ) from error
            assert_pre_mutation_settled(module, fixture)


def exercise_pre_mutation_rollback_scan_failure(module) -> None:
    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-one-run-rollback-scan-success."
    ) as temporary:
        fixture = build_pre_mutation_fixture(
            module,
            Path(temporary),
            rollback_scan_failure_indices=(0,),
            run_count=1,
        )
        settlement = retire_pre_mutation(module, fixture)
        assert settlement["reason"] == module.PRE_MUTATION_REASON
        assert len(settlement["relatedRuns"]) == 1
        assert_pre_mutation_settled(module, fixture)

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-rollback-scan-success."
    ) as temporary:
        fixture = build_pre_mutation_fixture(
            module, Path(temporary), rollback_scan_failure_indices=(1,)
        )
        settlement = retire_pre_mutation(module, fixture)
        assert settlement["reason"] == module.PRE_MUTATION_REASON
        assert_pre_mutation_settled(module, fixture)

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-rollback-scan-post-intent-artifact."
    ) as temporary:
        fixture = build_pre_mutation_fixture(
            module, Path(temporary), rollback_scan_failure_indices=(1,)
        )
        validation = (
            fixture["run_dirs"][-1]
            / "evidence/image-scan-qdrant-rollback.validation.json"
        )

        def drift_validation_marker(phase: str) -> None:
            if phase == "intent-after-prepared-directory-fsync":
                write_owner_file(validation, b"unexpected validation output\n")

        try:
            retire_pre_mutation(module, fixture, drift_validation_marker)
        except RuntimeError as error:
            assert "empty owner file" in str(error), error
        else:
            raise AssertionError(
                "rollback scan artifact drift crossed the durable intent"
            )
        assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]
        assert not os.path.lexists(fixture["intent"])
        assert not os.path.lexists(fixture["archive"])
        write_owner_file(validation, b"")
        retire_pre_mutation(module, fixture)
        assert_pre_mutation_settled(module, fixture)


def exercise_pre_mutation_binding_cardinality(module) -> None:
    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-zero-runs."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        fixture["related_runs"] = ()
        _expect_pre_mutation_failure(module, fixture, "between one and 16")

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-too-many-runs."
    ) as temporary:
        fixture = build_pre_mutation_fixture(
            module,
            Path(temporary),
            run_count=module.MAX_PRE_MUTATION_RELATED_RUNS + 1,
        )
        _expect_pre_mutation_failure(module, fixture, "between one and 16")


def exercise_pre_mutation_rollback_scan_fail_closed(module) -> None:
    state_mutations = (
        (
            "writer-state",
            lambda payload: payload + b"pipeline_writer.status=gating\n",
            "later boundary",
        ),
        (
            "other-writer-state",
            lambda payload: payload + b"pipeline_writer.owner=unexpected\n",
            "contains writer state",
        ),
        (
            "image-scan-status",
            lambda payload: payload
            + b"image_scan.status=all-exact-receipts-verified\n",
            "later boundary",
        ),
        (
            "backup-freshness",
            lambda payload: payload
            + b"backup.freshness=revalidated-before-writer-quiescence\n",
            "later boundary",
        ),
        (
            "qdrant-rollback-receipt-state",
            lambda payload: payload
            + b"qdrant.rollback_scan_receipt_sha256=" + b"e" * 64 + b"\n",
            "later boundary",
        ),
        (
            "postgres-rollback-receipt-state",
            lambda payload: payload
            + b"postgres.rollback_scan_receipt_sha256=" + b"d" * 64 + b"\n",
            "later boundary",
        ),
        (
            "missing-candidate-receipt",
            lambda payload: b"\n".join(
                line for line in payload.split(b"\n")
                if not line.startswith(
                    b"image_scan.postgres-migrate.receipt_sha256="
                )
            ),
            "receipt key set",
        ),
        (
            "extra-scan-key",
            lambda payload: payload
            + b"image_scan.qdrant-rollback.receipt_sha256="
            + b"f" * 64 + b"\n",
            "receipt key set",
        ),
        (
            "scan-record-order",
            lambda payload: payload.replace(
                next(
                    line + b"\n" for line in payload.splitlines()
                    if line.startswith(
                        b"image_scan.qdrant-runtime.receipt_sha256="
                    )
                ),
                b"",
            ).replace(
                b"deployment.status=failed\n",
                b"deployment.status=failed\n"
                + next(
                    line + b"\n" for line in payload.splitlines()
                    if line.startswith(
                        b"image_scan.qdrant-runtime.receipt_sha256="
                    )
                ),
            ),
            "terminal ordering",
        ),
    )
    for label, mutate, expected in state_mutations:
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-rollback-scan-{label}."
        ) as temporary:
            fixture = build_pre_mutation_fixture(
                module, Path(temporary), rollback_scan_failure_indices=(1,)
            )
            state_path = fixture["run_dirs"][-1] / "state"
            changed = mutate(state_path.read_bytes())
            write_owner_file(state_path, changed)
            refresh_pre_mutation_binding(module, fixture, 1)
            _expect_pre_mutation_failure(module, fixture, expected)

    artifact_mutations = (
        (
            "missing-report",
            "image-scan-qdrant-rollback.json",
            None,
            "report is absent",
        ),
        (
            "nonempty-validation",
            "image-scan-qdrant-rollback.validation.json",
            b"unexpected\n",
            "empty owner file",
        ),
        (
            "unexpected-receipt",
            "image-scan-qdrant-rollback.receipt.json",
            b"unexpected\n",
            "unexpected artifact",
        ),
        (
            "candidate-receipt-drift",
            "image-scan-qdrant-runtime.receipt.json",
            b"changed\n",
            "candidate scan receipt changed",
        ),
        (
            "downstream-scan-report",
            "image-scan-postgres-rollback.json",
            b'{"unexpected":"downstream"}\n',
            "artifact set is not exact",
        ),
    )
    for label, name, payload, expected in artifact_mutations:
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-rollback-scan-{label}."
        ) as temporary:
            fixture = build_pre_mutation_fixture(
                module, Path(temporary), rollback_scan_failure_indices=(1,)
            )
            path = fixture["run_dirs"][-1] / "evidence" / name
            if payload is None:
                path.unlink()
            else:
                write_owner_file(path, payload)
            _expect_pre_mutation_failure(module, fixture, expected)

    for leaf in ("qdrant-quiesce-first.json", "qdrant-before.json"):
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-rollback-scan-{leaf}."
        ) as temporary:
            fixture = build_pre_mutation_fixture(
                module, Path(temporary), rollback_scan_failure_indices=(1,)
            )
            write_owner_file(fixture["run_dirs"][-1] / leaf, b"{}\n")
            _expect_pre_mutation_failure(
                module, fixture, "post-quiescence artifact"
            )


def exercise_pre_mutation_post_intent_revalidation(module) -> None:
    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-post-intent-lock."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))

        def acquire_competing_lock(phase: str) -> None:
            if phase == "intent-after-prepared-directory-fsync":
                fixture["lock_dir"].mkdir(mode=0o700)
                os.chmod(fixture["lock_dir"], 0o700)

        try:
            retire_pre_mutation(module, fixture, acquire_competing_lock)
        except RuntimeError as error:
            assert "unexpected hardening lock" in str(error)
        else:
            raise AssertionError("a hardening lock crossed the durable retirement intent")
        assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]
        assert not os.path.lexists(fixture["intent"])
        assert not os.path.lexists(fixture["archive"])
        fixture["lock_dir"].rmdir()
        retire_pre_mutation(module, fixture)
        assert_pre_mutation_settled(module, fixture)

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-post-intent-state."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        original = fixture["state_payloads"][0]

        def drift_related_state(phase: str) -> None:
            if phase == "intent-after-prepared-directory-fsync":
                write_owner_file(
                    fixture["run_dirs"][0] / "state", original + b"drift=value\n"
                )

        try:
            retire_pre_mutation(module, fixture, drift_related_state)
        except RuntimeError as error:
            assert "state digest differs" in str(error)
        else:
            raise AssertionError("related state drift crossed the durable intent")
        assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]
        assert not os.path.lexists(fixture["intent"])
        assert not os.path.lexists(fixture["archive"])
        write_owner_file(fixture["run_dirs"][0] / "state", original)
        retire_pre_mutation(module, fixture)
        assert_pre_mutation_settled(module, fixture)


def exercise_pre_mutation_cancellation_faults(module) -> None:
    phases = (
        "retirement-cancel-before-intent-unlink",
        "retirement-cancel-after-intent-unlink",
        "retirement-cancel-after-intent-directory-fsync",
    )
    for index, phase in enumerate(phases):
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-retirement-cancel-{index}."
        ) as temporary:
            fixture = build_pre_mutation_fixture(module, Path(temporary))

            def compete_then_fail(observed: str, *, target: str = phase) -> None:
                if observed == "intent-after-prepared-directory-fsync":
                    fixture["lock_dir"].mkdir(mode=0o700)
                    os.chmod(fixture["lock_dir"], 0o700)
                if observed == target:
                    raise RuntimeError(f"injected cancellation fault at {target}")

            try:
                retire_pre_mutation(module, fixture, compete_then_fail)
            except RuntimeError as error:
                assert "intent cancellation did not complete" in str(error), error
            else:
                raise AssertionError(
                    f"cancellation fault at {phase} did not interrupt retirement"
                )
            assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]
            assert not os.path.lexists(fixture["archive"])
            assert os.path.lexists(fixture["intent"]) == (
                phase == "retirement-cancel-before-intent-unlink"
            )
            fixture["lock_dir"].rmdir()
            retire_pre_mutation(module, fixture)
            assert_pre_mutation_settled(module, fixture)


def exercise_pre_mutation_fixed_paths(module) -> None:
    path_bindings = (
        ("canonical", "receipt"),
        ("intent_path", "intent"),
        ("state_root", "state_root"),
        ("active", "active"),
        ("lock_dir", "lock_dir"),
        ("runtime_contract", "runtime_contract"),
    )
    for argument, _fixture_key in path_bindings:
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-retire-path-{argument}."
        ) as temporary:
            fixture = build_pre_mutation_fixture(module, Path(temporary))
            alternate = Path(temporary) / ("alternate-" + argument)
            try:
                retire_pre_mutation(
                    module, fixture, **{argument: alternate}
                )
            except RuntimeError as error:
                assert "fixed state-root path" in str(error), (argument, error)
            else:
                raise AssertionError(
                    f"retirement accepted substituted {argument} path"
                )
            assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]
            assert not os.path.lexists(fixture["intent"])
            assert not os.path.lexists(fixture["archive"])

    for argument, _fixture_key in path_bindings:
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-reconcile-path-{argument}."
        ) as temporary:
            fixture = build_fixture(module, Path(temporary), reason="calibration")
            arguments = {
                "state_root": fixture["state_root"],
                "canonical": fixture["receipt"],
                "intent_path": fixture["intent"],
                "active": fixture["active"],
                "lock_dir": fixture["lock_dir"],
                "runtime_contract": fixture["runtime_contract"],
            }
            arguments[argument] = Path(temporary) / ("alternate-" + argument)
            try:
                module.startup_reconcile(**arguments)
            except RuntimeError as error:
                assert "fixed state-root path" in str(error), (argument, error)
            else:
                raise AssertionError(
                    f"startup reconciliation accepted substituted {argument} path"
                )
            assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]
            assert os.path.lexists(fixture["active"])
            assert os.path.lexists(fixture["lock_dir"])

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-retire-idempotent-path."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        retire_pre_mutation(module, fixture)
        try:
            retire_pre_mutation(
                module,
                fixture,
                runtime_contract=Path(temporary) / "substituted-runtime-contract",
            )
        except RuntimeError as error:
            assert "fixed state-root path" in str(error), error
        else:
            raise AssertionError("idempotent retirement bypassed fixed paths")
        assert fixture["archive"].read_bytes() == fixture["receipt_payload"]
        module._validate_settlement(fixture["settlement"])


def exercise_pre_mutation_residual_contract(module) -> None:
    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-retire-extra-archive."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        other_sha = "f" * 64
        assert other_sha != fixture["receipt_sha"]
        write_owner_file(
            fixture["run_dirs"][0]
            / f"api-bridge-receipt.{module.PRE_MUTATION_REASON}.{other_sha}.json",
            b"unrelated archive\n",
        )
        _expect_pre_mutation_failure(module, fixture, "unsettled residual set")

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-retire-extra-prepared."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        write_owner_file(Path(str(fixture["settlement"]) + ".prepared"), b"partial\n")
        _expect_pre_mutation_failure(module, fixture, "unsettled residual set")

    for label, leaves in (
        ("settlement-only", ("settlement",)),
        ("prepared-only", ("prepared",)),
        ("settlement-prepared-without-archive", ("settlement", "prepared")),
    ):
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-retire-impossible-{label}."
        ) as temporary:
            fixture = build_pre_mutation_fixture(module, Path(temporary))
            if "settlement" in leaves:
                write_owner_file(fixture["settlement"], b"impossible\n")
            if "prepared" in leaves:
                write_owner_file(
                    Path(str(fixture["settlement"]) + ".prepared"),
                    b"impossible\n",
                )
            try:
                module._validate_pre_mutation_residuals(
                    state_root=fixture["state_root"],
                    archive_run_id=fixture["archive_run_id"],
                    expected_receipt_sha=fixture["receipt_sha"],
                    related_runs=fixture["related_runs"],
                    stage="in-flight",
                )
            except RuntimeError as error:
                assert "impossible residual path set" in str(error), error
            else:
                raise AssertionError(
                    f"accepted impossible in-flight residual set: {label}"
                )

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-retire-settled-extra."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        retire_pre_mutation(module, fixture)
        other_sha = "f" * 64
        assert other_sha != fixture["receipt_sha"]
        write_owner_file(
            fixture["run_dirs"][0]
            / f"api-bridge-receipt.{module.PRE_MUTATION_REASON}.{other_sha}.json",
            b"unrelated archive\n",
        )
        try:
            retire_pre_mutation(module, fixture)
        except RuntimeError as error:
            assert "settled residual set" in str(error), error
        else:
            raise AssertionError("idempotent retirement accepted an extra archive")
        assert fixture["archive"].read_bytes() == fixture["receipt_payload"]
        module._validate_settlement(fixture["settlement"])


def _expect_pre_mutation_failure(module, fixture: dict[str, object],
                                 message: str) -> None:
    try:
        retire_pre_mutation(module, fixture)
    except RuntimeError as error:
        assert message in str(error), (message, error)
    else:
        raise AssertionError(f"unsafe pre-mutation retirement was accepted: {message}")
    assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]


def exercise_pre_mutation_fail_closed_cases(module) -> None:
    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-state-sha."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        bindings = list(fixture["related_runs"])
        bindings[0] = module.RunBinding(bindings[0].run_id, "0" * 64)
        fixture["related_runs"] = tuple(bindings)
        _expect_pre_mutation_failure(module, fixture, "state digest differs")

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-receipt-sha."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        fixture["receipt"].write_bytes(b'{"receipt":"changed"}\n')
        try:
            retire_pre_mutation(module, fixture)
        except RuntimeError as error:
            assert "digest" in str(error)
        else:
            raise AssertionError("a changed canonical receipt was retired")
        assert os.path.lexists(fixture["receipt"])
        assert not os.path.lexists(fixture["archive"])

    for label, key, value in (
        ("writer-gated", "pipeline_writer.status", "gated"),
        ("qdrant-mutation", "qdrant.storage_upgrade", "intent-before-controller"),
        ("promotion", "promotion.status", "armed-in-memory-forward-only"),
        ("daemon-uncertain", "daemon.read_uncertain_exit", "124"),
    ):
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-pre-mutation-{label}."
        ) as temporary:
            fixture = build_pre_mutation_fixture(module, Path(temporary))
            state = fixture["run_dirs"][0] / "state"
            payload = pre_mutation_state_payload(
                fixture["run_ids"][0], fixture["receipt_sha"], f"{key}={value}"
            )
            write_owner_file(state, payload)
            refresh_pre_mutation_binding(module, fixture, 0)
            fixture["state_payloads"] = (
                payload,
                fixture["state_payloads"][1],
            )
            expected = "writer refusal sequence" if label == "writer-gated" \
                else "mutation evidence"
            _expect_pre_mutation_failure(module, fixture, expected)

    for label, path_key in (
        ("active", "active"),
        ("runtime-contract", "runtime_contract"),
    ):
        with tempfile.TemporaryDirectory(
            prefix=f"diva-sbc-bridge-pre-mutation-{label}."
        ) as temporary:
            fixture = build_pre_mutation_fixture(module, Path(temporary))
            write_owner_file(fixture[path_key], b"unexpected\n")
            _expect_pre_mutation_failure(module, fixture, "unexpected")

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-lock."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        fixture["lock_dir"].mkdir(mode=0o700)
        os.chmod(fixture["lock_dir"], 0o700)
        _expect_pre_mutation_failure(module, fixture, "unexpected hardening lock")

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-marker."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        write_owner_file(fixture["run_dirs"][0] / "promoted", b"status=promoted\n")
        _expect_pre_mutation_failure(module, fixture, "later boundary")

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-extra-run."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        extra_id = "20260902T070000Z-630000"
        extra_dir = fixture["state_root"] / ("stateful-" + extra_id)
        extra_dir.mkdir(mode=0o700)
        os.chmod(extra_dir, 0o700)
        write_owner_file(
            extra_dir / "state",
            pre_mutation_state_payload(extra_id, fixture["receipt_sha"]),
        )
        _expect_pre_mutation_failure(module, fixture, "run set differs")

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-order."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        fixture["related_runs"] = tuple(reversed(fixture["related_runs"]))
        _expect_pre_mutation_failure(module, fixture, "canonical order")

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-old-archive-run."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        fixture["archive_run_id"] = fixture["run_ids"][0]
        _expect_pre_mutation_failure(module, fixture, "latest related run")

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-duplicate."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        fixture["related_runs"] = (
            fixture["related_runs"][0], fixture["related_runs"][0]
        )
        _expect_pre_mutation_failure(module, fixture, "duplicate run ID")

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-conflict."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        write_owner_file(fixture["archive"], fixture["receipt_payload"])
        _expect_pre_mutation_failure(module, fixture, "incomplete or conflicting")

    with tempfile.TemporaryDirectory(
        prefix="diva-sbc-bridge-pre-mutation-generic."
    ) as temporary:
        fixture = build_pre_mutation_fixture(module, Path(temporary))
        try:
            module.consume(
                canonical=fixture["receipt"], archive=fixture["archive"],
                intent_path=fixture["intent"], reason=module.PRE_MUTATION_REASON,
                run_id=fixture["archive_run_id"], state_root=fixture["state_root"],
                active=fixture["active"], lock_dir=fixture["lock_dir"],
                expected_sha=fixture["receipt_sha"],
            )
        except RuntimeError as error:
            assert "generic receipt consumption" in str(error)
        else:
            raise AssertionError("generic consume accepted pre-mutation retirement")
        assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]
        try:
            module._consume(
                canonical=fixture["receipt"], archive=fixture["archive"],
                intent_path=fixture["intent"], reason=module.PRE_MUTATION_REASON,
                run_id=fixture["archive_run_id"], state_root=fixture["state_root"],
                active=fixture["active"], lock_dir=fixture["lock_dir"],
                expected_sha=fixture["receipt_sha"],
                related_runs=fixture["related_runs"],
            )
        except RuntimeError as error:
            assert "post-intent revalidation" in str(error)
        else:
            raise AssertionError("internal consume bypassed pre-mutation revalidation")
        assert fixture["receipt"].read_bytes() == fixture["receipt_payload"]


def main() -> int:
    module = load_helper()
    exercise_consume_cli(module)
    exercise_fault_matrix(module)
    exercise_empty_prepared_recovery(module)
    exercise_completed_boundary(module)
    exercise_calibration_status_contract(module)
    exercise_release_fault_matrix(module)
    exercise_live_intent_ordering(module)
    exercise_settlement_binding(module)
    exercise_calibration_cleanup_recovery(module)
    exercise_owner_identity_and_acquire_fail_safe(module)
    exercise_fail_closed_cases(module)
    exercise_pre_mutation_cli(module)
    exercise_pre_mutation_fault_matrix(module)
    exercise_pre_mutation_rollback_scan_failure(module)
    exercise_pre_mutation_fault_matrix(module, rollback_scan_failure=True)
    exercise_pre_mutation_fault_matrix(
        module, rollback_scan_failure=True, run_count=1
    )
    exercise_pre_mutation_post_intent_revalidation(module)
    exercise_pre_mutation_cancellation_faults(module)
    exercise_pre_mutation_fixed_paths(module)
    exercise_pre_mutation_residual_contract(module)
    exercise_pre_mutation_fail_closed_cases(module)
    exercise_pre_mutation_rollback_scan_fail_closed(module)
    exercise_pre_mutation_binding_cardinality(module)
    print("PASS crash-safe SBC API bridge receipt consumption")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
