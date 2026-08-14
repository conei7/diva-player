-- GetSongInfoBatch previously expanded songs.raw_json->'albums' for every
-- cold recommendation candidate.  With roughly 768k songs that JSONB is
-- commonly out-of-line TOAST data, although recommendation ranking needs only
-- its small ordered integer relationship.  Normalize it without rewriting or
-- locking the songs heap as a whole.
--
-- The migration intentionally commits one top-level CALL per 5,000 song IDs.
-- A crash can therefore leave a prefix populated, but migrate.sh records this
-- migration only after the complete file (including exact parity validation)
-- succeeds.  A retry rebuilds every batch with DELETE+INSERT and converges.

\set ON_ERROR_STOP on
\set AUTOCOMMIT on
SET search_path = pg_catalog, public;
SET lock_timeout = '5s';

CREATE TEMP TABLE song_album_migration_runtime_v1 (
    started_at TIMESTAMPTZ NOT NULL
) ON COMMIT PRESERVE ROWS;
INSERT INTO song_album_migration_runtime_v1(started_at)
VALUES (clock_timestamp());

-- Writers using the supported runner hold one or both of these session locks.
-- Hold both across every batch commit so a sync cannot mutate raw_json between
-- backfill and parity validation.  Failure releases any acquired lock when
-- psql exits and never records migration history.
DO $writer_preflight$
BEGIN
    IF NOT pg_try_advisory_lock(hashtext('diva-data-pipeline-publication-v1')) THEN
        RAISE EXCEPTION
            '0023 requires the global pipeline writer lease to be idle';
    END IF;
    IF NOT pg_try_advisory_lock(hashtext('diva-data-pipeline-child-v1')) THEN
        RAISE EXCEPTION
            '0023 requires the pipeline child writer lease to be idle';
    END IF;
END;
$writer_preflight$;

-- Install the table, ACLs, and both maintenance trigger phases atomically.
-- A process crash must expose either the old schema or the complete dual-write
-- cutover, never a table/function state that an old writer can update without
-- the missing-key preservation trigger.  This is a short metadata transaction;
-- all 768k-row data work remains in the bounded top-level CALLs below.
BEGIN;

-- All objects in this migration must stay under the same schema owner as the
-- songs source table.  A privileged but non-owner migration login would make
-- later CREATE OR REPLACE behavior ambiguous, so stop instead of accepting a
-- mixed-ownership cutover.
DO $migration_owner_preflight$
DECLARE
    songs_owner OID := (
        SELECT relation.relowner
        FROM pg_class relation
        WHERE relation.oid = 'public.songs'::regclass
    );
    migration_owner OID := (
        SELECT role_state.oid
        FROM pg_roles role_state
        WHERE role_state.rolname = current_user
    );
BEGIN
    IF songs_owner IS DISTINCT FROM migration_owner THEN
        RAISE EXCEPTION
            '0023 must run as the owner of public.songs';
    END IF;
END;
$migration_owner_preflight$;

-- Fail closed on a colliding object or a partially/manual-created table.  The
-- exact primary key is also the API's ordered per-song access path.
DO $table_preflight$
DECLARE
    album_relation regclass := to_regclass('public.song_album_links');
BEGIN
    IF album_relation IS NOT NULL AND (
        NOT EXISTS (
            SELECT 1
            FROM pg_class relation
            WHERE relation.oid = album_relation
              AND relation.relkind = 'r'
              AND relation.relpersistence = 'p'
              AND relation.relowner = (
                  SELECT songs_relation.relowner
                  FROM pg_class songs_relation
                  WHERE songs_relation.oid = 'public.songs'::regclass
              )
              AND NOT relation.relrowsecurity
              AND NOT relation.relforcerowsecurity
        )
        OR (
            SELECT COUNT(*)
            FROM pg_constraint constraint_state
            WHERE constraint_state.conrelid = album_relation
        ) <> 3
        OR (
            SELECT array_agg(
                attribute.attname || ':' ||
                format_type(attribute.atttypid, attribute.atttypmod) || ':' ||
                attribute.attnotnull::text
                ORDER BY attribute.attnum
            )
            FROM pg_attribute attribute
            WHERE attribute.attrelid = album_relation
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
        ) IS DISTINCT FROM ARRAY[
            'song_id:integer:true',
            'ordinal:integer:true',
            'album_id:integer:true'
        ]
        OR NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_state
            WHERE constraint_state.conrelid = album_relation
              AND constraint_state.contype = 'p'
              AND constraint_state.convalidated
              AND NOT constraint_state.condeferrable
              AND NOT constraint_state.condeferred
              AND pg_get_constraintdef(constraint_state.oid, TRUE)
                  = 'PRIMARY KEY (song_id, ordinal)'
        )
        OR NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_state
            WHERE constraint_state.conrelid = album_relation
              AND constraint_state.contype = 'f'
              AND constraint_state.confrelid = 'public.songs'::regclass
              AND constraint_state.confdeltype = 'c'
              AND constraint_state.convalidated
              AND NOT constraint_state.condeferrable
              AND NOT constraint_state.condeferred
              AND pg_get_constraintdef(constraint_state.oid, TRUE)
                  = 'FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE'
        )
        OR NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_state
            WHERE constraint_state.conrelid = album_relation
              AND constraint_state.contype = 'c'
              AND constraint_state.convalidated
              AND pg_get_constraintdef(constraint_state.oid, TRUE)
                  IN ('CHECK (ordinal > 0)', 'CHECK ((ordinal > 0))')
        )
        OR EXISTS (
            SELECT 1
            FROM pg_trigger trigger_state
            WHERE trigger_state.tgrelid = album_relation
              AND NOT trigger_state.tgisinternal
        )
        OR EXISTS (
            SELECT 1
            FROM pg_rewrite rule_state
            WHERE rule_state.ev_class = album_relation
        )
        OR EXISTS (
            SELECT 1
            FROM pg_class relation
            CROSS JOIN LATERAL aclexplode(
                COALESCE(relation.relacl, acldefault('r', relation.relowner))
            ) privilege
            WHERE relation.oid = album_relation
              AND privilege.grantee NOT IN (
                  relation.relowner,
                  0,
                  (SELECT role_state.oid FROM pg_roles role_state
                   WHERE role_state.rolname = 'diva_api_runtime'),
                  (SELECT role_state.oid FROM pg_roles role_state
                   WHERE role_state.rolname = 'diva_pipeline_runtime')
              )
        )
        OR EXISTS (
            SELECT 1
            FROM pg_attribute attribute
            CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
            WHERE attribute.attrelid = album_relation
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
        )
    ) THEN
        RAISE EXCEPTION
            'song_album_links exists with unexpected semantics; inspect it before retrying 0023';
    END IF;
END;
$table_preflight$;

CREATE TABLE IF NOT EXISTS public.song_album_links (
    song_id   INTEGER NOT NULL REFERENCES public.songs(id) ON DELETE CASCADE,
    ordinal   INTEGER NOT NULL CHECK (ordinal > 0),
    album_id  INTEGER NOT NULL,
    PRIMARY KEY (song_id, ordinal)
);

-- Production already has 0018 and its default privileges, but make the new
-- object's least-privilege contract explicit and independently testable.
REVOKE ALL PRIVILEGES ON TABLE public.song_album_links
    FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;
GRANT SELECT ON TABLE public.song_album_links TO diva_api_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.song_album_links
    TO diva_pipeline_runtime;

-- The trigger makes the schema safe across either deployment order:
--
-- * deploy the new pipeline first when possible; it can start before 0023
--   because it only adds Albums to raw_json and performs no link-table DML;
-- * after 0023, a direct UPDATE missing `albums` copies it from OLD, while a
--   non-owner INSERT missing the key fails closed.  Rolling back to an old
--   step-00 writer therefore cannot silently create an unnormalized song;
-- * a new checkout sends an explicit array (including []), which is replaced
--   atomically with the songs row.
DO $sync_function_preflight$
DECLARE
    sync_function regprocedure :=
        to_regprocedure('public.sync_song_album_links_from_raw_json_v1()');
    songs_owner OID := (
        SELECT relation.relowner
        FROM pg_class relation
        WHERE relation.oid = 'public.songs'::regclass
    );
BEGIN
    IF sync_function IS NOT NULL AND (
        NOT EXISTS (
            SELECT 1
            FROM pg_proc procedure_state
            JOIN pg_language language_state
              ON language_state.oid = procedure_state.prolang
            WHERE procedure_state.oid = sync_function
              AND procedure_state.proowner = songs_owner
              AND procedure_state.prokind = 'f'
              AND procedure_state.prorettype = 'trigger'::regtype
              AND procedure_state.pronargs = 0
              AND NOT procedure_state.prosecdef
              AND procedure_state.provolatile = 'v'
              AND procedure_state.proparallel = 'u'
              AND procedure_state.proconfig IS NOT DISTINCT FROM
                  ARRAY['search_path=pg_catalog, public']::TEXT[]
              AND language_state.lanname = 'plpgsql'
        )
        OR EXISTS (
            SELECT 1
            FROM pg_proc procedure_state
            CROSS JOIN LATERAL aclexplode(
                COALESCE(
                    procedure_state.proacl,
                    acldefault('f', procedure_state.proowner)
                )
            ) privilege
            WHERE procedure_state.oid = sync_function
              AND privilege.grantee NOT IN (
                  procedure_state.proowner,
                  0,
                  (SELECT role_state.oid FROM pg_roles role_state
                   WHERE role_state.rolname = 'diva_api_runtime'),
                  (SELECT role_state.oid FROM pg_roles role_state
                   WHERE role_state.rolname = 'diva_pipeline_runtime')
              )
        )
    ) THEN
        RAISE EXCEPTION
            'sync_song_album_links_from_raw_json_v1 exists with unexpected ownership or execution semantics';
    END IF;
END;
$sync_function_preflight$;

CREATE OR REPLACE FUNCTION public.sync_song_album_links_from_raw_json_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $sync_album_links$
BEGIN
    IF TG_WHEN = 'BEFORE' THEN
        IF TG_OP = 'INSERT' THEN
            IF jsonb_typeof(NEW.raw_json) = 'object'
               AND NOT (NEW.raw_json ? 'albums')
               AND to_regrole(CURRENT_USER)::OID <> (
                   SELECT relation.relowner
                   FROM pg_class relation
                   WHERE relation.oid = 'public.songs'::regclass
               ) THEN
                RAISE EXCEPTION
                    'non-owner song INSERT must include an explicit albums key'
                    USING ERRCODE = '23514';
            END IF;
        ELSIF TG_OP = 'UPDATE' THEN
            IF jsonb_typeof(NEW.raw_json) = 'object'
               AND NOT (NEW.raw_json ? 'albums')
               AND jsonb_typeof(OLD.raw_json) = 'object'
               AND OLD.raw_json ? 'albums' THEN
                NEW.raw_json := NEW.raw_json || jsonb_build_object(
                    'albums', OLD.raw_json -> 'albums'
                );
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    DELETE FROM public.song_album_links
    WHERE song_id = NEW.id;

    INSERT INTO public.song_album_links (song_id, ordinal, album_id)
    SELECT NEW.id,
           album.ordinal::INTEGER,
           (album.value ->> 'id')::INTEGER
    FROM jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(NEW.raw_json -> 'albums') = 'array'
                THEN NEW.raw_json -> 'albums'
            ELSE '[]'::jsonb
        END
    ) WITH ORDINALITY AS album(value, ordinal)
    WHERE album.value ->> 'id' ~ '^[0-9]+$';

    RETURN NEW;
END;
$sync_album_links$;

REVOKE ALL ON FUNCTION public.sync_song_album_links_from_raw_json_v1()
    FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;

DO $sync_trigger_preflight$
DECLARE
    sync_function regprocedure :=
        'public.sync_song_album_links_from_raw_json_v1()'::regprocedure;
    raw_json_attribute_number SMALLINT := (
        SELECT attribute.attnum
        FROM pg_attribute attribute
        WHERE attribute.attrelid = 'public.songs'::regclass
          AND attribute.attname = 'raw_json'
          AND NOT attribute.attisdropped
    );
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_trigger trigger_state
        WHERE trigger_state.tgrelid = 'public.songs'::regclass
          AND trigger_state.tgname = 'song_album_insert_guard_v1'
          AND NOT (
              NOT trigger_state.tgisinternal
              AND trigger_state.tgenabled = 'O'
              AND trigger_state.tgfoid = sync_function
              AND trigger_state.tgtype = 7
              AND trigger_state.tgattr::TEXT = ''
              AND trigger_state.tgqual IS NULL
          )
    ) THEN
        RAISE EXCEPTION
            'song_album_insert_guard_v1 exists with unexpected trigger semantics';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_trigger trigger_state
        WHERE trigger_state.tgrelid = 'public.songs'::regclass
          AND trigger_state.tgname = 'song_album_key_preserve_v1'
          AND NOT (
              NOT trigger_state.tgisinternal
              AND trigger_state.tgenabled = 'O'
              AND trigger_state.tgfoid = sync_function
              AND trigger_state.tgtype = 19
              AND trigger_state.tgattr::TEXT = raw_json_attribute_number::TEXT
              AND trigger_state.tgqual IS NULL
          )
    ) THEN
        RAISE EXCEPTION
            'song_album_key_preserve_v1 exists with unexpected trigger semantics';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_trigger trigger_state
        WHERE trigger_state.tgrelid = 'public.songs'::regclass
          AND trigger_state.tgname = 'song_album_links_sync_v1'
          AND NOT (
              NOT trigger_state.tgisinternal
              AND trigger_state.tgenabled = 'O'
              AND trigger_state.tgfoid = sync_function
              AND trigger_state.tgtype = 21
              AND trigger_state.tgattr::TEXT = raw_json_attribute_number::TEXT
              AND trigger_state.tgqual IS NULL
          )
    ) THEN
        RAISE EXCEPTION
            'song_album_links_sync_v1 exists with unexpected trigger semantics';
    END IF;
END;
$sync_trigger_preflight$;

CREATE OR REPLACE TRIGGER song_album_insert_guard_v1
BEFORE INSERT ON public.songs
FOR EACH ROW
EXECUTE FUNCTION public.sync_song_album_links_from_raw_json_v1();

CREATE OR REPLACE TRIGGER song_album_key_preserve_v1
BEFORE UPDATE OF raw_json ON public.songs
FOR EACH ROW
EXECUTE FUNCTION public.sync_song_album_links_from_raw_json_v1();

CREATE OR REPLACE TRIGGER song_album_links_sync_v1
AFTER INSERT OR UPDATE OF raw_json ON public.songs
FOR EACH ROW
EXECUTE FUNCTION public.sync_song_album_links_from_raw_json_v1();

DO $backfill_procedure_preflight$
DECLARE
    backfill_procedure regprocedure :=
        to_regprocedure(
            'public.backfill_song_album_links_batch_v1(integer,integer)'
        );
    songs_owner OID := (
        SELECT relation.relowner
        FROM pg_class relation
        WHERE relation.oid = 'public.songs'::regclass
    );
BEGIN
    IF backfill_procedure IS NOT NULL AND (
        NOT EXISTS (
            SELECT 1
            FROM pg_proc procedure_state
            JOIN pg_language language_state
              ON language_state.oid = procedure_state.prolang
            WHERE procedure_state.oid = backfill_procedure
              AND procedure_state.proowner = songs_owner
              AND procedure_state.prokind = 'p'
              AND procedure_state.prorettype = 'void'::regtype
              AND procedure_state.pronargs = 2
              AND procedure_state.proargtypes = '23 23'::OIDVECTOR
              AND NOT procedure_state.prosecdef
              AND procedure_state.provolatile = 'v'
              AND procedure_state.proparallel = 'u'
              AND procedure_state.proconfig IS NULL
              AND language_state.lanname = 'plpgsql'
        )
        OR EXISTS (
            SELECT 1
            FROM pg_proc procedure_state
            CROSS JOIN LATERAL aclexplode(
                COALESCE(
                    procedure_state.proacl,
                    acldefault('f', procedure_state.proowner)
                )
            ) privilege
            WHERE procedure_state.oid = backfill_procedure
              AND privilege.grantee NOT IN (
                  procedure_state.proowner,
                  0,
                  (SELECT role_state.oid FROM pg_roles role_state
                   WHERE role_state.rolname = 'diva_api_runtime'),
                  (SELECT role_state.oid FROM pg_roles role_state
                   WHERE role_state.rolname = 'diva_pipeline_runtime')
              )
        )
    ) THEN
        RAISE EXCEPTION
            'backfill_song_album_links_batch_v1 exists with unexpected ownership, execution, or ACL semantics';
    END IF;
END;
$backfill_procedure_preflight$;

CREATE OR REPLACE PROCEDURE public.backfill_song_album_links_batch_v1(
    first_song_id INTEGER,
    last_song_id INTEGER
)
LANGUAGE plpgsql
AS $backfill$
BEGIN
    IF first_song_id IS NULL OR last_song_id IS NULL
       OR first_song_id > last_song_id THEN
        RAISE EXCEPTION 'invalid song album backfill range: %..%',
            first_song_id, last_song_id;
    END IF;

    DELETE FROM public.song_album_links links
    WHERE links.song_id BETWEEN first_song_id AND last_song_id;

    INSERT INTO public.song_album_links (song_id, ordinal, album_id)
    SELECT song.id,
           album.ordinal::INTEGER,
           (album.value ->> 'id')::INTEGER
    FROM public.songs song
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(song.raw_json -> 'albums') = 'array'
                THEN song.raw_json -> 'albums'
            ELSE '[]'::jsonb
        END
    ) WITH ORDINALITY AS album(value, ordinal)
    WHERE song.id BETWEEN first_song_id AND last_song_id
      AND album.value ->> 'id' ~ '^[0-9]+$';
END;
$backfill$;

REVOKE ALL ON PROCEDURE public.backfill_song_album_links_batch_v1(INTEGER, INTEGER)
    FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;

-- Preflights reject unexpected ACLs on objects that already exist.  Validate
-- once more after creation so a stray owner ALTER DEFAULT PRIVILEGES grant
-- cannot add an unknown role during the absent-object path.
DO $post_create_acl_validation$
DECLARE
    songs_owner OID := (
        SELECT relation.relowner
        FROM pg_class relation
        WHERE relation.oid = 'public.songs'::regclass
    );
    api_role OID := (
        SELECT role_state.oid
        FROM pg_roles role_state
        WHERE role_state.rolname = 'diva_api_runtime'
    );
    pipeline_role OID := (
        SELECT role_state.oid
        FROM pg_roles role_state
        WHERE role_state.rolname = 'diva_pipeline_runtime'
    );
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(
            COALESCE(relation.relacl, acldefault('r', relation.relowner))
        ) privilege
        WHERE relation.oid = 'public.song_album_links'::regclass
          AND NOT (
              privilege.grantee = songs_owner
              OR (
                  privilege.grantee = api_role
                  AND privilege.privilege_type = 'SELECT'
              )
              OR (
                  privilege.grantee = pipeline_role
                  AND privilege.privilege_type IN (
                      'SELECT', 'INSERT', 'UPDATE', 'DELETE'
                  )
              )
          )
    ) OR (
        SELECT array_agg(privilege.privilege_type ORDER BY privilege.privilege_type)
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(relation.relacl) privilege
        WHERE relation.oid = 'public.song_album_links'::regclass
          AND privilege.grantee = api_role
    ) IS DISTINCT FROM ARRAY['SELECT']::TEXT[]
    OR (
        SELECT array_agg(privilege.privilege_type ORDER BY privilege.privilege_type)
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(relation.relacl) privilege
        WHERE relation.oid = 'public.song_album_links'::regclass
          AND privilege.grantee = pipeline_role
    ) IS DISTINCT FROM ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::TEXT[]
    OR EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
        WHERE attribute.attrelid = 'public.song_album_links'::regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
    ) OR EXISTS (
        SELECT 1
        FROM pg_proc procedure_state
        CROSS JOIN LATERAL aclexplode(
            COALESCE(
                procedure_state.proacl,
                acldefault('f', procedure_state.proowner)
            )
        ) privilege
        WHERE procedure_state.oid IN (
            'public.sync_song_album_links_from_raw_json_v1()'::regprocedure,
            'public.backfill_song_album_links_batch_v1(integer,integer)'::regprocedure
        )
          AND privilege.grantee <> songs_owner
    ) THEN
        RAISE EXCEPTION
            '0023 post-create ACL validation found an unexpected default or runtime grant';
    END IF;
END;
$post_create_acl_validation$;

COMMIT;

-- Boundary enumeration reads only songs' primary-key index.  \gexec submits
-- every CALL separately at top level with AUTOCOMMIT enabled, so the
-- 120-second statement timeout and transaction boundary apply to one bounded
-- batch rather than the full table.  The procedure itself does not commit.
SET statement_timeout = '10min';
WITH numbered_songs AS MATERIALIZED (
    SELECT id,
           ((row_number() OVER (ORDER BY id) - 1) / 5000)::INTEGER AS batch_number
    FROM public.songs
), song_batches AS (
    SELECT batch_number, MIN(id) AS first_song_id, MAX(id) AS last_song_id
    FROM numbered_songs
    GROUP BY batch_number
)
SELECT 'SET statement_timeout = ''120s''',
       format(
           'CALL public.backfill_song_album_links_batch_v1(%s, %s)',
           first_song_id,
           last_song_id
       )
FROM song_batches
ORDER BY batch_number
\gexec

SET statement_timeout = '30min';
DO $writer_lock_continuity$
DECLARE
    held_lock_count INTEGER;
BEGIN
    WITH expected_lock(lock_key) AS (
        VALUES
            (hashtext('diva-data-pipeline-publication-v1')::BIGINT),
            (hashtext('diva-data-pipeline-child-v1')::BIGINT)
    )
    SELECT COUNT(*)
    INTO held_lock_count
    FROM expected_lock expected
    JOIN pg_locks held
      ON held.pid = pg_backend_pid()
     AND held.locktype = 'advisory'
     AND held.granted
     AND held.objsubid = 1
     AND held.classid::BIGINT = CASE
         WHEN expected.lock_key < 0 THEN 4294967295
         ELSE 0
     END
     AND held.objid::BIGINT = (expected.lock_key & 4294967295);

    IF held_lock_count <> 2 THEN
        RAISE EXCEPTION
            '0023 lost a pipeline writer lease across batch commits; refusing parity validation';
    END IF;
END;
$writer_lock_continuity$;

DO $parity_validation$
DECLARE
    validation_started_at TIMESTAMPTZ := clock_timestamp();
    migration_started_at TIMESTAMPTZ;
    link_count BIGINT;
    missing_count BIGINT;
    unexpected_count BIGINT;
BEGIN
    SELECT started_at
    INTO STRICT migration_started_at
    FROM song_album_migration_runtime_v1;

    WITH expected AS MATERIALIZED (
        SELECT song.id AS song_id,
               album.ordinal::INTEGER AS ordinal,
               (album.value ->> 'id')::INTEGER AS album_id
        FROM public.songs song
        CROSS JOIN LATERAL jsonb_array_elements(
            CASE
                WHEN jsonb_typeof(song.raw_json -> 'albums') = 'array'
                    THEN song.raw_json -> 'albums'
                ELSE '[]'::jsonb
            END
        ) WITH ORDINALITY AS album(value, ordinal)
        WHERE album.value ->> 'id' ~ '^[0-9]+$'
    ), missing AS (
        SELECT * FROM expected
        EXCEPT
        SELECT song_id, ordinal, album_id FROM public.song_album_links
    ), unexpected AS (
        SELECT song_id, ordinal, album_id FROM public.song_album_links
        EXCEPT
        SELECT * FROM expected
    )
    SELECT (SELECT COUNT(*) FROM public.song_album_links),
           (SELECT COUNT(*) FROM missing),
           (SELECT COUNT(*) FROM unexpected)
    INTO link_count, missing_count, unexpected_count;

    IF missing_count <> 0 OR unexpected_count <> 0 THEN
        RAISE EXCEPTION
            '0023 album parity failed: links=%, missing=%, unexpected=%',
            link_count, missing_count, unexpected_count;
    END IF;

    RAISE NOTICE
        '0023 album parity complete: links=%, missing=0, unexpected=0, validation_elapsed=%, migration_elapsed=%',
        link_count,
        clock_timestamp() - validation_started_at,
        clock_timestamp() - migration_started_at;
END;
$parity_validation$;

-- Statistics are collected only after exact parity.  ANALYZE takes no table
-- rewrite or ACCESS EXCLUSIVE lock and makes the first API plan production-
-- representative instead of waiting for a later autovacuum cycle.
ANALYZE public.song_album_links;

DROP PROCEDURE public.backfill_song_album_links_batch_v1(INTEGER, INTEGER);

-- Recheck immediately before release: successful validation must never be
-- separated from raw_json writer exclusion by an unnoticed session change.
DO $final_writer_lock_check$
DECLARE
    held_lock_count INTEGER;
BEGIN
    WITH expected_lock(lock_key) AS (
        VALUES
            (hashtext('diva-data-pipeline-publication-v1')::BIGINT),
            (hashtext('diva-data-pipeline-child-v1')::BIGINT)
    )
    SELECT COUNT(*)
    INTO held_lock_count
    FROM expected_lock expected
    JOIN pg_locks held
      ON held.pid = pg_backend_pid()
     AND held.locktype = 'advisory'
     AND held.granted
     AND held.objsubid = 1
     AND held.classid::BIGINT = CASE
         WHEN expected.lock_key < 0 THEN 4294967295
         ELSE 0
     END
     AND held.objid::BIGINT = (expected.lock_key & 4294967295);

    IF held_lock_count <> 2 THEN
        RAISE EXCEPTION
            '0023 lost a pipeline writer lease before completion';
    END IF;
END;
$final_writer_lock_check$;

DO $writer_lock_release$
BEGIN
    IF NOT pg_advisory_unlock(hashtext('diva-data-pipeline-child-v1')) THEN
        RAISE EXCEPTION '0023 could not release the pipeline child writer lease';
    END IF;
    IF NOT pg_advisory_unlock(hashtext('diva-data-pipeline-publication-v1')) THEN
        RAISE EXCEPTION '0023 could not release the global pipeline writer lease';
    END IF;
END;
$writer_lock_release$;
RESET statement_timeout;
RESET lock_timeout;
RESET search_path;
