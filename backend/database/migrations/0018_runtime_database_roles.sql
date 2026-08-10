-- Split runtime database access from the schema-owning migration role.
--
-- This migration deliberately creates only NOLOGIN privilege roles.  LOGIN
-- roles and their passwords are provisioned out-of-band so credentials never
-- become part of the repository or schema history.
BEGIN;

DO $roles$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diva_api_runtime') THEN
        CREATE ROLE diva_api_runtime;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diva_pipeline_runtime') THEN
        CREATE ROLE diva_pipeline_runtime;
    END IF;
END;
$roles$;

-- Keep the privilege roles inert even if an earlier manual setup created a
-- role with one of these names and unsafe attributes.
ALTER ROLE diva_api_runtime
    WITH NOLOGIN NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE
         NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD NULL;
ALTER ROLE diva_pipeline_runtime
    WITH NOLOGIN NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE
         NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD NULL;

-- A colliding pre-existing role must not retain owner powers, which ordinary
-- REVOKE cannot remove.  Existing children are permitted only when they match
-- this deployment's versioned, unprivileged LOGIN-role convention; this also
-- allows the old and new generations to overlap during a rolling rotation.
DO $role_preflight$
DECLARE
    api_role_oid OID := (SELECT oid FROM pg_roles WHERE rolname = 'diva_api_runtime');
    pipeline_role_oid OID := (SELECT oid FROM pg_roles WHERE rolname = 'diva_pipeline_runtime');
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_database
        WHERE datdba IN (api_role_oid, pipeline_role_oid)
    ) OR EXISTS (
        SELECT 1 FROM pg_namespace
        WHERE nspname <> 'information_schema'
          AND nspname !~ '^pg_'
          AND nspowner IN (api_role_oid, pipeline_role_oid)
    ) OR EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND relation.relowner IN (api_role_oid, pipeline_role_oid)
    ) OR EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND procedure.proowner IN (api_role_oid, pipeline_role_oid)
    ) OR EXISTS (
        SELECT 1
        FROM pg_type database_type
        JOIN pg_namespace namespace ON namespace.oid = database_type.typnamespace
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND database_type.typowner IN (api_role_oid, pipeline_role_oid)
    ) OR EXISTS (
        SELECT 1 FROM pg_extension
        WHERE extowner IN (api_role_oid, pipeline_role_oid)
    ) THEN
        RAISE EXCEPTION 'runtime privilege role owns a database/schema/object; resolve the role-name collision first';
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
END;
$role_preflight$;

-- A runtime role must never acquire privileges transitively from another
-- group.  LOGIN roles are members of these roles, not the other way around.
DO $memberships$
DECLARE
    membership RECORD;
BEGIN
    FOR membership IN
        SELECT parent.rolname AS parent_name, member.rolname AS member_name
        FROM pg_auth_members auth
        JOIN pg_roles parent ON parent.oid = auth.roleid
        JOIN pg_roles member ON member.oid = auth.member
        WHERE member.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    LOOP
        EXECUTE format(
            'REVOKE %I FROM %I',
            membership.parent_name,
            membership.member_name
        );
    END LOOP;
END;
$memberships$;

-- PostgreSQL grants CREATE on public to PUBLIC on older/upgraded databases.
-- Runtime DDL must remain the responsibility of the schema/migration owner.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM diva_api_runtime, diva_pipeline_runtime;
GRANT USAGE ON SCHEMA public TO diva_api_runtime, diva_pipeline_runtime;

-- The PG16 runtime roles cannot be granted VACUUM independently of ownership
-- (the MAINTAIN privilege is only available in PG17+).  Keep the high-churn
-- external-view columns healthy through targeted autovacuum instead of making
-- the pipeline an owner/superuser or relying on an application-side VACUUM.
ALTER TABLE public.songs SET (
    autovacuum_vacuum_scale_factor = 0.01,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_scale_factor = 0.005,
    autovacuum_analyze_threshold = 500
);

-- Remove accidental broad grants before installing the exact contract.  This
-- also makes re-applying the migration converge to the same privilege set.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
    FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;

-- API: read the complete public data model and write only the two upstream
-- playlist response caches used by DbService's ON CONFLICT upserts.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO diva_api_runtime;
GRANT INSERT, UPDATE ON TABLE
    public.youtube_playlist_cache,
    public.nico_playlist_cache
TO diva_api_runtime;

-- Pipeline: maintain application data.  The only active bulk-replacement path
-- is the Markov rebuild, so its stronger TRUNCATE right stays table-scoped.
-- REFERENCES/TRIGGER and every schema-level DDL right remain unavailable.
GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public
    TO diva_pipeline_runtime;
GRANT TRUNCATE ON TABLE public.markov_transitions TO diva_pipeline_runtime;

-- Migration history and the discovery-quality policy are control-plane state,
-- not pipeline output.  The pipeline reads both, but only the migration owner
-- may change policy values.  The trigger's SELECT ... FOR SHARE additionally
-- requires some UPDATE privilege, so expose only the CHECK-constrained
-- singleton key; changing it away from TRUE is impossible and policy values
-- remain non-writable.  schema_migrations is created by migrate.sh before this
-- migration in production; keep the migration directly runnable in tests too.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
    ON TABLE public.discovery_quality_model_policy
    FROM diva_pipeline_runtime;
GRANT UPDATE (singleton)
    ON TABLE public.discovery_quality_model_policy
    TO diva_pipeline_runtime;
DO $migration_history_privileges$
BEGIN
    IF to_regclass('public.schema_migrations') IS NOT NULL THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE
            ON TABLE public.schema_migrations
            FROM diva_pipeline_runtime;
    END IF;
END;
$migration_history_privileges$;

GRANT USAGE
    ON ALL SEQUENCES IN SCHEMA public
    TO diva_pipeline_runtime;

-- Trigger functions run as the calling role and intentionally are not
-- SECURITY DEFINER.  The pipeline gets the explicit EXECUTE capability needed
-- for its guarded quality writes; the trigger return type prevents ordinary
-- direct invocation.
REVOKE EXECUTE ON FUNCTION public.enforce_discovery_quality_policy_revision()
    FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;
REVOKE EXECUTE ON FUNCTION public.enforce_discovery_quality_model_version()
    FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;
GRANT EXECUTE ON FUNCTION public.enforce_discovery_quality_policy_revision()
    TO diva_pipeline_runtime;
GRANT EXECUTE ON FUNCTION public.enforce_discovery_quality_model_version()
    TO diva_pipeline_runtime;

-- Future objects created by this migration/schema owner inherit the same
-- baseline.  A future API-writable table still requires an explicit migration,
-- preventing an unrelated table from silently becoming writable by the API.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO diva_api_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO diva_pipeline_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE ON SEQUENCES TO diva_pipeline_runtime;

-- PostgreSQL's default is EXECUTE TO PUBLIC for new functions.  Runtime code
-- currently invokes no public-schema function directly; future functions must
-- therefore opt in explicitly if that ever changes.
-- Function default EXECUTE is a global default in PostgreSQL; a schema-local
-- REVOKE cannot override it.  This applies to future functions created by the
-- current migration owner in every schema.
ALTER DEFAULT PRIVILEGES
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- CONNECT is made explicit so a later database-wide PUBLIC hardening does not
-- disconnect either service role.  Full Markov publication stages cluster
-- assignments in a PostgreSQL temporary table; grant that database-scoped
-- capability only to the pipeline and remove the default PUBLIC grant.
DO $database_grants$
BEGIN
    EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO diva_api_runtime, diva_pipeline_runtime',
        current_database()
    );
    EXECUTE format(
        'REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC, diva_api_runtime',
        current_database()
    );
    EXECUTE format(
        'GRANT TEMPORARY ON DATABASE %I TO diva_pipeline_runtime',
        current_database()
    );
END;
$database_grants$;

COMMIT;
