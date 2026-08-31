#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${DIVA_ALLOW_DESTRUCTIVE_DB_MIGRATION_TEST:?DIVA_ALLOW_DESTRUCTIVE_DB_MIGRATION_TEST is required}"
[[ "$DIVA_ALLOW_DESTRUCTIVE_DB_MIGRATION_TEST" == "1" ]] || {
  echo "DIVA_ALLOW_DESTRUCTIVE_DB_MIGRATION_TEST must equal 1" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
migration="$repo_root/backend/database/migrations/0023_normalize_song_album_links.sql"
manifest="$repo_root/backend/database/migrations/migration-manifest.tsv"
migrator="$repo_root/backend/database/migrate.sh"
psql_cmd=(
  psql -X -v ON_ERROR_STOP=1
  -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE"
)
task_temp_dir="${RUNNER_TEMP:-/tmp}"
failure_log="$(mktemp "$task_temp_dir/diva-album-migration-failure-XXXXXX.log")"
lock_log="$(mktemp "$task_temp_dir/diva-album-migration-lock-XXXXXX.log")"
lock_pid=""
migration_test_dir="$(mktemp -d "$task_temp_dir/diva-album-migrations-XXXXXX")"
mkdir "$migration_test_dir/sql"

cleanup() {
  if [[ -n "$lock_pid" ]]; then
    kill "$lock_pid" 2>/dev/null || true
    wait "$lock_pid" 2>/dev/null || true
  fi
  "${psql_cmd[@]}" >/dev/null 2>&1 <<'SQL' || true
DO $cleanup_rule$
BEGIN
    IF to_regclass('public.song_album_links') IS NOT NULL THEN
        EXECUTE 'DROP RULE IF EXISTS song_album_links_unexpected_rule_fixture ON public.song_album_links';
        EXECUTE 'REVOKE ALL ON TABLE public.song_album_links FROM pg_monitor';
        EXECUTE 'REVOKE ALL (album_id) ON TABLE public.song_album_links FROM pg_monitor';
    END IF;
    IF to_regprocedure('public.sync_song_album_links_from_raw_json_v1()') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public.sync_song_album_links_from_raw_json_v1() FROM pg_monitor';
    END IF;
    IF to_regprocedure('public.backfill_song_album_links_batch_v1(integer,integer)') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON PROCEDURE public.backfill_song_album_links_batch_v1(integer,integer) FROM pg_monitor';
    END IF;
END;
$cleanup_rule$;
ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM pg_monitor;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM pg_monitor;
DELETE FROM public.songs WHERE id BETWEEN 930000001 AND 930005004;
SQL
  if [[ "$migration_test_dir" == "$task_temp_dir/diva-album-migrations-"* ]]; then
    rm -f -- "$migration_test_dir/sql/"*.sql
    rm -f -- "$migration_test_dir/sql/migration-manifest.tsv"
    rmdir -- "$migration_test_dir/sql" 2>/dev/null || true
    rmdir -- "$migration_test_dir" 2>/dev/null || true
  else
    echo "refusing to remove unexpected migration fixture: $migration_test_dir" >&2
  fi
  rm -f -- "$failure_log" "$lock_log"
}
trap cleanup EXIT

cp "$repo_root/backend/database/migrations/"*.sql "$migration_test_dir/sql/"
cp "$manifest" "$migration_test_dir/sql/migration-manifest.tsv"

fail() {
  echo "song album normalization contract failed: $*" >&2
  if [[ -s "$failure_log" ]]; then
    echo "--- last expected-failure log ---" >&2
    tail -n 80 "$failure_log" >&2
  fi
  exit 1
}

"${psql_cmd[@]}" <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DELETE FROM schema_migrations
WHERE migration_id = '0023_normalize_song_album_links.sql';

-- Reproduce the real production upgrade, where schema.sql is not rerun and
-- 0023 is the first creator of the normalized relation and maintenance
-- trigger.  Later retries in this harness exercise the pre-existing path.
DROP TRIGGER IF EXISTS song_album_insert_guard_v1 ON songs;
DROP TRIGGER IF EXISTS song_album_key_preserve_v1 ON songs;
DROP TRIGGER IF EXISTS song_album_links_sync_v1 ON songs;
DROP FUNCTION IF EXISTS sync_song_album_links_from_raw_json_v1();
DROP TABLE IF EXISTS song_album_links;
DELETE FROM songs WHERE id BETWEEN 930000001 AND 930005004;

INSERT INTO songs (id, name, song_type, raw_json)
SELECT 930000000 + sequence,
       'album-contract-' || sequence,
       'Original',
       CASE
           WHEN sequence = 5001 THEN
               '{"albums":[{"id":"2147483648"}]}'::jsonb
           ELSE jsonb_build_object(
               'albums',
               jsonb_build_array(
                   jsonb_build_object('id', (sequence % 17)::text),
                   jsonb_build_object('id', 'not-numeric'),
                   jsonb_build_object('id', (sequence % 17)::integer)
               )
           )
       END
FROM generate_series(1, 5001) AS sequence;
SQL

# The overflow reproduces the legacy ::integer fail-closed boundary.  Batch 1
# must remain committed, while the actual migrator must not record success.
if MIGRATIONS_SQL_DIR="$migration_test_dir/sql" \
    sh "$migrator" >"$failure_log" 2>&1; then
  fail "int32 overflow unexpectedly succeeded"
fi

history_count="$("${psql_cmd[@]}" -Atc \
  "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = '0023_normalize_song_album_links.sql'")"
[[ "$history_count" == "0" ]] || fail "failed migration recorded history"

incomplete_attempt="$("${psql_cmd[@]}" -Atc "
SELECT COUNT(*) || '|' || MIN(status)
FROM schema_migration_attempts
WHERE migration_id = '0023_normalize_song_album_links.sql'
  AND status = 'running';")"
[[ "$incomplete_attempt" == "1|running" ]] || \
  fail "failed non-transactional migration did not preserve one running attempt: $incomplete_attempt"

# This is the explicit operator acknowledgement required after inspecting the
# committed prefix.  The production runner never retries an incomplete
# non-transactional attempt on its own.
"${psql_cmd[@]}" -c "
UPDATE schema_migration_attempts
SET status = 'abandoned', finished_at = clock_timestamp()
WHERE migration_id = '0023_normalize_song_album_links.sql'
  AND status = 'running';" >/dev/null

procedure_privileges="$("${psql_cmd[@]}" -Atc "
SELECT has_function_privilege(
           'diva_api_runtime',
           'public.backfill_song_album_links_batch_v1(integer,integer)',
           'EXECUTE'
       ),
       has_function_privilege(
           'diva_pipeline_runtime',
           'public.backfill_song_album_links_batch_v1(integer,integer)',
           'EXECUTE'
       ),
       NOT EXISTS (
           SELECT 1
           FROM pg_proc procedure_state
           CROSS JOIN LATERAL aclexplode(
               COALESCE(
                   procedure_state.proacl,
                   acldefault('f', procedure_state.proowner)
               )
           ) privilege
           WHERE procedure_state.oid =
               'public.backfill_song_album_links_batch_v1(integer,integer)'::regprocedure
             AND privilege.grantee = 0
       );")"
[[ "$procedure_privileges" == "f|f|t" ]] || \
  fail "unexpected backfill procedure privileges: $procedure_privileges"

"${psql_cmd[@]}" -c \
  "GRANT EXECUTE ON PROCEDURE public.backfill_song_album_links_batch_v1(integer,integer) TO pg_monitor" \
  >/dev/null
if "${psql_cmd[@]}" -f "$migration" >"$failure_log" 2>&1; then
  fail "migration accepted an unexpected backfill procedure ACL grantee"
fi
grep -q "backfill_song_album_links_batch_v1 exists with unexpected" "$failure_log" || \
  fail "unexpected backfill procedure ACL collision did not fail closed"
"${psql_cmd[@]}" -c \
  "REVOKE ALL ON PROCEDURE public.backfill_song_album_links_batch_v1(integer,integer) FROM pg_monitor" \
  >/dev/null

partial_count="$("${psql_cmd[@]}" -Atc \
  "SELECT COUNT(*) FROM song_album_links WHERE song_id BETWEEN 930000001 AND 930005000")"
[[ "$partial_count" == "10000" ]] || \
  fail "expected committed 5k-song prefix, got $partial_count links"

# A retry must replace, rather than trust, the committed prefix left by the
# failed run.
"${psql_cmd[@]}" -c \
  "UPDATE song_album_links SET album_id = 999999 WHERE song_id = 930000001 AND ordinal = 1" \
  >/dev/null

"${psql_cmd[@]}" -c \
  "UPDATE songs SET raw_json = '{\"albums\":[{\"id\":\"17\"}]}'::jsonb WHERE id = 930005001"

# Simulate the unavoidable SQL/history boundary of a non-transactional
# migration.  The runner journals this boundary; a direct SQL retry remains
# idempotent after an operator has inspected and acknowledged the prior run.
"${psql_cmd[@]}" -f "$migration"

history_after_direct_success="$("${psql_cmd[@]}" -Atc \
  "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = '0023_normalize_song_album_links.sql'")"
[[ "$history_after_direct_success" == "0" ]] || \
  fail "direct SQL success unexpectedly recorded migration history"

# Model a crash in the gap between non-transactional SQL success and its
# history record.  An old step-00 checkout must preserve both the source JSON
# component and links, so a complete migration retry cannot erase them.
gap_albums_before="$("${psql_cmd[@]}" -Atc \
  "SELECT raw_json -> 'albums' FROM songs WHERE id = 930000003")"
gap_links_before="$("${psql_cmd[@]}" -Atc \
  "SELECT array_agg(album_id ORDER BY ordinal) FROM song_album_links WHERE song_id = 930000003")"
"${psql_cmd[@]}" <<'SQL'
SET ROLE diva_pipeline_runtime;
UPDATE songs
SET raw_json = '{"name":"old-client-during-history-gap"}'::jsonb
WHERE id = 930000003;
RESET ROLE;
SQL
gap_albums_after="$("${psql_cmd[@]}" -Atc \
  "SELECT raw_json -> 'albums' FROM songs WHERE id = 930000003")"
gap_links_after="$("${psql_cmd[@]}" -Atc \
  "SELECT array_agg(album_id ORDER BY ordinal) FROM song_album_links WHERE song_id = 930000003")"
[[ "$gap_albums_after" == "$gap_albums_before" ]] || \
  fail "old writer during history gap erased source Albums JSON"
[[ "$gap_links_after" == "$gap_links_before" ]] || \
  fail "old writer during history gap erased normalized links"

parity="$("${psql_cmd[@]}" -Atc "
WITH expected AS (
    SELECT song.id AS song_id,
           album.ordinal::integer AS ordinal,
           (album.value ->> 'id')::integer AS album_id
    FROM songs song
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(song.raw_json -> 'albums') = 'array'
             THEN song.raw_json -> 'albums' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS album(value, ordinal)
    WHERE album.value ->> 'id' ~ '^[0-9]+$'
), differences AS (
    (SELECT * FROM expected EXCEPT
     SELECT song_id, ordinal, album_id FROM song_album_links)
    UNION ALL
    (SELECT song_id, ordinal, album_id FROM song_album_links EXCEPT
     SELECT * FROM expected)
)
SELECT (SELECT COUNT(*) FROM song_album_links), COUNT(*) FROM differences;")"
[[ "$parity" == "10001|0" ]] || fail "unexpected link/parity counts: $parity"

# The complete migration is deliberately safe to rerun after an inspected
# crash at the SQL/history boundary.
"${psql_cmd[@]}" -f "$migration" >/dev/null
rerun_count="$("${psql_cmd[@]}" -Atc \
  "SELECT COUNT(*) FROM song_album_links WHERE song_id BETWEEN 930000001 AND 930005001")"
[[ "$rerun_count" == "10001" ]] || fail "rerun changed link count"

# The real migrator performs one final convergent run, then atomically records
# history and closes its durable attempt row.
MIGRATIONS_SQL_DIR="$migration_test_dir/sql" sh "$migrator" >/dev/null
history_after_migrator="$(${psql_cmd[@]} -Atc \
  "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = '0023_normalize_song_album_links.sql'")"
[[ "$history_after_migrator" == "1" ]] || \
  fail "successful migrator did not record exactly one history row"

privileges="$("${psql_cmd[@]}" -Atc "
SELECT has_table_privilege('diva_api_runtime', 'public.song_album_links', 'SELECT'),
       NOT (
           has_table_privilege('diva_api_runtime', 'public.song_album_links', 'INSERT')
           OR has_table_privilege('diva_api_runtime', 'public.song_album_links', 'UPDATE')
           OR has_table_privilege('diva_api_runtime', 'public.song_album_links', 'DELETE')
           OR has_table_privilege('diva_api_runtime', 'public.song_album_links', 'TRUNCATE')
           OR has_table_privilege('diva_api_runtime', 'public.song_album_links', 'REFERENCES')
           OR has_table_privilege('diva_api_runtime', 'public.song_album_links', 'TRIGGER')
       ),
       has_table_privilege('diva_pipeline_runtime', 'public.song_album_links', 'SELECT')
           AND has_table_privilege('diva_pipeline_runtime', 'public.song_album_links', 'INSERT')
           AND has_table_privilege('diva_pipeline_runtime', 'public.song_album_links', 'UPDATE')
           AND has_table_privilege('diva_pipeline_runtime', 'public.song_album_links', 'DELETE'),
       NOT (
           has_table_privilege('diva_pipeline_runtime', 'public.song_album_links', 'TRUNCATE')
           OR has_table_privilege('diva_pipeline_runtime', 'public.song_album_links', 'REFERENCES')
           OR has_table_privilege('diva_pipeline_runtime', 'public.song_album_links', 'TRIGGER')
       ),
       NOT EXISTS (
           SELECT 1
           FROM pg_class relation
           CROSS JOIN LATERAL aclexplode(
               COALESCE(relation.relacl, acldefault('r', relation.relowner))
           ) privilege
           WHERE relation.oid = 'public.song_album_links'::regclass
             AND privilege.grantee = 0
       ),
       (
           SELECT owner.rolname NOT IN ('diva_api_runtime', 'diva_pipeline_runtime')
                  AND relation.relowner = songs_relation.relowner
                  AND relation.relkind = 'r'
                  AND relation.relpersistence = 'p'
                  AND NOT relation.relrowsecurity
                  AND NOT relation.relforcerowsecurity
           FROM pg_class relation
           CROSS JOIN pg_class songs_relation
           JOIN pg_roles owner ON owner.oid = relation.relowner
           WHERE relation.oid = 'public.song_album_links'::regclass
             AND songs_relation.oid = 'public.songs'::regclass
       ),
       NOT EXISTS (
           SELECT 1
           FROM pg_trigger trigger_state
           WHERE trigger_state.tgrelid = 'public.song_album_links'::regclass
             AND NOT trigger_state.tgisinternal
       ),
       NOT EXISTS (
           SELECT 1
           FROM pg_rewrite rule_state
           WHERE rule_state.ev_class = 'public.song_album_links'::regclass
       );")"
[[ "$privileges" == "t|t|t|t|t|t|t|t" ]] || fail "unexpected runtime privileges: $privileges"

sync_contract="$("${psql_cmd[@]}" -Atc "
SELECT NOT has_function_privilege(
           'diva_api_runtime',
           'public.sync_song_album_links_from_raw_json_v1()',
           'EXECUTE'
       ),
       NOT has_function_privilege(
           'diva_pipeline_runtime',
           'public.sync_song_album_links_from_raw_json_v1()',
           'EXECUTE'
       ),
       NOT EXISTS (
           SELECT 1
           FROM pg_proc procedure_state
           CROSS JOIN LATERAL aclexplode(
               COALESCE(
                   procedure_state.proacl,
                   acldefault('f', procedure_state.proowner)
               )
           ) privilege
           WHERE procedure_state.oid =
               'public.sync_song_album_links_from_raw_json_v1()'::regprocedure
             AND privilege.grantee = 0
       ),
       (
           SELECT COUNT(*) = 3
           FROM pg_trigger trigger_state
           JOIN pg_attribute attribute
             ON attribute.attrelid = trigger_state.tgrelid
            AND attribute.attname = 'raw_json'
           WHERE trigger_state.tgrelid = 'public.songs'::regclass
             AND NOT trigger_state.tgisinternal
             AND trigger_state.tgenabled = 'O'
             AND trigger_state.tgfoid =
                 'public.sync_song_album_links_from_raw_json_v1()'::regprocedure
             AND trigger_state.tgqual IS NULL
             AND (
                 (trigger_state.tgname = 'song_album_insert_guard_v1'
                  AND trigger_state.tgtype = 7
                  AND trigger_state.tgattr::text = '')
                 OR
                 (trigger_state.tgname = 'song_album_key_preserve_v1'
                  AND trigger_state.tgtype = 19
                  AND trigger_state.tgattr::text = attribute.attnum::text)
                 OR
                 (trigger_state.tgname = 'song_album_links_sync_v1'
                  AND trigger_state.tgtype = 21
                  AND trigger_state.tgattr::text = attribute.attnum::text)
             )
       );")"
[[ "$sync_contract" == "t|t|t|t" ]] || \
  fail "unexpected album sync trigger contract: $sync_contract"

# An old non-owner writer cannot insert a new object payload that omits the
# optional Albums component: the whole statement fails before either the song
# or a misleading empty link set can commit.
if "${psql_cmd[@]}" >"$failure_log" 2>&1 <<'SQL'
SET ROLE diva_pipeline_runtime;
INSERT INTO songs (id, name, song_type, raw_json)
VALUES (
    930005002,
    'old-client-missing-albums',
    'Original',
    '{"name":"old-client-missing-albums"}'::jsonb
);
RESET ROLE;
SQL
then
  fail "old non-owner INSERT without Albums unexpectedly succeeded"
fi
grep -q "non-owner song INSERT must include an explicit albums key" "$failure_log" || \
  fail "old non-owner INSERT did not report the fail-closed Albums guard"
old_insert_state="$(${psql_cmd[@]} -Atc "
SELECT (SELECT COUNT(*) FROM songs WHERE id = 930005002),
       (SELECT COUNT(*) FROM song_album_links WHERE song_id = 930005002);")"
[[ "$old_insert_state" == "0|0" ]] || \
  fail "failed old INSERT left a song or album link behind: $old_insert_state"

# PostgreSQL runs BEFORE INSERT triggers before resolving ON CONFLICT.  The old
# step-00 UPSERT therefore also fails closed on an existing song and cannot
# overwrite either its source JSON or normalized links with a missing-key page.
old_upsert_raw_before="$("${psql_cmd[@]}" -Atc \
  "SELECT raw_json FROM songs WHERE id = 930000001")"
old_upsert_links_before="$("${psql_cmd[@]}" -Atc \
  "SELECT array_agg(album_id ORDER BY ordinal) FROM song_album_links WHERE song_id = 930000001")"
if "${psql_cmd[@]}" >"$failure_log" 2>&1 <<'SQL'
SET ROLE diva_pipeline_runtime;
INSERT INTO songs (id, name, song_type, raw_json)
VALUES (
    930000001,
    'old-client-conflict',
    'Original',
    '{"name":"old-client-conflict"}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    raw_json = EXCLUDED.raw_json;
RESET ROLE;
SQL
then
  fail "old missing-key UPSERT unexpectedly succeeded"
fi
grep -q "non-owner song INSERT must include an explicit albums key" "$failure_log" || \
  fail "old missing-key UPSERT did not report the Albums guard"
old_upsert_raw_after="$("${psql_cmd[@]}" -Atc \
  "SELECT raw_json FROM songs WHERE id = 930000001")"
old_upsert_links_after="$("${psql_cmd[@]}" -Atc \
  "SELECT array_agg(album_id ORDER BY ordinal) FROM song_album_links WHERE song_id = 930000001")"
[[ "$old_upsert_raw_after" == "$old_upsert_raw_before" ]] || \
  fail "failed old UPSERT changed the existing raw_json"
[[ "$old_upsert_links_after" == "$old_upsert_links_before" ]] || \
  fail "failed old UPSERT changed the existing album links"

# The new client sends an explicit array, including [] for no relationships.
# That payload remains a valid atomic insert with an intentionally empty link
# set under the same runtime role.
"${psql_cmd[@]}" <<'SQL'
SET ROLE diva_pipeline_runtime;
INSERT INTO songs (id, name, song_type, raw_json)
VALUES (
    930005003,
    'new-client-explicit-empty-albums',
    'Original',
    '{"albums":[]}'::jsonb
);
RESET ROLE;
SQL
new_insert_state="$(${psql_cmd[@]} -Atc "
SELECT (SELECT COUNT(*) FROM songs WHERE id = 930005003),
       (SELECT COUNT(*) FROM song_album_links WHERE song_id = 930005003);")"
[[ "$new_insert_state" == "1|0" ]] || \
  fail "new explicit-empty INSERT did not commit cleanly: $new_insert_state"

# The schema/migration owner keeps a deliberate escape hatch for controlled
# fixtures and recovery work; normal runtime writers never inherit it.
"${psql_cmd[@]}" -c \
  "INSERT INTO songs (id, name, song_type, raw_json) VALUES (930005004, 'owner-missing-albums-fixture', 'Original', '{\"name\":\"owner-fixture\"}'::jsonb)" \
  >/dev/null
owner_insert_state="$(${psql_cmd[@]} -Atc "
SELECT (SELECT COUNT(*) FROM songs WHERE id = 930005004),
       (SELECT COUNT(*) FROM song_album_links WHERE song_id = 930005004);")"
[[ "$owner_insert_state" == "1|0" ]] || \
  fail "migration owner missing-key fixture did not remain available: $owner_insert_state"

# Prove both sides of the cross-version cutover under the real runtime role.
# An old payload with no optional Albums key preserves raw JSON and links; a
# new explicit array replaces them with exact positions/duplicates; explicit
# null clears.
before_old_writer="$(${psql_cmd[@]} -Atc \
  "SELECT array_agg(album_id ORDER BY ordinal) FROM song_album_links WHERE song_id = 930000002")"
before_old_albums="$(${psql_cmd[@]} -Atc \
  "SELECT raw_json -> 'albums' FROM songs WHERE id = 930000002")"
"${psql_cmd[@]}" <<'SQL'
SET ROLE diva_pipeline_runtime;
UPDATE songs
SET raw_json = '{"name":"old-client-no-albums-key"}'::jsonb
WHERE id = 930000002;
RESET ROLE;
SQL
after_old_writer="$(${psql_cmd[@]} -Atc \
  "SELECT array_agg(album_id ORDER BY ordinal) FROM song_album_links WHERE song_id = 930000002")"
after_old_albums="$(${psql_cmd[@]} -Atc \
  "SELECT raw_json -> 'albums' FROM songs WHERE id = 930000002")"
[[ "$after_old_writer" == "$before_old_writer" ]] || \
  fail "old writer without Albums erased normalized links"
[[ "$after_old_albums" == "$before_old_albums" ]] || \
  fail "old writer without Albums erased source Albums JSON"

"${psql_cmd[@]}" <<'SQL'
SET ROLE diva_pipeline_runtime;
UPDATE songs
SET raw_json = '{"albums":[{"id":"7"},{"id":"bad"},{"id":"7"},{"id":8},{"id":true},{"id":1.5},{"id":"１２"},{"id":"-9"},{"id":"+9"},{}]}'::jsonb
WHERE id = 930000002;
RESET ROLE;
SQL
new_writer_links="$(${psql_cmd[@]} -Atc \
  "SELECT array_agg(ordinal ORDER BY ordinal), array_agg(album_id ORDER BY ordinal) FROM song_album_links WHERE song_id = 930000002")"
[[ "$new_writer_links" == "{1,3,4}|{7,7,8}" ]] || \
  fail "new writer did not preserve album order/duplicates/ordinal holes: $new_writer_links"

"${psql_cmd[@]}" <<'SQL'
SET ROLE diva_pipeline_runtime;
UPDATE songs SET raw_json = '{"albums":null}'::jsonb WHERE id = 930000002;
RESET ROLE;
SQL
explicit_empty_count="$(${psql_cmd[@]} -Atc \
  "SELECT COUNT(*) FROM song_album_links WHERE song_id = 930000002")"
[[ "$explicit_empty_count" == "0" ]] || \
  fail "explicit null Albums did not clear normalized links"

"${psql_cmd[@]}" <<'SQL'
SET ROLE diva_pipeline_runtime;
UPDATE songs
SET raw_json = '{"albums":[{"id":"7"}]}'::jsonb
WHERE id = 930000002;
UPDATE songs
SET raw_json = '{"albums":{"id":"9"}}'::jsonb
WHERE id = 930000002;
RESET ROLE;
SQL
non_array_count="$("${psql_cmd[@]}" -Atc \
  "SELECT COUNT(*) FROM song_album_links WHERE song_id = 930000002")"
[[ "$non_array_count" == "0" ]] || \
  fail "non-array Albums did not clear normalized links"

"${psql_cmd[@]}" <<'SQL'
SET ROLE diva_pipeline_runtime;
UPDATE songs
SET raw_json = '{"albums":[{"id":"7"}]}'::jsonb
WHERE id = 930000002;
UPDATE songs
SET raw_json = NULL
WHERE id = 930000002;
RESET ROLE;
SQL
null_raw_json_count="$("${psql_cmd[@]}" -Atc \
  "SELECT COUNT(*) FROM song_album_links WHERE song_id = 930000002")"
[[ "$null_raw_json_count" == "0" ]] || \
  fail "SQL NULL raw_json did not clear normalized links"

plan="$("${psql_cmd[@]}" -Atc "
SET enable_seqscan = off;
SET enable_bitmapscan = off;
EXPLAIN (COSTS OFF)
SELECT requested.song_id,
       ARRAY(
           SELECT album_link.album_id
           FROM song_album_links album_link
           WHERE album_link.song_id = requested.song_id
           ORDER BY album_link.ordinal
       )
FROM unnest(ARRAY[930000001, 930005001]) AS requested(song_id);")"
grep -q "Index Scan using song_album_links_pkey" <<<"$plan" || \
  fail "production-shaped lookup did not use the ordered primary-key path"
if grep -Eq "raw_json|Jsonb|Seq Scan on songs" <<<"$plan"; then
  fail "production-shaped lookup touched songs.raw_json"
fi

# A live supported global or child writer must stop the migration before any
# batch work.  pg_try_advisory_lock in the poll session is released when that
# short session exits, so it cannot leak a fixture lock.
assert_writer_lock_collision() {
  local lock_name="$1"
  local expected_reason="$2"
  local busy="f"

  "${psql_cmd[@]}" -Atc \
    "SELECT set_config('application_name', 'diva-album-lock-fixture', false); SELECT pg_advisory_lock(hashtext('$lock_name')); SELECT pg_sleep(30)" \
    >"$lock_log" 2>&1 &
  lock_pid=$!

  for _ in {1..50}; do
    busy="$("${psql_cmd[@]}" -Atc \
      "SELECT NOT pg_try_advisory_lock(hashtext('$lock_name'))")"
    [[ "$busy" == "t" ]] && break
    sleep 0.1
  done
  [[ "$busy" == "t" ]] || fail "writer lock fixture did not start: $lock_name"

  if "${psql_cmd[@]}" -f "$migration" >"$failure_log" 2>&1; then
    fail "migration ran while writer lease was held: $lock_name"
  fi
  grep -q "$expected_reason" "$failure_log" || \
    fail "writer collision did not report the expected reason: $lock_name"

  "${psql_cmd[@]}" -Atc \
    "SELECT COALESCE(bool_and(pg_terminate_backend(pid)), true) FROM pg_stat_activity WHERE application_name = 'diva-album-lock-fixture' AND pid <> pg_backend_pid()" \
    >/dev/null
  kill "$lock_pid" 2>/dev/null || true
  wait "$lock_pid" 2>/dev/null || true
  lock_pid=""
}

assert_writer_lock_collision \
  "diva-data-pipeline-publication-v1" \
  "global pipeline writer lease"
assert_writer_lock_collision \
  "diva-data-pipeline-child-v1" \
  "pipeline child writer lease"

# A hand-created relation with rule behavior is not accepted merely because
# its columns and constraints happen to match.  This is a direct migration
# retry because migrate.sh correctly skips an already recorded migration.
"${psql_cmd[@]}" -c \
  "CREATE RULE song_album_links_unexpected_rule_fixture AS ON DELETE TO public.song_album_links DO ALSO NOTHING" \
  >/dev/null
if "${psql_cmd[@]}" -f "$migration" >"$failure_log" 2>&1; then
  fail "migration accepted an unexpected song_album_links rule"
fi
grep -q "unexpected semantics" "$failure_log" || \
  fail "unexpected rule collision did not fail closed"
"${psql_cmd[@]}" -c \
  "DROP RULE song_album_links_unexpected_rule_fixture ON public.song_album_links" \
  >/dev/null

"${psql_cmd[@]}" -c \
  "GRANT SELECT ON TABLE public.song_album_links TO pg_monitor" \
  >/dev/null
if "${psql_cmd[@]}" -f "$migration" >"$failure_log" 2>&1; then
  fail "migration accepted an unexpected song_album_links ACL grantee"
fi
grep -q "unexpected semantics" "$failure_log" || \
  fail "unexpected table ACL collision did not fail closed"
"${psql_cmd[@]}" -c \
  "REVOKE ALL ON TABLE public.song_album_links FROM pg_monitor" \
  >/dev/null

"${psql_cmd[@]}" -c \
  "GRANT SELECT (album_id) ON TABLE public.song_album_links TO pg_monitor" \
  >/dev/null
if "${psql_cmd[@]}" -f "$migration" >"$failure_log" 2>&1; then
  fail "migration accepted an unexpected song_album_links column ACL"
fi
grep -q "unexpected semantics" "$failure_log" || \
  fail "unexpected column ACL collision did not fail closed"
"${psql_cmd[@]}" -c \
  "REVOKE ALL (album_id) ON TABLE public.song_album_links FROM pg_monitor" \
  >/dev/null

"${psql_cmd[@]}" -c \
  "GRANT EXECUTE ON FUNCTION public.sync_song_album_links_from_raw_json_v1() TO pg_monitor" \
  >/dev/null
if "${psql_cmd[@]}" -f "$migration" >"$failure_log" 2>&1; then
  fail "migration accepted an unexpected album sync function ACL grantee"
fi
grep -q "sync_song_album_links_from_raw_json_v1 exists with unexpected" "$failure_log" || \
  fail "unexpected function ACL collision did not fail closed"
"${psql_cmd[@]}" -c \
  "REVOKE ALL ON FUNCTION public.sync_song_album_links_from_raw_json_v1() FROM pg_monitor" \
  >/dev/null

# Default privileges are applied only when an object is absent, after the
# corresponding preflight.  The short schema-cutover transaction must reject
# those grants post-create and roll every new object back atomically.
"${psql_cmd[@]}" <<'SQL'
DROP TRIGGER song_album_insert_guard_v1 ON public.songs;
DROP TRIGGER song_album_key_preserve_v1 ON public.songs;
DROP TRIGGER song_album_links_sync_v1 ON public.songs;
DROP FUNCTION public.sync_song_album_links_from_raw_json_v1();
DROP TABLE public.song_album_links;
ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO pg_monitor;
SQL
if "${psql_cmd[@]}" -f "$migration" >"$failure_log" 2>&1; then
  fail "migration accepted an unexpected default table privilege"
fi
grep -q "post-create ACL validation" "$failure_log" || \
  fail "default table privilege did not fail post-create validation"
absent_after_table_default="$(${psql_cmd[@]} -Atc \
  "SELECT to_regclass('public.song_album_links') IS NULL")"
[[ "$absent_after_table_default" == "t" ]] || \
  fail "failed atomic table cutover left a partial relation"
"${psql_cmd[@]}" -c \
  "ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM pg_monitor" \
  >/dev/null

"${psql_cmd[@]}" -c \
  "ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO pg_monitor" \
  >/dev/null
if "${psql_cmd[@]}" -f "$migration" >"$failure_log" 2>&1; then
  fail "migration accepted an unexpected default function privilege"
fi
grep -q "post-create ACL validation" "$failure_log" || \
  fail "default function privilege did not fail post-create validation"
absent_after_function_default="$(${psql_cmd[@]} -Atc \
  "SELECT to_regclass('public.song_album_links') IS NULL AND to_regprocedure('public.sync_song_album_links_from_raw_json_v1()') IS NULL")"
[[ "$absent_after_function_default" == "t" ]] || \
  fail "failed atomic function cutover left partial objects"
"${psql_cmd[@]}" -c \
  "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM pg_monitor" \
  >/dev/null

# Restore the normalized schema after both destructive collision fixtures and
# prove a clean absent-object retry still converges.
"${psql_cmd[@]}" -f "$migration" >/dev/null

echo "song album normalization contract: PASS"
