-- Run only against an isolated fixture database; all changes roll back.
BEGIN;
SELECT set_config('diva.quota_test_admin', session_user, true);
UPDATE public.sync_state SET value = '{"views":3,"playlists":2,"activeAfter":"2000-01-01T00:00:00Z"}'
WHERE key = 'youtube_quota_policy_v2';
DELETE FROM public.sync_state WHERE key LIKE 'youtube_quota_v2:%';
SET SESSION AUTHORIZATION diva_pipeline_runtime;
DO $test$
DECLARE result record; i integer;
BEGIN
    FOR i IN 1..5 LOOP
        SELECT * INTO result FROM public.reserve_youtube_quota('views');
        IF result.granted <> (i <= 3) OR result.used <> LEAST(i, 3) OR result.budget <> 3 THEN
            RAISE EXCEPTION 'view limit violated: %', result;
        END IF;
        IF result.quota_day <> (clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date THEN
            RAISE EXCEPTION 'wrong quota date';
        END IF;
    END LOOP;
    BEGIN
        PERFORM public.reserve_youtube_quota('playlists');
        RAISE EXCEPTION 'pipeline used playlist quota';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$test$;
DO $reset$ BEGIN EXECUTE format('SET SESSION AUTHORIZATION %I', current_setting('diva.quota_test_admin')); END; $reset$;
SET SESSION AUTHORIZATION diva_api_runtime;
DO $test$
DECLARE result record; i integer;
BEGIN
    FOR i IN 1..4 LOOP
        SELECT * INTO result FROM public.reserve_youtube_quota('playlists');
        IF result.granted <> (i <= 2) OR result.used <> LEAST(i, 2) THEN
            RAISE EXCEPTION 'playlist limit violated';
        END IF;
    END LOOP;
    BEGIN
        PERFORM public.reserve_youtube_quota('views');
        RAISE EXCEPTION 'API used reserved view quota';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN
        UPDATE public.sync_state SET value = '0' WHERE key LIKE 'youtube_quota_v2:%';
        RAISE EXCEPTION 'API can refund quota';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$test$;
DO $reset$ BEGIN EXECUTE format('SET SESSION AUTHORIZATION %I', current_setting('diva.quota_test_admin')); END; $reset$;
UPDATE public.sync_state SET value = '{"views":9000,"playlists":1000,"activeAfter":"2999-01-01T00:00:00Z"}'
WHERE key = 'youtube_quota_policy_v2';
DO $test$
BEGIN
    IF (SELECT granted FROM public.reserve_youtube_quota('views')) THEN
        RAISE EXCEPTION 'quota activated before cutover';
    END IF;
    -- PT midnight across both DST transitions and UTC midnight.
    IF ('2026-03-08 00:00'::timestamp AT TIME ZONE 'America/Los_Angeles') <> '2026-03-08 08:00Z'::timestamptz
       OR ('2026-03-09 00:00'::timestamp AT TIME ZONE 'America/Los_Angeles') <> '2026-03-09 07:00Z'::timestamptz
       OR ('2026-11-01 00:00'::timestamp AT TIME ZONE 'America/Los_Angeles') <> '2026-11-01 07:00Z'::timestamptz
       OR ('2026-11-02 00:00'::timestamp AT TIME ZONE 'America/Los_Angeles') <> '2026-11-02 08:00Z'::timestamptz
       OR ('2026-09-08 00:00Z'::timestamptz AT TIME ZONE 'America/Los_Angeles')::date <> '2026-09-07'::date THEN
        RAISE EXCEPTION 'PT reset boundary mismatch';
    END IF;
END;
$test$;
ROLLBACK;
