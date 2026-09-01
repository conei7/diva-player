from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("attest-disaster-backup-payloads.py")
SPEC = importlib.util.spec_from_file_location("diva_backup_attester", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Could not load the disaster backup attester")
ATTESTER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ATTESTER
SPEC.loader.exec_module(ATTESTER)


class WindowsTrusteePolicyTests(unittest.TestCase):
    TRUSTED_OWNER = "S-1-5-21-111-222-333-1001"
    UNTRUSTED_OWNER = "S-1-5-21-111-222-333-1002"

    def setUp(self) -> None:
        self.trusted_sids = {
            self.TRUSTED_OWNER,
            ATTESTER.WINDOWS_SYSTEM_SID,
            ATTESTER.WINDOWS_ADMINISTRATORS_SID,
        }

    def test_owner_rights_resolves_to_a_trusted_actual_owner(self) -> None:
        self.assertNotIn(ATTESTER.WINDOWS_OWNER_RIGHTS_SID, self.trusted_sids)
        self.assertTrue(
            ATTESTER._windows_owner_is_trusted(self.TRUSTED_OWNER, self.trusted_sids)
        )
        self.assertTrue(
            ATTESTER._windows_grantee_is_trusted(
                ATTESTER.WINDOWS_OWNER_RIGHTS_SID,
                owner_sid=self.TRUSTED_OWNER,
                trusted_sids=self.trusted_sids,
            )
        )

    def test_owner_rights_does_not_rescue_an_untrusted_actual_owner(self) -> None:
        self.assertFalse(
            ATTESTER._windows_owner_is_trusted(self.UNTRUSTED_OWNER, self.trusted_sids)
        )
        self.assertFalse(
            ATTESTER._windows_grantee_is_trusted(
                ATTESTER.WINDOWS_OWNER_RIGHTS_SID,
                owner_sid=self.UNTRUSTED_OWNER,
                trusted_sids=self.trusted_sids,
            )
        )

    def test_dynamic_sids_cannot_be_allowed_writers_or_actual_owners(self) -> None:
        for sid in ("S-1-3-0", ATTESTER.WINDOWS_OWNER_RIGHTS_SID):
            with self.subTest(sid=sid):
                with self.assertRaisesRegex(RuntimeError, "dynamic principal"):
                    ATTESTER._normalize_allowed_writer_sid(sid)
                accidentally_listed = {*self.trusted_sids, sid}
                self.assertFalse(
                    ATTESTER._windows_owner_is_trusted(sid, accidentally_listed)
                )
                self.assertFalse(
                    ATTESTER._windows_grantee_is_trusted(
                        ATTESTER.WINDOWS_OWNER_RIGHTS_SID,
                        owner_sid=sid,
                        trusted_sids=accidentally_listed,
                    )
                )

    def test_allowed_reader_sid_rejects_dynamic_and_broad_principals(self) -> None:
        for sid in ("S-1-3-0", "S-1-5-11"):
            with self.subTest(sid=sid):
                with self.assertRaises(RuntimeError):
                    ATTESTER._normalize_allowed_reader_sid(sid)

    def test_allowed_reader_must_match_and_remain_write_incapable(self) -> None:
        reader_sid = "S-1-5-21-111-222-333-1004"
        readers = {reader_sid}
        self.assertTrue(
            ATTESTER._windows_grantee_is_allowed_reader(
                reader_sid,
                access_mask=0x001200A9,
                write_mask=ATTESTER.WINDOWS_UNTRUSTED_FILE_WRITE_MASK,
                allowed_reader_sids=readers,
            )
        )
        self.assertFalse(
            ATTESTER._windows_grantee_is_allowed_reader(
                reader_sid,
                access_mask=0x001200A9 | 0x00000002,
                write_mask=ATTESTER.WINDOWS_UNTRUSTED_FILE_WRITE_MASK,
                allowed_reader_sids=readers,
            )
        )
        self.assertFalse(
            ATTESTER._windows_grantee_is_allowed_reader(
                self.UNTRUSTED_OWNER,
                access_mask=0x001200A9,
                write_mask=ATTESTER.WINDOWS_UNTRUSTED_FILE_WRITE_MASK,
                allowed_reader_sids=readers,
            )
        )

    def test_other_creator_or_dynamic_sid_remains_untrusted(self) -> None:
        creator_owner_sid = "S-1-3-0"
        accidentally_listed = {*self.trusted_sids, creator_owner_sid}
        self.assertFalse(
            ATTESTER._windows_grantee_is_trusted(
                creator_owner_sid,
                owner_sid=self.TRUSTED_OWNER,
                trusted_sids=accidentally_listed,
            )
        )

    def test_unknown_and_ordinary_untrusted_writers_remain_untrusted(self) -> None:
        for sid in ("S-1-42-1", "S-1-5-11", self.UNTRUSTED_OWNER):
            with self.subTest(sid=sid):
                self.assertFalse(
                    ATTESTER._windows_grantee_is_trusted(
                        sid,
                        owner_sid=self.TRUSTED_OWNER,
                        trusted_sids=self.trusted_sids,
                    )
                )


if __name__ == "__main__":
    unittest.main()
