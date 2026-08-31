-- Keep migration-history state read-only to both runtime roles.  This is a
-- forward, idempotent reconciliation for databases where the reusable 0018
-- role migration was applied after schema_migration_attempts was introduced.
DO $runtime_role_migration_history_acl$
DECLARE
    runtime_role_name TEXT;
    relation_name TEXT;
    relation_oid REGCLASS;
    attempt_sequence_oid REGCLASS :=
        to_regclass('public.schema_migration_attempts_attempt_id_seq');
    privilege_name TEXT;
BEGIN
    FOREACH runtime_role_name IN ARRAY ARRAY[
        'diva_api_runtime',
        'diva_pipeline_runtime'
    ] LOOP
        CONTINUE WHEN NOT EXISTS (
            SELECT 1 FROM pg_roles WHERE rolname = runtime_role_name
        );

        FOREACH relation_name IN ARRAY ARRAY[
            'schema_migrations',
            'schema_migration_attempts'
        ] LOOP
            relation_oid := to_regclass('public.' || relation_name);
            CONTINUE WHEN relation_oid IS NULL;

            EXECUTE format(
                'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE %s FROM %I',
                relation_oid,
                runtime_role_name
            );

            FOREACH privilege_name IN ARRAY ARRAY[
                'INSERT',
                'UPDATE',
                'DELETE',
                'TRUNCATE'
            ] LOOP
                IF has_table_privilege(
                    runtime_role_name,
                    relation_oid,
                    privilege_name
                ) THEN
                    RAISE EXCEPTION
                        '% retains effective % on %',
                        runtime_role_name,
                        privilege_name,
                        relation_oid;
                END IF;
            END LOOP;
        END LOOP;

        IF attempt_sequence_oid IS NOT NULL THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM %I',
                attempt_sequence_oid,
                runtime_role_name
            );

            FOREACH privilege_name IN ARRAY ARRAY[
                'USAGE',
                'SELECT',
                'UPDATE'
            ] LOOP
                IF has_sequence_privilege(
                    runtime_role_name,
                    attempt_sequence_oid,
                    privilege_name
                ) THEN
                    RAISE EXCEPTION
                        '% retains effective % on %',
                        runtime_role_name,
                        privilege_name,
                        attempt_sequence_oid;
                END IF;
            END LOOP;
        END IF;
    END LOOP;
END;
$runtime_role_migration_history_acl$;
