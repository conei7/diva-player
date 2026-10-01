#!/usr/bin/env bash
set +x
set -Eeuo pipefail
umask 077

fail() { printf '[postgres-restore] ERROR: %s\n' "$1" >&2; exit 1; }
usage() { printf 'Usage: smoke-sbc-postgres-isolated-api.sh --state-file <restore-state.json>\n' >&2; exit 2; }

state_file=''
while (($#)); do
    case "$1" in
        --state-file) (($# >= 2)) || usage; state_file="$2"; shift 2 ;;
        *) usage ;;
    esac
done
[[ -n "$state_file" ]] || usage
[[ "$(id -u)" -eq 0 ]] || fail 'must run as root on the SBC'
command -v docker >/dev/null 2>&1 || fail 'docker is unavailable'
command -v python3 >/dev/null 2>&1 || fail 'python3 is unavailable'
command -v curl >/dev/null 2>&1 || fail 'curl is unavailable'
command -v ss >/dev/null 2>&1 || fail 'ss is unavailable'

[[ -f "$state_file" && ! -L "$state_file" ]] || fail 'state file must be a regular file'
state_file="$(realpath -e -- "$state_file")"
state_directory="$(dirname -- "$state_file")"
[[ "$(stat -c '%u:%a' -- "$state_file")" == '0:600' ]] || fail 'state file must be root-owned mode 0600'
[[ "$(stat -c '%u:%a' -- "$state_directory")" == '0:700' ]] || fail 'restore state directory must be root-owned mode 0700'
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec 8>"$state_directory/api-verification.lock"
flock -n 8 || fail 'this restore run is already being verified'
if [[ "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["phase"])' "$state_file")" == verification-complete ]]; then
    exec python3 "$script_directory/postgres-restore-state.py" resume --state-file "$state_file"
fi
python3 "$script_directory/postgres-restore-state.py" resume --state-file "$state_file"
if [[ "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["phase"])' "$state_file")" == verification-complete ]]; then
    exit 0
fi
API_PASSWORD_FILE="$state_directory/api-password"
[[ -f "$API_PASSWORD_FILE" && ! -L "$API_PASSWORD_FILE" ]] || fail 'API password file must be a regular file'
[[ "$(stat -c '%u:%a' -- "$API_PASSWORD_FILE")" == '0:600' ]] || fail 'API password file must be root-owned mode 0600'
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
preflight_json="$state_directory/preflight.json"
verification_json="$state_directory/verification.json"
evidence_json="$state_directory/restore-evidence.json"
api_env_file="$state_directory/api.env"
candidate_api_started=false
api_env_exists=false

mapfile -t fields < <(python3 - "$state_file" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding="utf-8") as stream: state=json.load(stream)
if state.get("schemaVersion") != 1: raise SystemExit(1)
values=[state.get("runId",""),state.get("candidateVolume",""),state.get("candidateContainer",""),
        str(state.get("databasePort","")),state.get("apiLoginRole",""),state.get("pipelineLoginRole",""),
        state.get("startedAt",""),state.get("restoreStartedAt",""),
        state.get("logicalRestoreFinishedAt",""),state.get("resourceUsageFile","")]
if not re.fullmatch(r"postgres-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}",values[0]): raise SystemExit(1)
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}",values[1]) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}",values[2]): raise SystemExit(1)
if not re.fullmatch(r"[1-9][0-9]{3,4}",values[3]): raise SystemExit(1)
if not re.fullmatch(r"diva_api_login_[a-z0-9][a-z0-9_]*",values[4]): raise SystemExit(1)
if not re.fullmatch(r"diva_pipeline_login_[a-z0-9][a-z0-9_]*",values[5]): raise SystemExit(1)
if any(not isinstance(value,str) or "\n" in value or "\r" in value for value in values[6:9]): raise SystemExit(1)
if any(not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z",value) for value in values[6:9]): raise SystemExit(1)
if values[7] > values[8] or not re.fullmatch(r"resource-usage\.json",values[9]): raise SystemExit(1)
suffix=values[0].removeprefix("postgres-").replace("T","_").replace("Z","").replace("-","_")
if values[1] != "backend_postgres_restore_"+suffix: raise SystemExit(1)
if values[2] != "vocadb_postgres_restore_"+suffix: raise SystemExit(1)
if state.get("phase") != "database-ready-loopback-port-"+values[3]: raise SystemExit(1)
print("\n".join(values))
PY
)
[[ "${#fields[@]}" -eq 10 ]] || fail 'restore state is not at the isolated API verification phase'
run_id="${fields[0]}"
candidate_volume="${fields[1]}"
candidate_container="${fields[2]}"
database_port="${fields[3]}"
api_role="${fields[4]}"
pipeline_role="${fields[5]}"
workflow_started_at="${fields[6]}"
restore_started_at="${fields[7]}"
logical_restore_finished_at="${fields[8]}"
resource_usage_json="$state_directory/${fields[9]}"
candidate_api_container="${candidate_container}_api"
for attempt in $(seq 1 30); do
    docker exec "$candidate_container" pg_isready -h 127.0.0.1 -p "$database_port" >/dev/null 2>&1 && break
    sleep 1
done
[[ -f "$preflight_json" && ! -L "$preflight_json" ]] || fail 'bound preflight JSON is missing'
[[ "$(stat -c '%u:%a' -- "$preflight_json")" == '0:600' ]] || fail 'preflight report must be root-owned mode 0600'
[[ -f "$resource_usage_json" && ! -L "$resource_usage_json" ]] || fail 'resource usage summary is missing'
[[ "$(stat -c '%u:%a' -- "$resource_usage_json")" == '0:600' ]] || fail 'resource usage summary must be root-owned mode 0600'
if docker container inspect "$candidate_api_container" >/dev/null 2>&1; then
    fail "candidate API container already exists: $candidate_api_container"
fi
python3 "$script_directory/postgres-restore-verify.py" \
    --preflight-json "$preflight_json" --container "$candidate_container" \
    --volume "$candidate_volume" --database-port "$database_port" \
    --assert-candidate-only >/dev/null

for result_file in "$verification_json" "$evidence_json"; do
    if [[ -e "$result_file" ]]; then
        [[ -f "$result_file" && ! -L "$result_file" ]] || fail 'existing result is not a regular file'
        mv -- "$result_file" "$result_file.previous.$(date -u +%Y%m%dT%H%M%S).$$"
    fi
done
# Logical dumps omit planner statistics. Analyze only the bound candidate
# before a cold API warmup, including resumed runs restored by older scripts.
admin_user="$(python3 -c 'import json,re,sys; value=json.load(open(sys.argv[1]))["postgres"]["adminUser"]; assert re.fullmatch(r"[a-z_][a-z0-9_]{0,62}",value); print(value)' "$preflight_json")"
python3 "$script_directory/postgres-restore-state.py" update --state-file "$state_file" --phase api-database-analyzing
docker exec "$candidate_container" vacuumdb --analyze-only --jobs=2 -h 127.0.0.1 -p "$database_port" -U "$admin_user" -d vocadb_recommender >"$state_directory/analyze.log" 2>&1
python3 "$script_directory/postgres-restore-state.py" update --state-file "$state_file" --phase api-database-analyzed --fields-json '{"plannerStatisticsAnalyzed":true}'
api_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
[[ "$api_port" =~ ^[0-9]+$ && "$api_port" != "$database_port" ]] || fail 'could not choose a loopback API port'
api_image_id="$(docker inspect --format '{{.Image}}' vocadb_api_a)"
[[ "$api_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'live API image ID is invalid'

docker inspect vocadb_api_a vocadb_api_b | python3 "$script_directory/postgres-restore-api-env.py" \
    --password-file "$API_PASSWORD_FILE" --api-login-role "$api_role" \
    --database-port "$database_port" --api-port "$api_port" --output "$api_env_file"
api_env_exists=true

cleanup_transient() {
    local result=$?
    trap - EXIT
    if [ "$candidate_api_started" = true ]; then
        if (( result != 0 )); then
            docker logs --tail 300 "$candidate_api_container" >"$state_directory/api-failure.log" 2>&1 || true
            chmod 0600 "$state_directory/api-failure.log"
        fi
        docker rm -f "$candidate_api_container" >/dev/null 2>&1 || true
    fi
    if [ "$api_env_exists" = true ]; then rm -f -- "$api_env_file"; fi
    if (( result != 0 )); then
        docker stop --time 15 "$candidate_container" >/dev/null 2>&1 || true
        python3 "$script_directory/postgres-restore-state.py" update --state-file "$state_file" --phase api-verification-failed || true
    fi
    exit "$result"
}
trap cleanup_transient EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

api_started_epoch="$(date +%s)"
docker run --detach --pull=never \
    --name "$candidate_api_container" \
    --label "com.diva.postgres-restore.run-id=$run_id" \
    --label 'com.diva.postgres-restore.purpose=isolated-verification' \
    --restart no --network host --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
    --cap-drop ALL --security-opt no-new-privileges=true \
    --memory 768m --pids-limit 256 \
    --env-file "$api_env_file" "$api_image_id" >/dev/null
candidate_api_started=true

ready=false
for attempt in $(seq 1 180); do
    [[ "$(docker inspect --format '{{.State.Running}}' "$candidate_api_container")" == 'true' ]] \
        || fail 'isolated API exited before becoming ready'
    if curl --silent --show-error --fail --noproxy '*' --max-time 5 \
        "http://127.0.0.1:$api_port/api/ready" >/dev/null 2>&1; then ready=true; break; fi
    sleep 2
done
[ "$ready" = true ] || fail 'isolated API did not become ready against candidate PostgreSQL and current Qdrant'
api_ready_seconds="$(( $(date +%s) - api_started_epoch ))"
python3 "$script_directory/postgres-restore-state.py" update --state-file "$state_file" --phase "database-ready-loopback-port-$database_port" \
    --fields-json "$(python3 -c 'import json,sys;print(json.dumps({"apiReadyElapsedSeconds":int(sys.argv[1])}))' "$api_ready_seconds")"
printf '[postgres-restore] isolated API ready in %s seconds\n' "$api_ready_seconds"
# Operational health probes are cached on a five-minute cadence. Allow the
# first cold-start probe to refresh after readiness without accepting degradation.
healthy=false
for attempt in $(seq 1 180); do
    if curl --silent --show-error --fail --noproxy '*' --max-time 5 \
        "http://127.0.0.1:$api_port/api/health" >"$state_directory/api-health.json" 2>/dev/null; then
        healthy=true; break
    fi
    sleep 2
done
chmod 0600 "$state_directory/api-health.json"
[ "$healthy" = true ] || fail 'isolated API operational health did not become healthy'
mapfile -t api_listeners < <(ss -H -lnt "sport = :$api_port")
[[ "${#api_listeners[@]}" -eq 1 ]] || fail 'isolated API must expose exactly one listening socket'
read -r listener_state listener_recv listener_send listener_address listener_peer _ <<<"${api_listeners[0]}"
[[ "$listener_state" == 'LISTEN' && "$listener_address" == "127.0.0.1:$api_port" ]] \
    || fail 'isolated API listener is not restricted to IPv4 loopback'

python3 "$script_directory/postgres-restore-verify.py" \
    --preflight-json "$preflight_json" --container "$candidate_container" \
    --volume "$candidate_volume" --api-url "http://127.0.0.1:$api_port" \
    --database-port "$database_port" \
    --api-login-role "$api_role" \
    --pipeline-login-role "$pipeline_role" --started-at "$restore_started_at" \
    --logical-restore-finished-at "$logical_restore_finished_at" \
    --resource-usage-json "$resource_usage_json" \
    --output "$verification_json"
chmod 0600 -- "$verification_json"
python3 "$script_directory/postgres-restore-evidence.py" \
    --preflight-json "$preflight_json" --verification-json "$verification_json" \
    --output "$evidence_json"
chmod 0600 -- "$evidence_json"

docker rm -f "$candidate_api_container" >/dev/null
candidate_api_started=false
rm -f -- "$api_env_file"
api_env_exists=false
docker stop "$candidate_container" >/dev/null
docker rm "$candidate_container" >/dev/null
rm -f -- "$state_directory/admin-password" "$state_directory/api-password" "$state_directory/pipeline-password"

volume_run_id="$(docker volume inspect --format '{{ index .Labels "com.diva.postgres-restore.run-id" }}' "$candidate_volume")"
[[ "$volume_run_id" == "$run_id" ]] || fail 'candidate volume run-ID label changed during API verification'
[[ "$(docker ps -aq --filter "volume=$candidate_volume" | wc -l | tr -d '[:space:]')" == '0' ]] \
    || fail 'a stopped Docker container still refers to the isolated candidate volume'
old_volume="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf-8"))["postgres"]["oldVolume"])' "$preflight_json")"
[[ "$old_volume" != "$candidate_volume" ]] || fail 'candidate volume matches the production volume'
docker volume inspect "$old_volume" >/dev/null

python3 "$script_directory/postgres-restore-state.py" update --state-file "$state_file" \
    --phase verification-complete --fields-json '{"apiContainerStoppedAndRemoved":true,"databaseContainerStoppedAndRemoved":true,"candidateVolumeRetained":true,"adminPasswordRemoved":true,"apiVerificationComplete":true,"suspendedAtUserRequest":false,"evidenceFile":"restore-evidence.json"}'

printf '{"status":"restore-verified","runId":"%s","evidence":"%s","candidateVolume":"%s","candidateVolumeRetained":true}\n' \
    "$run_id" "$evidence_json" "$candidate_volume"
