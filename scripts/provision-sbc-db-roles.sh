#!/usr/bin/env bash

# Expand/contract PostgreSQL LOGIN roles without changing a password under a
# live A/B connection pool.  Passwords travel to psql over stdin and are never
# placed in argv, inherited by docker, or written to output.
set +x
set -Eeuo pipefail

DB_CONTAINER="${DIVA_DB_CONTAINER:-vocadb_postgres}"
ADMIN_USER="${DIVA_DB_ADMIN_USER:-vocadb}"
DATABASE_NAME="${DIVA_DB_NAME:-vocadb_recommender}"

usage() {
    cat >&2 <<'USAGE'
Usage:
  provision-sbc-db-roles.sh create
  provision-sbc-db-roles.sh decommission <api|pipeline> <old-versioned-role>
  provision-sbc-db-roles.sh rotate-admin

create requires new, never-before-used versioned role names:
  DIVA_DB_API_LOGIN_ROLE=diva_api_login_<version>
  DIVA_DB_PIPELINE_LOGIN_ROLE=diva_pipeline_login_<version>
and each corresponding DIVA_DB_*_PASSWORD or DIVA_DB_*_PASSWORD_FILE.

decommission requires:
  DIVA_DB_REPLACEMENT_LOGIN_ROLE=<verified replacement role>
  DIVA_DB_DECOMMISSION_CONFIRM=<old-versioned-role>

rotate-admin requires:
  DIVA_DB_ADMIN_ROTATE_CONFIRM=<exact DIVA_DB_ADMIN_USER value>
  DIVA_DB_ADMIN_NEW_PASSWORD or DIVA_DB_ADMIN_NEW_PASSWORD_FILE
USAGE
    exit 2
}

die() {
    printf 'ERROR: %s\n' "$1" >&2
    exit 1
}

validate_identifier() {
    local label="$1"
    local value="$2"
    [[ "$value" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] \
        || die "$label must be a lowercase PostgreSQL identifier (maximum 63 characters)"
}

validate_versioned_role() {
    local kind="$1"
    local label="$2"
    local value="$3"
    local expected_pattern

    validate_identifier "$label" "$value"
    case "$kind" in
        api) expected_pattern='^diva_api_login_[a-z0-9][a-z0-9_]*$' ;;
        pipeline) expected_pattern='^diva_pipeline_login_[a-z0-9][a-z0-9_]*$' ;;
        *) die "unknown runtime kind: $kind" ;;
    esac

    [[ "$value" =~ $expected_pattern ]] \
        || die "$label must use the versioned diva_${kind}_login_<version> form"
}

read_secret() {
    local value_var="$1"
    local file_var="$2"
    local default_file="$3"
    local secret_value="${!value_var-}"
    local configured_file="${!file_var-}"
    local secret_file="${configured_file:-$default_file}"

    if [[ -n "$secret_value" && -n "$configured_file" ]]; then
        die "set only one of $value_var or $file_var"
    fi

    if [[ -z "$secret_value" ]]; then
        [[ -r "$secret_file" ]] \
            || die "$value_var is unset and secret file is not readable: $secret_file"

        if [[ "$(uname -s)" == "Linux" ]]; then
            local file_mode
            local file_owner_uid
            local current_uid
            [[ -f "$secret_file" && ! -L "$secret_file" ]] \
                || die "$secret_file must be a regular, non-symlink file"
            file_mode="$(stat -c '%a' -- "$secret_file")"
            file_owner_uid="$(stat -c '%u' -- "$secret_file")"
            current_uid="$(id -u)"
            [[ "$file_owner_uid" == "$current_uid" ]] \
                || die "$secret_file must be owned by the current user"
            (( (8#$file_mode & 077) == 0 )) \
                || die "$secret_file must not be readable or writable by group/other"
        fi

        secret_value="$(<"$secret_file")"
    fi

    [[ -n "$secret_value" ]] || die "$value_var must not be empty"
    [[ ${#secret_value} -ge 24 ]] || die "$value_var must contain at least 24 characters"
    [[ "$secret_value" != *$'\n'* && "$secret_value" != *$'\r'* ]] \
        || die "$value_var must be a single line"

    printf '%s' "$secret_value"
}

csv_field() {
    local value="${1//\"/\"\"}"
    printf '"%s"' "$value"
}

container_psql() {
    # Use the fixed database container directly. This intentionally avoids
    # evaluating the new Compose file before its required API secrets exist,
    # which keeps first-time expand/contract provisioning bootstrap-safe.
    docker exec -i "$DB_CONTAINER" \
        psql --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
        --username "$ADMIN_USER" --dbname "$DATABASE_NAME" "$@"
}

verify_admin_tcp_password() {
    # The password is the only stdin payload.  The in-container shell keeps it
    # out of argv and the environment, writes a mode-0600 libpq passfile, and
    # removes that file on every shell exit or catchable termination signal.
    docker exec -i "$DB_CONTAINER" sh -ceu '
        umask 077
        admin_user="$1"
        database_name="$2"
        password=""
        passfile=""
        cleanup() {
            unset password escaped_password verified_identity
            if [ -n "$passfile" ]; then
                rm -f -- "$passfile"
            fi
            unset passfile
        }
        trap cleanup EXIT
        trap "exit 129" HUP
        trap "exit 130" INT
        trap "exit 143" TERM

        unset PGPASSWORD POSTGRES_PASSWORD
        IFS= read -r password || [ -n "$password" ]
        [ -n "$password" ]
        passfile="$(mktemp "/tmp/diva-admin-verify.XXXXXX.pgpass")"
        chmod 600 "$passfile"
        [ "$(stat -c "%a" "$passfile")" = "600" ]

        escaped_password="$(printf "%s" "$password" | sed -e "s/\\\\/\\\\\\\\/g" -e "s/:/\\\\:/g")"
        printf "127.0.0.1:5432:%s:%s:%s\n" \
            "$database_name" "$admin_user" "$escaped_password" >"$passfile"
        unset password escaped_password

        verified_identity="$(
            PGPASSFILE="$passfile" PGCONNECT_TIMEOUT=5 \
                psql --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
                    --tuples-only --no-align \
                    --host=127.0.0.1 --port=5432 \
                    --username="$admin_user" --dbname="$database_name" \
                    --command="SELECT current_user || chr(58) || pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database();"
        )"
        [ "$verified_identity" = "$admin_user:$admin_user" ]
    ' diva-admin-password-verifier "$ADMIN_USER" "$DATABASE_NAME"
}

rotate_admin_password() {
    local confirmation="${DIVA_DB_ADMIN_ROTATE_CONFIRM:-}"
    local new_password

    [[ "$confirmation" == "$ADMIN_USER" ]] \
        || die 'DIVA_DB_ADMIN_ROTATE_CONFIRM must exactly match DIVA_DB_ADMIN_USER'

    new_password="$(read_secret \
        DIVA_DB_ADMIN_NEW_PASSWORD \
        DIVA_DB_ADMIN_NEW_PASSWORD_FILE \
        /etc/diva-player/secrets/postgres-admin-password.next)"

    # Do not let any caller-supplied database password reach docker through its
    # inherited environment.  The new value remains a non-exported shell local.
    unset DIVA_DB_ADMIN_NEW_PASSWORD DIVA_DB_ADMIN_PASSWORD \
        DIVA_DB_API_PASSWORD DIVA_DB_PIPELINE_PASSWORD \
        PGPASSWORD POSTGRES_PASSWORD
    trap 'unset new_password' RETURN

    {
        cat <<'SQL_HEADER'
\set ON_ERROR_STOP on
\set VERBOSITY terse
BEGIN;
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
SET LOCAL log_error_verbosity = 'terse';
SET LOCAL password_encryption = 'scram-sha-256';
CREATE TEMP TABLE _diva_admin_rotation (
    admin_role name NOT NULL,
    password text NOT NULL
) ON COMMIT DROP;
COPY _diva_admin_rotation (admin_role, password)
FROM STDIN WITH (FORMAT csv);
SQL_HEADER
        csv_field "$ADMIN_USER"
        printf ','
        csv_field "$new_password"
        printf '\n'
        cat <<'SQL_BODY'
\.
DO $rotate_admin_password$
DECLARE
    rotation RECORD;
BEGIN
    SELECT * INTO STRICT rotation FROM _diva_admin_rotation;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = rotation.admin_role
          AND rolcanlogin
          AND rolsuper
    ) THEN
        RAISE EXCEPTION 'target admin role is missing, NOLOGIN, or not a superuser';
    END IF;

    IF current_user <> rotation.admin_role THEN
        RAISE EXCEPTION 'connected database user does not match the target admin role';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_database
        WHERE datname = current_database()
          AND datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    ) THEN
        RAISE EXCEPTION 'target admin role is not the current database owner';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE usename = rotation.admin_role
          AND backend_type = 'client backend'
          AND pid <> pg_backend_pid()
    ) THEN
        RAISE EXCEPTION 'target admin role still has another client session; migrate and drain runtime pools before rotation';
    END IF;

    EXECUTE format(
        'ALTER ROLE %I WITH LOGIN PASSWORD %L',
        rotation.admin_role,
        rotation.password
    );
END;
$rotate_admin_password$;
COMMIT;
SQL_BODY
    } | container_psql

    if ! printf '%s' "$new_password" | verify_admin_tcp_password; then
        die 'admin password was committed, but the independent TCP login verification failed; retain the new secret and investigate authentication configuration'
    fi

    unset new_password
    printf 'Rotated and verified database administrator password for role: %s\n' \
        "$ADMIN_USER"
}

create_roles() {
    local api_login_role="${DIVA_DB_API_LOGIN_ROLE:-}"
    local pipeline_login_role="${DIVA_DB_PIPELINE_LOGIN_ROLE:-}"
    local api_password
    local pipeline_password

    [[ -n "$api_login_role" ]] || die 'DIVA_DB_API_LOGIN_ROLE is required'
    [[ -n "$pipeline_login_role" ]] || die 'DIVA_DB_PIPELINE_LOGIN_ROLE is required'
    validate_versioned_role api DIVA_DB_API_LOGIN_ROLE "$api_login_role"
    validate_versioned_role pipeline DIVA_DB_PIPELINE_LOGIN_ROLE "$pipeline_login_role"

    api_password="$(read_secret \
        DIVA_DB_API_PASSWORD \
        DIVA_DB_API_PASSWORD_FILE \
        /etc/diva-player/secrets/postgres-api-password)"
    pipeline_password="$(read_secret \
        DIVA_DB_PIPELINE_PASSWORD \
        DIVA_DB_PIPELINE_PASSWORD_FILE \
        /etc/diva-player/secrets/postgres-pipeline-password)"

    # Environment-based input is supported for secret managers, but neither
    # docker nor Compose interpolation may inherit the plaintext values.
    unset DIVA_DB_API_PASSWORD DIVA_DB_PIPELINE_PASSWORD
    trap 'unset api_password pipeline_password' RETURN

    {
        cat <<'SQL_HEADER'
\set ON_ERROR_STOP on
\set VERBOSITY terse
BEGIN;
-- CREATE ROLE requires an administrator.  These local settings ensure even a
-- verbose PostgreSQL installation cannot log password-bearing dynamic SQL.
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
SET LOCAL log_error_verbosity = 'terse';
SET LOCAL password_encryption = 'scram-sha-256';
CREATE TEMP TABLE _diva_login_secrets (
    login_role name NOT NULL,
    password text NOT NULL,
    privilege_role name NOT NULL
) ON COMMIT DROP;
COPY _diva_login_secrets (login_role, password, privilege_role)
FROM STDIN WITH (FORMAT csv);
SQL_HEADER

        csv_field "$api_login_role"
        printf ','
        csv_field "$api_password"
        printf ',"diva_api_runtime"\n'
        csv_field "$pipeline_login_role"
        printf ','
        csv_field "$pipeline_password"
        printf ',"diva_pipeline_runtime"\n'

        cat <<'SQL_BODY'
\.

DO $create_versioned_roles$
DECLARE
    role_spec RECORD;
    runtime_role RECORD;
BEGIN
    FOR runtime_role IN
        SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
               rolreplication, rolbypassrls
        FROM pg_roles
        WHERE rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    LOOP
        IF runtime_role.rolcanlogin
            OR runtime_role.rolsuper
            OR runtime_role.rolcreatedb
            OR runtime_role.rolcreaterole
            OR runtime_role.rolreplication
            OR runtime_role.rolbypassrls THEN
            RAISE EXCEPTION 'unsafe privilege role attributes for %; apply migration 0018 first',
                runtime_role.rolname;
        END IF;
    END LOOP;

    IF (SELECT count(*) FROM pg_roles
        WHERE rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')) <> 2 THEN
        RAISE EXCEPTION 'runtime privilege roles are missing; apply migration 0018 first';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_database database
        JOIN pg_roles owner ON owner.oid = database.datdba
        WHERE owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) OR EXISTS (
        SELECT 1 FROM pg_namespace namespace
        JOIN pg_roles owner ON owner.oid = namespace.nspowner
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) OR EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_roles owner ON owner.oid = relation.relowner
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) OR EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        JOIN pg_roles owner ON owner.oid = procedure.proowner
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) OR EXISTS (
        SELECT 1
        FROM pg_type database_type
        JOIN pg_namespace namespace ON namespace.oid = database_type.typnamespace
        JOIN pg_roles owner ON owner.oid = database_type.typowner
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) OR EXISTS (
        SELECT 1
        FROM pg_extension extension
        JOIN pg_roles owner ON owner.oid = extension.extowner
        WHERE owner.rolname IN ('diva_api_runtime', 'diva_pipeline_runtime')
    ) THEN
        RAISE EXCEPTION 'runtime privilege role owns a database/schema/object';
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

    FOR role_spec IN
        SELECT login_role, password, privilege_role
        FROM _diva_login_secrets
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_spec.login_role) THEN
            RAISE EXCEPTION
                'LOGIN role % already exists; in-place password rotation is forbidden, use a new versioned role name',
                role_spec.login_role;
        END IF;

        EXECUTE format(
            'CREATE ROLE %I WITH LOGIN NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL %L PASSWORD %L',
            role_spec.login_role,
            'infinity',
            role_spec.password
        );
        EXECUTE format(
            'GRANT %I TO %I WITH INHERIT TRUE, SET FALSE',
            role_spec.privilege_role,
            role_spec.login_role
        );
        EXECUTE format(
            'ALTER ROLE %I SET search_path TO pg_catalog, public',
            role_spec.login_role
        );
    END LOOP;
END;
$create_versioned_roles$;

COMMIT;
SQL_BODY
    } | container_psql

    printf 'Created versioned database LOGIN roles: %s, %s\n' \
        "$api_login_role" "$pipeline_login_role"
}

active_session_count() {
    local role_name="$1"
    printf "SELECT count(*) FROM pg_stat_activity WHERE usename = :'target_role';\n" \
        | container_psql --tuples-only --no-align --set="target_role=$role_name"
}

decommission_role() {
    local kind="${1:-}"
    local old_role="${2:-}"
    local replacement_role="${DIVA_DB_REPLACEMENT_LOGIN_ROLE:-}"
    local confirmation="${DIVA_DB_DECOMMISSION_CONFIRM:-}"
    local wait_seconds="${DIVA_DB_DECOMMISSION_WAIT_SECONDS:-30}"
    local privilege_role
    local active_count
    local elapsed=0

    [[ "$kind" == 'api' || "$kind" == 'pipeline' ]] || usage
    [[ -n "$old_role" ]] || usage
    [[ -n "$replacement_role" ]] || die 'DIVA_DB_REPLACEMENT_LOGIN_ROLE is required'
    validate_versioned_role "$kind" old-versioned-role "$old_role"
    validate_versioned_role "$kind" DIVA_DB_REPLACEMENT_LOGIN_ROLE "$replacement_role"
    [[ "$old_role" != "$replacement_role" ]] || die 'replacement role must differ from old role'
    [[ "$confirmation" == "$old_role" ]] \
        || die 'DIVA_DB_DECOMMISSION_CONFIRM must exactly match the old role name'
    [[ "$wait_seconds" =~ ^[0-9]+$ && "$wait_seconds" -le 60 ]] \
        || die 'DIVA_DB_DECOMMISSION_WAIT_SECONDS must be an integer from 0 through 60'

    case "$kind" in
        api) privilege_role='diva_api_runtime' ;;
        pipeline) privilege_role='diva_pipeline_runtime' ;;
    esac

    # No password is needed for contraction, and stale caller environment must
    # still not reach docker/Compose.
    unset DIVA_DB_API_PASSWORD DIVA_DB_PIPELINE_PASSWORD

    {
        cat <<'SQL_HEADER'
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE _diva_role_contraction (
    old_role name NOT NULL,
    replacement_role name NOT NULL,
    privilege_role name NOT NULL
) ON COMMIT DROP;
COPY _diva_role_contraction (old_role, replacement_role, privilege_role)
FROM STDIN WITH (FORMAT csv);
SQL_HEADER
        csv_field "$old_role"
        printf ','
        csv_field "$replacement_role"
        printf ','
        csv_field "$privilege_role"
        printf '\n'
        cat <<'SQL_BODY'
\.
DO $disable_old_role$
DECLARE
    role_spec RECORD;
BEGIN
    SELECT * INTO STRICT role_spec FROM _diva_role_contraction;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles old_login
        JOIN pg_auth_members membership ON membership.member = old_login.oid
        JOIN pg_roles parent ON parent.oid = membership.roleid
        WHERE old_login.rolname = role_spec.old_role
          AND NOT old_login.rolsuper
          AND old_login.rolinherit
          AND NOT old_login.rolcreatedb
          AND NOT old_login.rolcreaterole
          AND NOT old_login.rolreplication
          AND NOT old_login.rolbypassrls
          AND parent.rolname = role_spec.privilege_role
          AND NOT membership.admin_option
          AND membership.inherit_option
          AND NOT membership.set_option
          AND NOT EXISTS (
              SELECT 1
              FROM pg_auth_members other_membership
              JOIN pg_roles other_parent ON other_parent.oid = other_membership.roleid
              WHERE other_membership.member = old_login.oid
                AND other_parent.rolname <> role_spec.privilege_role
          )
    ) THEN
        RAISE EXCEPTION 'old role % is missing, overprivileged, or has the wrong privilege role',
            role_spec.old_role;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles replacement
        JOIN pg_auth_members membership ON membership.member = replacement.oid
        JOIN pg_roles parent ON parent.oid = membership.roleid
        WHERE replacement.rolname = role_spec.replacement_role
          AND replacement.rolcanlogin
          AND replacement.rolinherit
          AND NOT replacement.rolsuper
          AND NOT replacement.rolcreatedb
          AND NOT replacement.rolcreaterole
          AND NOT replacement.rolreplication
          AND NOT replacement.rolbypassrls
          AND parent.rolname = role_spec.privilege_role
          AND NOT membership.admin_option
          AND membership.inherit_option
          AND NOT membership.set_option
          AND NOT EXISTS (
              SELECT 1
              FROM pg_auth_members other_membership
              JOIN pg_roles other_parent ON other_parent.oid = other_membership.roleid
              WHERE other_membership.member = replacement.oid
                AND other_parent.rolname <> role_spec.privilege_role
          )
    ) THEN
        RAISE EXCEPTION 'verified replacement role % is missing or has the wrong privilege role',
            role_spec.replacement_role;
    END IF;

    EXECUTE format('ALTER ROLE %I NOLOGIN', role_spec.old_role);
END;
$disable_old_role$;
COMMIT;
SQL_BODY
    } | container_psql

    while true; do
        active_count="$(active_session_count "$old_role")"
        active_count="${active_count//[[:space:]]/}"
        [[ "$active_count" =~ ^[0-9]+$ ]] \
            || die "could not determine active session count for $old_role"
        [[ "$active_count" == '0' ]] && break
        if (( elapsed >= wait_seconds )); then
            die "$old_role is NOLOGIN but still has $active_count active session(s); drain them and rerun decommission"
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done

    {
        cat <<'SQL_HEADER'
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE _diva_role_contraction (
    old_role name NOT NULL,
    privilege_role name NOT NULL
) ON COMMIT DROP;
COPY _diva_role_contraction (old_role, privilege_role)
FROM STDIN WITH (FORMAT csv);
SQL_HEADER
        csv_field "$old_role"
        printf ','
        csv_field "$privilege_role"
        printf '\n'
        cat <<'SQL_BODY'
\.
DO $drop_old_role$
DECLARE
    role_spec RECORD;
BEGIN
    SELECT * INTO STRICT role_spec FROM _diva_role_contraction;

    IF EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE usename = role_spec.old_role
    ) THEN
        RAISE EXCEPTION 'old role % acquired an active session during contraction',
            role_spec.old_role;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_spec.old_role) THEN
        EXECUTE format(
            'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
            role_spec.old_role
        );
        EXECUTE format(
            'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
            role_spec.old_role
        );
        EXECUTE format(
            'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I',
            role_spec.old_role
        );
        EXECUTE format(
            'REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I',
            role_spec.old_role
        );
        EXECUTE format(
            'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',
            current_database(),
            role_spec.old_role
        );
        EXECUTE format(
            'REVOKE diva_api_runtime, diva_pipeline_runtime FROM %I',
            role_spec.old_role
        );
        EXECUTE format('ALTER ROLE %I RESET ALL', role_spec.old_role);
        EXECUTE format('DROP ROLE %I', role_spec.old_role);
    END IF;
END;
$drop_old_role$;
COMMIT;
SQL_BODY
    } | container_psql

    printf 'Decommissioned database LOGIN role: %s (replacement: %s)\n' \
        "$old_role" "$replacement_role"
}

validate_identifier DIVA_DB_ADMIN_USER "$ADMIN_USER"
validate_identifier DIVA_DB_NAME "$DATABASE_NAME"
[[ "$DB_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
    || die "DIVA_DB_CONTAINER contains unsupported characters"

command="${1:-}"
case "$command" in
    create)
        [[ $# -eq 1 ]] || usage
        create_roles
        ;;
    decommission)
        [[ $# -eq 3 ]] || usage
        decommission_role "$2" "$3"
        ;;
    rotate-admin)
        [[ $# -eq 1 ]] || usage
        rotate_admin_password
        ;;
    *) usage ;;
esac
