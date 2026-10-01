\set roles_json ''
\set released ''
BEGIN;
LOCK TABLE pg_catalog.pg_auth_members IN SHARE MODE;
LOCK TABLE pg_catalog.pg_authid IN SHARE MODE;
WITH locks AS MATERIALIZED (
    SELECT
        pg_try_advisory_xact_lock(hashtext('diva-data-pipeline-publication-v1')) AS pipeline,
        pg_try_advisory_xact_lock(hashtext('diva-data-pipeline-child-v1')) AS child,
        pg_try_advisory_xact_lock(hashtextextended('diva-recommendation-publication-v1', 0)) AS publication
), gate AS MATERIALIZED (
    SELECT value AS token
    FROM sync_state
    WHERE key = 'diva_stateful_maintenance_gate'
), manifest AS MATERIALIZED (
    SELECT value::jsonb AS roles
    FROM sync_state
    WHERE key = 'diva_stateful_maintenance_login_roles'
)
SELECT CASE WHEN
    (SELECT token FROM gate) = :'token'
    AND (SELECT pipeline AND child AND publication FROM locks)
    AND jsonb_typeof((SELECT roles FROM manifest)) = 'array'
    AND jsonb_array_length((SELECT roles FROM manifest)) > 0
    AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text((SELECT roles FROM manifest)) AS listed(role_name)
        LEFT JOIN pg_roles AS role ON role.rolname = listed.role_name
        LEFT JOIN pg_auth_members AS membership ON membership.member = role.oid
        LEFT JOIN pg_roles AS parent_role
          ON parent_role.oid = membership.roleid
         AND parent_role.rolname = 'diva_pipeline_runtime'
        WHERE role.oid IS NULL
           OR role.rolcanlogin
           OR role.rolsuper
           OR role.rolreplication
           OR role.rolbypassrls
           OR parent_role.oid IS NULL
           OR role.rolname !~ '^diva_pipeline_login_[a-z0-9][a-z0-9_]*$'
    )
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
    AND NOT EXISTS (
        SELECT 1
        FROM pg_roles AS role
        WHERE role.rolcanlogin
          AND NOT role.rolsuper
          AND pg_has_role(role.oid, 'diva_pipeline_runtime', 'MEMBER')
    )
    AND (
        SELECT count(*)
        FROM pg_auth_members AS membership
        JOIN pg_roles AS parent_role
          ON parent_role.oid = membership.roleid
         AND parent_role.rolname = 'diva_pipeline_runtime'
    ) = jsonb_array_length((SELECT roles FROM manifest))
    AND NOT EXISTS (
        SELECT 1
        FROM pg_auth_members AS membership
        JOIN pg_roles AS role ON role.oid = membership.member
        JOIN pg_roles AS parent_role
          ON parent_role.oid = membership.roleid
         AND parent_role.rolname = 'diva_pipeline_runtime'
        WHERE NOT ((SELECT roles FROM manifest) ? role.rolname)
    )
    THEN 'true' ELSE 'false' END AS gate_releasable,
    (SELECT roles::text FROM manifest) AS roles_json
\gset
\if :gate_releasable
SELECT format('ALTER ROLE %I LOGIN;', listed.role_name)
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
          AND NOT (:'roles_json'::jsonb ? role.rolname)
    )
    AND (
        SELECT count(*)
        FROM pg_roles AS role
        WHERE role.rolcanlogin
          AND NOT role.rolsuper
          AND pg_has_role(role.oid, 'diva_pipeline_runtime', 'MEMBER')
    ) = jsonb_array_length(:'roles_json'::jsonb)
    AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(:'roles_json'::jsonb) AS listed(role_name)
        LEFT JOIN pg_roles AS role ON role.rolname = listed.role_name
        LEFT JOIN pg_auth_members AS membership ON membership.member = role.oid
        LEFT JOIN pg_roles AS parent_role
          ON parent_role.oid = membership.roleid
         AND parent_role.rolname = 'diva_pipeline_runtime'
        WHERE role.oid IS NULL OR NOT role.rolcanlogin OR parent_role.oid IS NULL
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
        FROM pg_auth_members AS membership
        JOIN pg_roles AS role ON role.oid = membership.member
        JOIN pg_roles AS parent_role
          ON parent_role.oid = membership.roleid
         AND parent_role.rolname = 'diva_pipeline_runtime'
        WHERE NOT (:'roles_json'::jsonb ? role.rolname)
    )
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
    THEN 'true' ELSE 'false' END AS released_roles_ok
\gset
\if :released_roles_ok
DELETE FROM sync_state
WHERE key = 'diva_stateful_maintenance_login_roles';
WITH deleted_gate AS (
    DELETE FROM sync_state
    WHERE key = 'diva_stateful_maintenance_gate'
      AND value = :'token'
    RETURNING value
)
SELECT COALESCE((SELECT value FROM deleted_gate), '') AS released
/* diva-writer-gate-release */
\gset
COMMIT;
SELECT :'released';
\else
ROLLBACK;
\endif
\else
ROLLBACK;
\endif
