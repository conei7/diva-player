-- Enable the verified 9,000-unit view allowance while reserving 1,000 units
-- for playlist synchronization. The project-wide daily quota was confirmed as
-- 10,000 units in Google Cloud Console on 2026-09-08.
DO $quota_policy$
DECLARE
    policy jsonb;
BEGIN
    SELECT value::jsonb INTO STRICT policy
    FROM public.sync_state
    WHERE key = 'youtube_quota_policy_v2'
    FOR UPDATE;

    IF policy->>'views' <> '3000'
       OR policy->>'playlists' <> '1000'
       OR policy->>'activeAfter' IS NULL THEN
        RAISE EXCEPTION 'Unexpected YouTube quota policy before 9,000-unit activation';
    END IF;

    UPDATE public.sync_state
    SET value = jsonb_set(policy, '{views}', '9000'::jsonb, false)::text,
        updated_at = clock_timestamp()
    WHERE key = 'youtube_quota_policy_v2';
END;
$quota_policy$;
