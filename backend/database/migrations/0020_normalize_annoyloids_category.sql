-- VocaDB represents the uncategorized Annoyloids tag with an explicit empty
-- category string.  Migration 0019 restored the missing parent row as NULL;
-- normalize that single verified row without weakening the parent FK.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Serialize with tag writers while the exact row and hierarchy are checked.
LOCK TABLE public.tags IN SHARE ROW EXCLUSIVE MODE;

DO $normalize$
DECLARE
    tags_oid OID := 'public.tags'::regclass;
    id_attnum SMALLINT;
    parent_attnum SMALLINT;
    problem_detail TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
        JOIN pg_roles effective_role ON effective_role.rolname = current_user
        WHERE relation.oid = tags_oid
          AND (
              owner_role.rolname = current_user
              OR effective_role.rolsuper
          )
    ) THEN
        RAISE EXCEPTION '0020 must run as the tags owner or a superuser';
    END IF;

    SELECT attnum
    INTO STRICT id_attnum
    FROM pg_attribute
    WHERE attrelid = tags_oid
      AND attname = 'id'
      AND NOT attisdropped;

    SELECT attnum
    INTO STRICT parent_attnum
    FROM pg_attribute
    WHERE attrelid = tags_oid
      AND attname = 'parent_id'
      AND NOT attisdropped;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = tags_oid
          AND constraint_row.conname = 'tags_parent_id_fkey'
          AND constraint_row.contype = 'f'
          AND constraint_row.conkey = ARRAY[parent_attnum]::SMALLINT[]
          AND constraint_row.confrelid = tags_oid
          AND constraint_row.confkey = ARRAY[id_attnum]::SMALLINT[]
          AND constraint_row.confmatchtype = 's'
          AND constraint_row.confupdtype = 'a'
          AND constraint_row.confdeltype = 'a'
          AND NOT constraint_row.condeferrable
          AND NOT constraint_row.condeferred
          AND constraint_row.convalidated
    ) THEN
        RAISE EXCEPTION '0020 requires the validated tags(parent_id) self-reference';
    END IF;

    -- Empty fresh schemas are valid.  If the repaired row exists, accept only
    -- the exact source identity and either the old NULL or canonical empty
    -- representation; every other drift requires operator review.
    IF EXISTS (SELECT 1 FROM public.tags WHERE id = 11669)
       AND NOT EXISTS (
           SELECT 1
           FROM public.tags
           WHERE id = 11669
             AND name = 'Annoyloids'
             AND parent_id = 92
             AND (category IS NULL OR category = '')
       ) THEN
        RAISE EXCEPTION 'tag 11669 conflicts with the verified Annoyloids category shape';
    END IF;

    UPDATE public.tags
    SET category = ''
    WHERE id = 11669
      AND name = 'Annoyloids'
      AND parent_id = 92
      AND category IS NULL;

    IF EXISTS (SELECT 1 FROM public.tags WHERE id = 11669)
       AND NOT EXISTS (
           SELECT 1
           FROM public.tags
           WHERE id = 11669
             AND name = 'Annoyloids'
             AND category = ''
             AND parent_id = 92
       ) THEN
        RAISE EXCEPTION 'tag 11669 was not normalized to the verified source category';
    END IF;

    SELECT string_agg(format('%s->%s', child.id, child.parent_id), ', ' ORDER BY child.id)
    INTO problem_detail
    FROM public.tags child
    LEFT JOIN public.tags parent_tag ON parent_tag.id = child.parent_id
    WHERE child.parent_id IS NOT NULL
      AND parent_tag.id IS NULL;

    IF problem_detail IS NOT NULL THEN
        RAISE EXCEPTION 'orphan tag parent edges found during 0020: %', problem_detail;
    END IF;

    WITH RECURSIVE parent_walk AS (
        SELECT
            child.id AS origin_id,
            child.parent_id AS next_id,
            ARRAY[child.id]::INTEGER[] AS path,
            FALSE AS cycle_found
        FROM public.tags child
        WHERE child.parent_id IS NOT NULL

        UNION ALL

        SELECT
            walk.origin_id,
            parent_tag.parent_id,
            walk.path || parent_tag.id,
            parent_tag.id = ANY(walk.path)
        FROM parent_walk walk
        JOIN public.tags parent_tag ON parent_tag.id = walk.next_id
        WHERE NOT walk.cycle_found
    )
    SELECT format('origin=%s path=%s', origin_id, path::TEXT)
    INTO problem_detail
    FROM parent_walk
    WHERE cycle_found
    ORDER BY origin_id
    LIMIT 1;

    IF problem_detail IS NOT NULL THEN
        RAISE EXCEPTION 'tag parent cycle found during 0020: %', problem_detail;
    END IF;
END;
$normalize$;

COMMIT;
