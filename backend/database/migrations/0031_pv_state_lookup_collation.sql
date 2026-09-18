-- Keep PV state updates usable while the legacy default-collation unique
-- index is repaired separately.  The index is intentionally non-unique so
-- existing duplicate rows remain intact and both rows receive the same
-- fetch state until data reconciliation is approved.
CREATE INDEX IF NOT EXISTS pvs_service_pv_id_lookup_c_idx
    ON pvs (service COLLATE "C", pv_id COLLATE "C");
