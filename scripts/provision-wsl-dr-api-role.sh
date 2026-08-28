#!/usr/bin/env bash

# Reapply the canonical runtime privilege contract to a restored WSL database
# and provision the API LOGIN role without exposing its password in argv,
# process environments, or command output.
set +x
set -Eeuo pipefail

DATABASE_NAME="diva_standby"
ENV_FILE="/etc/diva-player-standby/backend.env"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
MIGRATION_FILE="$SCRIPT_DIR/../backend/database/migrations/0018_runtime_database_roles.sql"

die() {
    printf 'ERROR: %s\n' "$1" >&2
    exit 1
}

usage() {
    cat >&2 <<'USAGE'
Usage: provision-wsl-dr-api-role.sh [--database NAME] [--env-file PATH] [--migration-file PATH]
USAGE
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --database)
            [[ $# -ge 2 ]] || usage
            DATABASE_NAME="$2"
            shift 2
            ;;
        --env-file)
            [[ $# -ge 2 ]] || usage
            ENV_FILE="$2"
            shift 2
            ;;
        --migration-file)
            [[ $# -ge 2 ]] || usage
            MIGRATION_FILE="$2"
            shift 2
            ;;
        *) usage ;;
    esac
done

[[ "$(id -u)" == "0" ]] || die 'run as root inside the isolated WSL distribution'
[[ "$DATABASE_NAME" =~ ^diva_standby(_next_[0-9a-f]{8})?$ ]] \
    || die 'database name is outside the managed DR namespace'
[[ -f "$MIGRATION_FILE" && ! -L "$MIGRATION_FILE" ]] \
    || die 'runtime-role migration must be a real file'
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die 'backend environment file must be a real file'
[[ "$(stat -c '%U:%G' -- "$ENV_FILE")" == 'root:root' ]] \
    || die 'backend environment file must be owned by root:root'
env_mode="$(stat -c '%a' -- "$ENV_FILE")"
(( (8#$env_mode & 077) == 0 )) || die 'backend environment file must not be accessible by group/other'
unset env_mode

# Parse only the two required Compose-environment assignments. Never source
# this file: even a root-owned copy may have originated on another host, and
# treating it as shell code would turn a credential transfer into code
# execution as root.
unset DIVA_API_DB_USER DIVA_API_DB_PASSWORD PGPASSWORD POSTGRES_PASSWORD
exec {env_values_fd}< <(python3 - "$ENV_FILE" <<'PY'
import json
import re
import sys

path = sys.argv[1]
wanted = {"DIVA_API_DB_USER", "DIVA_API_DB_PASSWORD"}
values = {}

with open(path, encoding="utf-8") as handle:
    for line_number, original in enumerate(handle, 1):
        line = original.rstrip("\r\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)", line)
        if not match:
            continue
        key, raw = match.groups()
        if key not in wanted:
            continue
        if key in values:
            raise SystemExit(f"duplicate {key} in backend environment file")
        raw = raw.strip()
        if raw.startswith('"'):
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as error:
                raise SystemExit(f"invalid quoted {key} on line {line_number}") from error
        elif raw.startswith("'"):
            if len(raw) < 2 or not raw.endswith("'"):
                raise SystemExit(f"invalid quoted {key} on line {line_number}")
            value = raw[1:-1]
        else:
            value = re.split(r"[ \t]+#", raw, maxsplit=1)[0].rstrip()
        if "\x00" in value or "\n" in value or "\r" in value:
            raise SystemExit(f"invalid control character in {key}")
        values[key] = value

missing = wanted.difference(values)
if missing:
    raise SystemExit(f"missing required backend environment key: {sorted(missing)[0]}")
for key in ("DIVA_API_DB_USER", "DIVA_API_DB_PASSWORD"):
    sys.stdout.buffer.write(values[key].encode("utf-8") + b"\0")
sys.stdout.buffer.write(b"PARSE_OK\0")
PY
)
IFS= read -r -d '' api_login_role <&"$env_values_fd" \
    || die 'failed to parse DIVA_API_DB_USER from backend environment file'
IFS= read -r -d '' api_password <&"$env_values_fd" \
    || die 'failed to parse DIVA_API_DB_PASSWORD from backend environment file'
IFS= read -r -d '' parse_marker <&"$env_values_fd" \
    || die 'backend environment parser did not complete'
exec {env_values_fd}<&-
[[ "$parse_marker" == 'PARSE_OK' ]] || die 'backend environment parser returned an invalid marker'
unset parse_marker
trap 'unset api_password api_login_role' EXIT

[[ "$api_login_role" =~ ^diva_api_login_[a-z0-9][a-z0-9_]*$ ]] \
    || die 'DIVA_API_DB_USER must use the versioned diva_api_login_<version> form'
[[ ${#api_password} -ge 24 ]] || die 'DIVA_API_DB_PASSWORD must contain at least 24 characters'
[[ "$api_password" != *$'\n'* && "$api_password" != *$'\r'* ]] \
    || die 'DIVA_API_DB_PASSWORD must be a single line'

runuser -u postgres -- psql \
    --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
    --dbname "$DATABASE_NAME" --file "$MIGRATION_FILE"

csv_field() {
    local value="${1//\"/\"\"}"
    printf '"%s"' "$value"
}

{
    cat <<'SQL_HEADER'
\set ON_ERROR_STOP on
\set VERBOSITY terse
BEGIN;
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
SET LOCAL log_error_verbosity = 'terse';
SET LOCAL password_encryption = 'scram-sha-256';
CREATE TEMP TABLE _diva_dr_api_login (
    login_role name NOT NULL,
    password text NOT NULL
) ON COMMIT DROP;
COPY _diva_dr_api_login (login_role, password) FROM STDIN WITH (FORMAT csv);
SQL_HEADER
    csv_field "$api_login_role"
    printf ','
    csv_field "$api_password"
    printf '\n'
    cat <<'SQL_BODY'
\.
DO $provision_dr_api_login$
DECLARE
    role_spec RECORD;
    existing RECORD;
BEGIN
    SELECT * INTO STRICT role_spec FROM _diva_dr_api_login;
    SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
           rolreplication, rolbypassrls
      INTO existing
      FROM pg_roles
     WHERE rolname = role_spec.login_role;

    IF FOUND THEN
        IF NOT existing.rolcanlogin
            OR NOT existing.rolinherit
            OR existing.rolsuper
            OR existing.rolcreatedb
            OR existing.rolcreaterole
            OR existing.rolreplication
            OR existing.rolbypassrls THEN
            RAISE EXCEPTION 'existing API LOGIN role has unsafe attributes';
        END IF;
    ELSE
        EXECUTE format(
            'CREATE ROLE %I WITH LOGIN NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL %L PASSWORD %L',
            role_spec.login_role,
            'infinity',
            role_spec.password
        );
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_auth_members membership
          JOIN pg_roles parent ON parent.oid = membership.roleid
          JOIN pg_roles member ON member.oid = membership.member
         WHERE member.rolname = role_spec.login_role
           AND parent.rolname <> 'diva_api_runtime'
    ) THEN
        RAISE EXCEPTION 'API LOGIN role inherits an unexpected role';
    END IF;

    EXECUTE format(
        'GRANT diva_api_runtime TO %I WITH INHERIT TRUE, SET FALSE',
        role_spec.login_role
    );
    EXECUTE format(
        'ALTER ROLE %I SET search_path TO pg_catalog, public',
        role_spec.login_role
    );
END;
$provision_dr_api_login$;
COMMIT;
SQL_BODY
} | runuser -u postgres -- psql \
    --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --dbname "$DATABASE_NAME"

passfile="$(mktemp /tmp/diva-dr-api.XXXXXX.pgpass)"
cleanup_passfile() {
    rm -f -- "$passfile"
}
trap 'cleanup_passfile; unset api_password api_login_role' EXIT
chmod 600 "$passfile"
escaped_password="${api_password//\\/\\\\}"
escaped_password="${escaped_password//:/\\:}"
printf '127.0.0.1:5432:%s:%s:%s\n' \
    "$DATABASE_NAME" "$api_login_role" "$escaped_password" >"$passfile"
unset escaped_password api_password

contract="$({
    PGPASSFILE="$passfile" PGCONNECT_TIMEOUT=5 psql \
        --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
        --host=127.0.0.1 --port=5432 \
        --username="$api_login_role" --dbname="$DATABASE_NAME" <<'SQL'
SELECT concat_ws('|',
    current_user,
    has_table_privilege(current_user, 'public.songs', 'SELECT'),
    has_table_privilege(current_user, 'public.songs', 'UPDATE'),
    has_table_privilege(current_user, 'public.youtube_playlist_cache', 'INSERT'),
    has_table_privilege(current_user, 'public.nico_playlist_cache', 'UPDATE'),
    has_table_privilege(current_user, 'public.youtube_playlist_cache', 'DELETE'),
    has_schema_privilege(current_user, 'public', 'CREATE'),
    has_database_privilege(current_user, current_database(), 'TEMPORARY'),
    pg_has_role(current_user, 'diva_api_runtime', 'MEMBER')
);
SQL
} | tr -d '[:space:]')"

expected="$api_login_role|t|f|t|t|f|f|f|t"
[[ "$contract" == "$expected" ]] || die 'API LOGIN role failed the least-privilege TCP contract'
cleanup_passfile
trap 'unset api_password api_login_role' EXIT
printf 'PASS WSL DR API database role contract: %s on %s\n' \
    "$api_login_role" "$DATABASE_NAME"
