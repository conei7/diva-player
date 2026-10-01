#!/usr/bin/env bash
set +x
set -Eeuo pipefail
umask 077

POSTGRES_IMAGE='diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1'
DATABASE_NAME='vocadb_recommender'
POSTGRES_DATA_PATH='/var/lib/postgresql/data'
CURRENT_CONTAINER='vocadb_postgres'
STATE_ROOT='/var/lib/diva-player/postgres-restore'
ADMIN_PASSWORD_PATH='/run/secrets/postgres-password'

fail() { printf '[postgres-restore] ERROR: %s\n' "$1" >&2; exit 1; }
usage() {
    printf 'Usage: restore-sbc-postgres-isolated.sh --backup-directory <run-dir> --run-id <postgres-run-id>\n' >&2
    exit 2
}

backup_directory=''
run_id=''
resume_state=''
while (($#)); do
    case "$1" in
        --backup-directory) (($# >= 2)) || usage; backup_directory="$2"; shift 2 ;;
        --resume-state) (($# >= 2)) || usage; resume_state="$2"; shift 2 ;;
        --run-id) (($# >= 2)) || usage; run_id="$2"; shift 2 ;;
        *) usage ;;
    esac
done
if [[ -n "$resume_state" ]]; then
    [[ -z "$backup_directory" && -z "$run_id" ]] || usage
    exec bash "$(dirname -- "${BASH_SOURCE[0]}")/smoke-sbc-postgres-isolated-api.sh" --state-file "$resume_state"
fi
[[ -n "$backup_directory" && -n "$run_id" ]] || usage
[[ "$(id -u)" -eq 0 ]] || fail 'must run as root on the SBC'
[[ "$run_id" =~ ^postgres-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || fail 'backup run ID is invalid'
for command_name in docker python3 bash realpath install stat date; do
    command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_directory/.." && pwd -P)"
[[ -d "$backup_directory" && ! -L "$backup_directory" && "$backup_directory" != *,* ]] \
    || fail 'backup directory is invalid or cannot be mounted safely'
backup_directory="$(realpath -e -- "$backup_directory")"
[[ -d "$backup_directory" && "$backup_directory" != *,* ]] \
    || fail 'backup directory is invalid or cannot be mounted safely'

run_suffix="${run_id#postgres-}"
run_suffix="${run_suffix//T/_}"
run_suffix="${run_suffix//Z/}"
run_suffix="${run_suffix//-/_}"
candidate_volume="backend_postgres_restore_${run_suffix}"
candidate_container="vocadb_postgres_restore_${run_suffix}"
state_token="$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
state_directory="$STATE_ROOT/$run_id-$state_token"
resource_usage_file="$state_directory/resource-usage.json"
resource_monitor_pid=''
resource_monitor_exit_code=0
[[ ! -e "$state_directory" && ! -L "$state_directory" ]] \
    || fail "state already exists for $run_id; inspect its exact labelled candidate before continuing"
install -d -o root -g root -m 0700 -- "$STATE_ROOT" "$state_directory"
[[ "$(stat -c '%u:%a' -- "$state_directory")" == '0:700' ]] || fail 'state directory must be root-owned mode 0700'
stop_resource_monitor() {
    if [[ -n "$resource_monitor_pid" ]]; then
        kill -TERM "$resource_monitor_pid" >/dev/null 2>&1 || true
        if wait "$resource_monitor_pid"; then resource_monitor_exit_code=0; else resource_monitor_exit_code=$?; fi
        resource_monitor_pid=''
    fi
}
on_restore_exit() {
    local result=$?
    trap - EXIT
    stop_resource_monitor
    if (( result != 0 )) && [[ -f "$state_directory/state.json" ]]; then
        python3 "$script_directory/postgres-restore-state.py" update --state-file "$state_directory/state.json" --phase failed-candidate-preserved || true
        docker stop --time 15 "$candidate_container" >/dev/null 2>&1 || true
    fi
    exit "$result"
}
trap on_restore_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if docker container inspect "$candidate_container" >/dev/null 2>&1 \
    || docker volume inspect "$candidate_volume" >/dev/null 2>&1; then
    candidate_container=''
    fail 'a candidate resource with this run ID already exists; no resource was changed'
fi

preflight_json="$state_directory/preflight.json"
started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if ! python3 "$script_directory/postgres-restore-preflight.py" \
    --backup-directory "$backup_directory" --run-id "$run_id" \
    --current-container "$CURRENT_CONTAINER" >"$preflight_json"; then
    fail 'read-only backup, image, publication-generation, or capacity preflight failed'
fi
chmod 0600 -- "$preflight_json"

mapfile -t fields < <(python3 - "$preflight_json" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding="utf-8") as stream: report = json.load(stream)
pg, backup = report.get("postgres", {}), report.get("backup", {})
if report.get("status") != "ready" or report.get("capacity", {}).get("sufficient") is not True: raise SystemExit(1)
values = [pg.get("adminUser", ""), pg.get("oldVolume", ""), pg.get("imageId", ""),
          backup.get("manifestSha256", ""), backup.get("dumpSha256", ""), backup.get("publicationGeneration", "")]
if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", values[0]): raise SystemExit(1)
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", values[1]): raise SystemExit(1)
if not re.fullmatch(r"sha256:[0-9a-f]{64}", values[2]): raise SystemExit(1)
if not all(re.fullmatch(r"[0-9a-f]{64}", value) for value in values[3:5]): raise SystemExit(1)
if not values[5] or "\n" in values[5] or "\r" in values[5]: raise SystemExit(1)
print("\n".join(values))
PY
)
[[ "${#fields[@]}" -eq 6 ]] || fail 'preflight report fields are incomplete'
admin_user="${fields[0]}"
old_volume="${fields[1]}"
image_id="${fields[2]}"
manifest_sha="${fields[3]}"
dump_sha="${fields[4]}"
generation="${fields[5]}"
[[ "$candidate_volume" != "$old_volume" ]] || fail 'candidate volume collides with the production volume'
[[ "$(docker image inspect --format '{{.Id}}' "$POSTGRES_IMAGE")" == "$image_id" ]] \
    || fail 'pinned PostgreSQL image ID changed after preflight'

toc_entries="$(docker run --rm --pull=never --network none \
    --mount "type=bind,src=$backup_directory,dst=/restore,readonly" \
    "$POSTGRES_IMAGE" pg_restore --list /restore/postgres.dump \
    | awk '$1 ~ /^[0-9]+;$/ { count++ } END { print count+0 }')"
[[ "$toc_entries" =~ ^[1-9][0-9]*$ ]] || fail 'backup archive has no restorable entries'

write_state() {
    python3 - "$state_directory/state.json" "$1" "$run_id" "$candidate_volume" \
        "$candidate_container" "$old_volume" "$manifest_sha" "$dump_sha" \
        "$generation" "$image_id" "$started_at" "$script_directory" "$repository_root" <<'PY'
import json, sys, hashlib, importlib.util
from pathlib import Path
path, phase, run_id, volume, container, old_volume, manifest_sha, dump_sha, generation, image_id, started_at, scripts, repository = sys.argv[1:]
spec=importlib.util.spec_from_file_location("restore_state",Path(scripts)/"postgres-restore-state.py")
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
marker=Path(repository)/"SOURCE_COMMIT"
fields={"schemaVersion":1,"runId":run_id,"candidateVolume":volume,"candidateContainer":container,
        "oldVolume":old_volume,"manifestSha256":manifest_sha,"dumpSha256":dump_sha,
        "publicationGeneration":generation,"postgresImageId":image_id,"startedAt":started_at,
        "sourceCommit":marker.read_text().strip() if marker.is_file() else None,
        "controllerSha256":hashlib.sha256((Path(scripts)/"restore-sbc-postgres-isolated.sh").read_bytes()).hexdigest()}
helper.checkpoint(path,phase,fields)
PY
}
write_state 'preflight-complete'

admin_password_file="$state_directory/admin-password"
python3 - "$admin_password_file" <<'PY'
import os, secrets, sys
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try: os.write(fd, secrets.token_urlsafe(48).encode("ascii")); os.fsync(fd)
finally: os.close(fd)
PY

write_state 'candidate-volume-creating'
docker volume create \
    --label "com.diva.postgres-restore.run-id=$run_id" \
    --label "com.diva.postgres-restore.manifest-sha256=$manifest_sha" \
    --label "com.diva.postgres-restore.dump-sha256=$dump_sha" \
    --label 'com.diva.postgres-restore.purpose=isolated-verification' \
    "$candidate_volume" >/dev/null
write_state 'candidate-volume-created'
docker run --detach --pull=never \
    --name "$candidate_container" \
    --label "com.diva.postgres-restore.run-id=$run_id" \
    --label "com.diva.postgres-restore.manifest-sha256=$manifest_sha" \
    --label "com.diva.postgres-restore.dump-sha256=$dump_sha" \
    --label 'com.diva.postgres-restore.purpose=isolated-verification' \
    --restart no --network none --shm-size 1gb --pids-limit 512 \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --cap-add SETGID --cap-add SETUID --security-opt no-new-privileges=true \
    --tmpfs /docker-entrypoint-initdb.d:rw,noexec,nosuid,size=1m \
    --mount "type=volume,src=$candidate_volume,dst=$POSTGRES_DATA_PATH" \
    --mount "type=bind,src=$backup_directory,dst=/restore,readonly" \
    --mount "type=bind,src=$admin_password_file,dst=$ADMIN_PASSWORD_PATH,readonly" \
    --mount "type=bind,src=$repository_root/backend/database/migrations,dst=/restore-migrations,readonly" \
    --mount "type=bind,src=$repository_root/backend/database/migrate.sh,dst=/tmp/restore-migrate.sh,readonly" \
    --mount "type=bind,src=$script_directory,dst=/restore-scripts,readonly" \
    --env "POSTGRES_USER=$admin_user" --env "POSTGRES_DB=$DATABASE_NAME" \
    --env "POSTGRES_PASSWORD_FILE=$ADMIN_PASSWORD_PATH" \
    "$POSTGRES_IMAGE" >/dev/null
write_state 'candidate-started-network-none'

ready=false
for attempt in $(seq 1 90); do
    if docker exec "$candidate_container" pg_isready -U "$admin_user" -d "$DATABASE_NAME" >/dev/null 2>&1; then ready=true; break; fi
    sleep 2
done
[ "$ready" = true ] || fail 'isolated PostgreSQL cluster did not become ready'
python3 "$script_directory/postgres-restore-resource-monitor.py" \
    --container "$candidate_container" --output "$resource_usage_file" --interval-seconds 10 &
resource_monitor_pid=$!
monitor_ready=false
for attempt in $(seq 1 10); do
    if python3 - "$resource_usage_file" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as stream: report = json.load(stream)
    raise SystemExit(0 if report.get("sampleCount", 0) > 0 else 1)
except (OSError, ValueError):
    raise SystemExit(1)
PY
    then monitor_ready=true; break; fi
    if ! kill -0 "$resource_monitor_pid" 2>/dev/null; then break; fi
    sleep 1
done
[ "$monitor_ready" = true ] || fail 'isolated PostgreSQL resource monitor did not capture a baseline sample'
logical_restore_started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
write_state 'logical-restore-running'
python3 "$script_directory/postgres-restore-state.py" update --state-file "$state_directory/state.json" --phase logical-restore-running \
    --fields-json "$(python3 -c 'import json,sys;print(json.dumps({"restoreStartedAt":sys.argv[1]}))' "$logical_restore_started_at")"
if ! docker exec "$candidate_container" pg_restore --exit-on-error --no-owner --no-privileges \
    --jobs=2 --username "$admin_user" --dbname "$DATABASE_NAME" /restore/postgres.dump >"$state_directory/restore.log" 2>&1; then
    chmod 0600 -- "$state_directory/restore.log"
    write_state 'restore-failed-candidate-preserved'
    fail 'logical restore failed; the exact labelled candidate and private state were preserved'
fi
chmod 0600 -- "$state_directory/restore.log"
logical_restore_finished_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
write_state 'logical-restore-complete'
python3 "$script_directory/postgres-restore-state.py" update --state-file "$state_directory/state.json" --phase logical-restore-complete \
    --fields-json "$(python3 -c 'import json,sys;print(json.dumps({"logicalRestoreFinishedAt":sys.argv[1]}))' "$logical_restore_finished_at")"
write_state 'acl-and-migration-rebuilding'

# The dump omits ACLs. Rebuild the base policy, run current migrations, then
# restore later explicit grants without changing migration-history rows.
docker exec "$candidate_container" psql -X -v ON_ERROR_STOP=1 -U "$admin_user" -d "$DATABASE_NAME" \
    -f /restore-migrations/0018_runtime_database_roles.sql >/dev/null
if ! docker exec -e "PGUSER=$admin_user" -e "PGDATABASE=$DATABASE_NAME" \
    -e MIGRATIONS_SQL_DIR=/restore-migrations "$candidate_container" \
    sh /tmp/restore-migrate.sh >"$state_directory/migrations.log" 2>&1; then
    chmod 0600 -- "$state_directory/migrations.log"
    write_state 'migration-failed-candidate-preserved'
    fail 'existing migration runner failed on the isolated database'
fi
chmod 0600 -- "$state_directory/migrations.log"
docker exec "$candidate_container" psql -X -v ON_ERROR_STOP=1 -U "$admin_user" -d "$DATABASE_NAME" \
    -f /restore-migrations/0025_reconcile_runtime_role_migration_history_acl.sql >/dev/null
docker exec "$candidate_container" psql -X -v ON_ERROR_STOP=1 -U "$admin_user" -d "$DATABASE_NAME" \
    -f /restore-scripts/postgres-restore-runtime-acls.sql >/dev/null

api_role="$(docker inspect vocadb_api_a vocadb_api_b | python3 -c '
import json,re,sys
records=json.load(sys.stdin); roles=[]
for record in records:
 env=dict(item.split("=",1) for item in record["Config"].get("Env",[]) if "=" in item)
 match=re.search(r"(?:^|;)Username=([^;]+)",env.get("ConnectionStrings__Postgres",""),re.I)
 if not match or not re.fullmatch(r"diva_api_login_[a-z0-9][a-z0-9_]*",match.group(1)): raise SystemExit(1)
 roles.append(match.group(1))
if len(roles)!=2 or roles[0]!=roles[1]: raise SystemExit(1)
print(roles[0])
')" || fail 'could not identify one matching versioned API role from both production slots'
[[ "$api_role" =~ ^diva_api_login_[a-z0-9][a-z0-9_]*$ ]] || fail 'API login role name is invalid'
mapfile -t pipeline_roles < <(docker exec "$CURRENT_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$admin_user" \
    -d "$DATABASE_NAME" -Atq -c "SELECT member.rolname FROM pg_auth_members membership JOIN pg_roles parent ON parent.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE parent.rolname='diva_pipeline_runtime' AND member.rolcanlogin AND member.rolname ~ '^diva_pipeline_login_[a-z0-9][a-z0-9_]*$' ORDER BY member.rolname")
[[ "${#pipeline_roles[@]}" -eq 1 ]] || fail 'production database must have exactly one versioned pipeline login role'
pipeline_role="${pipeline_roles[0]}"
python3 "$script_directory/postgres-restore-state.py" update --state-file "$state_directory/state.json" --phase credentials-preparing \
    --fields-json "$(python3 -c 'import json,sys;print(json.dumps({"apiLoginRole":sys.argv[1],"pipelineLoginRole":sys.argv[2]}))' "$api_role" "$pipeline_role")"
# Isolated verification uses its own credentials, independent of production secret storage.
python3 - "$state_directory" <<'PY_CREDENTIALS'
import os, secrets, sys
from pathlib import Path
for name in ("api-password", "pipeline-password"):
    fd = os.open(Path(sys.argv[1]) / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try: os.write(fd, secrets.token_urlsafe(48).encode("ascii")); os.fsync(fd)
    finally: os.close(fd)
PY_CREDENTIALS
DIVA_DB_API_PASSWORD_FILE="$state_directory/api-password" DIVA_DB_PIPELINE_PASSWORD_FILE="$state_directory/pipeline-password" \
DIVA_DB_CONTAINER="$candidate_container" DIVA_DB_ADMIN_USER="$admin_user" DIVA_DB_NAME="$DATABASE_NAME" \
    DIVA_DB_API_LOGIN_ROLE="$api_role" DIVA_DB_PIPELINE_LOGIN_ROLE="$pipeline_role" \
    bash "$repository_root/scripts/provision-sbc-db-roles.sh" create >/dev/null
write_state 'roles-and-acls-rebuilt'

db_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
[[ "$db_port" =~ ^[0-9]+$ ]] || fail 'could not choose a loopback verification port'
python3 "$script_directory/postgres-restore-state.py" update --state-file "$state_directory/state.json" --phase loopback-container-recreating \
    --fields-json "$(python3 -c 'import json,sys;print(json.dumps({"databasePort":int(sys.argv[1]),"rolesAndAclsRebuilt":True}))' "$db_port")"
docker stop "$candidate_container" >/dev/null
docker rm "$candidate_container" >/dev/null
docker run --detach --pull=never \
    --name "$candidate_container" \
    --label "com.diva.postgres-restore.run-id=$run_id" \
    --label "com.diva.postgres-restore.manifest-sha256=$manifest_sha" \
    --label "com.diva.postgres-restore.dump-sha256=$dump_sha" \
    --label 'com.diva.postgres-restore.purpose=isolated-verification' \
    --restart no --network host --shm-size 1gb --pids-limit 512 \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --cap-add SETGID --cap-add SETUID --security-opt no-new-privileges=true \
    --tmpfs /docker-entrypoint-initdb.d:rw,noexec,nosuid,size=1m \
    --mount "type=volume,src=$candidate_volume,dst=$POSTGRES_DATA_PATH" \
    --mount "type=bind,src=$admin_password_file,dst=$ADMIN_PASSWORD_PATH,readonly" \
    --mount "type=bind,src=$script_directory,dst=/restore-scripts,readonly" \
    --env "POSTGRES_USER=$admin_user" --env "POSTGRES_DB=$DATABASE_NAME" \
    --env "POSTGRES_PASSWORD_FILE=$ADMIN_PASSWORD_PATH" \
    --env "PGPORT=$db_port" \
    "$POSTGRES_IMAGE" postgres -c listen_addresses=127.0.0.1 -c "port=$db_port" >/dev/null
ready=false
for attempt in $(seq 1 90); do
    if docker exec "$candidate_container" pg_isready -h 127.0.0.1 -p "$db_port" \
        -U "$admin_user" -d "$DATABASE_NAME" >/dev/null 2>&1; then ready=true; break; fi
    sleep 2
done
[ "$ready" = true ] || fail 'restored PostgreSQL did not start on its loopback-only verification port'
write_state "database-ready-loopback-port-$db_port"
stop_resource_monitor
[[ "$resource_monitor_exit_code" -eq 0 ]] || fail 'isolated PostgreSQL resource monitoring failed'

python3 - "$state_directory/state.json" "$api_role" "$pipeline_role" "$db_port" \
    "$logical_restore_started_at" "$logical_restore_finished_at" <<'PY'
import json, os, sys
path, api_role, pipeline_role, port, restore_started, restore_finished = sys.argv[1:]
with open(path, encoding="utf-8") as stream: state = json.load(stream)
state.update({"apiLoginRole": api_role, "pipelineLoginRole": pipeline_role,
              "databasePort": int(port), "candidateVolumeRetained": True,
              "restoreStartedAt": restore_started,
              "logicalRestoreFinishedAt": restore_finished,
              "preflightFile": "preflight.json", "verificationFile": "verification.json",
              "resourceUsageFile": "resource-usage.json",
              "evidenceFile": "restore-evidence.json", "nextStep": "start isolated API on loopback and run postgres-restore-verify.py"})
temporary = path + ".tmp"
with open(temporary, "x", encoding="utf-8") as stream:
    json.dump(state, stream, sort_keys=True, indent=2); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
os.chmod(temporary, 0o600); os.replace(temporary, path)
PY

printf '{"status":"restore-staged","runId":"%s","candidateVolume":"%s","databasePort":%s,"state":"%s"}\n' \
    "$run_id" "$candidate_volume" "$db_port" "$state_directory/state.json"
