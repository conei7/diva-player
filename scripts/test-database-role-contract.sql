\set ON_ERROR_STOP on

-- Run after schema.sql, migration 0017, and migration 0018.  The entire data
-- exercise is rolled back; the NOLOGIN roles created by 0018 remain in place.
BEGIN;

-- Exercise the migration's allowed overlap shape: two versioned, unprivileged
-- LOGIN generations may coexist while A/B slots move to the replacement.
CREATE ROLE diva_api_login_role_contract
    WITH LOGIN NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE
         NOREPLICATION NOBYPASSRLS;
CREATE ROLE diva_pipeline_login_role_contract
    WITH LOGIN NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE
         NOREPLICATION NOBYPASSRLS;
GRANT diva_api_runtime TO diva_api_login_role_contract
    WITH INHERIT TRUE, SET FALSE;
GRANT diva_pipeline_runtime TO diva_pipeline_login_role_contract
    WITH INHERIT TRUE, SET FALSE;

DO $catalog_contract$
DECLARE
    runtime_role RECORD;
    relation RECORD;
    sequence RECORD;
    app_function RECORD;
    expected_api_write BOOLEAN;
    expected_pipeline_write BOOLEAN;
BEGIN
    FOR runtime_role IN
        SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
               rolreplication, rolbypassrls
        FROM pg_roles
        WHERE rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    LOOP
        IF runtime_role.rolcanlogin
            OR runtime_role.rolsuper
            OR runtime_role.rolcreatedb
            OR runtime_role.rolcreaterole
            OR runtime_role.rolreplication
            OR runtime_role.rolbypassrls THEN
            RAISE EXCEPTION 'runtime role % has unsafe attributes', runtime_role.rolname;
        END IF;
    END LOOP;

    IF (SELECT count(*) FROM pg_roles
        WHERE rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')) <> 2 THEN
        RAISE EXCEPTION 'expected two runtime privilege roles';
    END IF;

    IF has_schema_privilege('diva_api_runtime', 'public', 'CREATE')
        OR has_schema_privilege('diva_pipeline_runtime', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'runtime role can create objects in public';
    END IF;

    IF NOT has_schema_privilege('diva_api_runtime', 'public', 'USAGE')
        OR NOT has_schema_privilege('diva_pipeline_runtime', 'public', 'USAGE') THEN
        RAISE EXCEPTION 'runtime role lacks public schema usage';
    END IF;

    IF has_database_privilege(
            'diva_api_runtime', current_database(), 'TEMPORARY'
        ) OR NOT has_database_privilege(
            'diva_pipeline_runtime', current_database(), 'TEMPORARY'
        ) THEN
        RAISE EXCEPTION 'runtime temporary-table privilege contract is invalid';
    END IF;

    IF NOT COALESCE((
        SELECT class.reloptions @> ARRAY[
            'autovacuum_vacuum_scale_factor=0.01',
            'autovacuum_vacuum_threshold=1000',
            'autovacuum_analyze_scale_factor=0.005',
            'autovacuum_analyze_threshold=500'
        ]::text[]
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'public'
          AND class.relname = 'songs'
    ), FALSE) THEN
        RAISE EXCEPTION 'songs autovacuum contract is missing';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_auth_members memberships
        JOIN pg_roles member ON member.oid = memberships.member
        WHERE member.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) THEN
        RAISE EXCEPTION 'runtime privilege role inherits another role';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_database database
        JOIN pg_roles owner ON owner.oid = database.datdba
        WHERE owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) OR EXISTS (
        SELECT 1
        FROM pg_namespace namespace
        JOIN pg_roles owner ON owner.oid = namespace.nspowner
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) OR EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_roles owner ON owner.oid = relation.relowner
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) OR EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        JOIN pg_roles owner ON owner.oid = procedure.proowner
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) OR EXISTS (
        SELECT 1
        FROM pg_type database_type
        JOIN pg_namespace namespace ON namespace.oid = database_type.typnamespace
        JOIN pg_roles owner ON owner.oid = database_type.typowner
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) OR EXISTS (
        SELECT 1
        FROM pg_extension extension
        JOIN pg_roles owner ON owner.oid = extension.extowner
        WHERE owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) THEN
        RAISE EXCEPTION 'runtime privilege role owns a database/non-system object';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles parent ON parent.oid = membership.roleid
        JOIN pg_roles member ON member.oid = membership.member
        WHERE parent.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
          AND (
              NOT member.rolcanlogin
              OR NOT member.rolinherit
              OR member.rolsuper
              OR member.rolcreatedb
              OR member.rolcreaterole
              OR member.rolreplication
              OR member.rolbypassrls
              OR membership.admin_option
              OR NOT membership.inherit_option
              OR membership.set_option
              OR (
                  parent.rolname = 'diva_api_runtime'
                  AND member.rolname !~ '^diva_api_login_[a-z0-9][a-z0-9_]*$'
              )
              OR (
                  parent.rolname = 'diva_pipeline_runtime'
                  AND member.rolname !~ '^diva_pipeline_login_[a-z0-9][a-z0-9_]*$'
              )
          )
    ) THEN
        RAISE EXCEPTION 'runtime privilege role has an unexpected member';
    END IF;

    FOR relation IN
        SELECT class.oid, class.relname, class.relowner
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'public'
          AND class.relkind IN ('r', 'p', 'v', 'm', 'f')
    LOOP
        IF relation.relowner IN (
            (SELECT oid FROM pg_roles WHERE rolname = 'diva_api_runtime'),
            (SELECT oid FROM pg_roles WHERE rolname = 'diva_pipeline_runtime')
        ) THEN
            RAISE EXCEPTION 'runtime role owns relation %', relation.relname;
        END IF;

        IF NOT has_table_privilege('diva_api_runtime', relation.oid, 'SELECT') THEN
            RAISE EXCEPTION 'API lacks SELECT on %', relation.relname;
        END IF;

        expected_api_write := relation.relname IN (
            'youtube_playlist_cache',
            'nico_playlist_cache'
        );
        IF has_table_privilege('diva_api_runtime', relation.oid, 'INSERT')
            IS DISTINCT FROM expected_api_write
            OR has_table_privilege('diva_api_runtime', relation.oid, 'UPDATE')
            IS DISTINCT FROM expected_api_write THEN
            RAISE EXCEPTION 'API write privilege mismatch on %', relation.relname;
        END IF;

        IF has_table_privilege('diva_api_runtime', relation.oid, 'DELETE')
            OR has_table_privilege('diva_api_runtime', relation.oid, 'TRUNCATE')
            OR has_table_privilege('diva_api_runtime', relation.oid, 'REFERENCES')
            OR has_table_privilege('diva_api_runtime', relation.oid, 'TRIGGER') THEN
            RAISE EXCEPTION 'API has excessive privilege on %', relation.relname;
        END IF;

        expected_pipeline_write := relation.relname NOT IN (
            'schema_migrations',
            'discovery_quality_model_policy'
        );
        IF NOT has_table_privilege('diva_pipeline_runtime', relation.oid, 'SELECT')
            OR has_table_privilege('diva_pipeline_runtime', relation.oid, 'INSERT')
                IS DISTINCT FROM expected_pipeline_write
            OR has_table_privilege('diva_pipeline_runtime', relation.oid, 'UPDATE')
                IS DISTINCT FROM expected_pipeline_write
            OR has_table_privilege('diva_pipeline_runtime', relation.oid, 'DELETE')
                IS DISTINCT FROM expected_pipeline_write THEN
            RAISE EXCEPTION 'pipeline DML privilege mismatch on %', relation.relname;
        END IF;

        IF has_table_privilege('diva_pipeline_runtime', relation.oid, 'TRUNCATE')
            IS DISTINCT FROM (relation.relname = 'markov_transitions') THEN
            RAISE EXCEPTION 'pipeline TRUNCATE privilege mismatch on %', relation.relname;
        END IF;

        IF has_table_privilege('diva_pipeline_runtime', relation.oid, 'REFERENCES')
            OR has_table_privilege('diva_pipeline_runtime', relation.oid, 'TRIGGER') THEN
            RAISE EXCEPTION 'pipeline has excessive structural privilege on %', relation.relname;
        END IF;
    END LOOP;

    FOR sequence IN
        SELECT class.oid, class.relname
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'public'
          AND class.relkind = 'S'
    LOOP
        IF has_sequence_privilege('diva_api_runtime', sequence.oid, 'USAGE')
            OR has_sequence_privilege('diva_api_runtime', sequence.oid, 'SELECT')
            OR has_sequence_privilege('diva_api_runtime', sequence.oid, 'UPDATE') THEN
            RAISE EXCEPTION 'API has sequence privilege on %', sequence.relname;
        END IF;

        IF NOT has_sequence_privilege('diva_pipeline_runtime', sequence.oid, 'USAGE')
            OR has_sequence_privilege('diva_pipeline_runtime', sequence.oid, 'SELECT')
            OR has_sequence_privilege('diva_pipeline_runtime', sequence.oid, 'UPDATE') THEN
            RAISE EXCEPTION 'pipeline sequence privilege mismatch on %', sequence.relname;
        END IF;
    END LOOP;

    FOR app_function IN
        SELECT procedure.oid, procedure.proname, procedure.proowner,
               procedure.prosecdef
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure.proname IN (
              'enforce_discovery_quality_policy_revision',
              'enforce_discovery_quality_model_version'
          )
    LOOP
        IF app_function.proowner IN (
            (SELECT oid FROM pg_roles WHERE rolname = 'diva_api_runtime'),
            (SELECT oid FROM pg_roles WHERE rolname = 'diva_pipeline_runtime')
        ) OR app_function.prosecdef THEN
            RAISE EXCEPTION 'unsafe owner/security mode on function %', app_function.proname;
        END IF;

        IF has_function_privilege('diva_api_runtime', app_function.oid, 'EXECUTE')
            OR NOT has_function_privilege('diva_pipeline_runtime', app_function.oid, 'EXECUTE') THEN
            RAISE EXCEPTION 'runtime trigger-function privilege mismatch on %', app_function.proname;
        END IF;

        IF EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(
                (SELECT proacl FROM pg_proc WHERE oid = app_function.oid),
                acldefault('f', app_function.proowner)
            )) privilege
            WHERE privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
        ) THEN
            RAISE EXCEPTION 'PUBLIC can execute trigger function %', app_function.proname;
        END IF;
    END LOOP;

    IF (SELECT count(*) FROM pg_trigger database_trigger
        JOIN pg_proc procedure ON procedure.oid = database_trigger.tgfoid
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE NOT database_trigger.tgisinternal
          AND namespace.nspname = 'public'
          AND procedure.proname IN (
              'enforce_discovery_quality_policy_revision',
              'enforce_discovery_quality_model_version'
          )
          AND database_trigger.tgenabled <> 'D') <> 3 THEN
        RAISE EXCEPTION 'discovery quality trigger contract is incomplete';
    END IF;
END;
$catalog_contract$;

-- Objects created after 0018 verify ALTER DEFAULT PRIVILEGES, including the
-- identity sequence and PostgreSQL's otherwise-PUBLIC function EXECUTE grant.
CREATE TABLE public._diva_role_contract_future_table (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE FUNCTION public._diva_role_contract_future_function()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS 'SELECT 1';

DO $future_object_contract$
BEGIN
    IF NOT has_table_privilege(
        'diva_api_runtime',
        'public._diva_role_contract_future_table',
        'SELECT'
    ) OR has_table_privilege(
        'diva_api_runtime',
        'public._diva_role_contract_future_table',
        'INSERT'
    ) THEN
        RAISE EXCEPTION 'future table API defaults are incorrect';
    END IF;

    IF NOT has_table_privilege(
        'diva_pipeline_runtime',
        'public._diva_role_contract_future_table',
        'SELECT'
    ) OR NOT has_table_privilege(
        'diva_pipeline_runtime',
        'public._diva_role_contract_future_table',
        'INSERT'
    ) OR NOT has_table_privilege(
        'diva_pipeline_runtime',
        'public._diva_role_contract_future_table',
        'UPDATE'
    ) OR NOT has_table_privilege(
        'diva_pipeline_runtime',
        'public._diva_role_contract_future_table',
        'DELETE'
    ) OR NOT has_sequence_privilege(
        'diva_pipeline_runtime',
        'public._diva_role_contract_future_table_id_seq',
        'USAGE'
    ) THEN
        RAISE EXCEPTION 'future table/sequence pipeline defaults are incorrect';
    END IF;

    IF has_table_privilege(
        'diva_pipeline_runtime',
        'public._diva_role_contract_future_table',
        'TRUNCATE'
    ) THEN
        RAISE EXCEPTION 'future table inherited excessive TRUNCATE privilege';
    END IF;

    IF has_function_privilege(
        'diva_api_runtime',
        'public._diva_role_contract_future_function()',
        'EXECUTE'
    ) OR has_function_privilege(
        'diva_pipeline_runtime',
        'public._diva_role_contract_future_function()',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'future function is executable by a runtime role';
    END IF;
END;
$future_object_contract$;

SET LOCAL ROLE diva_api_login_role_contract;

DO $api_select_contract$
DECLARE
    relation RECORD;
BEGIN
    FOR relation IN
        SELECT namespace.nspname, class.relname
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'public'
          AND class.relkind IN ('r', 'p', 'v', 'm', 'f')
    LOOP
        EXECUTE format(
            'SELECT 1 FROM %I.%I LIMIT 0',
            relation.nspname,
            relation.relname
        );
    END LOOP;
END;
$api_select_contract$;

INSERT INTO youtube_playlist_cache (
    playlist_id, title, video_ids, etag, truncated, fetched_at, updated_at
) VALUES (
    '__diva_role_contract__', 'first', '[]'::jsonb, NULL, FALSE, now(), now()
)
ON CONFLICT (playlist_id) DO UPDATE SET title = EXCLUDED.title;
INSERT INTO youtube_playlist_cache (
    playlist_id, title, video_ids, etag, truncated, fetched_at, updated_at
) VALUES (
    '__diva_role_contract__', 'second', '[]'::jsonb, NULL, FALSE, now(), now()
)
ON CONFLICT (playlist_id) DO UPDATE SET title = EXCLUDED.title;

INSERT INTO nico_playlist_cache (
    source_kind, source_id, title, video_ids, truncated, fetched_at, updated_at
) VALUES (
    'mylist', '__diva_role_contract__', 'first', '[]'::jsonb, FALSE, now(), now()
)
ON CONFLICT (source_kind, source_id) DO UPDATE SET title = EXCLUDED.title;
INSERT INTO nico_playlist_cache (
    source_kind, source_id, title, video_ids, truncated, fetched_at, updated_at
) VALUES (
    'mylist', '__diva_role_contract__', 'second', '[]'::jsonb, FALSE, now(), now()
)
ON CONFLICT (source_kind, source_id) DO UPDATE SET title = EXCLUDED.title;

DO $api_denials$
BEGIN
    BEGIN
        UPDATE songs SET name = name WHERE FALSE;
        RAISE EXCEPTION 'API unexpectedly updated songs';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        UPDATE song_discovery_quality
        SET quality_score = quality_score
        WHERE FALSE;
        RAISE EXCEPTION 'API unexpectedly updated discovery quality';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        DELETE FROM youtube_playlist_cache WHERE FALSE;
        RAISE EXCEPTION 'API unexpectedly deleted cache rows';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        EXECUTE 'CREATE TABLE public._diva_api_must_not_create (id integer)';
        RAISE EXCEPTION 'API unexpectedly created a table';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        EXECUTE 'CREATE TEMP TABLE _diva_api_must_not_create_temp (id integer)';
        RAISE EXCEPTION 'API unexpectedly created a temporary table';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        EXECUTE 'ALTER TABLE public.songs ADD COLUMN _diva_api_must_not_alter integer';
        RAISE EXCEPTION 'API unexpectedly altered a table';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END;
$api_denials$;

RESET ROLE;
SET LOCAL ROLE diva_pipeline_login_role_contract;

-- Required by the atomic state-cluster staging transaction in full step 04.
CREATE TEMP TABLE _diva_pipeline_temp_contract (id integer) ON COMMIT DROP;
DROP TABLE _diva_pipeline_temp_contract;

INSERT INTO songs (id, name, song_type)
VALUES (-2147483647, 'database-role-contract', 'Original');
UPDATE songs
SET artist_string = 'database-role-contract'
WHERE id = -2147483647;

-- This write exercises both policy trigger functions under the pipeline role.
INSERT INTO song_discovery_quality (song_id, model_version)
SELECT -2147483647, expected_model_version
FROM discovery_quality_model_policy
WHERE singleton = TRUE;
DELETE FROM song_discovery_quality WHERE song_id = -2147483647;

INSERT INTO pvs (song_id, service, pv_id, pv_type, disabled)
VALUES (-2147483647, 'Youtube', '__diva_role_contract__', 'Original', FALSE);
DELETE FROM pvs WHERE song_id = -2147483647;

INSERT INTO public._diva_role_contract_future_table (value)
VALUES ('pipeline-default-privileges');
UPDATE public._diva_role_contract_future_table
SET value = 'pipeline-update';
DELETE FROM public._diva_role_contract_future_table;

-- Required by ml_pipeline/04_build_hybrid_and_markov.py.  It rolls back with
-- the rest of this transaction.
TRUNCATE markov_transitions;
DELETE FROM songs WHERE id = -2147483647;

DO $pipeline_denials$
BEGIN
    BEGIN
        UPDATE discovery_quality_model_policy
        SET expected_revision = expected_revision
        WHERE FALSE;
        RAISE EXCEPTION 'pipeline unexpectedly updated discovery quality policy';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        DELETE FROM schema_migrations WHERE FALSE;
        RAISE EXCEPTION 'pipeline unexpectedly deleted migration history';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        EXECUTE 'CREATE TABLE public._diva_pipeline_must_not_create (id integer)';
        RAISE EXCEPTION 'pipeline unexpectedly created a table';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        EXECUTE 'ALTER TABLE public.songs ADD COLUMN _diva_pipeline_must_not_alter integer';
        RAISE EXCEPTION 'pipeline unexpectedly altered a table';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END;
$pipeline_denials$;

RESET ROLE;
ROLLBACK;

SELECT 'PASS least-privilege database runtime role contract' AS result;
