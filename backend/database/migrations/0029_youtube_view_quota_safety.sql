-- Keep enough of the verified 10,000-unit project quota for same-run retries.
-- 9,500 view requests cover the current due set while leaving 500 playlist
-- requests for the API. The pipeline reserves each retry through this function.
DO $quota_policy$
DECLARE
    policy jsonb;
BEGIN
    SELECT value::jsonb INTO STRICT policy
    FROM public.sync_state
    WHERE key = 'youtube_quota_policy_v2'
    FOR UPDATE;

    IF policy->>'views' <> '9000'
       OR policy->>'playlists' <> '1000'
       OR policy->>'activeAfter' IS NULL THEN
        RAISE EXCEPTION 'Unexpected YouTube quota policy before retry-safe activation';
    END IF;

    UPDATE public.sync_state
    SET value = jsonb_set(
                   jsonb_set(policy, '{views}', '9500'::jsonb, false),
                   '{playlists}', '500'::jsonb, false
               )::text,
        updated_at = clock_timestamp()
    WHERE key = 'youtube_quota_policy_v2';
END;
$quota_policy$;

-- Extend the function's accepted policy range for the forward-only policy
-- change above. Keep ownership, locking, and role separation unchanged.
CREATE OR REPLACE FUNCTION public.reserve_youtube_quota(p_purpose text)
RETURNS TABLE(granted boolean, quota_day date, budget integer, used integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE
    policy jsonb;
    stamp timestamptz;
    reset_at timestamptz;
    counter_key text;
    counter_value integer;
    allowance integer;
BEGIN
    IF p_purpose NOT IN ('views', 'playlists') OR p_purpose IS NULL THEN
        RAISE EXCEPTION 'Invalid YouTube quota purpose';
    END IF;
    IF NOT pg_has_role(session_user,
        CASE WHEN p_purpose = 'views' THEN 'diva_pipeline_runtime' ELSE 'diva_api_runtime' END,
        'MEMBER') THEN
        RAISE EXCEPTION 'YouTube quota purpose not permitted' USING ERRCODE = '42501';
    END IF;
    SELECT value::jsonb INTO STRICT policy FROM public.sync_state
    WHERE key = 'youtube_quota_policy_v2' FOR UPDATE;
    IF (policy->>'views')::integer NOT BETWEEN 1 AND 9500
       OR (policy->>'playlists')::integer NOT BETWEEN 1 AND 1000
       OR policy->>'views' IS NULL OR policy->>'playlists' IS NULL
       OR policy->>'activeAfter' IS NULL THEN
        RAISE EXCEPTION 'Invalid YouTube quota policy';
    END IF;
    stamp := clock_timestamp();
    quota_day := (stamp AT TIME ZONE 'America/Los_Angeles')::date;
    reset_at := (quota_day + 1)::timestamp AT TIME ZONE 'America/Los_Angeles';
    allowance := (policy->>p_purpose)::integer;
    counter_key := 'youtube_quota_v2:' || quota_day::text || ':' || p_purpose;
    INSERT INTO public.sync_state(key, value, updated_at)
    VALUES (counter_key, '0', stamp) ON CONFLICT (key) DO NOTHING;
    SELECT value::integer INTO STRICT counter_value FROM public.sync_state WHERE key = counter_key;
    IF counter_value < 0 THEN RAISE EXCEPTION 'Invalid YouTube quota counter'; END IF;
    granted := counter_value < allowance
        AND stamp >= (policy->>'activeAfter')::timestamptz
        AND stamp < reset_at - INTERVAL '60 seconds';
    IF granted THEN
        counter_value := counter_value + 1;
        UPDATE public.sync_state SET value = counter_value::text, updated_at = stamp WHERE key = counter_key;
    END IF;
    budget := allowance;
    used := counter_value;
    RETURN NEXT;
END;
$body$;
REVOKE ALL ON FUNCTION public.reserve_youtube_quota(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_youtube_quota(text) TO diva_api_runtime, diva_pipeline_runtime;
