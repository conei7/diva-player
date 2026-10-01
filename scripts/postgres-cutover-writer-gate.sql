\set gate_value ''
\set roles_json ''
BEGIN;
LOCK TABLE pg_catalog.pg_auth_members IN SHARE MODE;
LOCK TABLE pg_catalog.pg_authid IN SHARE MODE;
WITH locks AS MATERIALIZED (
    SELECT
        pg_try_advisory_xact_lock(hashtext('diva-data-pipeline-publication-v1')) AS pipeline,
        pg_try_advisory_xact_lock(hashtext('diva-data-pipeline-child-v1')) AS child,
        pg_try_advisory_xact_lock(hashtextextended('diva-recommendation-publication-v1', 0)) AS publication
), idle AS MATERIALIZED (
    SELECT
        NOT EXISTS (SELECT 1 FROM sync_state WHERE key IN (
            'diva_pipeline_lock_owner',
            'recommendation_publication_in_progress',
            'diva_stateful_maintenance_gate',
            'diva_stateful_maintenance_login_roles'
        ))
        AND NOT EXISTS (
            SELECT 1
            FROM pg_stat_activity AS activity
            JOIN pg_roles AS role ON role.rolname = activity.usename
            WHERE activity.pid <> pg_backend_pid()
              AND activity.backend_type = 'client backend'
              AND EXISTS (
                  SELECT 1
                  FROM pg_auth_members AS membership
                  JOIN pg_roles AS parent_role ON parent_role.oid = membership.roleid
                  WHERE membership.member = role.oid
                    AND parent_role.rolname = 'diva_pipeline_runtime'
              )
        ) AS state_idle
)
,
inserted_gate AS (
    INSERT INTO sync_state(key, value, updated_at)
    SELECT 'diva_stateful_maintenance_gate', :'token', now()
    FROM locks, idle
    WHERE pipeline AND child AND publication AND state_idle
    ON CONFLICT DO NOTHING
    RETURNING value
)
SELECT COALESCE((SELECT value FROM inserted_gate), '') AS gate_value
/* diva-writer-gate-acquire */
\gset
WITH inserted_roles AS (
    INSERT INTO sync_state(key, value, updated_at)
    SELECT
        'diva_stateful_maintenance_login_roles',
        jsonb_agg(role.rolname ORDER BY role.rolname)::text,
        now()
    FROM pg_roles AS role
    JOIN pg_auth_members AS membership ON membership.member = role.oid
    JOIN pg_roles AS parent_role
      ON parent_role.oid = membership.roleid
     AND parent_role.rolname = 'diva_pipeline_runtime'
    WHERE EXISTS (
          SELECT 1
          FROM sync_state
          WHERE key = 'diva_stateful_maintenance_gate'
            AND value = :'token'
      )
    HAVING count(*) > 0
       AND bool_and(role.rolcanlogin)
       AND bool_and(role.rolname ~ '^diva_pipeline_login_[a-z0-9][a-z0-9_]*$')
       AND bool_and(NOT role.rolsuper AND NOT role.rolreplication AND NOT role.rolbypassrls)
       AND count(*) = (
           SELECT count(*)
           FROM pg_roles AS effective_role
           WHERE effective_role.rolcanlogin
             AND NOT effective_role.rolsuper
             AND pg_has_role(
                 effective_role.oid, 'diva_pipeline_runtime', 'MEMBER'
             )
       )
    ON CONFLICT DO NOTHING
    RETURNING value
)
SELECT COALESCE((SELECT value FROM inserted_roles), '') AS roles_json
\gset
SELECT CASE
    WHEN :'gate_value' = :'token' AND :'roles_json' <> '' THEN 'true'
    ELSE 'false'
END AS gate_armed
\gset
\if :gate_armed
SELECT format('ALTER ROLE %I NOLOGIN;', listed.role_name)
FROM jsonb_array_elements_text(:'roles_json'::jsonb) AS listed(role_name)
ORDER BY listed.role_name
\gexec
SELECT CASE WHEN
    NOT EXISTS (
        SELECT 1
        FROM pg_roles AS role
        WHERE role.rolcanlogin
          AND NOT role.rolsuper
          AND pg_has_role(role.oid, 'diva_pipeline_runtime', 'MEMBER')
    )
    AND NOT EXISTS (
        SELECT 1
        FROM pg_auth_members AS membership
        JOIN pg_roles AS role ON role.oid = membership.member
        JOIN pg_roles AS parent_role
          ON parent_role.oid = membership.roleid
         AND parent_role.rolname = 'diva_pipeline_runtime'
        WHERE NOT (:'roles_json'::jsonb ? role.rolname)
    )
    AND (
        SELECT count(*)
        FROM pg_auth_members AS membership
        JOIN pg_roles AS parent_role
          ON parent_role.oid = membership.roleid
         AND parent_role.rolname = 'diva_pipeline_runtime'
    ) = jsonb_array_length(:'roles_json'::jsonb)
    AND NOT EXISTS (
        SELECT 1
        FROM pg_stat_activity AS activity
        JOIN pg_roles AS role ON role.rolname = activity.usename
        WHERE activity.pid <> pg_backend_pid()
          AND activity.backend_type = 'client backend'
          AND EXISTS (
              SELECT 1
              FROM pg_auth_members AS membership
              JOIN pg_roles AS parent_role ON parent_role.oid = membership.roleid
              WHERE membership.member = role.oid
                AND parent_role.rolname = 'diva_pipeline_runtime'
          )
    )
    THEN 'true' ELSE 'false' END AS lockdown_ok
\gset
\if :lockdown_ok
COMMIT;
SELECT :'token';
\else
ROLLBACK;
\endif
\else
ROLLBACK;
\endif
