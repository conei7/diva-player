-- Rebuild ACLs omitted by the no-owner/no-privileges disaster dump.
-- Apply only to an isolated restored database, after migrations 0018 and 0025
-- and before running test-database-role-contract.sql.  No migration-history
-- rows change.
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
SET LOCAL log_error_verbosity = 'terse';
SET LOCAL search_path = pg_catalog, public;

DO $restore_role_preflight$
BEGIN
    IF (SELECT count(*) FROM pg_roles
        WHERE rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')) <> 2 THEN
        RAISE EXCEPTION 'migration 0018 runtime privilege roles are missing';
    END IF;

    IF to_regclass('public.song_album_links') IS NULL
       OR to_regprocedure('public.sync_song_album_links_from_raw_json_v1()') IS NULL
       OR to_regprocedure('public.reserve_youtube_quota(text)') IS NULL THEN
        RAISE EXCEPTION 'restored database is missing a relation or routine with a runtime ACL contract';
    END IF;
END;
$restore_role_preflight$;

-- Migration 0023 introduced these ACLs after the reusable 0018 role policy.
REVOKE ALL PRIVILEGES ON TABLE public.song_album_links
    FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;
GRANT SELECT ON TABLE public.song_album_links TO diva_api_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.song_album_links
    TO diva_pipeline_runtime;
REVOKE ALL ON FUNCTION public.sync_song_album_links_from_raw_json_v1()
    FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;
-- The migration drops its temporary backfill procedure after completing work.

-- Migrations 0026 and 0029 installed the same quota-routine ACL contract.
REVOKE ALL ON FUNCTION public.reserve_youtube_quota(text)
    FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;
GRANT EXECUTE ON FUNCTION public.reserve_youtube_quota(text)
    TO diva_api_runtime, diva_pipeline_runtime;

COMMIT;
