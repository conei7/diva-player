-- Restore the two verified VocaDB parent tags that were omitted historically,
-- then install the tags.parent_id self-reference that fresh schemas already
-- receive from schema.sql.  Every repair precondition is deliberately exact:
-- an unfamiliar orphan, identity collision, cycle, or competing constraint
-- aborts the entire migration for operator review.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Block tag writers while the snapshot is checked, repaired, and constrained.
-- Readers remain available.  ADD FOREIGN KEY uses this lock level as well.
LOCK TABLE public.tags IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
    problem_detail TEXT;
BEGIN
    -- A runtime DML role must not be able to perform even the data-repair half
    -- of this owner-only schema migration.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
        JOIN pg_roles effective_role ON effective_role.rolname = current_user
        WHERE relation.oid = 'public.tags'::regclass
          AND (
              owner_role.rolname = current_user
              OR effective_role.rolsuper
          )
    ) THEN
        RAISE EXCEPTION '0019 must run as the tags owner or a superuser';
    END IF;

    -- If either historical child exists, its source identity and edge must be
    -- unchanged.  An empty fresh schema is valid and does not seed these rows.
    IF EXISTS (SELECT 1 FROM public.tags WHERE id = 11668)
       AND NOT EXISTS (
           SELECT 1
           FROM public.tags
           WHERE id = 11668
             AND name = 'Nowaru Burakku Hato'
             AND category = 'Derivative'
             AND parent_id = 11669
       ) THEN
        RAISE EXCEPTION 'tag 11668 does not match the verified historical child shape';
    END IF;

    IF EXISTS (SELECT 1 FROM public.tags WHERE id = 11822)
       AND NOT EXISTS (
           SELECT 1
           FROM public.tags
           WHERE id = 11822
             AND name = '猫の日'
             AND category = 'Themes'
             AND parent_id = 11805
       ) THEN
        RAISE EXCEPTION 'tag 11822 does not match the verified historical child shape';
    END IF;

    -- Existing parent rows are accepted only when they are the exact source
    -- rows this migration would insert.  This makes a crash-before-history
    -- rerun safe without turning an ID collision into an overwrite.
    IF EXISTS (SELECT 1 FROM public.tags WHERE id = 11669)
       AND NOT EXISTS (
           SELECT 1
           FROM public.tags
           WHERE id = 11669
             AND name = 'Annoyloids'
             AND category IS NULL
             AND parent_id = 92
       ) THEN
        RAISE EXCEPTION 'tag 11669 conflicts with the verified Annoyloids parent shape';
    END IF;

    IF EXISTS (SELECT 1 FROM public.tags WHERE id = 11805)
       AND NOT EXISTS (
           SELECT 1
           FROM public.tags
           WHERE id = 11805
             AND name = '記念日'
             AND category = 'Themes'
             AND parent_id IS NULL
       ) THEN
        RAISE EXCEPTION 'tag 11805 conflicts with the verified 記念日 parent shape';
    END IF;

    -- Reject case/space-normalized aliases before an INSERT can encounter the
    -- weaker, exact-text UNIQUE constraint on tags.name.
    IF EXISTS (
        SELECT 1
        FROM public.tags
        WHERE id <> 11669
          AND lower(btrim(name)) = lower('Annoyloids')
    ) THEN
        RAISE EXCEPTION 'Annoyloids already exists under a different tag id';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.tags
        WHERE id <> 11805
          AND lower(btrim(name)) = lower('記念日')
    ) THEN
        RAISE EXCEPTION '記念日 already exists under a different tag id';
    END IF;

    -- Annoyloids has a verified canonical parent.  Require that canonical row
    -- only when the chain is present or needs repair, so fresh schemas remain
    -- data-free.
    IF (
        EXISTS (SELECT 1 FROM public.tags WHERE id = 11669)
        OR EXISTS (SELECT 1 FROM public.tags WHERE parent_id = 11669)
    ) AND NOT EXISTS (
        SELECT 1
        FROM public.tags
        WHERE id = 92
          AND name = '亜種'
          AND category = 'Derivative'
          AND parent_id IS NULL
    ) THEN
        RAISE EXCEPTION 'canonical tag 92 does not match the verified 亜種 parent shape';
    END IF;

    -- Before repair, the only permitted dangling edges are the two observed
    -- production pairs.  Any additional child, even one targeting a known
    -- missing parent ID, is an unreviewed state and must fail closed.
    SELECT string_agg(format('%s->%s', child.id, child.parent_id), ', ' ORDER BY child.id)
    INTO problem_detail
    FROM public.tags child
    LEFT JOIN public.tags parent_tag ON parent_tag.id = child.parent_id
    WHERE child.parent_id IS NOT NULL
      AND parent_tag.id IS NULL
      AND (child.id, child.parent_id) NOT IN ((11668, 11669), (11822, 11805));

    IF problem_detail IS NOT NULL THEN
        RAISE EXCEPTION 'unreviewed orphan tag parent edges: %', problem_detail;
    END IF;

    -- A self-FK cannot prohibit cycles, so reject every existing cycle before
    -- doing any repair.  The path guard both detects and terminates recursion.
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
        RAISE EXCEPTION 'tag parent cycle detected before repair: %', problem_detail;
    END IF;
END;
$preflight$;

DO $repair$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.tags
        WHERE id = 11668
          AND name = 'Nowaru Burakku Hato'
          AND category = 'Derivative'
          AND parent_id = 11669
    ) AND NOT EXISTS (SELECT 1 FROM public.tags WHERE id = 11669) THEN
        INSERT INTO public.tags (id, name, category, parent_id)
        VALUES (11669, 'Annoyloids', NULL, 92);
        RAISE NOTICE 'restored verified tag 11669 (Annoyloids)';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.tags
        WHERE id = 11822
          AND name = '猫の日'
          AND category = 'Themes'
          AND parent_id = 11805
    ) AND NOT EXISTS (SELECT 1 FROM public.tags WHERE id = 11805) THEN
        INSERT INTO public.tags (id, name, category, parent_id)
        VALUES (11805, '記念日', 'Themes', NULL);
        RAISE NOTICE 'restored verified tag 11805 (記念日)';
    END IF;
END;
$repair$;

DO $post_repair_validation$
DECLARE
    problem_detail TEXT;
BEGIN
    SELECT string_agg(format('%s->%s', child.id, child.parent_id), ', ' ORDER BY child.id)
    INTO problem_detail
    FROM public.tags child
    LEFT JOIN public.tags parent_tag ON parent_tag.id = child.parent_id
    WHERE child.parent_id IS NOT NULL
      AND parent_tag.id IS NULL;

    IF problem_detail IS NOT NULL THEN
        RAISE EXCEPTION 'orphan tag parent edges remain after repair: %', problem_detail;
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
        RAISE EXCEPTION 'tag parent cycle detected after repair: %', problem_detail;
    END IF;
END;
$post_repair_validation$;

DO $foreign_key$
DECLARE
    tags_oid OID := 'public.tags'::regclass;
    id_attnum SMALLINT;
    parent_attnum SMALLINT;
    expected_constraint RECORD;
    competing_constraints TEXT;
BEGIN
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

    SELECT
        constraint_row.oid,
        constraint_row.contype,
        constraint_row.conkey,
        constraint_row.confrelid,
        constraint_row.confkey,
        constraint_row.confmatchtype,
        constraint_row.confupdtype,
        constraint_row.confdeltype,
        constraint_row.condeferrable,
        constraint_row.condeferred,
        constraint_row.convalidated
    INTO expected_constraint
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = tags_oid
      AND constraint_row.conname = 'tags_parent_id_fkey';

    IF FOUND AND NOT (
        expected_constraint.contype = 'f'
        AND expected_constraint.conkey = ARRAY[parent_attnum]::SMALLINT[]
        AND expected_constraint.confrelid = tags_oid
        AND expected_constraint.confkey = ARRAY[id_attnum]::SMALLINT[]
        AND expected_constraint.confmatchtype = 's'
        AND expected_constraint.confupdtype = 'a'
        AND expected_constraint.confdeltype = 'a'
        AND NOT expected_constraint.condeferrable
        AND NOT expected_constraint.condeferred
    ) THEN
        RAISE EXCEPTION 'constraint tags_parent_id_fkey exists with unexpected semantics';
    END IF;

    SELECT string_agg(constraint_row.conname, ', ' ORDER BY constraint_row.conname)
    INTO competing_constraints
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = tags_oid
      AND constraint_row.contype = 'f'
      AND parent_attnum = ANY(constraint_row.conkey)
      AND constraint_row.conname <> 'tags_parent_id_fkey';

    IF competing_constraints IS NOT NULL THEN
        RAISE EXCEPTION 'competing foreign keys involve tags.parent_id: %', competing_constraints;
    END IF;

    IF expected_constraint.oid IS NULL THEN
        ALTER TABLE public.tags
            ADD CONSTRAINT tags_parent_id_fkey
            FOREIGN KEY (parent_id)
            REFERENCES public.tags (id)
            ON UPDATE NO ACTION
            ON DELETE NO ACTION
            NOT DEFERRABLE
            NOT VALID;
    END IF;

    ALTER TABLE public.tags
        VALIDATE CONSTRAINT tags_parent_id_fkey;

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
        RAISE EXCEPTION 'validated tags(parent_id) self-reference was not established';
    END IF;
END;
$foreign_key$;

COMMIT;
