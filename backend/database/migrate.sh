#!/bin/sh
set -eu

umask 077

migrations_sql_dir="${MIGRATIONS_SQL_DIR:-/migrations/sql}"
migrations_manifest="${MIGRATIONS_MANIFEST_FILE:-$migrations_sql_dir/migration-manifest.tsv}"
task_temp_dir="${TMPDIR:-/tmp}"

fail() {
  echo "[migrate] ERROR: $*" >&2
  exit 1
}

command -v psql >/dev/null 2>&1 || fail "psql is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required"
[ -d "$migrations_sql_dir" ] || fail "migration directory does not exist: $migrations_sql_dir"
[ -f "$migrations_manifest" ] || fail "migration manifest does not exist: $migrations_manifest"
[ ! -L "$migrations_manifest" ] || fail "migration manifest must not be a symbolic link"
[ -d "$task_temp_dir" ] || fail "temporary directory does not exist: $task_temp_dir"

runner_temp_dir="$(mktemp -d "$task_temp_dir/diva-migrate.XXXXXX")"
driver="$runner_temp_dir/driver.sql"
manifest_ids="$runner_temp_dir/manifest-ids.txt"
filesystem_ids="$runner_temp_dir/filesystem-ids.txt"
prepared_file="$runner_temp_dir/prepared.sql"
normalized_manifest="$runner_temp_dir/migration-manifest.tsv"
validated_dir="$runner_temp_dir/validated"
mkdir "$validated_dir"

cleanup() {
  for validated_file in "$validated_dir"/*.sql; do
    [ -f "$validated_file" ] || continue
    rm -f -- "$validated_file"
  done
  rm -f -- "$driver" "$manifest_ids" "$filesystem_ids" "$prepared_file" \
    "$normalized_manifest"
  rmdir -- "$validated_dir" 2>/dev/null || true
  rmdir -- "$runner_temp_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

: >"$manifest_ids"
sed 's/\r$//' "$migrations_manifest" >"$normalized_manifest"
line_number=0
previous_migration_id=""

while IFS='|' read -r migration_id execution_mode expected_sha256 extra_field \
    || [ -n "${migration_id}${execution_mode}${expected_sha256}${extra_field}" ]; do
  line_number=$((line_number + 1))
  [ -n "$migration_id" ] || fail "blank manifest row at line $line_number"
  case "$migration_id" in
    \#*) fail "comments are not allowed in the migration manifest (line $line_number)" ;;
  esac
  printf '%s\n' "$migration_id" \
    | grep -Eq '^[0-9]{4}_[a-z0-9][a-z0-9_]*\.sql$' \
    || fail "unsafe migration id at manifest line $line_number: $migration_id"
  case "$execution_mode" in
    atomic|atomic-boundary|non-transactional) ;;
    *) fail "unsupported execution mode for $migration_id: $execution_mode" ;;
  esac
  printf '%s\n' "$expected_sha256" | grep -Eq '^[0-9a-f]{64}$' \
    || fail "invalid SHA-256 for $migration_id"
  [ -z "$extra_field" ] || fail "too many manifest fields for $migration_id"
  if grep -Fqx "$migration_id" "$manifest_ids"; then
    fail "duplicate migration id in manifest: $migration_id"
  fi
  if [ -n "$previous_migration_id" ] \
      && [ "$(printf '%s\n%s\n' "$previous_migration_id" "$migration_id" | LC_ALL=C sort | head -n 1)" != "$previous_migration_id" ]; then
    fail "migration manifest is not ordered: $migration_id follows $previous_migration_id"
  fi
  previous_migration_id="$migration_id"
  printf '%s\n' "$migration_id" >>"$manifest_ids"

  migration_file="$migrations_sql_dir/$migration_id"
  [ -f "$migration_file" ] || fail "manifest migration file is missing: $migration_id"
  [ ! -L "$migration_file" ] || fail "migration file must not be a symbolic link: $migration_id"
  validated_migration_file="$validated_dir/$migration_id"
  cp "$migration_file" "$validated_migration_file"
  # Git may materialize CRLF on the Windows operator host.  Hash canonical LF
  # content so the same reviewed migration has one identity on every host.
  # Execute this private snapshot later so a host-side edit cannot race the
  # integrity check and change the generated driver.
  actual_sha256="$(sed 's/\r$//' "$validated_migration_file" | sha256sum | awk '{ print $1 }')"
  [ "$actual_sha256" = "$expected_sha256" ] \
    || fail "checksum mismatch for $migration_id (expected $expected_sha256, got $actual_sha256)"
done <"$normalized_manifest"

[ -s "$manifest_ids" ] || fail "migration manifest is empty"

: >"$filesystem_ids"
for migration_file in "$migrations_sql_dir"/*.sql; do
  [ -f "$migration_file" ] || continue
  [ ! -L "$migration_file" ] \
    || fail "migration file must not be a symbolic link: $(basename "$migration_file")"
  basename "$migration_file" >>"$filesystem_ids"
done
LC_ALL=C sort "$filesystem_ids" -o "$filesystem_ids"
if ! cmp -s "$manifest_ids" "$filesystem_ids"; then
  fail "the manifest and migration directory contain different SQL file sets"
fi

cat >"$driver" <<'SQL'
\set ON_ERROR_STOP on

SET search_path = pg_catalog, public;

DO $migration_runner_lock$
BEGIN
    IF NOT pg_try_advisory_lock(
        hashtextextended('diva-player-schema-migration-runner-v1', 0)
    ) THEN
        RAISE EXCEPTION
            'another DIVA schema migration runner holds the global advisory lock';
    END IF;
END;
$migration_runner_lock$;

BEGIN;

-- Keep unqualified migration DDL anchored to public without allowing another
-- role to plant objects that could shadow built-ins during this privileged run.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
    migration_id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    content_sha256 TEXT,
    execution_mode TEXT
);

ALTER TABLE public.schema_migrations
    ADD COLUMN IF NOT EXISTS content_sha256 TEXT,
    ADD COLUMN IF NOT EXISTS execution_mode TEXT;

DO $migration_history_shape$
DECLARE
    migration_id_attnum SMALLINT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'schema_migrations'
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
    ) THEN
        RAISE EXCEPTION 'public.schema_migrations is not a permanent ordinary table';
    END IF;

    SELECT attribute.attnum
    INTO migration_id_attnum
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'public.schema_migrations'::regclass
      AND attribute.attname = 'migration_id'
      AND attribute.atttypid = 'text'::regtype
      AND attribute.attnotnull
      AND NOT attribute.attisdropped;

    IF migration_id_attnum IS NULL
       OR NOT EXISTS (
            SELECT 1
            FROM pg_attribute attribute
            WHERE attribute.attrelid = 'public.schema_migrations'::regclass
              AND attribute.attname = 'applied_at'
              AND attribute.atttypid = 'timestamptz'::regtype
              AND attribute.attnotnull
              AND attribute.atthasdef
              AND NOT attribute.attisdropped
       )
       OR NOT EXISTS (
            SELECT 1
            FROM pg_attribute attribute
            WHERE attribute.attrelid = 'public.schema_migrations'::regclass
              AND attribute.attname = 'content_sha256'
              AND attribute.atttypid = 'text'::regtype
              AND NOT attribute.attisdropped
       )
       OR NOT EXISTS (
            SELECT 1
            FROM pg_attribute attribute
            WHERE attribute.attrelid = 'public.schema_migrations'::regclass
              AND attribute.attname = 'execution_mode'
              AND attribute.atttypid = 'text'::regtype
              AND NOT attribute.attisdropped
       ) THEN
        RAISE EXCEPTION 'public.schema_migrations has an unexpected column shape';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_state
        WHERE constraint_state.conrelid = 'public.schema_migrations'::regclass
          AND constraint_state.contype = 'p'
          AND constraint_state.conkey = ARRAY[migration_id_attnum]::SMALLINT[]
    ) THEN
        RAISE EXCEPTION 'public.schema_migrations lacks the exact migration_id primary key';
    END IF;
END;
$migration_history_shape$;

CREATE TABLE IF NOT EXISTS public.schema_migration_attempts (
    attempt_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    migration_id TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    execution_mode TEXT NOT NULL CHECK (
        execution_mode IN ('atomic', 'atomic-boundary', 'non-transactional')
    ),
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'abandoned')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    finished_at TIMESTAMPTZ,
    backend_pid INTEGER NOT NULL DEFAULT pg_backend_pid(),
    CHECK (
        (status = 'running' AND finished_at IS NULL)
        OR (status IN ('succeeded', 'abandoned') AND finished_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS schema_migration_attempts_migration_idx
    ON public.schema_migration_attempts (migration_id, attempt_id DESC);

CREATE TEMP TABLE expected_schema_migrations (
    migration_id TEXT PRIMARY KEY,
    content_sha256 TEXT NOT NULL,
    execution_mode TEXT NOT NULL
) ON COMMIT DROP;
SQL

while IFS='|' read -r migration_id execution_mode expected_sha256; do
  printf "INSERT INTO expected_schema_migrations VALUES ('%s', '%s', '%s');\n" \
    "$migration_id" "$expected_sha256" "$execution_mode" >>"$driver"
done <"$normalized_manifest"

cat >>"$driver" <<'SQL'

DO $migration_history_preflight$
DECLARE
    problem_detail TEXT;
BEGIN
    SELECT string_agg(applied.migration_id, ', ' ORDER BY applied.migration_id)
    INTO problem_detail
    FROM public.schema_migrations applied
    LEFT JOIN expected_schema_migrations expected USING (migration_id)
    WHERE expected.migration_id IS NULL;

    IF problem_detail IS NOT NULL THEN
        RAISE EXCEPTION
            'database contains migrations absent from this checkout: %',
            problem_detail;
    END IF;

    -- Existing DIVA installations have the original two-column history table.
    -- Adopt those rows only after the checkout has matched the immutable
    -- manifest, then enforce the checksum on every subsequent run.
    UPDATE public.schema_migrations applied
    SET content_sha256 = expected.content_sha256,
        execution_mode = expected.execution_mode
    FROM expected_schema_migrations expected
    WHERE expected.migration_id = applied.migration_id
      AND applied.content_sha256 IS NULL
      AND applied.execution_mode IS NULL;

    SELECT string_agg(applied.migration_id, ', ' ORDER BY applied.migration_id)
    INTO problem_detail
    FROM public.schema_migrations applied
    JOIN expected_schema_migrations expected USING (migration_id)
    WHERE applied.content_sha256 IS DISTINCT FROM expected.content_sha256
       OR applied.execution_mode IS DISTINCT FROM expected.execution_mode;

    IF problem_detail IS NOT NULL THEN
        RAISE EXCEPTION
            'applied migration checksum or execution mode differs from this checkout: %',
            problem_detail;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.schema_migrations
        WHERE content_sha256 !~ '^[0-9a-f]{64}$'
           OR execution_mode NOT IN ('atomic', 'atomic-boundary', 'non-transactional')
    ) THEN
        RAISE EXCEPTION 'schema migration history contains invalid integrity metadata';
    END IF;
END;
$migration_history_preflight$;

ALTER TABLE public.schema_migrations
    ALTER COLUMN content_sha256 SET NOT NULL,
    ALTER COLUMN execution_mode SET NOT NULL;

DO $migration_history_privileges$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diva_pipeline_runtime') THEN
        EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE '
             || 'ON TABLE public.schema_migrations, public.schema_migration_attempts '
             || 'FROM diva_pipeline_runtime';
        EXECUTE 'REVOKE ALL ON SEQUENCE public.schema_migration_attempts_attempt_id_seq '
             || 'FROM diva_pipeline_runtime';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diva_api_runtime') THEN
        EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE '
             || 'ON TABLE public.schema_migrations, public.schema_migration_attempts '
             || 'FROM diva_api_runtime';
        EXECUTE 'REVOKE ALL ON SEQUENCE public.schema_migration_attempts_attempt_id_seq '
             || 'FROM diva_api_runtime';
    END IF;
END;
$migration_history_privileges$;

COMMIT;
SQL

while IFS='|' read -r migration_id execution_mode expected_sha256; do
  migration_file="$validated_dir/$migration_id"

  cat >>"$driver" <<SQL

SELECT EXISTS (
    SELECT 1 FROM public.schema_migrations
    WHERE migration_id = '$migration_id'
) AS applied
\gset migration_
\if :migration_applied
\echo [migrate] already applied: $migration_id
\else
SQL

  case "$execution_mode" in
    atomic)
      if grep -Eiq '^[[:space:]]*(BEGIN|COMMIT)[[:space:]]*;|^[[:space:]]*(CREATE([[:space:]]+UNIQUE)?[[:space:]]+INDEX|DROP[[:space:]]+INDEX|REINDEX)[[:space:]].*CONCURRENTLY|^[[:space:]]*(VACUUM|CLUSTER|CREATE[[:space:]]+DATABASE|DROP[[:space:]]+DATABASE|ALTER[[:space:]]+SYSTEM|CALL)[[:space:]]|^[[:space:]]*\\(gexec|set[[:space:]]+AUTOCOMMIT)' "$migration_file"; then
        fail "atomic migration contains transaction-incompatible SQL: $migration_id"
      fi
      printf '%s\n' "\\echo [migrate] applying atomic migration: $migration_id" >>"$driver"
      echo "BEGIN;" >>"$driver"
      echo "SET LOCAL search_path = public, pg_catalog;" >>"$driver"
      cat "$migration_file" >>"$driver"
      printf "\nINSERT INTO public.schema_migrations " >>"$driver"
      printf "(migration_id, content_sha256, execution_mode) " >>"$driver"
      printf "VALUES ('%s', '%s', '%s');\n" \
        "$migration_id" "$expected_sha256" "$execution_mode" >>"$driver"
      echo "COMMIT;" >>"$driver"
      ;;
    atomic-boundary)
      begin_count="$(grep -Ec '^BEGIN;[[:space:]]*$' "$migration_file" || true)"
      commit_count="$(grep -Ec '^COMMIT;[[:space:]]*$' "$migration_file" || true)"
      [ "$begin_count" = "1" ] && [ "$commit_count" = "1" ] \
        || fail "atomic-boundary migration must contain one top-level BEGIN and COMMIT: $migration_id"
      awk '
        /^BEGIN;[[:space:]]*$/ && !removed_begin { removed_begin = 1; next }
        /^COMMIT;[[:space:]]*$/ && !removed_commit { removed_commit = 1; next }
        { print }
      ' "$migration_file" >"$prepared_file"
      if grep -Eiq '^[[:space:]]*(CREATE([[:space:]]+UNIQUE)?[[:space:]]+INDEX|DROP[[:space:]]+INDEX|REINDEX)[[:space:]].*CONCURRENTLY|^[[:space:]]*(VACUUM|CLUSTER|CREATE[[:space:]]+DATABASE|DROP[[:space:]]+DATABASE|ALTER[[:space:]]+SYSTEM|CALL)[[:space:]]|^[[:space:]]*\\(gexec|set[[:space:]]+AUTOCOMMIT)' "$prepared_file"; then
        fail "atomic-boundary migration contains transaction-incompatible SQL: $migration_id"
      fi
      printf '%s\n' "\\echo [migrate] applying atomic migration: $migration_id" >>"$driver"
      echo "BEGIN;" >>"$driver"
      echo "SET LOCAL search_path = public, pg_catalog;" >>"$driver"
      cat "$prepared_file" >>"$driver"
      printf "\nINSERT INTO public.schema_migrations " >>"$driver"
      printf "(migration_id, content_sha256, execution_mode) " >>"$driver"
      printf "VALUES ('%s', '%s', '%s');\n" \
        "$migration_id" "$expected_sha256" "$execution_mode" >>"$driver"
      echo "COMMIT;" >>"$driver"
      ;;
    non-transactional)
      cat >>"$driver" <<SQL
\echo [migrate] applying non-transactional migration: $migration_id
SET search_path = public, pg_catalog;
DO \$incomplete_nontransactional_migration\$
DECLARE
    incomplete_attempt RECORD;
BEGIN
    SELECT attempt_id, content_sha256, started_at, backend_pid
    INTO incomplete_attempt
    FROM public.schema_migration_attempts
    WHERE migration_id = '$migration_id'
      AND status = 'running'
    ORDER BY attempt_id DESC
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'non-transactional migration $migration_id has incomplete attempt % (checksum %, started %, backend %); inspect partial database state and mark that attempt abandoned before retrying',
            incomplete_attempt.attempt_id,
            incomplete_attempt.content_sha256,
            incomplete_attempt.started_at,
            incomplete_attempt.backend_pid;
    END IF;
END;
\$incomplete_nontransactional_migration\$;

INSERT INTO public.schema_migration_attempts (
    migration_id, content_sha256, execution_mode, status
) VALUES (
    '$migration_id', '$expected_sha256', '$execution_mode', 'running'
)
RETURNING attempt_id
\gset migration_
SQL
      cat "$migration_file" >>"$driver"
      cat >>"$driver" <<SQL

BEGIN;
INSERT INTO public.schema_migrations (
    migration_id, content_sha256, execution_mode
) VALUES (
    '$migration_id', '$expected_sha256', '$execution_mode'
);
UPDATE public.schema_migration_attempts
SET status = 'succeeded',
    finished_at = clock_timestamp()
WHERE attempt_id = :migration_attempt_id
  AND status = 'running';
COMMIT;
RESET search_path;
SQL
      ;;
  esac

  printf '%s\n' "\\endif" >>"$driver"
done <"$normalized_manifest"

cat >>"$driver" <<'SQL'

-- Migration 0018 may have granted its original broad table defaults on a
-- fresh database.  Reassert that both migration-history relations remain
-- control-plane state after all migrations have completed.
DO $final_migration_history_privileges$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diva_pipeline_runtime') THEN
        EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE '
             || 'ON TABLE public.schema_migrations, public.schema_migration_attempts '
             || 'FROM diva_pipeline_runtime';
        EXECUTE 'REVOKE ALL ON SEQUENCE public.schema_migration_attempts_attempt_id_seq '
             || 'FROM diva_pipeline_runtime';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diva_api_runtime') THEN
        EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE '
             || 'ON TABLE public.schema_migrations, public.schema_migration_attempts '
             || 'FROM diva_api_runtime';
        EXECUTE 'REVOKE ALL ON SEQUENCE public.schema_migration_attempts_attempt_id_seq '
             || 'FROM diva_api_runtime';
    END IF;
END;
$final_migration_history_privileges$;

DO $migration_runner_unlock$
BEGIN
    IF NOT pg_advisory_unlock(
        hashtextextended('diva-player-schema-migration-runner-v1', 0)
    ) THEN
        RAISE EXCEPTION 'DIVA schema migration runner lost its advisory lock';
    END IF;
END;
$migration_runner_unlock$;
SQL

psql -X -v ON_ERROR_STOP=1 -f "$driver"
