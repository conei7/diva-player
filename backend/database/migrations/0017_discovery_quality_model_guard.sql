-- Prevent a scheduled pipeline running an old checkout from replacing newer
-- discovery-quality classifications.  Model promotion is an explicit,
-- monotonic database migration; normal recomputation of the current model is
-- still allowed.
BEGIN;

CREATE TABLE IF NOT EXISTS discovery_quality_model_policy (
    singleton              BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    expected_model_version TEXT NOT NULL,
    expected_revision      INTEGER NOT NULL CHECK (expected_revision > 0),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT discovery_quality_model_policy_version_check
        CHECK (expected_model_version = 'heuristic-v' || expected_revision::text)
);

CREATE OR REPLACE FUNCTION enforce_discovery_quality_policy_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.expected_revision < OLD.expected_revision THEN
        RAISE EXCEPTION
            'discovery quality model policy cannot move backward from revision % to %',
            OLD.expected_revision,
            NEW.expected_revision
            USING ERRCODE = '23514',
                  HINT = 'Promote a new revision even when restoring earlier scoring logic.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discovery_quality_policy_revision_guard
    ON discovery_quality_model_policy;
CREATE TRIGGER discovery_quality_policy_revision_guard
BEFORE UPDATE ON discovery_quality_model_policy
FOR EACH ROW
EXECUTE FUNCTION enforce_discovery_quality_policy_revision();

INSERT INTO discovery_quality_model_policy (
    singleton,
    expected_model_version,
    expected_revision
)
VALUES (TRUE, 'heuristic-v3', 3)
ON CONFLICT (singleton) DO UPDATE
SET expected_model_version = EXCLUDED.expected_model_version,
    expected_revision = EXCLUDED.expected_revision,
    updated_at = now()
WHERE discovery_quality_model_policy.expected_revision < EXCLUDED.expected_revision;

ALTER TABLE song_discovery_quality
    ALTER COLUMN model_version SET DEFAULT 'heuristic-v3';

CREATE OR REPLACE FUNCTION enforce_discovery_quality_model_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected_version TEXT;
    unexpected_version TEXT;
BEGIN
    SELECT expected_model_version
    INTO expected_version
    FROM discovery_quality_model_policy
    WHERE singleton = TRUE
    FOR SHARE;

    IF expected_version IS NULL THEN
        RAISE EXCEPTION 'discovery quality model policy is missing'
            USING ERRCODE = '55000';
    END IF;

    SELECT model_version
    INTO unexpected_version
    FROM new_quality_rows
    WHERE model_version IS DISTINCT FROM expected_version
    LIMIT 1;

    IF unexpected_version IS NOT NULL THEN
        RAISE EXCEPTION
            'discovery quality model version % is not allowed; expected %',
            unexpected_version,
            expected_version
            USING ERRCODE = '23514',
                  HINT = 'Deploy the matching pipeline checkout or promote a newer model with a DB migration.';
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS song_discovery_quality_model_version_guard
    ON song_discovery_quality;
DROP TRIGGER IF EXISTS song_discovery_quality_model_version_insert_guard
    ON song_discovery_quality;
DROP TRIGGER IF EXISTS song_discovery_quality_model_version_update_guard
    ON song_discovery_quality;
CREATE TRIGGER song_discovery_quality_model_version_insert_guard
AFTER INSERT ON song_discovery_quality
REFERENCING NEW TABLE AS new_quality_rows
FOR EACH STATEMENT
EXECUTE FUNCTION enforce_discovery_quality_model_version();
CREATE TRIGGER song_discovery_quality_model_version_update_guard
AFTER UPDATE ON song_discovery_quality
REFERENCING NEW TABLE AS new_quality_rows
FOR EACH STATEMENT
EXECUTE FUNCTION enforce_discovery_quality_model_version();

COMMIT;
