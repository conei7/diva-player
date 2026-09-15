-- Keep permanently unavailable YouTube PVs out of the daily quota loop.
-- A PV is only put into this cooldown after three response-confirmed misses;
-- transport, authentication, quota, and database failures remain retryable
-- through the existing transient backoff path.
ALTER TABLE pvs
    ADD COLUMN IF NOT EXISTS stats_last_failure_kind TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS stats_missing_streak INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS stats_unavailable_until TIMESTAMPTZ;

UPDATE pvs
SET stats_last_failure_kind = 'none'
WHERE stats_last_failure_kind IS NULL
   OR stats_last_failure_kind NOT IN ('none', 'missing', 'transient', 'hard');

UPDATE pvs
SET stats_missing_streak = 0
WHERE stats_missing_streak IS NULL OR stats_missing_streak < 0;

ALTER TABLE pvs
    ALTER COLUMN stats_last_failure_kind SET DEFAULT 'none',
    ALTER COLUMN stats_missing_streak SET DEFAULT 0;

DO $constraints$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.pvs'::regclass
          AND conname = 'pvs_stats_last_failure_kind_check'
    ) THEN
        ALTER TABLE pvs ADD CONSTRAINT pvs_stats_last_failure_kind_check
            CHECK (stats_last_failure_kind IN ('none', 'missing', 'transient', 'hard'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.pvs'::regclass
          AND conname = 'pvs_stats_missing_streak_check'
    ) THEN
        ALTER TABLE pvs ADD CONSTRAINT pvs_stats_missing_streak_check
            CHECK (stats_missing_streak >= 0);
    END IF;
END;
$constraints$;

CREATE INDEX IF NOT EXISTS pvs_unavailable_until_idx
    ON pvs (service, stats_unavailable_until)
    WHERE disabled = FALSE AND stats_unavailable_until IS NOT NULL;
