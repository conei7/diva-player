#!/usr/bin/env bash
set -euo pipefail

# Destructive only inside the disposable CI database.  Run after schema.sql,
# migrations 0017/0018, and test-database-role-contract.sql.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
migration="$repo_root/backend/database/migrations/0019_repair_tag_parent_fk.sql"
normalization_migration="$repo_root/backend/database/migrations/0020_normalize_annoyloids_category.sql"

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-vocadb}"
export PGDATABASE="${PGDATABASE:-vocadb_recommender}"

psql_cmd=(psql --no-psqlrc --set=ON_ERROR_STOP=1)

if [[ "${DIVA_ALLOW_DESTRUCTIVE_DB_MIGRATION_TEST:-}" != '1' ]]; then
    printf '%s\n' \
        'refusing destructive DB fixture test without DIVA_ALLOW_DESTRUCTIVE_DB_MIGRATION_TEST=1' >&2
    exit 2
fi

expect_sql_failure() {
    local migration_file="$1"
    local expected_message="$2"
    shift 2
    local output

    if output="$("${psql_cmd[@]}" "$@" --file="$migration_file" 2>&1)"; then
        printf 'migration unexpectedly succeeded; wanted: %s\n' "$expected_message" >&2
        exit 1
    fi

    if [[ "$output" != *"$expected_message"* ]]; then
        printf 'migration failed for an unexpected reason\n%s\n' "$output" >&2
        exit 1
    fi
}

expect_migration_failure() {
    local expected_message="$1"
    shift
    expect_sql_failure "$migration" "$expected_message" "$@"
}

expect_normalization_failure() {
    local expected_message="$1"
    shift
    expect_sql_failure "$normalization_migration" "$expected_message" "$@"
}

# Refuse a database that is not the freshly created CI fixture before running
# even the idempotent migration checks.  The explicit opt-in above is not, by
# itself, sufficient protection against pointing PG* at a populated database.
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
    IF EXISTS (SELECT 1 FROM public.tags)
       OR EXISTS (SELECT 1 FROM public.songs)
       OR EXISTS (SELECT 1 FROM public.song_tags) THEN
        RAISE EXCEPTION 'migration integration test requires empty tags/songs/song_tags tables';
    END IF;
END;
$test$;
SQL

# schema.sql already supplies the intended FK.  Applying 0019 twice to an
# empty schema must validate that constraint without seeding source data.
"${psql_cmd[@]}" --file="$migration"
"${psql_cmd[@]}" --file="$migration"
"${psql_cmd[@]}" --file="$normalization_migration"
"${psql_cmd[@]}" --file="$normalization_migration"
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.tags
        WHERE id IN (92, 11668, 11669, 11805, 11822)
    ) THEN
        RAISE EXCEPTION 'fresh-schema migration seeded VocaDB tag rows';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.tags'::regclass
          AND conname = 'tags_parent_id_fkey'
          AND contype = 'f'
          AND convalidated
          AND NOT condeferrable
          AND NOT condeferred
          AND confupdtype = 'a'
          AND confdeltype = 'a'
          AND pg_get_constraintdef(oid) =
              'FOREIGN KEY (parent_id) REFERENCES tags(id)'
    ) THEN
        RAISE EXCEPTION 'fresh-schema parent FK does not match the contract';
    END IF;
END;
$test$;
SQL

# Recreate the exact production defect, with two song-tag references that must
# survive every failed and successful migration attempt unchanged.
"${psql_cmd[@]}" <<'SQL'
ALTER TABLE public.tags DROP CONSTRAINT tags_parent_id_fkey;

INSERT INTO public.tags (id, name, category, parent_id) VALUES
    (92, '亜種', 'Derivative', NULL),
    (11668, 'Nowaru Burakku Hato', 'Derivative', 11669),
    (11822, '猫の日', 'Themes', 11805);

INSERT INTO public.songs (id, name, song_type) VALUES
    (-2147483000, 'tag-parent-fk-test-a', 'Original'),
    (-2147482999, 'tag-parent-fk-test-b', 'Original');

INSERT INTO public.song_tags (song_id, tag_id, tag_count) VALUES
    (-2147483000, 11668, 7),
    (-2147482999, 11822, 11);
SQL

# Any third orphan must stop the migration without repairing the whitelisted
# edges or adding a constraint.
"${psql_cmd[@]}" <<'SQL'
INSERT INTO public.tags (id, name, category, parent_id)
VALUES (-2147482900, 'unknown-orphan-child', 'Other', -2147482899);
SQL
expect_migration_failure 'unreviewed orphan tag parent edges'
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
    IF EXISTS (SELECT 1 FROM public.tags WHERE id IN (11669, 11805))
       OR EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = 'public.tags'::regclass
             AND conname = 'tags_parent_id_fkey'
       )
       OR (SELECT parent_id FROM public.tags WHERE id = -2147482900)
          IS DISTINCT FROM -2147482899
       OR (SELECT count(*) FROM public.song_tags
           WHERE (song_id, tag_id, tag_count) IN (
               (-2147483000, 11668, 7),
               (-2147482999, 11822, 11)
           )) <> 2 THEN
        RAISE EXCEPTION 'unknown-orphan failure changed protected state';
    END IF;
END;
$test$;

DELETE FROM public.tags WHERE id = -2147482900;
SQL

# FK constraints permit cycles, but 0019 must reject both self and multi-node
# cycles before doing any repair.  This fixture exercises a two-node cycle.
"${psql_cmd[@]}" <<'SQL'
INSERT INTO public.tags (id, name, category, parent_id) VALUES
    (-2147482902, 'cycle-a', 'Other', -2147482901),
    (-2147482901, 'cycle-b', 'Other', -2147482902);
SQL
expect_migration_failure 'tag parent cycle detected before repair'
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
    IF EXISTS (SELECT 1 FROM public.tags WHERE id IN (11669, 11805))
       OR EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = 'public.tags'::regclass
             AND conname = 'tags_parent_id_fkey'
       )
       OR (SELECT count(*) FROM public.tags
           WHERE (id, parent_id) IN (
               (-2147482902, -2147482901),
               (-2147482901, -2147482902)
           )) <> 2 THEN
        RAISE EXCEPTION 'cycle failure changed protected state';
    END IF;
END;
$test$;

DELETE FROM public.tags WHERE id IN (-2147482902, -2147482901);
SQL

# A wrong same-name constraint is detected after the verified parent INSERTs.
# Its failure therefore proves the single transaction rolls those INSERTs back.
"${psql_cmd[@]}" <<'SQL'
CREATE TABLE public.tag_parent_fk_wrong_target (id INTEGER PRIMARY KEY);
INSERT INTO public.tag_parent_fk_wrong_target (id) VALUES (92);
ALTER TABLE public.tags
    ADD CONSTRAINT tags_parent_id_fkey
    FOREIGN KEY (parent_id)
    REFERENCES public.tag_parent_fk_wrong_target (id)
    NOT VALID;
SQL
expect_migration_failure 'constraint tags_parent_id_fkey exists with unexpected semantics'
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
    IF EXISTS (SELECT 1 FROM public.tags WHERE id IN (11669, 11805))
       OR (SELECT count(*) FROM public.song_tags
           WHERE (song_id, tag_id, tag_count) IN (
               (-2147483000, 11668, 7),
               (-2147482999, 11822, 11)
           )) <> 2 THEN
        RAISE EXCEPTION 'late constraint failure did not roll back repairs';
    END IF;
END;
$test$;

ALTER TABLE public.tags DROP CONSTRAINT tags_parent_id_fkey;
DROP TABLE public.tag_parent_fk_wrong_target;
SQL

# The runtime role retains tag DML but cannot execute this owner-only schema
# migration.  No parent insert may leak from that failed attempt.
expect_migration_failure '0019 must run as the tags owner or a superuser' \
    --command='SET ROLE diva_pipeline_runtime'
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
    IF EXISTS (SELECT 1 FROM public.tags WHERE id IN (11669, 11805)) THEN
        RAISE EXCEPTION 'runtime-role migration attempt changed tag data';
    END IF;
END;
$test$;
SQL

# Exact production repair: reconstruct the two verified parent rows, retain
# child IDs/edges and song_tags, then add and validate the canonical FK.
"${psql_cmd[@]}" --file="$migration"
"${psql_cmd[@]}" <<'SQL'
DO $test$
DECLARE
    parent_attnum SMALLINT;
    id_attnum SMALLINT;
    cycle_origin INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.tags
        WHERE id = 11669
          AND name = 'Annoyloids'
          AND category IS NULL
          AND parent_id = 92
    ) OR NOT EXISTS (
        SELECT 1 FROM public.tags
        WHERE id = 11805
          AND name = '記念日'
          AND category = 'Themes'
          AND parent_id IS NULL
    ) THEN
        RAISE EXCEPTION 'verified parent rows were not reconstructed exactly';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.tags
        WHERE id = 11668
          AND name = 'Nowaru Burakku Hato'
          AND category = 'Derivative'
          AND parent_id = 11669
    ) OR NOT EXISTS (
        SELECT 1 FROM public.tags
        WHERE id = 11822
          AND name = '猫の日'
          AND category = 'Themes'
          AND parent_id = 11805
    ) THEN
        RAISE EXCEPTION 'verified child rows changed during repair';
    END IF;

    IF (SELECT count(*) FROM public.song_tags
        WHERE (song_id, tag_id, tag_count) IN (
            (-2147483000, 11668, 7),
            (-2147482999, 11822, 11)
        )) <> 2 THEN
        RAISE EXCEPTION 'song_tags references changed during repair';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.tags child
        LEFT JOIN public.tags parent_tag ON parent_tag.id = child.parent_id
        WHERE child.parent_id IS NOT NULL
          AND parent_tag.id IS NULL
    ) THEN
        RAISE EXCEPTION 'global orphan check failed after migration';
    END IF;

    WITH RECURSIVE parent_walk AS (
        SELECT child.id AS origin_id,
               child.parent_id AS next_id,
               ARRAY[child.id]::INTEGER[] AS path,
               FALSE AS cycle_found
        FROM public.tags child
        WHERE child.parent_id IS NOT NULL
        UNION ALL
        SELECT walk.origin_id,
               parent_tag.parent_id,
               walk.path || parent_tag.id,
               parent_tag.id = ANY(walk.path)
        FROM parent_walk walk
        JOIN public.tags parent_tag ON parent_tag.id = walk.next_id
        WHERE NOT walk.cycle_found
    )
    SELECT origin_id
    INTO cycle_origin
    FROM parent_walk
    WHERE cycle_found
    LIMIT 1;

    IF cycle_origin IS NOT NULL THEN
        RAISE EXCEPTION 'global cycle check failed after migration';
    END IF;

    SELECT attnum INTO STRICT parent_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.tags'::regclass
      AND attname = 'parent_id'
      AND NOT attisdropped;

    SELECT attnum INTO STRICT id_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.tags'::regclass
      AND attname = 'id'
      AND NOT attisdropped;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.tags'::regclass
          AND conname = 'tags_parent_id_fkey'
          AND contype = 'f'
          AND conkey = ARRAY[parent_attnum]::SMALLINT[]
          AND confrelid = 'public.tags'::regclass
          AND confkey = ARRAY[id_attnum]::SMALLINT[]
          AND confmatchtype = 's'
          AND confupdtype = 'a'
          AND confdeltype = 'a'
          AND NOT condeferrable
          AND NOT condeferred
          AND convalidated
    ) THEN
        RAISE EXCEPTION 'canonical validated parent FK is missing';
    END IF;

    IF NOT has_table_privilege('diva_pipeline_runtime', 'public.tags', 'SELECT')
       OR NOT has_table_privilege('diva_pipeline_runtime', 'public.tags', 'INSERT')
       OR NOT has_table_privilege('diva_pipeline_runtime', 'public.tags', 'UPDATE')
       OR NOT has_table_privilege('diva_pipeline_runtime', 'public.tags', 'DELETE')
       OR has_table_privilege('diva_pipeline_runtime', 'public.tags', 'REFERENCES')
       OR has_table_privilege('diva_pipeline_runtime', 'public.tags', 'TRIGGER')
       OR has_table_privilege('diva_pipeline_runtime', 'public.tags', 'TRUNCATE') THEN
        RAISE EXCEPTION 'pipeline tag privileges changed during migration';
    END IF;

    BEGIN
        UPDATE public.tags SET parent_id = -2147482899 WHERE id = 11822;
        RAISE EXCEPTION 'validated FK accepted an orphan update';
    EXCEPTION
        WHEN foreign_key_violation THEN
            NULL;
    END;

    IF (SELECT parent_id FROM public.tags WHERE id = 11822)
       IS DISTINCT FROM 11805 THEN
        RAISE EXCEPTION 'rejected orphan update changed the child edge';
    END IF;
END;
$test$;
SQL

# Crash-safe retry: a second execution with repaired data and a validated FK
# must be a no-op that leaves data and privileges intact.
"${psql_cmd[@]}" --file="$migration"

# 0020 is owner-only, rejects identity/category drift, and changes only the
# source's NULL-vs-empty representation after all 0019 invariants hold.
expect_normalization_failure '0020 must run as the tags owner or a superuser' \
    --command='SET ROLE diva_pipeline_runtime'
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
    IF (SELECT category FROM public.tags WHERE id = 11669) IS NOT NULL THEN
        RAISE EXCEPTION 'runtime-role normalization attempt changed tag 11669';
    END IF;
END;
$test$;

UPDATE public.tags SET category = 'Unexpected' WHERE id = 11669;
SQL
expect_normalization_failure 'tag 11669 conflicts with the verified Annoyloids category shape'
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
    IF (SELECT category FROM public.tags WHERE id = 11669)
       IS DISTINCT FROM 'Unexpected' THEN
        RAISE EXCEPTION 'failed normalization changed an unexpected category';
    END IF;
END;
$test$;

UPDATE public.tags SET category = NULL WHERE id = 11669;
UPDATE public.tags SET name = 'Annoyloids drift' WHERE id = 11669;
SQL
expect_normalization_failure 'tag 11669 conflicts with the verified Annoyloids category shape'
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
    IF (SELECT name FROM public.tags WHERE id = 11669)
       IS DISTINCT FROM 'Annoyloids drift' THEN
        RAISE EXCEPTION 'failed normalization changed an unexpected identity';
    END IF;
END;
$test$;

UPDATE public.tags SET name = 'Annoyloids' WHERE id = 11669;
UPDATE public.tags SET parent_id = 11805 WHERE id = 11669;
SQL
expect_normalization_failure 'tag 11669 conflicts with the verified Annoyloids category shape'
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
    IF (SELECT parent_id FROM public.tags WHERE id = 11669)
       IS DISTINCT FROM 11805 THEN
        RAISE EXCEPTION 'failed normalization changed an unexpected parent';
    END IF;
END;
$test$;

UPDATE public.tags SET parent_id = 92 WHERE id = 11669;
SQL
"${psql_cmd[@]}" --file="$normalization_migration"
"${psql_cmd[@]}" --file="$normalization_migration"
"${psql_cmd[@]}" <<'SQL'
DO $test$
DECLARE
    parent_attnum SMALLINT;
    id_attnum SMALLINT;
    cycle_origin INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.tags
        WHERE id = 11669
          AND name = 'Annoyloids'
          AND category = ''
          AND parent_id = 92
    ) THEN
        RAISE EXCEPTION 'tag 11669 was not normalized to an empty category';
    END IF;

    IF (SELECT count(*) FROM public.song_tags
        WHERE (song_id, tag_id, tag_count) IN (
            (-2147483000, 11668, 7),
            (-2147482999, 11822, 11)
        )) <> 2 THEN
        RAISE EXCEPTION 'song_tags references changed during category normalization';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.tags child
        LEFT JOIN public.tags parent_tag ON parent_tag.id = child.parent_id
        WHERE child.parent_id IS NOT NULL
          AND parent_tag.id IS NULL
    ) THEN
        RAISE EXCEPTION 'category normalization introduced an orphan';
    END IF;

    WITH RECURSIVE parent_walk AS (
        SELECT child.id AS origin_id,
               child.parent_id AS next_id,
               ARRAY[child.id]::INTEGER[] AS path,
               FALSE AS cycle_found
        FROM public.tags child
        WHERE child.parent_id IS NOT NULL
        UNION ALL
        SELECT walk.origin_id,
               parent_tag.parent_id,
               walk.path || parent_tag.id,
               parent_tag.id = ANY(walk.path)
        FROM parent_walk walk
        JOIN public.tags parent_tag ON parent_tag.id = walk.next_id
        WHERE NOT walk.cycle_found
    )
    SELECT origin_id
    INTO cycle_origin
    FROM parent_walk
    WHERE cycle_found
    LIMIT 1;

    IF cycle_origin IS NOT NULL THEN
        RAISE EXCEPTION 'category normalization left a cycle';
    END IF;

    SELECT attnum INTO STRICT parent_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.tags'::regclass
      AND attname = 'parent_id'
      AND NOT attisdropped;

    SELECT attnum INTO STRICT id_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.tags'::regclass
      AND attname = 'id'
      AND NOT attisdropped;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.tags'::regclass
          AND conname = 'tags_parent_id_fkey'
          AND contype = 'f'
          AND conkey = ARRAY[parent_attnum]::SMALLINT[]
          AND confrelid = 'public.tags'::regclass
          AND confkey = ARRAY[id_attnum]::SMALLINT[]
          AND NOT condeferrable
          AND NOT condeferred
          AND convalidated
    ) THEN
        RAISE EXCEPTION 'category normalization changed the parent FK contract';
    END IF;
END;
$test$;
SQL

# Remove test data in FK-safe order, then exercise an exact unvalidated FK and
# a competing differently named FK on an empty schema.
"${psql_cmd[@]}" <<'SQL'
DELETE FROM public.song_tags
WHERE song_id IN (-2147483000, -2147482999);
DELETE FROM public.songs
WHERE id IN (-2147483000, -2147482999);
DELETE FROM public.tags WHERE id IN (11668, 11822);
DELETE FROM public.tags WHERE id IN (11669, 11805);
DELETE FROM public.tags WHERE id = 92;

ALTER TABLE public.tags DROP CONSTRAINT tags_parent_id_fkey;
ALTER TABLE public.tags
    ADD CONSTRAINT tags_parent_id_fkey
    FOREIGN KEY (parent_id) REFERENCES public.tags (id)
    NOT VALID;
SQL
expect_normalization_failure '0020 requires the validated tags(parent_id) self-reference'
"${psql_cmd[@]}" --file="$migration"
"${psql_cmd[@]}" --file="$normalization_migration"
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.tags'::regclass
          AND conname = 'tags_parent_id_fkey'
          AND convalidated
    ) THEN
        RAISE EXCEPTION 'exact pre-existing FK was not validated';
    END IF;
END;
$test$;

ALTER TABLE public.tags DROP CONSTRAINT tags_parent_id_fkey;
ALTER TABLE public.tags
    ADD CONSTRAINT tags_parent_competing_fkey
    FOREIGN KEY (parent_id) REFERENCES public.tags (id)
    NOT VALID;
SQL
expect_migration_failure 'competing foreign keys involve tags.parent_id'
"${psql_cmd[@]}" <<'SQL'
ALTER TABLE public.tags DROP CONSTRAINT tags_parent_competing_fkey;
SQL

# Leave the disposable database in the same constrained, data-free shape in
# which the test started.  Repeat once more to cover the no-FK creation path.
"${psql_cmd[@]}" --file="$migration"
"${psql_cmd[@]}" --file="$migration"
"${psql_cmd[@]}" --file="$normalization_migration"
"${psql_cmd[@]}" --file="$normalization_migration"

printf 'PASS tag parent FK migration contract\n'
