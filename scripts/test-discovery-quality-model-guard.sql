\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    test_song_id CONSTANT INTEGER := -2147483648;
    expected_version TEXT;
BEGIN
    SELECT expected_model_version
    INTO STRICT expected_version
    FROM discovery_quality_model_policy
    WHERE singleton = TRUE;

    IF EXISTS (SELECT 1 FROM songs WHERE id = test_song_id) THEN
        RAISE EXCEPTION 'reserved model-guard test song id already exists';
    END IF;

    INSERT INTO songs (id, name, song_type)
    VALUES (test_song_id, 'model-guard-transaction-test', 'Original');

    BEGIN
        INSERT INTO song_discovery_quality (song_id, model_version)
        VALUES (test_song_id, 'heuristic-v2');
        RAISE EXCEPTION 'outdated model insert was not rejected';
    EXCEPTION
        WHEN check_violation THEN
            IF SQLERRM NOT LIKE 'discovery quality model version % is not allowed%' THEN
                RAISE;
            END IF;
    END;

    INSERT INTO song_discovery_quality (song_id, model_version)
    VALUES (test_song_id, expected_version);

    BEGIN
        INSERT INTO song_discovery_quality (song_id, model_version)
        VALUES (test_song_id, 'heuristic-v2')
        ON CONFLICT (song_id) DO UPDATE
        SET model_version = EXCLUDED.model_version;
        RAISE EXCEPTION 'outdated model upsert was not rejected';
    EXCEPTION
        WHEN check_violation THEN
            IF SQLERRM NOT LIKE 'discovery quality model version % is not allowed%' THEN
                RAISE;
            END IF;
    END;

    BEGIN
        UPDATE song_discovery_quality
        SET model_version = 'heuristic-v2'
        WHERE song_id = test_song_id;
        RAISE EXCEPTION 'outdated model update was not rejected';
    EXCEPTION
        WHEN check_violation THEN
            IF SQLERRM NOT LIKE 'discovery quality model version % is not allowed%' THEN
                RAISE;
            END IF;
    END;

    IF (SELECT model_version FROM song_discovery_quality WHERE song_id = test_song_id)
        IS DISTINCT FROM expected_version THEN
        RAISE EXCEPTION 'rejected update changed the protected row';
    END IF;
END;
$$;

DO $$
DECLARE
    original_version TEXT;
    original_revision INTEGER;
BEGIN
    SELECT expected_model_version, expected_revision
    INTO STRICT original_version, original_revision
    FROM discovery_quality_model_policy
    WHERE singleton = TRUE;

    BEGIN
        UPDATE discovery_quality_model_policy
        SET expected_model_version = 'heuristic-v2',
            expected_revision = 2
        WHERE singleton = TRUE;
        RAISE EXCEPTION 'model policy downgrade was not rejected';
    EXCEPTION
        WHEN check_violation THEN
            IF SQLERRM NOT LIKE 'discovery quality model policy cannot move backward%' THEN
                RAISE;
            END IF;
    END;

    IF (SELECT expected_model_version FROM discovery_quality_model_policy WHERE singleton = TRUE)
        IS DISTINCT FROM original_version
        OR (SELECT expected_revision FROM discovery_quality_model_policy WHERE singleton = TRUE)
        IS DISTINCT FROM original_revision THEN
        RAISE EXCEPTION 'rejected policy downgrade changed the policy';
    END IF;
END;
$$;

ROLLBACK;

SELECT 'PASS discovery quality model guard transaction contract' AS result;
