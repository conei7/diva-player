-- A YouTube/Nico PV may be referenced by more than one song.  The legacy
-- unique index became inconsistent after a libc collation change and made
-- updates to existing duplicate rows fail.  Preserve every row and keep a
-- non-unique lookup index for state updates instead.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.pvs'::regclass
          AND conname = 'pvs_service_pv_id_key'
    ) THEN
        ALTER TABLE public.pvs DROP CONSTRAINT pvs_service_pv_id_key;
    END IF;
END;
$$;

DROP INDEX IF EXISTS public.pvs_service_pv_id_key;
DROP INDEX IF EXISTS public.pvs_service_pv_id_key_ccnew;

CREATE INDEX IF NOT EXISTS pvs_service_pv_id_lookup_c_idx
    ON public.pvs (service COLLATE "C", pv_id COLLATE "C");
