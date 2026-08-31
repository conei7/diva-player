#!/usr/bin/env python3
"""Fault tests for crash-safe SBC API bridge receipt consumption."""

from __future__ import annotations

import hashlib
import importlib.util
import os
import stat
import tempfile
from pathlib import Path


HELPER = Path(__file__).with_name("sbc-api-bridge-consumption.py")
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
                  incomplete: bool = False) -> dict[str, object]:
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
        state_lines.extend((
            "deployment.status=preflight",
            "image_scan.status=requires-reviewed-exact-inventory-bounds",
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


def exercise_completed_boundary(module) -> None:
    with tempfile.TemporaryDirectory(prefix="diva-sbc-bridge-completed.") as temporary:
        fixture = build_fixture(module, Path(temporary), reason="completed")
        consume(module, fixture)
        assert reconcile(module, fixture) == "completed"
        assert_settled(module, fixture)


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


def main() -> int:
    module = load_helper()
    exercise_fault_matrix(module)
    exercise_completed_boundary(module)
    exercise_release_fault_matrix(module)
    exercise_live_intent_ordering(module)
    exercise_settlement_binding(module)
    exercise_calibration_cleanup_recovery(module)
    exercise_owner_identity_and_acquire_fail_safe(module)
    exercise_fail_closed_cases(module)
    print("PASS crash-safe SBC API bridge receipt consumption")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
