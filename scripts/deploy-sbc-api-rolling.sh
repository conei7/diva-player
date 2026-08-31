#!/bin/sh
set -eu
umask 077

BRIDGE_BOOTSTRAP_MODE=false
case "$#:${1:-}" in
    0:) ;;
    1:--bootstrap-legacy-qdrant-bridge) BRIDGE_BOOTSTRAP_MODE=true ;;
    *) printf '%s\n' 'usage: deploy-sbc-api-rolling.sh [--bootstrap-legacy-qdrant-bridge]' >&2; exit 64 ;;
esac

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ORIGINAL_ROOT_DIR="$ROOT_DIR"
OFFICIAL_GIT_REMOTE_URL='https://github.com/conei7/diva-player.git'
COMPOSE_FILE="$ROOT_DIR/backend/docker-compose.yml"
RUNTIME_COMPOSE_FILE="$COMPOSE_FILE"
COMPOSE_PROJECT=backend
GATEWAY_CONTAINER="vocadb_api_gateway"
API_IMAGE="diva-player-api:local"
GATEWAY_IMAGE="diva-player-api-gateway:local"
WEB_IMAGE="diva-player-web:local"
QDRANT_STABLE_IMAGE="diva-player-qdrant:v1.19.0-hardened-r1"
POSTGRES_STABLE_IMAGE="diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1"
POSTGRES_MIGRATE_STABLE_IMAGE="diva-player-postgres-migrate:16.15-hardened-r1"
BRIDGE_RECEIPT_PRODUCER="$ROOT_DIR/scripts/sbc-api-bridge-receipt.py"
BRIDGE_RECEIPT_PUBLISHER="$ROOT_DIR/scripts/sbc-api-bridge-publication.py"
IMAGE_SCAN_VALIDATOR="$ROOT_DIR/scripts/validate-container-image-scan.py"
TRIVY_VERSION=0.74.0
TRIVY_BINARY_SHA256=fed2c9ca7d27191ada34524b5eaf5216a845c6d6f3246143c3b475552ffe5358
API_A_ROLLBACK_IMAGE="diva-player-api:rollback-api-a"
API_B_ROLLBACK_IMAGE="diva-player-api:rollback-api-b"
GATEWAY_ROLLBACK_IMAGE="diva-player-api-gateway:rollback"
WEB_CONTAINER="vocadb_web"

# Command overrides make the real deployment state machine executable against
# deterministic fakes. Production uses the defaults.
DOCKER_COMMAND=${DIVA_DOCKER_COMMAND:-docker}
CURL_COMMAND=${DIVA_CURL_COMMAND:-curl}
SLEEP_COMMAND=${DIVA_SLEEP_COMMAND:-sleep}
TIMEOUT_COMMAND=${DIVA_TIMEOUT_COMMAND:-timeout}
SYNC_COMMAND=${DIVA_SYNC_COMMAND:-sync}
PYTHON_COMMAND=${DIVA_DEPLOY_PYTHON_COMMAND:-python3}
EXACT_PYTHON_COMMAND=${DIVA_DEPLOY_EXACT_PYTHON_COMMAND:-$PYTHON_COMMAND}
TRIVY_COMMAND=${DIVA_TRIVY_COMMAND:-trivy}
HOOK_COMMAND=${DIVA_DEPLOY_HOOK_COMMAND:-}
TEST_MODE=${DIVA_DEPLOY_TEST_MODE:-0}
HEALTH_ATTEMPTS=${DIVA_DEPLOY_HEALTH_ATTEMPTS:-180}
DRAIN_ATTEMPTS=${DIVA_DEPLOY_DRAIN_ATTEMPTS:-75}
ROUTE_ATTEMPTS=${DIVA_DEPLOY_ROUTE_ATTEMPTS:-30}
WAIT_SECONDS=${DIVA_DEPLOY_WAIT_SECONDS:-1}
MUTATION_TIMEOUT_SECONDS=${DIVA_DEPLOY_MUTATION_TIMEOUT_SECONDS:-60}
BUILD_TIMEOUT_SECONDS=${DIVA_DEPLOY_BUILD_TIMEOUT_SECONDS:-1800}
MIGRATION_TIMEOUT_SECONDS=${DIVA_DEPLOY_MIGRATION_TIMEOUT_SECONDS:-600}
DOCKER_READ_TIMEOUT_SECONDS=${DIVA_DEPLOY_DOCKER_READ_TIMEOUT_SECONDS:-30}
DAEMON_SETTLE_ATTEMPTS=${DIVA_DEPLOY_DAEMON_SETTLE_ATTEMPTS:-30}
DAEMON_STABLE_SAMPLES=${DIVA_DEPLOY_DAEMON_STABLE_SAMPLES:-10}

if [ "$TEST_MODE" = "1" ]; then
    # Test mode permits command fakes, so it must never be selectable by a
    # privileged production caller merely by exporting an environment flag.
    [ "$(/usr/bin/id -u)" -ne 0 ] || {
        printf '%s\n' 'ERROR: deterministic deployment test mode refuses uid 0' >&2
        exit 1
    }
else
    [ -z "${DIVA_DEPLOY_TEST_BACKEND_ENV_SOURCE+x}" ] || {
        printf '%s\n' 'ERROR: production backend environment source override is forbidden' >&2
        exit 1
    }
    for forbidden_docker_setting in DOCKER_DEFAULT_PLATFORM DOCKER_HOST DOCKER_CONTEXT \
        DOCKER_API_VERSION DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH BUILDX_BUILDER; do
        eval "forbidden_docker_value=\${$forbidden_docker_setting-}"
        [ -z "$forbidden_docker_value" ] || {
            printf '%s\n' "ERROR: production Docker override is forbidden: $forbidden_docker_setting" >&2
            exit 1
        }
    done
    case "${DIVA_DOCKER_COMMAND+x}:${DIVA_CURL_COMMAND+x}:${DIVA_SLEEP_COMMAND+x}:${DIVA_TIMEOUT_COMMAND+x}:${DIVA_SYNC_COMMAND+x}:${DIVA_DEPLOY_PYTHON_COMMAND+x}:${DIVA_DEPLOY_EXACT_PYTHON_COMMAND+x}:${DIVA_TRIVY_COMMAND+x}:${DIVA_DEPLOY_HOOK_COMMAND+x}:${DIVA_DEPLOY_PRIVATE_RUNTIME_DIR+x}" in
        ::::::::: ) ;;
        *)
            printf '%s\n' 'ERROR: production deployment command/hook overrides are forbidden' >&2
            exit 1
            ;;
    esac
    PATH=/usr/sbin:/usr/bin:/sbin:/bin
    export PATH
    DOCKER_COMMAND=/usr/bin/docker
    CURL_COMMAND=/usr/bin/curl
    SLEEP_COMMAND=/usr/bin/sleep
    TIMEOUT_COMMAND=/usr/bin/timeout
    SYNC_COMMAND=/usr/bin/sync
    PYTHON_COMMAND=/usr/bin/python3
    EXACT_PYTHON_COMMAND=/usr/bin/python3
    TRIVY_COMMAND=/usr/local/libexec/diva-player/trivy-0.74.0
    HOOK_COMMAND=
    validate_trusted_system_directory() {
        local directory="$1" mode
        [ -d "$directory" ] && [ ! -L "$directory" ] \
            && [ "$(/usr/bin/stat -c '%u:%g' "$directory")" = 0:0 ] \
            || return 1
        mode=$(/usr/bin/stat -c '%a' "$directory") || return 1
        [ $((0$mode & 022)) -eq 0 ] || return 1
    }
    validate_trusted_system_ancestry() {
        local path="$1" directory
        directory=${path%/*}
        [ -n "$directory" ] || directory=/
        directory=$(/usr/bin/readlink -f -- "$directory") || return 1
        case "$directory" in /|/usr|/usr/*|/etc|/etc/*) ;; *) return 1 ;; esac
        while :; do
            validate_trusted_system_directory "$directory" || return 1
            [ "$directory" = / ] && break
            directory=${directory%/*}
            [ -n "$directory" ] || directory=/
        done
    }
    validate_trusted_system_binary() {
        local requested="$1" current target final mode link_count=0
        case "$requested" in /usr/bin/*) ;; *) return 1 ;; esac
        validate_trusted_system_ancestry "$requested" || return 1
        current="$requested"
        while [ -L "$current" ]; do
            link_count=$((link_count + 1))
            [ "$link_count" -le 8 ] || return 1
            [ "$(/usr/bin/stat -c '%u:%g' "$current")" = 0:0 ] || return 1
            target=$(/usr/bin/readlink -- "$current") || return 1
            case "$target" in
                /*) current="$target" ;;
                ../*|*/../*|*/..|..|*'/./'*) return 1 ;;
                *) current="${current%/*}/$target" ;;
            esac
            case "$current" in /usr/bin/*|/etc/alternatives/*) ;; *) return 1 ;; esac
            validate_trusted_system_ancestry "$current" || return 1
        done
        final=$(/usr/bin/readlink -f -- "$requested") || return 1
        [ "$current" = "$final" ] || return 1
        case "$final" in /usr/bin/*) ;; *) return 1 ;; esac
        [ -f "$final" ] && [ ! -L "$final" ] && [ -x "$final" ] \
            && [ "$(/usr/bin/stat -c '%u:%g' "$final")" = 0:0 ] \
            || return 1
        mode=$(/usr/bin/stat -c '%a' "$final") || return 1
        [ $((0$mode & 022)) -eq 0 ]
    }
    for trusted_binary in \
        "$DOCKER_COMMAND" "$CURL_COMMAND" "$SLEEP_COMMAND" \
        "$TIMEOUT_COMMAND" "$SYNC_COMMAND" "$PYTHON_COMMAND" \
        /usr/bin/awk /usr/bin/cat /usr/bin/chmod /usr/bin/env /usr/bin/git \
        /usr/bin/grep /usr/bin/id /usr/bin/od /usr/bin/readlink /usr/bin/sha256sum \
        /usr/bin/mkdir /usr/bin/rm /usr/bin/rmdir /usr/bin/stat /usr/bin/tar \
        /usr/bin/uname /usr/bin/wc; do
        validate_trusted_system_binary "$trusted_binary" || {
                printf '%s\n' "ERROR: production binary is not trusted: $trusted_binary" >&2
                exit 1
            }
    done
    verify_reviewed_trivy() {
        local actual_sha version_output
        validate_trusted_system_ancestry "$TRIVY_COMMAND" || return 1
        [ -f "$TRIVY_COMMAND" ] && [ ! -L "$TRIVY_COMMAND" ] \
            && [ -x "$TRIVY_COMMAND" ] \
            && [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$TRIVY_COMMAND")" = 0:0:555:1 ] \
            || return 1
        actual_sha=$(/usr/bin/sha256sum "$TRIVY_COMMAND" | /usr/bin/awk '{print $1}') \
            || return 1
        [ "$actual_sha" = "$TRIVY_BINARY_SHA256" ] || return 1
        # ELF64, little-endian, ET_EXEC, EM_AARCH64. This rejects an amd64
        # scanner before any candidate evidence can be produced.
        set -- $(/usr/bin/od -An -tx1 -N20 "$TRIVY_COMMAND")
        [ "$#" -eq 20 ] \
            && [ "$1:$2:$3:$4" = 7f:45:4c:46 ] \
            && [ "$5:$6:$7" = 02:01:01 ] || return 1
        shift 16
        [ "$1:$2:$3:$4" = 02:00:b7:00 ] || return 1
        version_output=$(/usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin \
            "$TRIVY_COMMAND" --version) || return 1
        printf '%s\n' "$version_output" | /usr/bin/grep -Fx \
            "Version: $TRIVY_VERSION" >/dev/null
    }
    verify_reviewed_trivy || {
        printf '%s\n' 'ERROR: reviewed native ARM64 Trivy installation is unavailable or changed' >&2
        exit 1
    }
fi

if [ "$TEST_MODE" = "1" ]; then
    [ -n "${DIVA_DEPLOY_TEST_BACKEND_ENV_SOURCE:-}" ] || {
        printf '%s\n' 'ERROR: deterministic deployment test backend environment source is required' >&2
        exit 1
    }
    BACKEND_ENV_SOURCE=$DIVA_DEPLOY_TEST_BACKEND_ENV_SOURCE
else
    BACKEND_ENV_SOURCE="$ORIGINAL_ROOT_DIR/backend/.env"
fi

if [ -n "${DIVA_DEPLOY_STATE_DIR:-}" ] && [ -n "${DIVA_STATEFUL_STATE_DIR:-}" ] \
    && [ "$DIVA_DEPLOY_STATE_DIR" != "$DIVA_STATEFUL_STATE_DIR" ]; then
    printf '%s\n' 'ERROR: deploy and stateful state-root overrides must be identical' >&2
    exit 1
fi
STATE_ROOT=${DIVA_DEPLOY_STATE_DIR:-${DIVA_STATEFUL_STATE_DIR:-"$ROOT_DIR/.deploy-state"}}
STATE_ROOT_ID=""
DEPLOY_LOCK_DIR="$STATE_ROOT/deploy.lock"
STATEFUL_LOCK_DIR="$STATE_ROOT/stateful-hardening.lock"
ACTIVE_JOURNAL="$STATE_ROOT/rolling-deployment-active"
STATEFUL_ACTIVE_JOURNAL="$STATE_ROOT/stateful-hardening-active"
STATEFUL_RUNTIME_CONTRACT="$STATE_ROOT/stateful-runtime-contract"
API_BRIDGE_RECEIPT="$STATE_ROOT/api-bridge-receipt.json"
DEPLOYMENT_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
DEPLOYMENT_DIR="$STATE_ROOT/$DEPLOYMENT_ID"
DEPLOYMENT_DIR_ID=""
if [ "$TEST_MODE" = "1" ]; then
    PRIVATE_RUNTIME_ROOT=${DIVA_DEPLOY_PRIVATE_RUNTIME_DIR:-"$DEPLOYMENT_DIR/runtime-private"}
else
    PRIVATE_RUNTIME_ROOT="/run/diva-player-rolling/$DEPLOYMENT_ID"
fi
PRIVATE_RUNTIME_BASE=${PRIVATE_RUNTIME_ROOT%/*}
STATE_FILE="$DEPLOYMENT_DIR/state"
DAEMON_UNRESOLVED_FILE="$DEPLOYMENT_DIR/daemon-mutation-unresolved"
DOCKER_QUERY_FILE="$DEPLOYMENT_DIR/docker-query-output"
GATEWAY_STATS_FILE="$DEPLOYMENT_DIR/gateway-stats"
GATEWAY_COMMAND_FILE="$DEPLOYMENT_DIR/gateway-command"
RESOLVED_COMPOSE_FILE="$PRIVATE_RUNTIME_ROOT/resolved-compose.private.json"
RESOLVED_COMPOSE_SHA256=""
SOURCE_SNAPSHOT_ROOT="$DEPLOYMENT_DIR/source-root"
SOURCE_ARCHIVE_FILE="$DEPLOYMENT_DIR/source.tar"
SOURCE_TREE_ENTRIES_FILE="$DEPLOYMENT_DIR/source-tree.entries"
SOURCE_ARCHIVE_SHA256=""
SOURCE_SNAPSHOT_SHA256=""
SOURCE_TREE_ID=""
SOURCE_SNAPSHOT_CAPTURED=false
PRIVATE_BACKEND_ENV_FILE="$PRIVATE_RUNTIME_ROOT/backend.env.private"
PRIVATE_BACKEND_ENV_ID=""
PRIVATE_RUNTIME_ROOT_ID=""
RUNTIME_CONTRACT_HELPER="$ORIGINAL_ROOT_DIR/scripts/sbc-runtime-contract.py"
IMAGE_SCAN_VALIDATOR_RELEASE="$SOURCE_SNAPSHOT_ROOT/scripts/validate-container-image-scan.py"
IMAGE_SCAN_ROOT="$DEPLOYMENT_DIR/image-scan"
TRIVY_RUN_CACHE="$IMAGE_SCAN_ROOT/trivy-cache"
TRIVY_EMPTY_CONFIG="$IMAGE_SCAN_ROOT/trivy-empty.yaml"
TRIVY_EMPTY_IGNORE="$IMAGE_SCAN_ROOT/trivy-empty.ignore"
TRIVY_SCANNER_SHA=""
API_SCAN_RECEIPT_SHA=""
GATEWAY_SCAN_RECEIPT_SHA=""
WEB_SCAN_RECEIPT_SHA=""
WEB_PREVIOUS_CONTAINER="diva_web_previous_$DEPLOYMENT_ID"
API_A_PREVIOUS_CONTAINER="diva_api_a_previous_$DEPLOYMENT_ID"
API_B_PREVIOUS_CONTAINER="diva_api_b_previous_$DEPLOYMENT_ID"
GATEWAY_PREVIOUS_CONTAINER="diva_api_gateway_previous_$DEPLOYMENT_ID"
API_CANDIDATE_IMAGE="diva-player-api:candidate-$DEPLOYMENT_ID"
API_A_BRIDGE_ROLLBACK_IMAGE="diva-player-api:bridge-rollback-api-a-$DEPLOYMENT_ID"
API_B_BRIDGE_ROLLBACK_IMAGE="diva-player-api:bridge-rollback-api-b-$DEPLOYMENT_ID"
API_BRIDGE_PREVIOUS_RECEIPT="$DEPLOYMENT_DIR/api-bridge-previous-api-rollback.receipt"
API_BRIDGE_PREPARED_RECEIPT="$DEPLOYMENT_DIR/api-bridge-receipt.prepared.json"
GATEWAY_CANDIDATE_IMAGE="diva-player-api-gateway:candidate-$DEPLOYMENT_ID"
WEB_CANDIDATE_IMAGE="diva-player-web:candidate-$DEPLOYMENT_ID"
CANDIDATE_CONTAINER="diva_api_gateway_candidate_$DEPLOYMENT_ID"
CANDIDATE_STARTED=false
CANDIDATE_GATEWAY_ID=""
CANDIDATE_GATEWAY_IMAGE_ID=""
CANDIDATE_CONFIG_HASH=""
CANDIDATE_GATEWAY_RUNTIME_SHA256=""
CANDIDATE_API_A_CONTAINER="diva_api_a_candidate_$DEPLOYMENT_ID"
CANDIDATE_API_B_CONTAINER="diva_api_b_candidate_$DEPLOYMENT_ID"
CANDIDATE_API_A_STARTED=false
CANDIDATE_API_B_STARTED=false
CANDIDATE_API_A_ID=""
CANDIDATE_API_B_ID=""
CANDIDATE_API_IMAGE_ID=""
CANDIDATE_API_A_CONFIG_HASH=""
CANDIDATE_API_B_CONFIG_HASH=""
CANDIDATE_API_A_RUNTIME_SHA256=""
CANDIDATE_API_B_RUNTIME_SHA256=""
CANDIDATE_WEB_CONTAINER="diva_web_candidate_$DEPLOYMENT_ID"
MIGRATION_CONTAINER="diva_migration_$DEPLOYMENT_ID"
CANDIDATE_WEB_STARTED=false
CANDIDATE_WEB_ID=""
CANDIDATE_WEB_IMAGE_ID=""
CANDIDATE_WEB_CONFIG_HASH=""
CANDIDATE_WEB_RUNTIME_SHA256=""
WEB_CANDIDATE_TAG_CREATED=false
API_CANDIDATE_TAG_CREATED=false
GATEWAY_CANDIDATE_TAG_CREATED=false
API_A_BRIDGE_ROLLBACK_TAG_CREATED=false
API_B_BRIDGE_ROLLBACK_TAG_CREATED=false
API_BRIDGE_PUBLISHED=false
API_BRIDGE_PUBLICATION_ARMED=false
API_BRIDGE_PREPARED_SHA=""
BRIDGE_QDRANT_ID=""
BRIDGE_POSTGRES_ID=""
BRIDGE_QDRANT_IMAGE_ID=""
BRIDGE_POSTGRES_IMAGE_ID=""
BRIDGE_GATEWAY_IMAGE_ID=""
BRIDGE_WEB_IMAGE_ID=""
BRIDGE_QDRANT_CONFIG_HASH=""
BRIDGE_POSTGRES_CONFIG_HASH=""
BRIDGE_GATEWAY_CONFIG_HASH=""
BRIDGE_WEB_CONFIG_HASH=""
BRIDGE_QDRANT_BACKUP_BINDING=""
BRIDGE_QDRANT_PUBLICATION_GENERATION=""
CANONICAL_IMAGE_STATE_CAPTURED=false
CANONICAL_IMAGES_COMMITTED=false
OLD_CANONICAL_API_PRESENT=false
OLD_CANONICAL_GATEWAY_PRESENT=false
OLD_CANONICAL_WEB_PRESENT=false
OLD_CANONICAL_API_ID=""
OLD_CANONICAL_GATEWAY_ID=""
OLD_CANONICAL_WEB_ID=""
DEPLOYMENT_SUCCEEDED=false
RECOVERY_ARMED=false
RECOVERY_RUNNING=false
ACTIVE_SLOT=""
ACTIVE_SLOT_PREVIOUS_STATE="unknown"
ACTIVE_SLOT_ROUTE_DISABLED=false
ACTIVE_SLOT_CONTAINER_MUTATED=false
API_A_UPDATED=false
API_B_UPDATED=false
API_A_PREVIOUS_PRESERVED=false
API_B_PREVIOUS_PRESERVED=false
GATEWAY_PREVIOUS_PRESERVED=false
GATEWAY_REPLACEMENT_STARTED=false
GATEWAY_UPDATED=false
API_A_STATE="unknown"
API_B_STATE="unknown"
BOOTSTRAP_RECOVERY_ARMED=false
BOOTSTRAP_GATEWAY_MUTATED=false
BOOTSTRAP_GATEWAY_ID=""
BOOTSTRAP_API_A_ID=""
BOOTSTRAP_API_B_ID=""
LEGACY_WAS_RUNNING=false
LEGACY_STOPPED_BY_DEPLOY=false
LEGACY_CONTAINER_ID=""
PREFLIGHT_LEGACY_CONTAINER_ID=""
PUBLISHED_GATEWAY_ID=""
WEB_WAS_RUNNING=false
WEB_REPLACEMENT_STARTED=false
WEB_UPDATED=false
WEB_PREVIOUS_PRESERVED=false
OLD_WEB_CONTAINER_ID=""
NEW_WEB_CONTAINER_ID=""
OLD_API_A_CONTAINER_ID=""
OLD_API_B_CONTAINER_ID=""
OLD_GATEWAY_CONTAINER_ID=""
NEW_API_A_CONTAINER_ID=""
NEW_API_B_CONTAINER_ID=""
NEW_GATEWAY_CONTAINER_ID=""
DEPLOY_LOCK_HELD=false
DEPLOY_LOCK_DIR_ID=""
DEPLOY_LOCK_OWNER_ID=""
ACTIVE_JOURNAL_CREATED=false
ACTIVE_JOURNAL_ID=""
MIGRATION_ACL_UNRESOLVED=false
MIGRATION_PUBLICATION_GATE_ACTIVE=false
MIGRATION_GATEWAY_QUIESCED=false
MIGRATION_LEGACY_QUIESCED=false
DAEMON_MUTATION_IN_FLIGHT=false
DAEMON_MUTATION_UNRESOLVED=false
TOPOLOGY_DRIFT_UNRESOLVED=false
SECRET_CLEANUP_UNRESOLVED=false
DAEMON_MUTATION_SEQUENCE=0
DAEMON_MUTATION_INTENT=""
POSTCOMMIT_CLEANUP_PENDING=false
RUNTIME_ENV_FILE=""
RUNTIME_INSPECT_FILE=""
CREATED_CONTAINER_ID=""
API_A_RUNTIME_ENV_FILE="$PRIVATE_RUNTIME_ROOT/api_a.candidate.env"
API_B_RUNTIME_ENV_FILE="$PRIVATE_RUNTIME_ROOT/api_b.candidate.env"
GATEWAY_RUNTIME_ENV_FILE="$PRIVATE_RUNTIME_ROOT/api_gateway.candidate.env"
WEB_RUNTIME_ENV_FILE="$PRIVATE_RUNTIME_ROOT/web.candidate.env"

mkdir -p "$STATE_ROOT"
if [ ! -d "$STATE_ROOT" ] || [ -L "$STATE_ROOT" ]; then
    printf '%s\n' "ERROR: deployment state root is not a safe directory: $STATE_ROOT" >&2
    exit 1
fi
chmod 700 "$STATE_ROOT"
STATE_ROOT_ID=$(stat -c '%d:%i' "$STATE_ROOT") || exit 1

record_state() {
    local key="$1"
    local value="$2"
    printf '%s=%s\n' "$key" "$value" >> "$STATE_FILE"
    "$SYNC_COMMAND" -f "$STATE_FILE" 2>/dev/null || "$SYNC_COMMAND"
}

create_deployment_state_directory() {
    if ! mkdir "$DEPLOYMENT_DIR" 2>/dev/null; then
        printf '%s\n' "ERROR: deployment state directory already exists: $DEPLOYMENT_DIR" >&2
        return 1
    fi
    chmod 700 "$DEPLOYMENT_DIR" || return 1
    DEPLOYMENT_DIR_ID=$(stat -c '%d:%i' "$DEPLOYMENT_DIR") || return 1
    record_state "deployment.id" "$DEPLOYMENT_ID" || return 1
    record_state "deployment.directory_identity" "$DEPLOYMENT_DIR_ID" || return 1
}

create_private_runtime_root() {
    if [ "$TEST_MODE" = "1" ]; then
        [ ! -e "$PRIVATE_RUNTIME_ROOT" ] && [ ! -L "$PRIVATE_RUNTIME_ROOT" ] \
            || return 1
        mkdir "$PRIVATE_RUNTIME_ROOT" || return 1
        chmod 700 "$PRIVATE_RUNTIME_ROOT" || return 1
    else
        [ -d /run ] && [ ! -L /run ] \
            && [ "$(/usr/bin/stat -c '%u:%g' /run)" = 0:0 ] \
            && [ "$(/usr/bin/stat -f -c '%T' /run)" = tmpfs ] || return 1
        if [ ! -e /run/diva-player-rolling ] && [ ! -L /run/diva-player-rolling ]; then
            /usr/bin/mkdir -m 700 /run/diva-player-rolling || return 1
        fi
        [ -d /run/diva-player-rolling ] && [ ! -L /run/diva-player-rolling ] \
            && [ "$(/usr/bin/stat -c '%u:%g:%a' /run/diva-player-rolling)" = 0:0:700 ] \
            || return 1
        /usr/bin/mkdir -m 700 "$PRIVATE_RUNTIME_ROOT" || return 1
    fi
    PRIVATE_RUNTIME_ROOT_ID=$(stat -c '%d:%i' "$PRIVATE_RUNTIME_ROOT") || return 1
    record_state "private_runtime.path" "$PRIVATE_RUNTIME_ROOT" || return 1
    record_state "private_runtime.identity" "$PRIVATE_RUNTIME_ROOT_ID" || return 1
    record_state "private_runtime.status" "ready-before-secret-capture" || return 1
}

contract_value() {
    local key="$1"
    awk -F= -v expected="$key" '$1 == expected { print substr($0, length($1) + 2) }' \
        "$STATEFUL_RUNTIME_CONTRACT"
}

stateful_compose_projection_sha256() {
    run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" "$PYTHON_COMMAND" -I -c '
import copy
import hashlib
import json
import subprocess
import sys

docker, project, compose_file = sys.argv[1:]
result = subprocess.run(
    [docker, "compose", "--project-name", project, "-f", compose_file,
     "config", "--format", "json"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)
if result.returncode != 0 or len(result.stdout) > 4 * 1024 * 1024:
    raise SystemExit(2)
configuration = json.loads(result.stdout)
services_source = configuration.get("services")
all_volumes = configuration.get("volumes") or {}
all_networks = configuration.get("networks") or {}
if not isinstance(services_source, dict) or not isinstance(all_volumes, dict) \
        or not isinstance(all_networks, dict):
    raise SystemExit(2)
services = {}
volume_sources = set()
network_sources = set()
for service_name in ("postgres", "qdrant"):
    service = services_source.get(service_name)
    if not isinstance(service, dict):
        raise SystemExit(2)
    service = copy.deepcopy(service)
    environment = service.get("environment")
    if environment is not None:
        if not isinstance(environment, dict):
            raise SystemExit(2)
        service["environment"] = {
            key: hashlib.sha256(
                json.dumps([key, value], ensure_ascii=True,
                           separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            for key, value in sorted(environment.items())
        }
    mounts = service.get("volumes") or []
    if not isinstance(mounts, list):
        raise SystemExit(2)
    for mount in mounts:
        if not isinstance(mount, dict):
            raise SystemExit(2)
        if mount.get("type") == "volume":
            source = mount.get("source")
            if not isinstance(source, str) or not source:
                raise SystemExit(2)
            volume_sources.add(source)
    networks = service.get("networks") or {}
    if isinstance(networks, dict):
        network_sources.update(networks)
    elif isinstance(networks, list) and all(isinstance(value, str) for value in networks):
        network_sources.update(networks)
    else:
        raise SystemExit(2)
    services[service_name] = service

def referenced_definitions(definitions, sources):
    selected = {}
    for source in sorted(sources):
        matches = [
            key for key, value in definitions.items()
            if key == source or (isinstance(value, dict) and value.get("name") == source)
        ]
        if len(set(matches)) != 1:
            raise SystemExit(2)
        key = matches[0]
        selected[key] = definitions[key]
    return selected

projection = {
    "schema": 1,
    "services": services,
    "volumes": referenced_definitions(all_volumes, volume_sources),
    "networks": referenced_definitions(all_networks, network_sources),
}
encoded = (json.dumps(projection, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":")) + "\n").encode("utf-8")
print(hashlib.sha256(encoded).hexdigest())
' "$DOCKER_COMMAND" "$COMPOSE_PROJECT" "$COMPOSE_FILE"
}

validate_stateful_runtime_contract() {
    local state_metadata contract_metadata state_uid state_gid
    local expected_keys actual_keys contract_digest compose_digest compose_digest_after
    local contract_qdrant_id contract_postgres_id contract_postgres_migrate_id
    local observed_qdrant_id observed_postgres_id observed_postgres_migrate_id
    local contract_player_commit current ancestor ancestor_metadata ancestor_uid ancestor_mode

    if [ ! -f "$STATEFUL_RUNTIME_CONTRACT" ] || [ -L "$STATEFUL_RUNTIME_CONTRACT" ]; then
        fail "Completed stateful runtime contract is missing or unsafe: $STATEFUL_RUNTIME_CONTRACT"
        return 1
    fi
    state_metadata=$(stat -c '%u:%g:%a:%h' "$STATE_ROOT") || return 1
    contract_metadata=$(stat -c '%u:%g:%a:%h' "$STATEFUL_RUNTIME_CONTRACT") || return 1
    state_uid=${state_metadata%%:*}
    state_metadata=${state_metadata#*:}
    state_gid=${state_metadata%%:*}
    case "$contract_metadata" in
        "$state_uid:$state_gid:600:1") ;;
        *)
            fail "Stateful runtime contract owner, mode, or link count is unsafe"
            return 1
            ;;
    esac
    if [ "$TEST_MODE" != "1" ]; then
        current="$STATE_ROOT"
        while :; do
            [ ! -L "$current" ] || {
                fail "Stateful runtime contract ancestry contains a symlink: $current"
                return 1
            }
            ancestor_metadata=$(stat -c '%u:%a' "$current") || return 1
            ancestor_uid=${ancestor_metadata%%:*}
            ancestor_mode=${ancestor_metadata#*:}
            case "$ancestor_uid" in
                0|"$state_uid") ;;
                *)
                    fail "Stateful runtime contract ancestry has an untrusted owner: $current"
                    return 1
                    ;;
            esac
            case "$ancestor_mode" in
                *[2367][0-7]|*[0-7][2367])
                    fail "Stateful runtime contract ancestry is group/world writable: $current"
                    return 1
                    ;;
            esac
            [ "$current" = / ] && break
            ancestor=$(dirname -- "$current")
            [ "$ancestor" != "$current" ] || break
            current="$ancestor"
        done
    fi

    expected_keys='schema
status
run
qdrant_stable_tag
qdrant_image_id
postgres_image_reference
postgres_image_id
postgres_migrate_image_reference
postgres_migrate_image_id
qdrant_image_scan_receipt_sha256
qdrant_audit_image_scan_receipt_sha256
postgres_image_scan_receipt_sha256
postgres_migrate_image_scan_receipt_sha256
postgres_dockerfile_sha256
postgres_schema_sha256
postgres_source_bundle_sha256
postgres_migrate_dockerfile_sha256
stateful_compose_projection_sha256
promotion_manifest_sha256
player_commit
pipeline_commit'
    actual_keys=$(awk -F= 'NF >= 2 { print $1; next } { print "__invalid__" }' \
        "$STATEFUL_RUNTIME_CONTRACT") || return 1
    if [ "$actual_keys" != "$expected_keys" ]; then
        fail "Stateful runtime contract has an unexpected key set or ordering"
        return 1
    fi
    [ "$(contract_value schema)" = 1 ] \
        && [ "$(contract_value status)" = completed ] \
        && printf '%s\n' "$(contract_value run)" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9]+$' \
        && [ "$(contract_value qdrant_stable_tag)" = "$QDRANT_STABLE_IMAGE" ] \
        && [ "$(contract_value postgres_image_reference)" = "$POSTGRES_STABLE_IMAGE" ] \
        && [ "$(contract_value postgres_migrate_image_reference)" \
            = "$POSTGRES_MIGRATE_STABLE_IMAGE" ] \
        || {
            fail "Stateful runtime contract identity fields are invalid"
            return 1
        }
    contract_qdrant_id=$(contract_value qdrant_image_id)
    contract_postgres_id=$(contract_value postgres_image_id)
    contract_postgres_migrate_id=$(contract_value postgres_migrate_image_id)
    contract_player_commit=$(contract_value player_commit)
    for contract_image_id in "$contract_qdrant_id" "$contract_postgres_id" \
        "$contract_postgres_migrate_id"; do
        printf '%s\n' "$contract_image_id" | grep -Eq '^sha256:[0-9a-f]{64}$' || {
                fail "Stateful runtime contract image IDs are invalid"
                return 1
            }
    done
    for contract_sha256 in "$(contract_value qdrant_image_scan_receipt_sha256)" \
        "$(contract_value qdrant_audit_image_scan_receipt_sha256)" \
        "$(contract_value postgres_image_scan_receipt_sha256)" \
        "$(contract_value postgres_migrate_image_scan_receipt_sha256)" \
        "$(contract_value postgres_dockerfile_sha256)" \
        "$(contract_value postgres_schema_sha256)" \
        "$(contract_value postgres_source_bundle_sha256)" \
        "$(contract_value postgres_migrate_dockerfile_sha256)" \
        "$(contract_value stateful_compose_projection_sha256)" \
        "$(contract_value promotion_manifest_sha256)"; do
        printf '%s\n' "$contract_sha256" | grep -Eq '^[0-9a-f]{64}$' || {
                fail "Stateful runtime contract digests are invalid"
                return 1
            }
    done
    for contract_commit in "$contract_player_commit" "$(contract_value pipeline_commit)"; do
        printf '%s\n' "$contract_commit" | grep -Eq '^[0-9a-f]{40}$' || {
                fail "Stateful runtime contract commit IDs are invalid"
                return 1
            }
    done
    if ! trusted_git merge-base --is-ancestor \
        "$contract_player_commit" "$GIT_COMMIT"; then
        fail "Stateful runtime contract player commit is not an ancestor of this release"
        return 1
    fi
    if [ ! -f "$COMPOSE_FILE" ] || [ -L "$COMPOSE_FILE" ]; then
        fail "Primary Compose file is missing or unsafe"
        return 1
    fi
    compose_digest=$(stateful_compose_projection_sha256) || {
        mark_daemon_unresolved "stateful-compose-projection-query-failed"
        return 1
    }
    if [ "$compose_digest" != "$(contract_value stateful_compose_projection_sha256)" ]; then
        fail "Stateful Compose projection does not match the completed runtime contract"
        return 1
    fi
    observed_qdrant_id=$(image_ref_id "$QDRANT_STABLE_IMAGE") || return 1
    observed_postgres_id=$(image_ref_id "$POSTGRES_STABLE_IMAGE") || return 1
    observed_postgres_migrate_id=$(image_ref_id "$POSTGRES_MIGRATE_STABLE_IMAGE") \
        || return 1
    if [ "$observed_qdrant_id" != "$contract_qdrant_id" ] \
        || [ "$observed_postgres_id" != "$contract_postgres_id" ] \
        || [ "$observed_postgres_migrate_id" != "$contract_postgres_migrate_id" ]; then
        fail "Stateful Docker image references drifted from the completed runtime contract"
        return 1
    fi
    contract_digest=$(sha256sum "$STATEFUL_RUNTIME_CONTRACT" | awk '{print $1}') \
        || return 1
    compose_digest_after=$(stateful_compose_projection_sha256) || {
        mark_daemon_unresolved "stateful-compose-projection-recheck-failed"
        return 1
    }
    if [ "$contract_digest" != "$(sha256sum "$STATEFUL_RUNTIME_CONTRACT" | awk '{print $1}')" ] \
        || [ "$compose_digest_after" != "$compose_digest" ]; then
        fail "Stateful runtime contract or Compose projection changed during validation"
        return 1
    fi
    if [ -e "$STATEFUL_ACTIVE_JOURNAL" ] || [ -L "$STATEFUL_ACTIVE_JOURNAL" ] \
        || [ -e "$STATEFUL_LOCK_DIR" ] || [ -L "$STATEFUL_LOCK_DIR" ]; then
        fail "Stateful hardening became active while its runtime contract was validated"
        return 1
    fi
    record_state "stateful_runtime_contract.sha256" "$contract_digest"
    record_state "stateful_runtime_contract.qdrant_image_id" "$contract_qdrant_id"
    record_state "stateful_runtime_contract.postgres_image_id" "$contract_postgres_id"
    record_state "stateful_runtime_contract.postgres_migrate_image_id" \
        "$contract_postgres_migrate_id"
}

begin_daemon_mutation() {
    local intent="$1"
    if [ "$DAEMON_MUTATION_UNRESOLVED" = "true" ] \
        || [ -e "$DAEMON_UNRESOLVED_FILE" ] || [ -L "$DAEMON_UNRESOLVED_FILE" ]; then
        record_state "daemon_mutation.rejected" "prior-request-unresolved"
        return 125
    fi
    DAEMON_MUTATION_SEQUENCE=$((DAEMON_MUTATION_SEQUENCE + 1))
    DAEMON_MUTATION_INTENT="$intent"
    DAEMON_MUTATION_IN_FLIGHT=true
    record_state "daemon_mutation.$DAEMON_MUTATION_SEQUENCE.intent" "$intent"
    record_state "daemon_mutation.$DAEMON_MUTATION_SEQUENCE.phase" "submitted-possible"
}

mark_daemon_unresolved() {
    local reason="$1"
    DAEMON_MUTATION_UNRESOLVED=true
    if [ ! -e "$DAEMON_UNRESOLVED_FILE" ] && [ ! -L "$DAEMON_UNRESOLVED_FILE" ]; then
        (umask 077; set -C; printf '%s\n' "$reason" > "$DAEMON_UNRESOLVED_FILE") \
            2>/dev/null || true
        "$SYNC_COMMAND" -f "$DAEMON_UNRESOLVED_FILE" 2>/dev/null || "$SYNC_COMMAND" || true
        "$SYNC_COMMAND" -f "$DEPLOYMENT_DIR" 2>/dev/null || "$SYNC_COMMAND" || true
    fi
    record_state "daemon_mutation.terminal_release" \
        "forbidden-$reason" || true
}

complete_daemon_mutation() {
    record_state "daemon_mutation.$DAEMON_MUTATION_SEQUENCE.phase" "client-exit-zero"
    DAEMON_MUTATION_IN_FLIGHT=false
    DAEMON_MUTATION_INTENT=""
}

fail_daemon_mutation() {
    local rc="$1"
    mark_daemon_unresolved \
        "${DAEMON_MUTATION_INTENT:-unknown}-client-exit-$rc"
    record_state "daemon_mutation.$DAEMON_MUTATION_SEQUENCE.phase" \
        "unresolved-client-exit-$rc-terminal-release-forbidden" || true
    DAEMON_MUTATION_IN_FLIGHT=false
    return "$rc"
}

log() {
    printf '%s\n' "$*"
}

fail() {
    if [ -d "$DEPLOYMENT_DIR" ] && [ ! -L "$DEPLOYMENT_DIR" ]; then
        record_state "failure" "$1" || true
    fi
    printf '%s\n' "ERROR: $1" >&2
    return 1
}

mark_topology_drift_unresolved() {
    local reason="$1"
    TOPOLOGY_DRIFT_UNRESOLVED=true
    record_state "topology_drift.interlock" "$reason" || true
}

mark_slot_updated() {
    local slot="$1"
    local updated="$2"
    case "$slot" in
        api_a) API_A_UPDATED="$updated" ;;
        api_b) API_B_UPDATED="$updated" ;;
        *) return 1 ;;
    esac
}

clear_active_slot() {
    ACTIVE_SLOT=""
    ACTIVE_SLOT_PREVIOUS_STATE="unknown"
    ACTIVE_SLOT_ROUTE_DISABLED=false
    ACTIVE_SLOT_CONTAINER_MUTATED=false
}

run_test_hook() {
    local phase="$1"
    if [ -z "$HOOK_COMMAND" ]; then
        return 0
    fi
    if ! env DIVA_DEPLOYMENT_PID="$$" \
        DIVA_PRIVATE_BACKEND_ENV_FILE="$PRIVATE_BACKEND_ENV_FILE" \
        DIVA_DEPLOY_LOCK_DIR="$DEPLOY_LOCK_DIR" \
        "$HOOK_COMMAND" "$phase"; then
        record_state "hook.failure" "$phase"
        exit 97
    fi
}

handle_signal() {
    local signal_name="$1"
    local exit_code="$2"
    record_state "deployment.signal" "$signal_name"
    exit "$exit_code"
}

retire_private_backend_environment() {
    if [ -z "$PRIVATE_BACKEND_ENV_ID" ]; then
        [ ! -e "$PRIVATE_BACKEND_ENV_FILE" ] && [ ! -L "$PRIVATE_BACKEND_ENV_FILE" ]
        return $?
    fi
    run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" "$EXACT_PYTHON_COMMAND" -I -c '
import os
import stat
import sys

path, expected_raw, expected_parent, expected_parent_raw, allow_current = sys.argv[1:]
parent = os.path.dirname(path)
name = os.path.basename(path)
if parent != expected_parent or os.path.realpath(parent) != os.path.realpath(expected_parent):
    raise SystemExit(2)
expected_parts = expected_raw.split(":")
parent_parts = expected_parent_raw.split(":")
if len(expected_parts) != 5 or len(parent_parts) != 2:
    raise SystemExit(2)
expected = (
    int(expected_parts[0]), int(expected_parts[1]), int(expected_parts[2]),
    int(expected_parts[3], 16), int(expected_parts[4]),
)
expected_parent_identity = tuple(int(value) for value in parent_parts)
if allow_current == "1" and os.name == "nt":
    # The Windows-focused harness executes this same Python retirement path,
    # but Windows has no dir_fd operations. Production never enters this
    # adapter; Linux continues through the descriptor-relative implementation.
    parent_info = os.lstat(parent)
    if (parent_info.st_dev, parent_info.st_ino) != expected_parent_identity \
            or not stat.S_ISDIR(parent_info.st_mode):
        raise RuntimeError("private deployment directory is unsafe")
    tombstone_path = os.path.join(parent, ".backend.env.private.retiring")
    source_path = path
    if os.path.lexists(tombstone_path):
        if os.path.lexists(path):
            raise RuntimeError("private environment retirement paths conflict")
        source_path = tombstone_path
    opened = os.lstat(source_path)
    identity = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink)
    comparable_expected = (expected[0], expected[1], expected[2], expected[4])
    if identity != comparable_expected or not stat.S_ISREG(opened.st_mode):
        raise RuntimeError("private environment identity changed")
    if source_path == path:
        os.rename(path, tombstone_path)
        moved = os.lstat(tombstone_path)
        if (moved.st_dev, moved.st_ino, moved.st_size, moved.st_nlink) != identity:
            os.rename(tombstone_path, path)
            raise RuntimeError("private environment rename did not preserve identity")
    os.unlink(tombstone_path)
    if os.path.lexists(path):
        raise RuntimeError("private environment path survived retirement")
    raise SystemExit(0)
flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
directory_flags = flags | getattr(os, "O_DIRECTORY", 0)
directory = os.open(parent, directory_flags)
descriptor = None
tombstone = ".backend.env.private.retiring"
try:
    parent_info = os.fstat(directory)
    expected_uid = os.getuid() if allow_current == "1" and hasattr(os, "getuid") else 0
    if (parent_info.st_dev, parent_info.st_ino) != expected_parent_identity \
            or not stat.S_ISDIR(parent_info.st_mode) \
            or (hasattr(os, "getuid") and parent_info.st_uid != expected_uid) \
            or (allow_current != "1" and parent_info.st_mode & 0o077):
        raise RuntimeError("private deployment directory is unsafe")
    source_name = name
    try:
        os.stat(tombstone, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        try:
            os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            source_name = tombstone
        else:
            raise RuntimeError("private environment retirement paths conflict")
    descriptor = os.open(source_name, flags, dir_fd=directory)
    opened = os.fstat(descriptor)
    identity = (opened.st_dev, opened.st_ino, opened.st_size,
                opened.st_mode, opened.st_nlink)
    if identity != expected or not stat.S_ISREG(opened.st_mode) \
            or opened.st_mode & 0o077:
        raise RuntimeError("private environment identity changed")
    if source_name == name:
        os.rename(name, tombstone, src_dir_fd=directory, dst_dir_fd=directory)
        moved = os.stat(tombstone, dir_fd=directory, follow_symlinks=False)
        moved_identity = (moved.st_dev, moved.st_ino, moved.st_size,
                          moved.st_mode, moved.st_nlink)
        if moved_identity != identity:
            try:
                os.rename(tombstone, name, src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            finally:
                raise RuntimeError("private environment rename did not preserve identity")
    os.unlink(tombstone, dir_fd=directory)
    os.fsync(directory)
    try:
        os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError("private environment path survived retirement")
finally:
    if descriptor is not None:
        os.close(descriptor)
    os.close(directory)
' "$PRIVATE_BACKEND_ENV_FILE" "$PRIVATE_BACKEND_ENV_ID" "$PRIVATE_RUNTIME_ROOT" \
        "$PRIVATE_RUNTIME_ROOT_ID" "$TEST_MODE" || return 1
    PRIVATE_BACKEND_ENV_ID=""
    record_state "backend_env.private_cleanup" "durable-exact-inode-unlink" || return 1
}

retire_private_runtime_root() {
    if [ -z "$PRIVATE_RUNTIME_ROOT_ID" ]; then
        [ ! -e "$PRIVATE_RUNTIME_ROOT" ] && [ ! -L "$PRIVATE_RUNTIME_ROOT" ]
        return $?
    fi
    run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" "$EXACT_PYTHON_COMMAND" -I -c '
import os
import stat
import sys

path, expected_raw, allow_current = sys.argv[1:]
parent = os.path.dirname(path)
name = os.path.basename(path)
expected = tuple(int(value) for value in expected_raw.split(":"))
if len(expected) != 2:
    raise SystemExit(2)
allowed = {
    "api_a.candidate.env", "api_b.candidate.env",
    "api_gateway.candidate.env", "web.candidate.env",
    "resolved-compose.private.json",
    "api_a.runtime.inspect.json", "api_b.runtime.inspect.json",
    "api_gateway.runtime.inspect.json", "web.runtime.inspect.json",
    "api_a.runtime.verify.json", "api_b.runtime.verify.json",
    "api_gateway.runtime.verify.json", "web.runtime.verify.json",
}
if allow_current == "1" and os.name == "nt":
    info = os.lstat(path)
    if (info.st_dev, info.st_ino) != expected or not stat.S_ISDIR(info.st_mode):
        raise RuntimeError("private runtime directory identity changed")
    entries = os.listdir(path)
    if any(entry not in allowed for entry in entries):
        raise RuntimeError("private runtime directory contains an unexpected entry")
    for entry in entries:
        entry_path = os.path.join(path, entry)
        item = os.lstat(entry_path)
        if not stat.S_ISREG(item.st_mode) or item.st_nlink != 1:
            raise RuntimeError("private runtime artifact is unsafe")
        os.unlink(entry_path)
    if os.listdir(path):
        raise RuntimeError("private runtime directory did not become empty")
    os.rmdir(path)
    raise SystemExit(0)
directory_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | getattr(os, "O_DIRECTORY", 0)
parent_fd = os.open(parent, directory_flags)
directory_fd = None
try:
    directory_fd = os.open(name, directory_flags, dir_fd=parent_fd)
    info = os.fstat(directory_fd)
    expected_uid = os.getuid() if allow_current == "1" and hasattr(os, "getuid") else 0
    if (info.st_dev, info.st_ino) != expected or not stat.S_ISDIR(info.st_mode) \
            or (hasattr(os, "getuid") and info.st_uid != expected_uid) \
            or (allow_current != "1" and (info.st_gid != 0 or info.st_mode & 0o077)):
        raise RuntimeError("private runtime directory identity changed")
    entries = os.listdir(directory_fd)
    if any(entry not in allowed for entry in entries):
        raise RuntimeError("private runtime directory contains an unexpected entry")
    file_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    for entry in entries:
        descriptor = os.open(entry, file_flags, dir_fd=directory_fd)
        try:
            item = os.fstat(descriptor)
            if not stat.S_ISREG(item.st_mode) \
                    or (hasattr(os, "getuid") and item.st_uid != expected_uid) \
                    or item.st_nlink != 1 \
                    or (allow_current != "1" and (item.st_gid != 0 or item.st_mode & 0o077)):
                raise RuntimeError("private runtime artifact is unsafe")
        finally:
            os.close(descriptor)
        os.unlink(entry, dir_fd=directory_fd)
    os.fsync(directory_fd)
    if os.listdir(directory_fd):
        raise RuntimeError("private runtime directory did not become empty")
    os.rmdir(name, dir_fd=parent_fd)
    os.fsync(parent_fd)
finally:
    if directory_fd is not None:
        os.close(directory_fd)
    os.close(parent_fd)
' "$PRIVATE_RUNTIME_ROOT" "$PRIVATE_RUNTIME_ROOT_ID" "$TEST_MODE" || return 1
    PRIVATE_RUNTIME_ROOT_ID=""
    record_state "backend_env.private_runtime_cleanup" "durable-tmpfs-dirfd-release" \
        || return 1
}

mark_secret_cleanup_unresolved() {
    SECRET_CLEANUP_UNRESOLVED=true
    record_state "backend_env.private_cleanup" \
        "failed-exact-inode-unlink-deploy-lock-retained" || true
    record_state "deployment.interlock" \
        "private-secret-cleanup-unresolved-active-journal-and-lock-retained" || true
    printf '%s\n' \
        "Private backend environment could not be durably retired. Preserve $PRIVATE_RUNTIME_ROOT, $ACTIVE_JOURNAL, $DEPLOY_LOCK_DIR, and $DEPLOYMENT_DIR for manual reconciliation." >&2
}

retire_private_backend_environment_or_mark() {
    if ! retire_private_backend_environment \
        || ! retire_private_runtime_root; then
        mark_secret_cleanup_unresolved
        return 1
    fi
}

terminal_secret_cleanup() {
    local terminal_exit_code="$1"
    trap - 0
    if ! retire_private_backend_environment_or_mark; then
        terminal_exit_code=1
    fi
    exit "$terminal_exit_code"
}

cleanup() {
    local original_exit_code="$1"
    local recovery_result=0
    local bootstrap_gateway_current_id=""
    trap - 0
    # cleanup itself is deliberately complex recovery code. This secondary
    # EXIT guard guarantees that an unexpected error/exit in any recovery
    # helper still retires the captured credential inode before termination.
    trap 'terminal_secret_cleanup $?' 0
    trap '' HUP INT TERM

    # Resolved Compose environment contains database/API credentials.  It is
    # needed only while docker create reads it and must never survive success,
    # failure, signal handling, or a daemon fail-stop branch.
    for runtime_secret in "$RUNTIME_ENV_FILE" "$RUNTIME_INSPECT_FILE" \
        "$API_A_RUNTIME_ENV_FILE" "$API_B_RUNTIME_ENV_FILE" \
        "$GATEWAY_RUNTIME_ENV_FILE" "$WEB_RUNTIME_ENV_FILE" \
        "$RESOLVED_COMPOSE_FILE"; do
        [ -n "$runtime_secret" ] || continue
        rm -f -- "$runtime_secret" >/dev/null 2>&1 || true
    done
    RUNTIME_ENV_FILE=""
    RUNTIME_INSPECT_FILE=""

    if [ "$DAEMON_MUTATION_IN_FLIGHT" = "true" ]; then
        mark_daemon_unresolved \
            "${DAEMON_MUTATION_INTENT:-unknown}-worker-interrupted"
        record_state "daemon_mutation.interrupted" \
            "${DAEMON_MUTATION_INTENT:-unknown}-terminal-release-forbidden" || true
    fi
    if [ "$API_BRIDGE_PUBLICATION_ARMED" = "true" ]; then
        if [ -f "$API_BRIDGE_RECEIPT" ] && [ ! -L "$API_BRIDGE_RECEIPT" ] \
            && [ -n "$API_BRIDGE_PREPARED_SHA" ] \
            && "$PYTHON_COMMAND" -I \
                "$SOURCE_SNAPSHOT_ROOT/scripts/sbc-api-bridge-publication.py" reconcile \
                --prepared "$API_BRIDGE_PREPARED_RECEIPT" \
                --canonical "$API_BRIDGE_RECEIPT" \
                --expected-sha256 "$API_BRIDGE_PREPARED_SHA" >/dev/null
        then
            # Receipt publication is the one-way bridge commit point.  A
            # signal between link(2) and the in-memory flag update must never
            # roll the exact APIs back underneath a durable canonical receipt.
            API_BRIDGE_PUBLISHED=true
            DEPLOYMENT_SUCCEEDED=true
            CANONICAL_IMAGES_COMMITTED=true
            RECOVERY_ARMED=false
            record_state "bridge.receipt_reconciled" \
                "$API_BRIDGE_PREPARED_SHA" || true
        elif [ -e "$API_BRIDGE_RECEIPT" ] || [ -L "$API_BRIDGE_RECEIPT" ]; then
            # An unexpected canonical object at the publication boundary is
            # ambiguous. Preserve the new topology and journal for manual
            # reconciliation; neither rollback nor unlink is safe.
            DEPLOYMENT_SUCCEEDED=true
            CANONICAL_IMAGES_COMMITTED=true
            RECOVERY_ARMED=false
            TOPOLOGY_DRIFT_UNRESOLVED=true
            recovery_result=1
            record_state "bridge.receipt_reconciliation" \
                "unresolved-canonical-object-preserved" || true
        else
            API_BRIDGE_PUBLICATION_ARMED=false
        fi
    fi
    if [ "$DAEMON_MUTATION_UNRESOLVED" = "true" ] \
        || [ -e "$DAEMON_UNRESOLVED_FILE" ] || [ -L "$DAEMON_UNRESOLVED_FILE" ]; then
        record_state "deployment.status" \
            "daemon-unresolved-fail-stop-manual-reconciliation-required" || true
        record_state "recovery.status" \
            "forbidden-no-conflicting-daemon-mutation" || true
        if [ "$ACTIVE_JOURNAL_CREATED" = "true" ]; then
            record_state "deployment.interlock" \
                "active-journal-and-deploy-lock-retained" || true
        fi
        printf '%s\n' \
            "Daemon mutation settlement is unresolved. No rollback or cleanup was attempted; preserve $ACTIVE_JOURNAL and $DEPLOYMENT_DIR." >&2
        retire_private_backend_environment_or_mark || true
        exit 1
    fi
    if [ "$TOPOLOGY_DRIFT_UNRESOLVED" = "true" ]; then
        recovery_result=1
        record_state "deployment.interlock" \
            "active-journal-and-deploy-lock-retained-after-unowned-topology-drift" || true
    fi

    if [ "$MIGRATION_ACL_UNRESOLVED" = "true" ]; then
        record_state "migration.acl_reconciliation" "cleanup-started"
        if reconcile_migration_acl_after_run; then
            record_state "migration.acl_reconciliation" "cleanup-verified"
        else
            record_state "migration.acl_reconciliation" \
                "unresolved-manual-intervention-required"
            recovery_result=1
        fi
    fi
    if [ "$MIGRATION_ACL_UNRESOLVED" != "true" ] \
        && [ "$MIGRATION_PUBLICATION_GATE_ACTIVE" = "true" ]; then
        restore_migration_publication || recovery_result=1
    fi

    if [ "$CANDIDATE_STARTED" = "true" ]; then
        remove_candidate_gateway || recovery_result=1
    fi
    if [ "$CANDIDATE_API_A_STARTED" = "true" ] \
        || [ "$CANDIDATE_API_B_STARTED" = "true" ]; then
        remove_candidate_api || recovery_result=1
    fi
    if [ "$CANDIDATE_WEB_STARTED" = "true" ]; then
        remove_candidate_web || recovery_result=1
    fi
    if [ "$DEPLOYMENT_SUCCEEDED" != "true" ]; then
        set +e
        if [ "$RECOVERY_ARMED" = "true" ] && [ "$RECOVERY_RUNNING" != "true" ]; then
            RECOVERY_RUNNING=true
            record_state "recovery.status" "started"

            # Restore the old gateway first if its replacement may have taken
            # ownership of the public port. API slots can then be rolled back
            # through the known routing topology.
            if [ "$GATEWAY_REPLACEMENT_STARTED" = "true" ]; then
                if rollback_gateway "$API_A_STATE" "$API_B_STATE"; then
                    GATEWAY_REPLACEMENT_STARTED=false
                    GATEWAY_UPDATED=false
                else
                    recovery_result=1
                fi
            fi

            if [ -n "$ACTIVE_SLOT" ]; then
                if [ "$ACTIVE_SLOT_CONTAINER_MUTATED" = "true" ]; then
                    rollback_slot "$ACTIVE_SLOT" "$ACTIVE_SLOT_PREVIOUS_STATE" \
                        || recovery_result=1
                elif [ "$ACTIVE_SLOT_ROUTE_DISABLED" = "true" ]; then
                    if restore_slot_route "$ACTIVE_SLOT" "$ACTIVE_SLOT_PREVIOUS_STATE"; then
                        clear_active_slot
                    else
                        recovery_result=1
                    fi
                else
                    clear_active_slot
                fi
            fi

            rollback_updated_slots "$API_B_UPDATED" "$API_A_UPDATED" \
                "$API_A_STATE" "$API_B_STATE" || recovery_result=1

            if [ "$recovery_result" -eq 0 ]; then
                record_state "recovery.status" "completed"
            else
                record_state "recovery.status" "incomplete-manual-intervention-required"
            fi
        fi
        if [ "$BOOTSTRAP_RECOVERY_ARMED" = "true" ]; then
            record_state "bootstrap.recovery" "started"
            if [ "$BOOTSTRAP_GATEWAY_MUTATED" = "true" ]; then
                if [ -z "$BOOTSTRAP_GATEWAY_ID" ]; then
                    # A mutating request was submitted but no exact identity
                    # was durably pinned. Never guess which container to undo.
                    recovery_result=1
                elif ! bootstrap_gateway_current_id=$(container_id "$GATEWAY_CONTAINER"); then
                    recovery_result=1
                elif [ "$bootstrap_gateway_current_id" != "$BOOTSTRAP_GATEWAY_ID" ]; then
                    recovery_result=1
                else
                    run_bounded_docker_mutation rm -f "$BOOTSTRAP_GATEWAY_ID" \
                        >/dev/null 2>&1 || recovery_result=1
                    wait_container_mapping "$GATEWAY_CONTAINER" "" \
                        || recovery_result=1
                fi
            fi
            if [ "$LEGACY_STOPPED_BY_DEPLOY" = "true" ]; then
                if [ -n "$LEGACY_CONTAINER_ID" ]; then
                    run_bounded_docker_mutation start "$LEGACY_CONTAINER_ID" \
                        >/dev/null 2>&1 || recovery_result=1
                    wait_container_running_id "$LEGACY_CONTAINER_ID" true \
                        || recovery_result=1
                else
                    recovery_result=1
                fi
            fi
            for bootstrap_slot in api_b api_a; do
                case "$bootstrap_slot" in
                    api_a) bootstrap_id="$BOOTSTRAP_API_A_ID" ;;
                    api_b) bootstrap_id="$BOOTSTRAP_API_B_ID" ;;
                esac
                if [ -n "$bootstrap_id" ]; then
                    if [ "$(container_id "vocadb_$bootstrap_slot")" != "$bootstrap_id" ]; then
                        recovery_result=1
                        continue
                    fi
                    run_bounded_docker_mutation rm -f "$bootstrap_id" \
                        >/dev/null 2>&1 || recovery_result=1
                    wait_container_mapping "vocadb_$bootstrap_slot" "" \
                        || recovery_result=1
                elif [ -n "$(container_id "vocadb_$bootstrap_slot")" ]; then
                    # Never remove an unjournaled identity discovered only
                    # during EXIT recovery.
                    recovery_result=1
                fi
            done
            if [ "$recovery_result" -eq 0 ]; then
                record_state "bootstrap.recovery" "completed"
            else
                record_state "bootstrap.recovery" "incomplete-manual-intervention-required"
            fi
        fi
        if [ "$WEB_REPLACEMENT_STARTED" = "true" ]; then
            rollback_web || recovery_result=1
        fi
        if [ "$DAEMON_MUTATION_UNRESOLVED" = "true" ] \
            || [ -e "$DAEMON_UNRESOLVED_FILE" ] || [ -L "$DAEMON_UNRESOLVED_FILE" ]; then
            record_state "deployment.status" \
                "daemon-unresolved-during-recovery-manual-reconciliation-required" || true
            record_state "recovery.status" \
                "stopped-no-further-conflicting-mutation" || true
            printf '%s\n' \
                "Recovery encountered an unsettled daemon request. The active journal and deployment lock were retained." >&2
            retire_private_backend_environment_or_mark || true
            exit 1
        fi
        record_state "deployment.status" "failed"
        printf '%s\n' "Deployment failed. State was saved to $STATE_FILE" >&2
        if [ "$recovery_result" -ne 0 ] && [ "$ACTIVE_JOURNAL_CREATED" = "true" ]; then
            printf '%s\n' "Recovery is incomplete. Preserve $ACTIVE_JOURNAL and $DEPLOYMENT_DIR." >&2
        fi
    fi
    if [ "$DEPLOYMENT_SUCCEEDED" != "true" ] \
        && [ "$CANONICAL_IMAGE_STATE_CAPTURED" = "true" ] \
        && [ "$CANONICAL_IMAGES_COMMITTED" != "true" ]; then
        restore_canonical_image_state || recovery_result=1
    fi
    if [ "$WEB_CANDIDATE_TAG_CREATED" = "true" ]; then
        if remove_owned_image_ref "$WEB_CANDIDATE_IMAGE" "$NEW_WEB_IMAGE"; then
            WEB_CANDIDATE_TAG_CREATED=false
        else
            recovery_result=1
        fi
    fi
    if [ "$GATEWAY_CANDIDATE_TAG_CREATED" = "true" ]; then
        if remove_owned_image_ref "$GATEWAY_CANDIDATE_IMAGE" "$NEW_GATEWAY_IMAGE"; then
            GATEWAY_CANDIDATE_TAG_CREATED=false
        else
            recovery_result=1
        fi
    fi
    if [ "$API_CANDIDATE_TAG_CREATED" = "true" ]; then
        if remove_owned_image_ref "$API_CANDIDATE_IMAGE" "$NEW_API_IMAGE"; then
            API_CANDIDATE_TAG_CREATED=false
        else
            recovery_result=1
        fi
    fi
    if [ "$DEPLOYMENT_SUCCEEDED" != "true" ] \
        && [ "$API_BRIDGE_PUBLISHED" != "true" ]; then
        if [ "$API_A_BRIDGE_ROLLBACK_TAG_CREATED" = "true" ]; then
            if remove_owned_image_ref "$API_A_BRIDGE_ROLLBACK_IMAGE" "$OLD_API_A_IMAGE"; then
                API_A_BRIDGE_ROLLBACK_TAG_CREATED=false
            else
                recovery_result=1
            fi
        fi
        if [ "$API_B_BRIDGE_ROLLBACK_TAG_CREATED" = "true" ]; then
            if remove_owned_image_ref "$API_B_BRIDGE_ROLLBACK_IMAGE" "$OLD_API_B_IMAGE"; then
                API_B_BRIDGE_ROLLBACK_TAG_CREATED=false
            else
                recovery_result=1
            fi
        fi
    fi
    if [ "$DAEMON_MUTATION_UNRESOLVED" = "true" ] \
        || [ -e "$DAEMON_UNRESOLVED_FILE" ] || [ -L "$DAEMON_UNRESOLVED_FILE" ]; then
        record_state "deployment.status" \
            "daemon-unresolved-during-final-cleanup-manual-reconciliation-required" || true
        retire_private_backend_environment_or_mark || true
        exit 1
    fi
    if [ "$DEPLOYMENT_SUCCEEDED" != "true" ] \
        && [ "$recovery_result" -ne 0 ] && [ "$ACTIVE_JOURNAL_CREATED" = "true" ]; then
        record_state "deployment.interlock" \
            "active-journal-and-deploy-lock-retained-after-incomplete-recovery" || true
        retire_private_backend_environment_or_mark || true
        exit 1
    fi
    if ! retire_private_backend_environment_or_mark; then
        exit 1
    fi
    if [ "$ACTIVE_JOURNAL_CREATED" = "true" ] \
        && { [ "$DEPLOYMENT_SUCCEEDED" != "true" ] \
            || [ "$POSTCOMMIT_CLEANUP_PENDING" != "true" ]; }; then
        if ! release_active_journal; then
            record_state "deployment.interlock" \
                "active-journal-cleanup-unresolved-deploy-lock-retained" || true
            exit 1
        fi
    fi
    if [ "$ACTIVE_JOURNAL_CREATED" = "true" ]; then
        record_state "deployment.interlock" \
            "active-journal-retained-deploy-lock-release-forbidden" || true
        printf '%s\n' \
            "Active deployment journal remains; deployment lock release is forbidden: $ACTIVE_JOURNAL" >&2
        exit 1
    fi
    if [ "$DEPLOY_LOCK_HELD" = "true" ]; then
        if ! release_deploy_lock; then
            record_state "deployment.lock_cleanup" \
                "failed-exact-identity-release-manual-reconciliation-required" || true
            record_state "deployment.interlock" \
                "deploy-lock-cleanup-unresolved" || true
            printf '%s\n' \
                "Deployment lock cleanup failed and was not ignored: $DEPLOY_LOCK_DIR" >&2
            exit 1
        fi
    fi
    exit "$original_exit_code"
}
trap 'cleanup $?' 0
trap 'handle_signal HUP 129' HUP
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM

compose_with_images() {
    local api_image="$1"
    local gateway_image="$2"
    local web_image="$3"
    shift 3
    env DIVA_API_IMAGE="$api_image" DIVA_GATEWAY_IMAGE="$gateway_image" \
        DIVA_WEB_IMAGE="$web_image" \
        "$DOCKER_COMMAND" compose --env-file "$PRIVATE_BACKEND_ENV_FILE" \
        --project-name "$COMPOSE_PROJECT" -f "$RUNTIME_COMPOSE_FILE" "$@"
}

compose() {
    compose_with_images "$API_IMAGE" "$GATEWAY_IMAGE" "$WEB_IMAGE" "$@"
}

run_with_timeout() {
    local timeout_seconds="$1"
    shift
    if [ "$TEST_MODE" = "1" ]; then
        "$@"
    else
        "$TIMEOUT_COMMAND" --signal=TERM --kill-after=10 \
            "$timeout_seconds" "$@"
    fi
}

trusted_git() {
    if [ "$TEST_MODE" = "1" ]; then
        git -C "$ORIGINAL_ROOT_DIR" "$@"
        return
    fi
    run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" /usr/bin/env -i \
        PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 LC_ALL=C.UTF-8 \
        GIT_CONFIG_COUNT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null \
        GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 \
        GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 \
        XDG_CONFIG_HOME=/nonexistent \
        /usr/bin/git --git-dir="$ORIGINAL_ROOT_DIR/.git" \
            --work-tree="$ORIGINAL_ROOT_DIR" \
            -c safe.directory="$ORIGINAL_ROOT_DIR" \
            -c core.fsmonitor=false -c core.untrackedCache=false \
            -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null \
            -c diff.external= -c pager.status=false "$@"
}

verify_official_source_provenance() {
    local branch origin head remote_main live line_oid line_ref extra replace_refs
    if [ "$TEST_MODE" = "1" ]; then
        GIT_COMMIT=$(git -C "$ORIGINAL_ROOT_DIR" rev-parse HEAD) || return 1
        record_state "source.provenance" "deterministic-test-live-tree"
        return 0
    fi
    branch=$(trusted_git symbolic-ref --quiet HEAD) || return 1
    [ "$branch" = refs/heads/main ] || return 1
    origin=$(run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" /usr/bin/env -i \
        PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
        GIT_CONFIG_COUNT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        /usr/bin/git config --no-includes --file "$ORIGINAL_ROOT_DIR/.git/config" \
            --get remote.origin.url) || return 1
    [ "$origin" = "$OFFICIAL_GIT_REMOTE_URL" ] || return 1
    replace_refs=$(trusted_git for-each-ref --format='%(refname)' refs/replace/) \
        || return 1
    [ -z "$replace_refs" ] || return 1
    head=$(trusted_git rev-parse --verify 'HEAD^{commit}') || return 1
    remote_main=$(trusted_git rev-parse --verify 'refs/remotes/origin/main^{commit}') \
        || return 1
    [ "$head" = "$remote_main" ] || return 1
    trusted_git diff-index --cached --quiet "$head" -- || return 1
    [ -z "$(trusted_git status --porcelain=v1 --untracked-files=all)" ] || return 1
    live=$(cd / && run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" \
        /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
        LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_COUNT=0 \
        GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null \
        GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 \
        GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 \
        XDG_CONFIG_HOME=/nonexistent /usr/bin/git \
        -c protocol.ext.allow=never -c protocol.file.allow=never \
        ls-remote --exit-code "$OFFICIAL_GIT_REMOTE_URL" refs/heads/main) \
        || return 1
    read -r line_oid line_ref extra <<EOF
$live
EOF
    case "$line_oid" in *[!0-9a-fA-F]*|'') return 1 ;; esac
    [ "${#line_oid}" -eq 40 ] && [ "$line_ref" = refs/heads/main ] \
        && [ -z "${extra:-}" ] && [ "$line_oid" = "$head" ] || return 1
    GIT_COMMIT="$head"
    record_state "source.provenance" "official-live-main-clean-exact"
}

capture_private_backend_environment() {
    local source="$BACKEND_ENV_SOURCE"
    [ -f "$source" ] && [ ! -L "$source" ] \
        && [ ! -e "$PRIVATE_BACKEND_ENV_FILE" ] || return 1
    if [ "$TEST_MODE" = "1" ]; then
        (umask 077; cat "$source" > "$PRIVATE_BACKEND_ENV_FILE") || return 1
    else
        run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" "$PYTHON_COMMAND" -I -c '
import hashlib
import os
import stat
import sys

source, destination, root = sys.argv[1:]
expected_uid = os.stat(root, follow_symlinks=False).st_uid
current = os.path.dirname(source)
while True:
    info = os.stat(current, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, expected_uid) or info.st_mode & 0o022:
        raise SystemExit(2)
    parent = os.path.dirname(current)
    if parent == current:
        break
    current = parent
fd = os.open(source, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
try:
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_uid != expected_uid \
            or before.st_nlink != 1 or before.st_mode & 0o077:
        raise SystemExit(2)
    payload = bytearray()
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        payload.extend(chunk)
        if len(payload) > 1024 * 1024:
            raise SystemExit(2)
    after = os.fstat(fd)
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size,
                              value.st_mtime_ns, value.st_ctime_ns)
    if identity(before) != identity(after):
        raise SystemExit(2)
    digest = hashlib.sha256(payload).digest()
finally:
    os.close(fd)
fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
try:
    view = memoryview(payload)
    while view:
        written = os.write(fd, view)
        view = view[written:]
    os.fsync(fd)
finally:
    os.close(fd)
fd = os.open(source, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
try:
    final = os.fstat(fd)
    final_payload = bytearray()
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        final_payload.extend(chunk)
finally:
    os.close(fd)
if identity(before) != identity(final) or hashlib.sha256(final_payload).digest() != digest:
    raise SystemExit(2)
' "$source" "$PRIVATE_BACKEND_ENV_FILE" "$ORIGINAL_ROOT_DIR" || return 1
    fi
    [ -f "$PRIVATE_BACKEND_ENV_FILE" ] && [ ! -L "$PRIVATE_BACKEND_ENV_FILE" ] \
        && [ "$(stat -c '%a:%h' "$PRIVATE_BACKEND_ENV_FILE")" = 600:1 ] \
        || return 1
    "$SYNC_COMMAND" -f "$PRIVATE_BACKEND_ENV_FILE" 2>/dev/null || "$SYNC_COMMAND" \
        || return 1
    PRIVATE_BACKEND_ENV_ID=$(stat -c '%d:%i:%s:%f:%h' \
        "$PRIVATE_BACKEND_ENV_FILE") || return 1
    case "$PRIVATE_BACKEND_ENV_ID" in
        *:*:*:*:1) ;;
        *) return 1 ;;
    esac
    record_state "backend_env.private_capture" "stable-single-fd"
    record_state "backend_env.private_identity" "$PRIVATE_BACKEND_ENV_ID"
}

create_private_source_snapshot() {
    local archive_hash snapshot_hash tree_count
    if [ "$TEST_MODE" = "1" ]; then
        COMPOSE_FILE="$ORIGINAL_ROOT_DIR/backend/docker-compose.yml"
        RUNTIME_COMPOSE_FILE="$COMPOSE_FILE"
        RUNTIME_CONTRACT_HELPER="$ORIGINAL_ROOT_DIR/scripts/sbc-runtime-contract.py"
        IMAGE_SCAN_VALIDATOR_RELEASE="$ORIGINAL_ROOT_DIR/scripts/validate-container-image-scan.py"
        record_state "source.snapshot" "deterministic-test-live-tree"
        return 0
    fi
    SOURCE_TREE_ID=$(trusted_git rev-parse 'HEAD^{tree}') || return 1
    trusted_git ls-tree -rz --full-tree HEAD > "$SOURCE_TREE_ENTRIES_FILE" \
        || return 1
    "$SYNC_COMMAND" -f "$SOURCE_TREE_ENTRIES_FILE" 2>/dev/null || "$SYNC_COMMAND" \
        || return 1
    tree_count=$(run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" \
        "$PYTHON_COMMAND" -I -c '
import pathlib
import re
import sys
payload = pathlib.Path(sys.argv[1]).read_bytes()
entries = payload.split(b"\0")
if entries[-1:] != [b""]:
    raise SystemExit(2)
entries = entries[:-1]
if not entries:
    raise SystemExit(2)
for entry in entries:
    try:
        metadata, path = entry.split(b"\t", 1)
        mode, kind, object_id = metadata.split(b" ")
    except ValueError:
        raise SystemExit(2)
    if mode not in (b"100644", b"100755") or kind != b"blob" \
            or re.fullmatch(b"[0-9a-fA-F]{40,64}", object_id) is None \
            or not path or path.startswith(b"/") or b"\n" in path \
            or b"\r" in path or b"\t" in path or b"\x00" in path \
            or b".." in path.split(b"/"):
        raise SystemExit(2)
print(len(entries))
' "$SOURCE_TREE_ENTRIES_FILE") || return 1
    case "$tree_count" in ''|*[!0-9]*|0) return 1 ;; esac
    trusted_git archive --format=tar --output="$SOURCE_ARCHIVE_FILE" HEAD \
        || return 1
    [ -f "$SOURCE_ARCHIVE_FILE" ] && [ ! -L "$SOURCE_ARCHIVE_FILE" ] \
        || return 1
    "$SYNC_COMMAND" -f "$SOURCE_ARCHIVE_FILE" 2>/dev/null || "$SYNC_COMMAND" \
        || return 1
    mkdir -m 0700 "$SOURCE_SNAPSHOT_ROOT" || return 1
    run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" /usr/bin/tar \
        --extract --file "$SOURCE_ARCHIVE_FILE" --directory "$SOURCE_SNAPSHOT_ROOT" \
        --no-same-owner --same-permissions || return 1
    [ -f "$SOURCE_SNAPSHOT_ROOT/backend/docker-compose.yml" ] \
        && [ ! -L "$SOURCE_SNAPSHOT_ROOT/backend/docker-compose.yml" ] \
        || return 1
    archive_hash=$(sha256sum "$SOURCE_ARCHIVE_FILE" | awk '{print $1}') || return 1
    SOURCE_ARCHIVE_SHA256="$archive_hash"
    SOURCE_SNAPSHOT_SHA256=$(private_source_tree_digest) || return 1
    SOURCE_SNAPSHOT_CAPTURED=true
    COMPOSE_FILE="$SOURCE_SNAPSHOT_ROOT/backend/docker-compose.yml"
    RUNTIME_COMPOSE_FILE="$COMPOSE_FILE"
    RUNTIME_CONTRACT_HELPER="$SOURCE_SNAPSHOT_ROOT/scripts/sbc-runtime-contract.py"
    [ -f "$RUNTIME_CONTRACT_HELPER" ] && [ ! -L "$RUNTIME_CONTRACT_HELPER" ] \
        || return 1
    record_state "source.snapshot_tree" "$SOURCE_TREE_ID"
    record_state "source.snapshot_archive_sha256" "$SOURCE_ARCHIVE_SHA256"
    record_state "source.snapshot_sha256" "$SOURCE_SNAPSHOT_SHA256"
    record_state "source.snapshot_file_count" "$tree_count"
}

verify_private_source_snapshot() {
    local current snapshot_current
    [ "$TEST_MODE" = "1" ] && return 0
    [ "$SOURCE_SNAPSHOT_CAPTURED" = "true" ] || return 1
    current=$(sha256sum "$SOURCE_ARCHIVE_FILE" | awk '{print $1}') || return 1
    snapshot_current=$(private_source_tree_digest) || return 1
    [ "$current" = "$SOURCE_ARCHIVE_SHA256" ] \
        && [ "$snapshot_current" = "$SOURCE_SNAPSHOT_SHA256" ] \
        && [ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ]
}

private_source_tree_digest() {
    local digest_tar="$DEPLOYMENT_DIR/source-digest.$$.tar" digest
    [ -d "$SOURCE_SNAPSHOT_ROOT" ] && [ ! -L "$SOURCE_SNAPSHOT_ROOT" ] \
        && [ ! -e "$digest_tar" ] || return 1
    run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" /usr/bin/tar \
        --sort=name --format=gnu --mtime=@0 --owner=0 --group=0 \
        --numeric-owner -C "$SOURCE_SNAPSHOT_ROOT" -cf "$digest_tar" . \
        || return 1
    digest=$(sha256sum "$digest_tar" | awk '{print $1}') || return 1
    rm -f -- "$digest_tar" || return 1
    printf '%s\n' "$digest"
}

bounded_compose_with_images() {
    local timeout_seconds="$1" api_image="$2" gateway_image="$3" web_image="$4"
    local rc=0 intent
    shift 4
    intent="compose-$1"
    begin_daemon_mutation "$intent" || return $?
    run_with_timeout "$timeout_seconds" \
        env DIVA_API_IMAGE="$api_image" DIVA_GATEWAY_IMAGE="$gateway_image" \
        DIVA_WEB_IMAGE="$web_image" \
        "$DOCKER_COMMAND" compose --env-file "$PRIVATE_BACKEND_ENV_FILE" \
        --project-name "$COMPOSE_PROJECT" -f "$RUNTIME_COMPOSE_FILE" "$@" \
        || rc=$?
    if [ "$rc" -eq 0 ]; then
        complete_daemon_mutation
        return 0
    fi
    fail_daemon_mutation "$rc"
}

bounded_compose() {
    local timeout_seconds="$1"
    shift
    bounded_compose_with_images "$timeout_seconds" \
        "$API_IMAGE" "$GATEWAY_IMAGE" "$WEB_IMAGE" "$@"
}

capture_resolved_compose_contract() {
    local byte_count current
    [ ! -e "$RESOLVED_COMPOSE_FILE" ] && [ ! -L "$RESOLVED_COMPOSE_FILE" ] \
        || return 1
    # Resolve .env/interpolation exactly once. The private result is the only
    # Compose input used by migration and candidate validation thereafter, so
    # a concurrent .env edit cannot produce different candidate/published
    # environments. Cleanup always removes this secret-bearing artifact.
    RUNTIME_COMPOSE_FILE="$COMPOSE_FILE"
    if ! bounded_compose "$DOCKER_READ_TIMEOUT_SECONDS" config --format json \
        > "$RESOLVED_COMPOSE_FILE"; then
        rm -f -- "$RESOLVED_COMPOSE_FILE" >/dev/null 2>&1 || true
        return 1
    fi
    [ -f "$RESOLVED_COMPOSE_FILE" ] && [ ! -L "$RESOLVED_COMPOSE_FILE" ] \
        && [ "$(stat -c '%a:%h' "$RESOLVED_COMPOSE_FILE")" = 600:1 ] \
        || return 1
    byte_count=$(wc -c < "$RESOLVED_COMPOSE_FILE") || return 1
    case "$byte_count" in ''|*[!0-9]*) return 1 ;; esac
    [ "$byte_count" -gt 0 ] && [ "$byte_count" -le 4194304 ] || return 1
    "$SYNC_COMMAND" -f "$RESOLVED_COMPOSE_FILE" 2>/dev/null || "$SYNC_COMMAND" \
        || return 1
    RESOLVED_COMPOSE_SHA256=$(sha256sum "$RESOLVED_COMPOSE_FILE" | awk '{print $1}') \
        || return 1
    printf '%s\n' "$RESOLVED_COMPOSE_SHA256" | grep -Eq '^[0-9a-f]{64}$' \
        || return 1
    RUNTIME_COMPOSE_FILE="$RESOLVED_COMPOSE_FILE"
    # A parse/config pass over the frozen artifact proves it remains a valid
    # Compose input before any candidate or migration is submitted.
    bounded_compose "$DOCKER_READ_TIMEOUT_SECONDS" config -q || return 1
    current=$(sha256sum "$RESOLVED_COMPOSE_FILE" | awk '{print $1}') || return 1
    [ "$current" = "$RESOLVED_COMPOSE_SHA256" ] || return 1
    record_state "compose.resolved_contract" \
        "captured-private-sha256-$RESOLVED_COMPOSE_SHA256"
}

verify_resolved_compose_contract() {
    local current
    [ -n "$RESOLVED_COMPOSE_SHA256" ] \
        && [ -f "$RESOLVED_COMPOSE_FILE" ] && [ ! -L "$RESOLVED_COMPOSE_FILE" ] \
        || return 1
    current=$(sha256sum "$RESOLVED_COMPOSE_FILE" | awk '{print $1}') || return 1
    [ "$current" = "$RESOLVED_COMPOSE_SHA256" ]
}

wait_once() {
    "$SLEEP_COMMAND" "$WAIT_SECONDS"
}

container_running() {
    local container="$1" id state
    if ! id=$(container_id "$container"); then
        fail "Container inventory query failed for $container"
        exit 1
    fi
    [ -n "$id" ] || return 1
    if ! run_bounded_docker_query inspect --format '{{.State.Running}}' "$id"; then
        fail "Container runtime query failed for $container ($id)"
        exit 1
    fi
    state="$DOCKER_QUERY_OUTPUT"
    case "$state" in
        true) return 0 ;;
        false) return 1 ;;
        *) fail "Container runtime query returned an invalid state for $container"; exit 1 ;;
    esac
}

container_id() {
    local container="$1"
    local output
    if ! run_bounded_docker_query container ls -a --no-trunc \
        --filter "name=^/${container}$" --format '{{.ID}}'; then
        return 1
    fi
    output="$DOCKER_QUERY_OUTPUT"
    case "$output" in
        "") ;;
        *[!0-9a-f]* ) return 1 ;;
        *) [ "${#output}" -eq 64 ] || return 1 ;;
    esac
    printf '%s\n' "$output"
}

container_health() {
    local container="$1"
    run_bounded_docker_query inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$container" || return 1
    printf '%s\n' "$DOCKER_QUERY_OUTPUT"
}

container_image() {
    local container="$1"
    local id
    if ! id=$(container_id "$container"); then
        fail "Container inventory query failed while reading the image for $container"
        exit 1
    fi
    [ -n "$id" ] || return 0
    if ! run_bounded_docker_query inspect --format '{{.Image}}' "$id"; then
        fail "Container image query failed for $container ($id)"
        exit 1
    fi
    printf '%s\n' "$DOCKER_QUERY_OUTPUT"
}

container_compose_config_hash() {
    local container="$1"
    local id
    if ! id=$(container_id "$container"); then
        fail "Container inventory query failed while reading the config hash for $container"
        exit 1
    fi
    [ -n "$id" ] || return 0
    if ! run_bounded_docker_query inspect \
        --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' \
        "$id"; then
        fail "Container config hash query failed for $container ($id)"
        exit 1
    fi
    printf '%s\n' "$DOCKER_QUERY_OUTPUT"
}

run_bounded_docker_mutation() {
    local rc=0 intent="docker-${1:-missing}"
    begin_daemon_mutation "$intent" || return $?
    run_with_timeout "$MUTATION_TIMEOUT_SECONDS" \
        "$DOCKER_COMMAND" "$@" || rc=$?
    if [ "$rc" -eq 0 ]; then
        complete_daemon_mutation
        return 0
    fi
    fail_daemon_mutation "$rc"
}

DOCKER_QUERY_OUTPUT=""
run_bounded_docker_query() {
    local rc=0 query_kind="${1:-missing}"
    DOCKER_QUERY_OUTPUT=""
    : > "$DOCKER_QUERY_FILE" || {
        mark_daemon_unresolved "docker-$query_kind-query-output-create-failed"
        return 125
    }
    run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" \
        "$DOCKER_COMMAND" "$@" \
        > "$DOCKER_QUERY_FILE" || rc=$?
    if [ "$rc" -ne 0 ]; then
        rm -f "$DOCKER_QUERY_FILE" >/dev/null 2>&1 || true
        mark_daemon_unresolved "docker-$query_kind-query-exit-$rc"
        return "$rc"
    fi
    DOCKER_QUERY_OUTPUT=$(cat "$DOCKER_QUERY_FILE") || {
        rm -f "$DOCKER_QUERY_FILE" >/dev/null 2>&1 || true
        mark_daemon_unresolved "docker-$query_kind-query-output-read-failed"
        return 125
    }
    rm -f "$DOCKER_QUERY_FILE" >/dev/null 2>&1 || {
        mark_daemon_unresolved "docker-$query_kind-query-output-remove-failed"
        return 125
    }
    return 0
}

run_bounded_docker_observe() {
    run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" \
        "$DOCKER_COMMAND" "$@"
}

image_ref_presence() {
    local reference="$1" expected_line
    if ! run_bounded_docker_query image ls --no-trunc \
        --filter "reference=$reference" --format '{{.Repository}}:{{.Tag}}'; then
        return 2
    fi
    expected_line="$reference"
    case "$DOCKER_QUERY_OUTPUT" in
        "") return 1 ;;
        "$expected_line") return 0 ;;
        *)
            mark_daemon_unresolved "docker-image-presence-ambiguous-$reference"
            return 2
            ;;
    esac
}

require_image_ref_absent() {
    local reference="$1" rc=0
    image_ref_presence "$reference" || rc=$?
    case "$rc" in
        0) return 1 ;;
        1) return 0 ;;
        *) return 2 ;;
    esac
}

image_ref_id() {
    local reference="$1" digest
    run_bounded_docker_query image inspect --format '{{.Id}}' "$reference" \
        || return 1
    case "$DOCKER_QUERY_OUTPUT" in
        sha256:*) digest=${DOCKER_QUERY_OUTPUT#sha256:} ;;
        *)
            mark_daemon_unresolved "docker-image-id-invalid-$reference"
            return 1
            ;;
    esac
    if [ "${#digest}" -ne 64 ]; then
        mark_daemon_unresolved "docker-image-id-invalid-$reference"
        return 1
    fi
    case "$digest" in
        *[!0-9a-f]*)
            mark_daemon_unresolved "docker-image-id-invalid-$reference"
            return 1
            ;;
    esac
    printf '%s\n' "$DOCKER_QUERY_OUTPUT"
}

verify_image_linux_arm64() {
    local reference="$1"
    run_bounded_docker_query image inspect --format '{{.Os}}/{{.Architecture}}' \
        "$reference" || return 1
    [ "$DOCKER_QUERY_OUTPUT" = "linux/arm64" ]
}

verify_container_image_linux_arm64() {
    local container_id="$1" image_id
    image_id=$(container_inspect_value "$container_id" '{{.Image}}') || return 1
    verify_image_linux_arm64 "$image_id"
}

verify_production_docker_platform() {
    local host_machine daemon_platform context_name
    [ "$TEST_MODE" = "1" ] && return 0
    host_machine=$(/usr/bin/uname -m) || return 1
    [ "$host_machine" = "aarch64" ] || return 1
    run_bounded_docker_query context show || return 1
    context_name=$DOCKER_QUERY_OUTPUT
    [ "$context_name" = "default" ] || return 1
    run_bounded_docker_query info --format '{{.OSType}}/{{.Architecture}}' || return 1
    daemon_platform=$DOCKER_QUERY_OUTPUT
    # Docker reports the ARM64 daemon architecture as aarch64 while image
    # metadata uses arm64.  Keep the mapping explicit and reject emulation.
    [ "$daemon_platform" = "linux/aarch64" ]
}

prepare_candidate_image_scan_database() {
    [ ! -e "$IMAGE_SCAN_ROOT" ] && [ ! -L "$IMAGE_SCAN_ROOT" ] || return 1
    mkdir "$IMAGE_SCAN_ROOT" || return 1
    chmod 700 "$IMAGE_SCAN_ROOT" || return 1
    mkdir "$TRIVY_RUN_CACHE" "$IMAGE_SCAN_ROOT/home" "$IMAGE_SCAN_ROOT/xdg-cache" \
        || return 1
    chmod 700 "$TRIVY_RUN_CACHE" "$IMAGE_SCAN_ROOT/home" \
        "$IMAGE_SCAN_ROOT/xdg-cache" || return 1
    : > "$TRIVY_EMPTY_CONFIG"
    : > "$TRIVY_EMPTY_IGNORE"
    chmod 600 "$TRIVY_EMPTY_CONFIG" "$TRIVY_EMPTY_IGNORE" || return 1
    if [ "$TEST_MODE" = "1" ]; then
        "$TRIVY_COMMAND" prepare "$TRIVY_RUN_CACHE" || return 1
        TRIVY_SCANNER_SHA=$(sha256sum "$TRIVY_COMMAND" | awk '{print $1}') \
            || return 1
    else
        TRIVY_SCANNER_SHA=$(sha256sum "$TRIVY_COMMAND" | awk '{print $1}') \
            || return 1
        [ "$TRIVY_SCANNER_SHA" = "$TRIVY_BINARY_SHA256" ] || return 1
        run_with_timeout "$BUILD_TIMEOUT_SECONDS" env -i \
            PATH=/usr/bin:/bin HOME="$IMAGE_SCAN_ROOT/home" \
            XDG_CACHE_HOME="$IMAGE_SCAN_ROOT/xdg-cache" \
            "$TRIVY_COMMAND" --config "$TRIVY_EMPTY_CONFIG" \
            --cache-dir "$TRIVY_RUN_CACHE" image --download-db-only \
            || return 1
        [ -f "$TRIVY_RUN_CACHE/db/metadata.json" ] \
            && [ ! -L "$TRIVY_RUN_CACHE/db/metadata.json" ] \
            && [ -f "$TRIVY_RUN_CACHE/db/trivy.db" ] \
            && [ ! -L "$TRIVY_RUN_CACHE/db/trivy.db" ] || return 1
        chmod -R go-rwx "$TRIVY_RUN_CACHE" || return 1
        "$SYNC_COMMAND" -f "$TRIVY_RUN_CACHE/db/metadata.json" 2>/dev/null \
            || "$SYNC_COMMAND" || return 1
        "$SYNC_COMMAND" -f "$TRIVY_RUN_CACHE/db/trivy.db" 2>/dev/null \
            || "$SYNC_COMMAND" || return 1
        "$SYNC_COMMAND" -f "$TRIVY_RUN_CACHE/db" 2>/dev/null \
            || "$SYNC_COMMAND" || return 1
    fi
    case "$TRIVY_SCANNER_SHA" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#TRIVY_SCANNER_SHA}" -eq 64 ] || return 1
    "$SYNC_COMMAND" -f "$IMAGE_SCAN_ROOT" 2>/dev/null || "$SYNC_COMMAND" \
        || return 1
    record_state "image_scan.database" "prepared-private-fresh"
}

scan_exact_candidate_image() {
    local service="$1" reference="$2" expected_image_id="$3"
    local report receipt validation verification started_at completed_at
    local before_id after_id receipt_sha inventory_arguments inventory_bound
    shift 3
    inventory_arguments="$*"
    before_id=$(image_ref_id "$reference") || return 1
    [ "$before_id" = "$expected_image_id" ] || return 1
    verify_image_linux_arm64 "$expected_image_id" || return 1
    report="$IMAGE_SCAN_ROOT/$service.report.json"
    receipt="$IMAGE_SCAN_ROOT/$service.receipt.json"
    validation="$IMAGE_SCAN_ROOT/$service.validation.json"
    verification="$IMAGE_SCAN_ROOT/$service.verification.json"
    for scan_artifact in "$report" "$receipt" "$validation" "$verification"; do
        [ ! -e "$scan_artifact" ] && [ ! -L "$scan_artifact" ] || return 1
    done
    if [ "$TEST_MODE" = "1" ]; then
        "$TRIVY_COMMAND" scan "$service" "$reference" "$expected_image_id" \
            "$receipt" || return 1
        [ -f "$receipt" ] && [ ! -L "$receipt" ] || return 1
        chmod 600 "$receipt" || return 1
    else
        started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        run_with_timeout "$BUILD_TIMEOUT_SECONDS" env -i \
            PATH=/usr/bin:/bin HOME="$IMAGE_SCAN_ROOT/home" \
            XDG_CACHE_HOME="$IMAGE_SCAN_ROOT/xdg-cache" \
            "$TRIVY_COMMAND" --config "$TRIVY_EMPTY_CONFIG" \
            --cache-dir "$TRIVY_RUN_CACHE" image \
            --ignorefile "$TRIVY_EMPTY_IGNORE" --skip-db-update \
            --image-src docker --scanners vuln --severity HIGH,CRITICAL \
            --format json --list-all-pkgs --exit-code 1 \
            --output "$report" "$expected_image_id" || return 1
        completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        chmod 600 "$report" || return 1
        "$SYNC_COMMAND" -f "$report" 2>/dev/null || "$SYNC_COMMAND" || return 1
        after_id=$(image_ref_id "$reference") || return 1
        [ "$after_id" = "$expected_image_id" ] || return 1
        # The inventory arguments supplied by the caller are reviewed exact
        # bounds shared with the existing CI/stateful Trivy receipt gate.
        set -- "$PYTHON_COMMAND" -I "$IMAGE_SCAN_VALIDATOR_RELEASE" validate \
            --service "$service" --expected-image-id "$expected_image_id" \
            --expected-architecture arm64 --expected-os linux \
            --expected-os-family alpine --report "$report" \
            --db-metadata "$TRIVY_RUN_CACHE/db/metadata.json" \
            --db "$TRIVY_RUN_CACHE/db/trivy.db" --receipt "$receipt"
        for inventory_bound in $inventory_arguments; do
            set -- "$@" --inventory-bound "$inventory_bound"
        done
        set -- "$@" --scanner-version "$TRIVY_VERSION" \
            --scanner-sha256 "$TRIVY_SCANNER_SHA" \
            --scan-started-at "$started_at" --scan-completed-at "$completed_at"
        "$@" > "$validation" || return 1
        chmod 600 "$receipt" "$validation" || return 1
    fi
    receipt_sha=$(sha256sum "$receipt" | awk '{print $1}') || return 1
    case "$receipt_sha" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#receipt_sha}" -eq 64 ] || return 1
    "$SYNC_COMMAND" -f "$receipt" 2>/dev/null || "$SYNC_COMMAND" || return 1
    [ "$TEST_MODE" = "1" ] \
        || { "$SYNC_COMMAND" -f "$validation" 2>/dev/null || "$SYNC_COMMAND"; } \
        || return 1
    case "$service" in
        api) API_SCAN_RECEIPT_SHA="$receipt_sha" ;;
        gateway) GATEWAY_SCAN_RECEIPT_SHA="$receipt_sha" ;;
        web) WEB_SCAN_RECEIPT_SHA="$receipt_sha" ;;
        *) return 1 ;;
    esac
    record_state "image_scan.$service.receipt_sha256" "$receipt_sha"
}

verify_exact_candidate_scan_receipt() {
    local service="$1" reference="$2" expected_image_id="$3" expected_receipt_sha="$4"
    local report receipt verification actual_receipt_sha
    [ "$(image_ref_id "$reference")" = "$expected_image_id" ] || return 1
    verify_image_linux_arm64 "$expected_image_id" || return 1
    report="$IMAGE_SCAN_ROOT/$service.report.json"
    receipt="$IMAGE_SCAN_ROOT/$service.receipt.json"
    verification="$IMAGE_SCAN_ROOT/$service.reverification.json"
    actual_receipt_sha=$(sha256sum "$receipt" | awk '{print $1}') || return 1
    [ "$actual_receipt_sha" = "$expected_receipt_sha" ] || return 1
    if [ "$TEST_MODE" = "1" ]; then
        "$TRIVY_COMMAND" verify "$service" "$reference" "$expected_image_id" \
            "$receipt" "$expected_receipt_sha" || return 1
    else
        [ ! -e "$verification" ] && [ ! -L "$verification" ] || return 1
        "$PYTHON_COMMAND" -I "$IMAGE_SCAN_VALIDATOR_RELEASE" verify \
            --service "$service" --expected-image-id "$expected_image_id" \
            --expected-architecture arm64 --expected-os linux \
            --expected-os-family alpine --report "$report" \
            --db-metadata "$TRIVY_RUN_CACHE/db/metadata.json" \
            --db "$TRIVY_RUN_CACHE/db/trivy.db" --receipt "$receipt" \
            --expected-receipt-sha256 "$expected_receipt_sha" \
            --maximum-receipt-age-seconds 21600 > "$verification" || return 1
        chmod 600 "$verification" || return 1
        "$SYNC_COMMAND" -f "$verification" 2>/dev/null || "$SYNC_COMMAND" \
            || return 1
    fi
    [ "$(image_ref_id "$reference")" = "$expected_image_id" ] || return 1
}

scan_all_rolling_candidate_images() {
    prepare_candidate_image_scan_database || return 1
    scan_exact_candidate_image api "$API_CANDIDATE_IMAGE" "$NEW_API_IMAGE" \
        'os-pkgs:alpine:30:30:1' 'lang-pkgs:dotnet-core:13:13:3' \
        || return 1
    scan_exact_candidate_image gateway "$GATEWAY_CANDIDATE_IMAGE" \
        "$NEW_GATEWAY_IMAGE" 'os-pkgs:alpine:33:33:1' || return 1
    scan_exact_candidate_image web "$WEB_CANDIDATE_IMAGE" "$NEW_WEB_IMAGE" \
        'os-pkgs:alpine:70:70:1' || return 1
    record_state "image_scan.status" "all-exact-receipts-verified"
}

scan_bridge_api_candidate_image() {
    prepare_candidate_image_scan_database || return 1
    scan_exact_candidate_image api "$API_CANDIDATE_IMAGE" "$NEW_API_IMAGE" \
        'os-pkgs:alpine:30:30:1' 'lang-pkgs:dotnet-core:13:13:3' \
        || return 1
    record_state "image_scan.status" "bridge-api-exact-receipt-verified"
}

verify_all_rolling_candidate_scan_receipts() {
    verify_exact_candidate_scan_receipt api "$API_CANDIDATE_IMAGE" \
        "$NEW_API_IMAGE" "$API_SCAN_RECEIPT_SHA" || return 1
    verify_exact_candidate_scan_receipt gateway "$GATEWAY_CANDIDATE_IMAGE" \
        "$NEW_GATEWAY_IMAGE" "$GATEWAY_SCAN_RECEIPT_SHA" || return 1
    verify_exact_candidate_scan_receipt web "$WEB_CANDIDATE_IMAGE" \
        "$NEW_WEB_IMAGE" "$WEB_SCAN_RECEIPT_SHA" || return 1
    record_state "image_scan.status" "all-exact-receipts-reverified-before-promotion"
}

verify_bridge_api_candidate_scan_receipt() {
    verify_exact_candidate_scan_receipt api "$API_CANDIDATE_IMAGE" \
        "$NEW_API_IMAGE" "$API_SCAN_RECEIPT_SHA" || return 1
    record_state "image_scan.status" \
        "bridge-api-exact-receipt-reverified-before-promotion"
}

capture_one_image_ref_state() {
    local reference="$1" prefix="$2" rc=0 image_id=""
    image_ref_presence "$reference" || rc=$?
    case "$rc" in
        0)
            image_id=$(image_ref_id "$reference") || return 1
            eval "OLD_CANONICAL_${prefix}_PRESENT=true"
            eval "OLD_CANONICAL_${prefix}_ID=\$image_id"
            ;;
        1)
            eval "OLD_CANONICAL_${prefix}_PRESENT=false"
            eval "OLD_CANONICAL_${prefix}_ID="
            ;;
        *) return 1 ;;
    esac
    record_state "canonical_${prefix}.pre_present" "$(eval "printf '%s' \"\$OLD_CANONICAL_${prefix}_PRESENT\"")"
    record_state "canonical_${prefix}.pre_image_id" "${image_id:-absent}"
}

capture_canonical_image_state() {
    capture_one_image_ref_state "$API_IMAGE" API \
        && capture_one_image_ref_state "$GATEWAY_IMAGE" GATEWAY \
        && capture_one_image_ref_state "$WEB_IMAGE" WEB \
        || return 1
    CANONICAL_IMAGE_STATE_CAPTURED=true
    record_state "canonical_images.prestate" "captured-before-build"
}

restore_one_image_ref_state() {
    local reference="$1" prefix="$2" present image_id new_image_id rc=0 observed=""
    present=$(eval "printf '%s' \"\$OLD_CANONICAL_${prefix}_PRESENT\"")
    image_id=$(eval "printf '%s' \"\$OLD_CANONICAL_${prefix}_ID\"")
    new_image_id=$(eval "printf '%s' \"\$NEW_${prefix}_IMAGE\"")
    if [ "$present" = "true" ]; then
        [ -n "$image_id" ] || return 1
        observed=$(image_ref_id "$reference") || rc=$?
        [ "$rc" -eq 0 ] || return 1
        if [ "$observed" = "$image_id" ]; then
            :
        elif [ -n "$new_image_id" ] && [ "$observed" = "$new_image_id" ]; then
            run_bounded_docker_mutation image tag "$image_id" "$reference" \
                >/dev/null || return 1
        else
            mark_topology_drift_unresolved \
                "canonical-image-$reference-owned-${new_image_id:-absent}-observed-$observed"
            fail "Canonical image ref $reference changed to an unowned third image; refusing rollback mutation"
            return 1
        fi
        [ "$(image_ref_id "$reference")" = "$image_id" ] || return 1
    else
        image_ref_presence "$reference" || rc=$?
        case "$rc" in
            0)
                observed=$(image_ref_id "$reference") || return 1
                if [ -z "$new_image_id" ] || [ "$observed" != "$new_image_id" ]; then
                    mark_topology_drift_unresolved \
                        "canonical-image-$reference-owned-${new_image_id:-absent}-observed-$observed"
                    fail "Canonical image ref $reference appeared with an unowned third image; refusing removal"
                    return 1
                fi
                run_bounded_docker_mutation image rm "$reference" >/dev/null \
                    || return 1
                require_image_ref_absent "$reference" || return 1
                ;;
            1) ;;
            *) return 1 ;;
        esac
    fi
    record_state "canonical_${prefix}.restore" "exact-prestate"
}

restore_canonical_image_state() {
    local result=0
    restore_one_image_ref_state "$API_IMAGE" API || result=1
    restore_one_image_ref_state "$GATEWAY_IMAGE" GATEWAY || result=1
    restore_one_image_ref_state "$WEB_IMAGE" WEB || result=1
    [ "$result" -eq 0 ] && record_state "canonical_images.restore" "completed"
    return "$result"
}

remove_owned_image_ref() {
    local reference="$1" expected_image_id="$2" rc=0 observed
    image_ref_presence "$reference" || rc=$?
    case "$rc" in
        1) return 0 ;;
        0) ;;
        *) return 1 ;;
    esac
    observed=$(image_ref_id "$reference") || return 1
    if [ -z "$expected_image_id" ] || [ "$observed" != "$expected_image_id" ]; then
        mark_topology_drift_unresolved \
            "candidate-image-$reference-owned-${expected_image_id:-absent}-observed-$observed"
        return 1
    fi
    run_bounded_docker_mutation image rm "$reference" >/dev/null || return 1
    require_image_ref_absent "$reference"
}

container_inspect_value() {
    local container_id_value="$1" format="$2"
    run_bounded_docker_query inspect --format "$format" "$container_id_value" \
        || return 1
    printf '%s\n' "$DOCKER_QUERY_OUTPUT"
}

wait_container_mapping() {
    local name="$1" expected_id="$2" attempts=0 stable=0 actual_id
    while [ "$attempts" -lt "$ROUTE_ATTEMPTS" ]; do
        if ! actual_id=$(container_id "$name"); then
            return 1
        elif [ "$actual_id" = "$expected_id" ]; then
            stable=$((stable + 1))
            [ "$stable" -ge 2 ] && return 0
        else
            stable=0
        fi
        attempts=$((attempts + 1))
        wait_once
    done
    return 1
}

wait_container_running_id() {
    local id="$1" expected="$2" attempts=0 stable=0 actual
    while [ "$attempts" -lt "$ROUTE_ATTEMPTS" ]; do
        if ! run_bounded_docker_query inspect --format '{{.State.Running}}' "$id"; then
            return 1
        fi
        actual="$DOCKER_QUERY_OUTPUT"
        if [ "$actual" = "$expected" ]; then
            stable=$((stable + 1))
            [ "$stable" -ge 2 ] && return 0
        else
            stable=0
        fi
        attempts=$((attempts + 1))
        wait_once
    done
    return 1
}

require_exact_running_mapping() {
    local name="$1" expected_id="$2" actual_id running
    [ -n "$expected_id" ] || return 1
    actual_id=$(container_id "$name") || return 1
    if [ "$actual_id" != "$expected_id" ]; then
        mark_topology_drift_unresolved "$name-expected-$expected_id-observed-${actual_id:-absent}"
        return 1
    fi
    run_bounded_docker_query inspect --format '{{.State.Running}}' "$expected_id" \
        || return 1
    running="$DOCKER_QUERY_OUTPUT"
    if [ "$running" != true ]; then
        mark_topology_drift_unresolved "$name-exact-id-not-running"
        return 1
    fi
}

quiesce_named_migration_container() {
    local attempts=0 stable=0 container_id_value running
    while [ "$attempts" -lt "$DAEMON_SETTLE_ATTEMPTS" ]; do
        if ! container_id_value=$(container_id "$MIGRATION_CONTAINER"); then
            return 1
        fi
        if [ -z "$container_id_value" ]; then
            stable=$((stable + 1))
            [ "$stable" -ge "$DAEMON_STABLE_SAMPLES" ] && return 0
        else
            stable=0
            if run_bounded_docker_query inspect --format '{{.State.Running}}' \
                "$container_id_value"; then
                running="$DOCKER_QUERY_OUTPUT"
            else
                return 1
            fi
            if [ "$running" = "true" ]; then
                run_bounded_docker_mutation stop --time 30 "$container_id_value" \
                    >/dev/null 2>&1 || true
                wait_container_running_id "$container_id_value" false || return 1
            elif [ "$running" != "false" ]; then
                # A disappearing container is harmless only after the exact
                # canonical-name inventory subsequently stabilizes as absent.
                wait_once
                attempts=$((attempts + 1))
                continue
            fi
            run_bounded_docker_observe logs --tail 200 "$container_id_value" \
                2>/dev/null || true
            run_bounded_docker_mutation rm -f "$container_id_value" >/dev/null 2>&1 || true
        fi
        attempts=$((attempts + 1))
        wait_once
    done
    return 1
}

reconcile_migration_acl_after_run() {
    quiesce_named_migration_container || return 1
    bounded_compose "$MUTATION_TIMEOUT_SECONDS" run --rm --no-deps migrate \
        --reconcile-migration-acl-only || return 1
    MIGRATION_ACL_UNRESOLVED=false
}

wait_healthy() {
    local container="$1"
    local attempts=0
    local status
    while [ "$attempts" -lt "$HEALTH_ATTEMPTS" ]; do
        if ! status=$(container_health "$container"); then
            return 1
        fi
        if [ "$status" = "healthy" ]; then
            return 0
        fi
        if [ "$status" = "unhealthy" ] || [ "$status" = "exited" ] || [ "$status" = "dead" ]; then
            run_bounded_docker_observe logs --tail 100 "$container" || true
            return 1
        fi
        attempts=$((attempts + 1))
        wait_once
    done
    run_bounded_docker_observe logs --tail 100 "$container" || true
    return 1
}

wait_http() {
    local url="$1" max_time="$2" attempts=0
    while [ "$attempts" -lt "$HEALTH_ATTEMPTS" ]; do
        if "$CURL_COMMAND" -fsS --connect-timeout 2 --max-time "$max_time" \
            "$url" >/dev/null 2>&1; then
            return 0
        fi
        attempts=$((attempts + 1))
        wait_once
    done
    return 1
}

gateway_running() {
    local mapped_id running
    [ -n "$PUBLISHED_GATEWAY_ID" ] || return 1
    mapped_id=$(container_id "$GATEWAY_CONTAINER") || return 1
    if [ "$mapped_id" != "$PUBLISHED_GATEWAY_ID" ]; then
        mark_topology_drift_unresolved \
            "gateway-running-expected-$PUBLISHED_GATEWAY_ID-observed-${mapped_id:-absent}"
        return 1
    fi
    run_bounded_docker_query inspect --format '{{.State.Running}}' \
        "$PUBLISHED_GATEWAY_ID" || return 1
    running="$DOCKER_QUERY_OUTPUT"
    [ "$running" = true ] || {
        mark_topology_drift_unresolved "gateway-exact-id-not-running"
        return 1
    }
}

gateway_command() {
    local command="$1" rc=0 mapped_id
    [ -n "$PUBLISHED_GATEWAY_ID" ] || return 1
    mapped_id=$(container_id "$GATEWAY_CONTAINER") || return 1
    if [ "$mapped_id" != "$PUBLISHED_GATEWAY_ID" ]; then
        mark_topology_drift_unresolved \
            "gateway-command-expected-$PUBLISHED_GATEWAY_ID-observed-${mapped_id:-absent}"
        return 1
    fi
    case "$command" in
        "show stat")
            capture_gateway_stats || return 1
            cat "$GATEWAY_STATS_FILE"
            ;;
        "disable server api_nodes/"*|"enable server api_nodes/"*)
            printf '%s\n' "$command" > "$GATEWAY_COMMAND_FILE" || {
                mark_daemon_unresolved "docker-gateway-command-input-write-failed"
                return 125
            }
            run_bounded_docker_mutation exec -i "$PUBLISHED_GATEWAY_ID" \
                socat - UNIX-CONNECT:/tmp/haproxy-admin.sock \
                < "$GATEWAY_COMMAND_FILE" || return $?
            mapped_id=$(container_id "$GATEWAY_CONTAINER") || return 1
            if [ "$mapped_id" != "$PUBLISHED_GATEWAY_ID" ]; then
                mark_topology_drift_unresolved \
                    "gateway-command-postcheck-expected-$PUBLISHED_GATEWAY_ID-observed-${mapped_id:-absent}"
                return 1
            fi
            ;;
        *)
            mark_daemon_unresolved "docker-gateway-command-not-allowlisted"
            return 125
            ;;
    esac
}

capture_gateway_stats() {
    local rc=0 mapped_id
    [ -n "$PUBLISHED_GATEWAY_ID" ] || return 1
    mapped_id=$(container_id "$GATEWAY_CONTAINER") || return 1
    if [ "$mapped_id" != "$PUBLISHED_GATEWAY_ID" ]; then
        mark_topology_drift_unresolved \
            "gateway-stats-expected-$PUBLISHED_GATEWAY_ID-observed-${mapped_id:-absent}"
        return 1
    fi
    : > "$GATEWAY_STATS_FILE" || {
        mark_daemon_unresolved "docker-gateway-query-output-create-failed"
        return 125
    }
    printf '%s\n' "show stat" | run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" \
        "$DOCKER_COMMAND" exec -i \
        "$PUBLISHED_GATEWAY_ID" socat - UNIX-CONNECT:/tmp/haproxy-admin.sock \
        > "$GATEWAY_STATS_FILE" || rc=$?
    if [ "$rc" -ne 0 ]; then
        mark_daemon_unresolved "docker-gateway-query-exit-$rc"
        return "$rc"
    fi
    mapped_id=$(container_id "$GATEWAY_CONTAINER") || return 1
    if [ "$mapped_id" != "$PUBLISHED_GATEWAY_ID" ]; then
        mark_topology_drift_unresolved \
            "gateway-stats-postcheck-expected-$PUBLISHED_GATEWAY_ID-observed-${mapped_id:-absent}"
        return 1
    fi
}

quiesce_migration_publication() {
    local legacy_id legacy_running
    if [ "$GATEWAY_WAS_RUNNING" = "true" ]; then
        require_exact_running_mapping vocadb_api_a "$OLD_API_A_CONTAINER_ID" \
            || return 1
        require_exact_running_mapping vocadb_api_b "$OLD_API_B_CONTAINER_ID" \
            || return 1
        gateway_running || return 1
        MIGRATION_PUBLICATION_GATE_ACTIVE=true
        MIGRATION_GATEWAY_QUIESCED=true
        record_state "migration.publication_gate" \
            "armed-before-gateway-route-quiescence"
        gateway_command "disable server api_nodes/api_a" >/dev/null || return 1
        gateway_command "disable server api_nodes/api_b" >/dev/null || return 1
        wait_slot_sessions api_a || return 1
        wait_slot_sessions api_b || return 1
        [ "$(slot_enabled_state api_a)" = "disabled" ] || return 1
        [ "$(slot_enabled_state api_b)" = "disabled" ] || return 1
        record_state "migration.publication_gate" \
            "gateway-routes-disabled-and-sessions-drained"
        return 0
    fi

    legacy_id=$(container_id vocadb_api) || return 1
    if [ -z "$PREFLIGHT_LEGACY_CONTAINER_ID" ]; then
        if [ -n "$legacy_id" ]; then
            mark_topology_drift_unresolved \
                "legacy-migration-expected-absent-observed-$legacy_id"
            return 1
        fi
        record_state "migration.publication_gate" "no-public-api-container"
        return 0
    fi
    if [ "$legacy_id" != "$PREFLIGHT_LEGACY_CONTAINER_ID" ]; then
        mark_topology_drift_unresolved \
            "legacy-migration-expected-$PREFLIGHT_LEGACY_CONTAINER_ID-observed-${legacy_id:-absent}"
        return 1
    fi
    if ! run_bounded_docker_query inspect --format '{{.State.Running}}' "$legacy_id"; then
        return 1
    fi
    legacy_running="$DOCKER_QUERY_OUTPUT"
    case "$legacy_running" in
        false)
            record_state "migration.publication_gate" \
                "legacy-api-already-stopped"
            return 0
            ;;
        true) ;;
        *) return 1 ;;
    esac
    [ "$LEGACY_CONTAINER_ID" = "$PREFLIGHT_LEGACY_CONTAINER_ID" ] || return 1
    require_exact_running_mapping vocadb_api "$PREFLIGHT_LEGACY_CONTAINER_ID" \
        || return 1
    LEGACY_WAS_RUNNING=true
    MIGRATION_PUBLICATION_GATE_ACTIVE=true
    MIGRATION_LEGACY_QUIESCED=true
    record_state "migration.publication_gate" \
        "armed-before-legacy-api-stop"
    run_bounded_docker_mutation stop --time 30 "$LEGACY_CONTAINER_ID" \
        >/dev/null || return 1
    wait_container_running_id "$LEGACY_CONTAINER_ID" false || return 1
    record_state "migration.publication_gate" \
        "legacy-api-stopped-exact-id"
}

restore_migration_publication() {
    if [ "$MIGRATION_PUBLICATION_GATE_ACTIVE" != "true" ]; then
        return 0
    fi
    if [ "$MIGRATION_GATEWAY_QUIESCED" = "true" ]; then
        restore_slot_route api_a "$API_A_STATE" "$OLD_API_A_CONTAINER_ID" || return 1
        restore_slot_route api_b "$API_B_STATE" "$OLD_API_B_CONTAINER_ID" || return 1
        MIGRATION_GATEWAY_QUIESCED=false
    fi
    if [ "$MIGRATION_LEGACY_QUIESCED" = "true" ]; then
        [ -n "$LEGACY_CONTAINER_ID" ] || return 1
        run_bounded_docker_mutation start "$LEGACY_CONTAINER_ID" \
            >/dev/null || return 1
        wait_container_running_id "$LEGACY_CONTAINER_ID" true || return 1
        wait_healthy "$LEGACY_CONTAINER_ID" || return 1
        MIGRATION_LEGACY_QUIESCED=false
    fi
    MIGRATION_PUBLICATION_GATE_ACTIVE=false
    record_state "migration.publication_gate" \
        "released-after-container-quiescence-and-acl-reconcile"
}

slot_status() {
    local slot="$1"
    capture_gateway_stats 2>/dev/null || return 1
    awk -F, -v slot="$slot" '$1 == "api_nodes" && $2 == slot { print $18; exit }' \
        "$GATEWAY_STATS_FILE"
}

slot_sessions() {
    local slot="$1"
    capture_gateway_stats 2>/dev/null || return 1
    awk -F, -v slot="$slot" '$1 == "api_nodes" && $2 == slot { print $5; exit }' \
        "$GATEWAY_STATS_FILE"
}

slot_enabled_state() {
    local slot="$1"
    local status
    status=$(slot_status "$slot") || return 1
    case "$status" in
        UP*|DOWN*|NOLB*) printf '%s\n' "enabled" ;;
        MAINT*) printf '%s\n' "disabled" ;;
        *) printf '%s\n' "unknown" ;;
    esac
}

wait_slot_sessions() {
    local slot="$1"
    local attempts=0
    local sessions
    while [ "$attempts" -lt "$DRAIN_ATTEMPTS" ]; do
        sessions=$(slot_sessions "$slot") || return 1
        # An empty value can mean the admin socket/query failed. Only an
        # explicit zero authorizes container replacement.
        if [ "$sessions" = "0" ]; then
            return 0
        fi
        attempts=$((attempts + 1))
        wait_once
    done
    return 1
}

wait_slot_up() {
    local slot="$1"
    local attempts=0
    local status
    while [ "$attempts" -lt "$ROUTE_ATTEMPTS" ]; do
        status=$(slot_status "$slot") || return 1
        case "$status" in
            UP*) return 0 ;;
        esac
        attempts=$((attempts + 1))
        wait_once
    done
    return 1
}

rollback_tag_for_slot() {
    case "$1" in
        api_a) printf '%s\n' "$API_A_ROLLBACK_IMAGE" ;;
        api_b) printf '%s\n' "$API_B_ROLLBACK_IMAGE" ;;
        *) return 1 ;;
    esac
}

old_image_for_slot() {
    case "$1" in
        api_a) printf '%s\n' "$OLD_API_A_IMAGE" ;;
        api_b) printf '%s\n' "$OLD_API_B_IMAGE" ;;
        *) return 1 ;;
    esac
}

peer_for_slot() {
    case "$1" in
        api_a) printf '%s\n' "api_b" ;;
        api_b) printf '%s\n' "api_a" ;;
        *) return 1 ;;
    esac
}

candidate_api_config_for_slot() {
    case "$1" in
        api_a) printf '%s\n' "$CANDIDATE_API_A_CONFIG_HASH" ;;
        api_b) printf '%s\n' "$CANDIDATE_API_B_CONFIG_HASH" ;;
        *) return 1 ;;
    esac
}

published_slot_id() {
    case "$1" in
        api_a)
            if [ -n "$NEW_API_A_CONTAINER_ID" ]; then
                printf '%s\n' "$NEW_API_A_CONTAINER_ID"
            else
                printf '%s\n' "$OLD_API_A_CONTAINER_ID"
            fi
            ;;
        api_b)
            if [ -n "$NEW_API_B_CONTAINER_ID" ]; then
                printf '%s\n' "$NEW_API_B_CONTAINER_ID"
            else
                printf '%s\n' "$OLD_API_B_CONTAINER_ID"
            fi
            ;;
        *) return 1 ;;
    esac
}

restore_slot_route() {
    local slot="$1"
    local previous_state="$2"
    local container="vocadb_${slot}"
    local expected_id="${3:-}" mapped_id

    if [ -z "$expected_id" ]; then
        expected_id=$(published_slot_id "$slot") || return 1
    fi
    [ -n "$expected_id" ] || return 1

    if ! gateway_running; then
        [ "$GATEWAY_WAS_RUNNING" != "true" ] && [ -z "$PUBLISHED_GATEWAY_ID" ] \
            && return 0
        return 1
    fi
    require_exact_running_mapping "$container" "$expected_id" || return 1

    if [ "$previous_state" = "disabled" ]; then
        gateway_command "disable server api_nodes/$slot" >/dev/null || return $?
        mapped_id=$(container_id "$container") || return 1
        if [ "$mapped_id" != "$expected_id" ]; then
            mark_topology_drift_unresolved \
                "$container-route-disable-expected-$expected_id-observed-${mapped_id:-absent}"
            return 1
        fi
        return $?
    fi

    if [ "$previous_state" != "enabled" ]; then
        fail "Cannot restore unknown gateway state for $slot"
        return 1
    fi

    # Never enable a server just because a deploy step finished. Its saved
    # state must have been enabled and the restored/new container must first
    # pass its own readiness check.
    if ! wait_healthy "$expected_id"; then
        fail "Refusing to enable unhealthy $slot"
        return 1
    fi
    run_test_hook "before-route-enable:$slot"
    require_exact_running_mapping "$container" "$expected_id" || return 1
    if ! gateway_command "enable server api_nodes/$slot" >/dev/null; then
        fail "HAProxy rejected enable for $slot"
        return 1
    fi
    mapped_id=$(container_id "$container") || return 1
    if [ "$mapped_id" != "$expected_id" ]; then
        mark_topology_drift_unresolved \
            "$container-route-enable-expected-$expected_id-observed-${mapped_id:-absent}"
        return 1
    fi
    wait_healthy "$expected_id" || return 1
    if ! wait_slot_up "$slot"; then
        fail "$slot did not return UP after its readiness-guarded enable"
        return 1
    fi
}

candidate_environment_file() {
    case "$1" in
        api_a) printf '%s\n' "$API_A_RUNTIME_ENV_FILE" ;;
        api_b) printf '%s\n' "$API_B_RUNTIME_ENV_FILE" ;;
        api_gateway) printf '%s\n' "$GATEWAY_RUNTIME_ENV_FILE" ;;
        web) printf '%s\n' "$WEB_RUNTIME_ENV_FILE" ;;
        *) return 1 ;;
    esac
}

capture_candidate_environment_contract() {
    local service="$1" id="$2" output inspect_file rc=0
    output=$(candidate_environment_file "$service") || return 1
    inspect_file="$DEPLOYMENT_DIR/$service.environment.inspect.json"
    if [ -e "$output" ] || [ -L "$output" ] \
        || [ -e "$inspect_file" ] || [ -L "$inspect_file" ]; then
        return 1
    fi
    if [ "$TEST_MODE" = "1" ]; then
        (umask 077; set -C; printf 'DIVA_TEST_SERVICE=%s\n' "$service" > "$output") \
            || return 1
    else
        RUNTIME_INSPECT_FILE="$inspect_file"
        run_bounded_docker_observe inspect "$id" > "$inspect_file" || rc=$?
        if [ "$rc" -eq 0 ]; then
            run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" "$PYTHON_COMMAND" -I \
                "$RUNTIME_CONTRACT_HELPER" environment "$inspect_file" "$output" \
                || rc=$?
        fi
        rm -f -- "$inspect_file" >/dev/null 2>&1 || rc=1
        RUNTIME_INSPECT_FILE=""
        if [ "$rc" -ne 0 ]; then
            rm -f -- "$output" >/dev/null 2>&1 || true
            return "$rc"
        fi
    fi
    [ -f "$output" ] && [ ! -L "$output" ] \
        && [ "$(stat -c '%a:%h' "$output")" = "600:1" ]
}

container_runtime_fingerprint() {
    local id="$1" service="$2" fingerprint rc=0
    if [ "$TEST_MODE" = "1" ]; then
        printf 'test-runtime-%s\n' "$service"
        return 0
    fi
    RUNTIME_INSPECT_FILE="$PRIVATE_RUNTIME_ROOT/$service.runtime.inspect.json"
    rm -f -- "$RUNTIME_INSPECT_FILE" >/dev/null 2>&1 || return 1
    run_bounded_docker_observe inspect "$id" > "$RUNTIME_INSPECT_FILE" || return 1
    fingerprint="$(run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" \
        "$PYTHON_COMMAND" -I "$RUNTIME_CONTRACT_HELPER" fingerprint \
        "$RUNTIME_INSPECT_FILE")" || rc=$?
    rm -f -- "$RUNTIME_INSPECT_FILE" >/dev/null 2>&1 || rc=1
    RUNTIME_INSPECT_FILE=""
    [ "$rc" -eq 0 ] || return "$rc"
    printf '%s\n' "$fingerprint" | grep -Eq '^[0-9a-f]{64}$' || return 1
    printf '%s\n' "$fingerprint"
}

verify_created_runtime_contract() {
    local service="$1" id="$2" expected_image_ref="$3" expected_image_id="$4"
    local expected_config_hash="$5" expected_runtime_sha="$6" environment_file="$7"
    local expected_restart="${8:-no}"
    local actual_runtime_sha rc=0
    actual_runtime_sha=$(container_runtime_fingerprint "$id" "$service") || return 1
    [ "$actual_runtime_sha" = "$expected_runtime_sha" ] || return 1
    if [ "$TEST_MODE" = "1" ]; then
        [ "$(container_inspect_value "$id" '{{.HostConfig.ReadonlyRootfs}}')" = true ] \
            || return 1
        return 0
    fi

    RUNTIME_INSPECT_FILE="$PRIVATE_RUNTIME_ROOT/$service.runtime.verify.json"
    rm -f -- "$RUNTIME_INSPECT_FILE" >/dev/null 2>&1 || return 1
    run_bounded_docker_observe inspect "$id" > "$RUNTIME_INSPECT_FILE" || return 1
    run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" "$PYTHON_COMMAND" -I \
        "$RUNTIME_CONTRACT_HELPER" verify "$RUNTIME_INSPECT_FILE" \
        "$service" "$id" "$expected_image_ref" \
        "$expected_image_id" "$expected_config_hash" "$environment_file" \
        "$expected_restart" || rc=$?
    rm -f -- "$RUNTIME_INSPECT_FILE" >/dev/null 2>&1 || rc=1
    RUNTIME_INSPECT_FILE=""
    return "$rc"
}

create_managed_service_container() {
    local service="$1" config_hash="$2" image_reference="$3" image_id="$4"
    local name environment_file depends_on id expected_runtime_sha mapped_id
    case "$service" in
        api_a)
            name=vocadb_api_a
            depends_on='migrate:service_completed_successfully:false,postgres:service_healthy:false,qdrant:service_started:false'
            ;;
        api_b)
            name=vocadb_api_b
            depends_on='migrate:service_completed_successfully:false,postgres:service_healthy:false,qdrant:service_started:false'
            ;;
        api_gateway)
            name="$GATEWAY_CONTAINER"
            depends_on='api_a:service_healthy:false,api_b:service_healthy:false'
            ;;
        web)
            name="$WEB_CONTAINER"
            depends_on='api_gateway:service_started:false'
            ;;
        *) return 1 ;;
    esac
    environment_file=$(candidate_environment_file "$service") || return 1
    case "$service" in
        api_a) expected_runtime_sha="$CANDIDATE_API_A_RUNTIME_SHA256" ;;
        api_b) expected_runtime_sha="$CANDIDATE_API_B_RUNTIME_SHA256" ;;
        api_gateway) expected_runtime_sha="$CANDIDATE_GATEWAY_RUNTIME_SHA256" ;;
        web) expected_runtime_sha="$CANDIDATE_WEB_RUNTIME_SHA256" ;;
    esac
    [ -n "$expected_runtime_sha" ] || return 1
    [ -f "$environment_file" ] && [ ! -L "$environment_file" ] \
        && [ "$(stat -c '%a:%h' "$environment_file")" = "600:1" ] || return 1
    RUNTIME_ENV_FILE="$environment_file"
    : > "$DOCKER_QUERY_FILE" || return 1

    case "$service" in
        api_a|api_b)
            run_bounded_docker_mutation create --name "$name" \
                --label "com.docker.compose.config-hash=$config_hash" \
                --label com.docker.compose.container-number=1 \
                --label "com.docker.compose.depends_on=$depends_on" \
                --label "com.docker.compose.image=$image_id" \
                --label com.docker.compose.oneoff=False \
                --label "com.docker.compose.project=$COMPOSE_PROJECT" \
                --label "com.docker.compose.project.config_files=$COMPOSE_FILE" \
                --label "com.docker.compose.project.working_dir=$ROOT_DIR/backend" \
                --label "com.docker.compose.service=$service" \
                --network backend_default --network-alias "$service" --network-alias "$name" \
                --env-file "$environment_file" --expose 5000 \
                --health-cmd 'curl -fsS --max-time 5 http://127.0.0.1:5000/api/ready' \
                --health-interval 5s --health-timeout 6s --health-retries 12 \
                --health-start-period 180s --stop-timeout 30 \
                --cap-drop ALL --security-opt no-new-privileges=true --read-only \
                --tmpfs /tmp:size=64m,mode=1777 --memory-reservation 256m \
                --memory 768m --pids-limit 256 --restart no \
                --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
                "$image_reference" > "$DOCKER_QUERY_FILE"
            ;;
        api_gateway)
            run_bounded_docker_mutation create --name "$name" \
                --label "com.docker.compose.config-hash=$config_hash" \
                --label com.docker.compose.container-number=1 \
                --label "com.docker.compose.depends_on=$depends_on" \
                --label "com.docker.compose.image=$image_id" \
                --label com.docker.compose.oneoff=False \
                --label "com.docker.compose.project=$COMPOSE_PROJECT" \
                --label "com.docker.compose.project.config_files=$COMPOSE_FILE" \
                --label "com.docker.compose.project.working_dir=$ROOT_DIR/backend" \
                --label "com.docker.compose.service=$service" \
                --network backend_default --network-alias api_gateway --network-alias "$name" \
                --env-file "$environment_file" --publish 5000:5000 \
                --health-cmd 'curl -fsS --max-time 5 http://127.0.0.1:5000/api/ready' \
                --health-interval 5s --health-timeout 6s --health-retries 12 \
                --health-start-period 5s --stop-timeout 30 \
                --cap-drop ALL --security-opt no-new-privileges=true --read-only \
                --tmpfs /tmp:size=16m,mode=1777 --memory-reservation 64m \
                --memory 256m --pids-limit 128 --restart no \
                --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
                "$image_reference" > "$DOCKER_QUERY_FILE"
            ;;
        web)
            run_bounded_docker_mutation create --name "$name" --user 101:101 \
                --label "com.docker.compose.config-hash=$config_hash" \
                --label com.docker.compose.container-number=1 \
                --label "com.docker.compose.depends_on=$depends_on" \
                --label "com.docker.compose.image=$image_id" \
                --label com.docker.compose.oneoff=False \
                --label "com.docker.compose.project=$COMPOSE_PROJECT" \
                --label "com.docker.compose.project.config_files=$COMPOSE_FILE" \
                --label "com.docker.compose.project.working_dir=$ROOT_DIR/backend" \
                --label "com.docker.compose.service=$service" \
                --network backend_default --network-alias web --network-alias "$name" \
                --env-file "$environment_file" --publish 8080:8080 \
                --health-cmd 'wget -q -O /dev/null http://127.0.0.1:8080/backend-api/api/ready' \
                --health-interval 5s --health-timeout 6s --health-retries 12 \
                --health-start-period 5s --stop-timeout 30 \
                --cap-drop ALL --security-opt no-new-privileges=true --read-only \
                --tmpfs /tmp:size=16m,mode=1777 --memory-reservation 64m \
                --memory 256m --pids-limit 128 --restart no \
                --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
                "$image_reference" > "$DOCKER_QUERY_FILE"
            ;;
    esac
    IFS= read -r id < "$DOCKER_QUERY_FILE" || return 1
    if ! printf '%s\n' "$id" | grep -Eq '^[0-9a-f]{64}$'; then
        mark_daemon_unresolved "docker-create-$service-returned-invalid-container-id"
        return 1
    fi
    if ! mapped_id=$(container_id "$name") || [ "$mapped_id" != "$id" ]; then
        mark_daemon_unresolved "docker-create-$service-name-mapping-not-owned"
        return 1
    fi
    CREATED_CONTAINER_ID="$id"
    case "$service" in
        api_a) NEW_API_A_CONTAINER_ID="$id" ;;
        api_b) NEW_API_B_CONTAINER_ID="$id" ;;
        api_gateway) NEW_GATEWAY_CONTAINER_ID="$id" ;;
        web) NEW_WEB_CONTAINER_ID="$id" ;;
    esac
    record_state "$service.created_container_id" "$id"
    run_bounded_docker_mutation start "$id" >/dev/null || return 1
    wait_container_running_id "$id" true || return 1
    verify_created_runtime_contract "$service" "$id" "$image_reference" "$image_id" \
        "$config_hash" "$expected_runtime_sha" "$environment_file" || return 1
    RUNTIME_ENV_FILE=""
}

rollback_slot() {
    local slot="$1"
    local previous_state="$2"
    local peer
    local container="vocadb_${slot}"
    local previous_container expected_old_id expected_new_id current_id previous_id
    local owned_new_removed=false
    case "$slot" in
        api_a)
            previous_container="$API_A_PREVIOUS_CONTAINER"
            expected_old_id="$OLD_API_A_CONTAINER_ID"
            expected_new_id="$NEW_API_A_CONTAINER_ID"
            ;;
        api_b)
            previous_container="$API_B_PREVIOUS_CONTAINER"
            expected_old_id="$OLD_API_B_CONTAINER_ID"
            expected_new_id="$NEW_API_B_CONTAINER_ID"
            ;;
        *) return 1 ;;
    esac
    peer=$(peer_for_slot "$slot")

    log "Rolling back $slot to exact previous container $expected_old_id"
    record_state "$slot.rollback" "started"

    if [ "$GATEWAY_WAS_RUNNING" = "true" ]; then
        gateway_running || return 1
        if [ "$previous_state" = "enabled" ] && ! wait_slot_up "$peer"; then
            fail "Cannot roll back $slot because peer $peer is not UP"
            return 1
        fi
        if ! gateway_command "disable server api_nodes/$slot" >/dev/null; then
            fail "Cannot disable $slot for rollback"
            return 1
        fi
        if ! wait_slot_sessions "$slot"; then
            # Killing a container with active requests is less safe than
            # leaving the known healthy replacement drained for inspection.
            fail "Active sessions did not drain from $slot; rollback was not forced"
            return 1
        fi
    fi

    current_id=$(container_id "$container") || return 1
    if [ -n "$current_id" ] && [ "$current_id" != "$expected_old_id" ]; then
        if [ -z "$expected_new_id" ] || [ "$current_id" != "$expected_new_id" ]; then
            mark_topology_drift_unresolved \
                "$container-rollback-owned-${expected_new_id:-absent}-observed-$current_id"
            fail "Canonical $slot name belongs to an unowned third container; refusing rollback removal"
            return 1
        fi
        run_bounded_docker_mutation rm -f "$expected_new_id" >/dev/null 2>&1 || true
        if ! wait_container_mapping "$container" ""; then
            fail "Replacement $slot removal did not reach a stable terminal state"
            return 1
        fi
        owned_new_removed=true
    fi
    current_id=$(container_id "$container") || return 1
    if [ "$current_id" != "$expected_old_id" ]; then
        if [ -z "$current_id" ] && [ -n "$expected_new_id" ] \
            && [ "$owned_new_removed" != "true" ]; then
            mark_topology_drift_unresolved \
                "$container-owned-replacement-$expected_new_id-disappeared"
            fail "Expected owned replacement $expected_new_id disappeared before rollback"
            return 1
        fi
        previous_id=$(container_id "$previous_container") || return 1
        if [ "$previous_id" != "$expected_old_id" ]; then
            fail "Exact previous $slot container is unavailable for rollback"
            return 1
        fi
        run_bounded_docker_mutation rename "$expected_old_id" "$container" \
            >/dev/null 2>&1 || true
        if ! wait_container_mapping "$container" "$expected_old_id" \
            || ! wait_container_mapping "$previous_container" ""; then
            fail "Exact previous $slot rename did not reach a stable terminal state"
            return 1
        fi
    fi
    run_bounded_docker_mutation start "$expected_old_id" >/dev/null 2>&1 || true
    if ! wait_container_running_id "$expected_old_id" true; then
        fail "Exact previous $slot start did not reach a stable running state"
        return 1
    fi
    if ! wait_healthy "$expected_old_id"; then
        fail "Exact previous $slot container did not become healthy"
        return 1
    fi
    if ! restore_slot_route "$slot" "$previous_state" "$expected_old_id"; then
        return 1
    fi

    mark_slot_updated "$slot" false
    case "$slot" in
        api_a)
            API_A_PREVIOUS_PRESERVED=false
            NEW_API_A_CONTAINER_ID=""
            ;;
        api_b)
            API_B_PREVIOUS_PRESERVED=false
            NEW_API_B_CONTAINER_ID=""
            ;;
    esac
    if [ "$ACTIVE_SLOT" = "$slot" ]; then
        clear_active_slot
    fi
    record_state "$slot.rollback" "completed"
    return 0
}

update_slot() {
    local slot="$1"
    local previous_state="$2"
    local peer
    local container="vocadb_${slot}"
    local current_id current_image current_config previous_container expected_old_id previous_id
    local expected_config_hash
    case "$slot" in
        api_a)
            previous_container="$API_A_PREVIOUS_CONTAINER"
            expected_old_id="$OLD_API_A_CONTAINER_ID"
            ;;
        api_b)
            previous_container="$API_B_PREVIOUS_CONTAINER"
            expected_old_id="$OLD_API_B_CONTAINER_ID"
            ;;
        *) return 1 ;;
    esac
    expected_config_hash=$(candidate_api_config_for_slot "$slot") || return 1
    [ -n "$expected_config_hash" ] || return 1
    peer=$(peer_for_slot "$slot")

    log "Updating $slot"
    record_state "$slot.update" "started"
    ACTIVE_SLOT="$slot"
    ACTIVE_SLOT_PREVIOUS_STATE="$previous_state"
    ACTIVE_SLOT_ROUTE_DISABLED=false
    ACTIVE_SLOT_CONTAINER_MUTATED=false

    if [ "$GATEWAY_WAS_RUNNING" = "true" ]; then
        gateway_running || return 1
        if [ "$previous_state" = "enabled" ] && ! wait_slot_up "$peer"; then
            fail "Cannot update $slot because peer $peer is not UP"
            return 1
        fi
        # Assume the route may have changed before a command failure is
        # reported. EXIT recovery will only re-enable it after readiness.
        ACTIVE_SLOT_ROUTE_DISABLED=true
        if ! gateway_command "disable server api_nodes/$slot" >/dev/null; then
            fail "Cannot disable $slot"
            return 1
        fi
        run_test_hook "slot-disabled:$slot"
        if ! wait_slot_sessions "$slot"; then
            fail "Active sessions did not drain from $slot"
            return 1
        fi
    fi

    # Preserve the exact old container and its HostConfig. Recreating an old
    # image under the new Compose contract is not an exact rollback and can be
    # incompatible with security/port changes in the same release.
    ACTIVE_SLOT_CONTAINER_MUTATED=true
    current_id=$(container_id "$container") || return 1
    if [ "$current_id" != "$expected_old_id" ]; then
        fail "$slot identity changed before exact preservation"
        return 1
    fi
    run_bounded_docker_mutation stop --time 30 "$expected_old_id" \
        >/dev/null 2>&1 || true
    if ! wait_container_running_id "$expected_old_id" false; then
        fail "Previous $slot stop did not reach a stable terminal state"
        return 1
    fi
    run_bounded_docker_mutation rename "$expected_old_id" "$previous_container" \
        >/dev/null 2>&1 || true
    if ! wait_container_mapping "$container" "" \
        || ! wait_container_mapping "$previous_container" "$expected_old_id"; then
        fail "Previous $slot rename did not reach a stable preserved state"
        return 1
    fi
    previous_id=$(container_id "$previous_container") || return 1
    if [ "$previous_id" != "$expected_old_id" ]; then
        fail "Preserved $slot identity did not match preflight"
        return 1
    fi
    case "$slot" in
        api_a) API_A_PREVIOUS_PRESERVED=true ;;
        api_b) API_B_PREVIOUS_PRESERVED=true ;;
    esac
    record_state "$slot.previous_container" "$previous_container"
    record_state "$slot.previous_container_id" "$expected_old_id"

    CREATED_CONTAINER_ID=""
    if ! create_managed_service_container "$slot" "$expected_config_hash" \
        "$CANDIDATE_API_IMAGE_ID" "$CANDIDATE_API_IMAGE_ID"; then
        fail "Docker could not create the exact managed replacement for $slot"
        return 1
    fi
    run_test_hook "slot-replaced:$slot"
    current_id="$CREATED_CONTAINER_ID"
    if [ -z "$current_id" ] || [ "$(container_id "$container")" != "$current_id" ]; then
        fail "Replacement $slot identity could not be pinned"
        return 1
    fi
    if [ "$current_id" = "$expected_old_id" ]; then
        fail "Replacement $slot reused the preserved old container identity"
        return 1
    fi
    case "$slot" in
        api_a) NEW_API_A_CONTAINER_ID="$current_id" ;;
        api_b) NEW_API_B_CONTAINER_ID="$current_id" ;;
    esac
    current_image=$(container_inspect_value "$current_id" '{{.Image}}') || return 1
    current_config=$(container_inspect_value "$current_id" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    if [ "$current_image" != "$CANDIDATE_API_IMAGE_ID" ] \
        || [ "$current_config" != "$expected_config_hash" ]; then
        fail "Replacement $slot did not use the validated API image/config"
        return 1
    fi
    if ! wait_healthy "$current_id"; then
        fail "Replacement $slot did not become healthy"
        return 1
    fi
    if ! wait_container_mapping "$container" "$current_id"; then
        fail "Replacement $slot mapping changed during readiness"
        return 1
    fi
    current_image=$(container_inspect_value "$current_id" '{{.Image}}') || return 1
    current_config=$(container_inspect_value "$current_id" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    if [ "$current_image" != "$CANDIDATE_API_IMAGE_ID" ] \
        || [ "$current_config" != "$expected_config_hash" ]; then
        fail "Replacement $slot image/config changed after readiness"
        return 1
    fi
    if ! restore_slot_route "$slot" "$previous_state" "$current_id"; then
        fail "Replacement $slot could not safely rejoin HAProxy"
        return 1
    fi

    mark_slot_updated "$slot" true
    clear_active_slot
    record_state "$slot.update" "completed"
    return 0
}

restore_gateway_routes() {
    local api_a_state="$1"
    local api_b_state="$2"
    restore_slot_route "api_a" "$api_a_state" && \
        restore_slot_route "api_b" "$api_b_state"
}

remove_candidate_gateway() {
    if [ "$CANDIDATE_STARTED" = "true" ]; then
        if [ -z "$CANDIDATE_GATEWAY_ID" ]; then
            CANDIDATE_GATEWAY_ID=$(container_id "$CANDIDATE_CONTAINER") || return 1
        fi
        if [ -n "$CANDIDATE_GATEWAY_ID" ]; then
            run_bounded_docker_mutation rm -f "$CANDIDATE_GATEWAY_ID" >/dev/null 2>&1 || true
            wait_container_mapping "$CANDIDATE_CONTAINER" "" || return 1
        fi
        CANDIDATE_STARTED=false
        CANDIDATE_GATEWAY_ID=""
    fi
}

remove_candidate_api() {
    local service container started id
    for service in api_a api_b; do
        case "$service" in
            api_a)
                container="$CANDIDATE_API_A_CONTAINER"
                started="$CANDIDATE_API_A_STARTED"
                id="$CANDIDATE_API_A_ID"
                ;;
            api_b)
                container="$CANDIDATE_API_B_CONTAINER"
                started="$CANDIDATE_API_B_STARTED"
                id="$CANDIDATE_API_B_ID"
                ;;
        esac
        [ "$started" = "true" ] || continue
        if [ -z "$id" ]; then
            id=$(container_id "$container") || return 1
        fi
        if [ -n "$id" ]; then
            run_bounded_docker_mutation rm -f "$id" >/dev/null 2>&1 || true
            wait_container_mapping "$container" "" || return 1
        fi
        case "$service" in
            api_a) CANDIDATE_API_A_STARTED=false; CANDIDATE_API_A_ID="" ;;
            api_b) CANDIDATE_API_B_STARTED=false; CANDIDATE_API_B_ID="" ;;
        esac
    done
}

remove_candidate_web() {
    if [ "$CANDIDATE_WEB_STARTED" = "true" ]; then
        if [ -n "$CANDIDATE_WEB_ID" ]; then
            run_bounded_docker_mutation rm -f "$CANDIDATE_WEB_ID" >/dev/null 2>&1 || true
            wait_container_mapping "$CANDIDATE_WEB_CONTAINER" "" || return 1
        fi
        CANDIDATE_WEB_STARTED=false
        CANDIDATE_WEB_ID=""
    fi
}

validate_candidate_api_service() {
    local service="$1" container image_id config_hash runtime_sha
    case "$service" in
        api_a) container="$CANDIDATE_API_A_CONTAINER" ;;
        api_b) container="$CANDIDATE_API_B_CONTAINER" ;;
        *) return 1 ;;
    esac
    log "Starting an unexposed candidate $service API"
    if ! bounded_compose "$MUTATION_TIMEOUT_SECONDS" \
        run -d --no-deps --name "$container" "$service" >/dev/null; then
        fail "Candidate $service API could not start with the configured runtime credentials"
        return 1
    fi
    case "$service" in
        api_a) CANDIDATE_API_A_STARTED=true ;;
        api_b) CANDIDATE_API_B_STARTED=true ;;
    esac
    if ! id=$(container_id "$container") || [ -z "$id" ]; then
        fail "Candidate $service API identity could not be pinned"
        return 1
    fi
    case "$service" in
        api_a) CANDIDATE_API_A_ID="$id" ;;
        api_b) CANDIDATE_API_B_ID="$id" ;;
    esac
    image_id=$(container_inspect_value "$id" '{{.Image}}') || return 1
    config_hash=$(container_inspect_value "$id" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    if [ "$image_id" != "$NEW_API_IMAGE" ] || [ -z "$config_hash" ]; then
        fail "Candidate $service API did not use the pinned image/config"
        return 1
    fi
    if [ -n "$CANDIDATE_API_IMAGE_ID" ] \
        && [ "$CANDIDATE_API_IMAGE_ID" != "$image_id" ]; then
        fail "Candidate API slots resolved to different image IDs"
        return 1
    fi
    CANDIDATE_API_IMAGE_ID="$image_id"
    if ! wait_healthy "$id"; then
        run_bounded_docker_observe logs --tail 100 "$container" || true
        remove_candidate_api
        fail "Candidate $service API could not become ready with the configured database and Qdrant state"
        return 1
    fi
    image_id=$(container_inspect_value "$id" '{{.Image}}') || return 1
    if [ "$image_id" != "$CANDIDATE_API_IMAGE_ID" ]; then
        fail "Candidate $service API image changed during validation"
        return 1
    fi
    if [ "$config_hash" != "$(container_inspect_value "$id" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}')" ]; then
        fail "Candidate $service API config changed during validation"
        return 1
    fi
    runtime_sha=$(container_runtime_fingerprint "$id" "$service") || return 1
    capture_candidate_environment_contract "$service" "$id" || {
        fail "Candidate $service API environment could not be bound to its exact identity"
        return 1
    }
    case "$service" in
        api_a)
            CANDIDATE_API_A_CONFIG_HASH="$config_hash"
            CANDIDATE_API_A_RUNTIME_SHA256="$runtime_sha"
            ;;
        api_b)
            CANDIDATE_API_B_CONFIG_HASH="$config_hash"
            CANDIDATE_API_B_RUNTIME_SHA256="$runtime_sha"
            ;;
    esac
    remove_candidate_api || return 1
    record_state "$service.candidate" "healthy"
    record_state "$service.candidate_image" "$CANDIDATE_API_IMAGE_ID"
    record_state "$service.candidate_config_hash" "$config_hash"
    record_state "$service.candidate_runtime_sha256" "$runtime_sha"
}

validate_candidate_api() {
    validate_candidate_api_service api_a \
        && validate_candidate_api_service api_b
}

validate_candidate_web() {
    local image_id config_hash
    log "Starting an unexposed candidate Web proxy"
    if ! bounded_compose_with_images "$MUTATION_TIMEOUT_SECONDS" \
        "$API_IMAGE" "$GATEWAY_IMAGE" "$WEB_IMAGE" \
        run -d --no-deps --name "$CANDIDATE_WEB_CONTAINER" web >/dev/null; then
        fail "Candidate Web proxy could not start"
        return 1
    fi
    CANDIDATE_WEB_STARTED=true
    if ! CANDIDATE_WEB_ID=$(container_id "$CANDIDATE_WEB_CONTAINER") \
        || [ -z "$CANDIDATE_WEB_ID" ]; then
        fail "Candidate Web proxy identity could not be pinned"
        return 1
    fi
    image_id=$(container_inspect_value "$CANDIDATE_WEB_ID" '{{.Image}}') || return 1
    config_hash=$(container_inspect_value "$CANDIDATE_WEB_ID" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    if [ "$image_id" != "$NEW_WEB_IMAGE" ] || [ -z "$config_hash" ]; then
        fail "Candidate Web proxy did not use the pinned image/config"
        return 1
    fi
    CANDIDATE_WEB_IMAGE_ID="$image_id"
    CANDIDATE_WEB_CONFIG_HASH="$config_hash"
    if ! wait_healthy "$CANDIDATE_WEB_ID"; then
        run_bounded_docker_observe logs --tail 100 "$CANDIDATE_WEB_CONTAINER" || true
        remove_candidate_web
        fail "Candidate Web proxy could not reach the API gateway"
        return 1
    fi
    image_id=$(container_inspect_value "$CANDIDATE_WEB_ID" '{{.Image}}') || return 1
    config_hash=$(container_inspect_value "$CANDIDATE_WEB_ID" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    if [ "$image_id" != "$CANDIDATE_WEB_IMAGE_ID" ] \
        || [ "$config_hash" != "$CANDIDATE_WEB_CONFIG_HASH" ]; then
        fail "Candidate Web proxy image/config changed during validation"
        return 1
    fi
    CANDIDATE_WEB_RUNTIME_SHA256=$(container_runtime_fingerprint \
        "$CANDIDATE_WEB_ID" web) || return 1
    capture_candidate_environment_contract web "$CANDIDATE_WEB_ID" || {
        fail "Candidate Web environment could not be bound to its exact identity"
        return 1
    }
    remove_candidate_web || return 1
    record_state "web.candidate" "healthy"
    record_state "web.candidate_image" "$CANDIDATE_WEB_IMAGE_ID"
    record_state "web.candidate_config_hash" "$CANDIDATE_WEB_CONFIG_HASH"
}

rollback_web() {
    local current_id previous_id
    record_state "web.rollback" "started"
    if [ "$WEB_WAS_RUNNING" != "true" ]; then
        if ! current_id=$(container_id "$WEB_CONTAINER"); then
            fail "Web proxy inventory could not be read during rollback"
            return 1
        fi
        if [ -n "$current_id" ]; then
            if [ -z "$NEW_WEB_CONTAINER_ID" ] \
                || [ "$current_id" != "$NEW_WEB_CONTAINER_ID" ]; then
                mark_topology_drift_unresolved \
                    "web-rollback-owned-${NEW_WEB_CONTAINER_ID:-absent}-observed-$current_id"
                fail "Canonical Web name belongs to an unowned third container"
                return 1
            fi
            run_bounded_docker_mutation rm -f "$NEW_WEB_CONTAINER_ID" \
                >/dev/null 2>&1 || true
            if ! wait_container_mapping "$WEB_CONTAINER" ""; then
                fail "New Web proxy container removal did not reach a stable terminal state"
                return 1
            fi
        elif [ -n "$NEW_WEB_CONTAINER_ID" ]; then
            mark_topology_drift_unresolved \
                "web-owned-replacement-$NEW_WEB_CONTAINER_ID-disappeared"
            fail "Expected owned Web replacement disappeared before rollback"
            return 1
        fi
        WEB_REPLACEMENT_STARTED=false
        WEB_UPDATED=false
        record_state "web.rollback" "removed-new-container"
        return 0
    fi

    log "Rolling back the exact previous Web proxy container $OLD_WEB_CONTAINER_ID"
    if ! current_id=$(container_id "$WEB_CONTAINER"); then
        fail "Web proxy inventory could not be read during rollback"
        return 1
    fi
    if [ -z "$current_id" ] && [ -n "$NEW_WEB_CONTAINER_ID" ]; then
        mark_topology_drift_unresolved \
            "web-owned-replacement-$NEW_WEB_CONTAINER_ID-disappeared"
        fail "Expected owned Web replacement disappeared before rollback"
        return 1
    fi
    if [ -n "$current_id" ] && [ "$current_id" != "$OLD_WEB_CONTAINER_ID" ]; then
        if [ -z "$NEW_WEB_CONTAINER_ID" ] \
            || [ "$current_id" != "$NEW_WEB_CONTAINER_ID" ]; then
            mark_topology_drift_unresolved \
                "web-rollback-owned-${NEW_WEB_CONTAINER_ID:-absent}-observed-$current_id"
            fail "Canonical Web name belongs to an unowned third container"
            return 1
        fi
        run_bounded_docker_mutation rm -f "$NEW_WEB_CONTAINER_ID" \
            >/dev/null 2>&1 || true
        if ! wait_container_mapping "$WEB_CONTAINER" ""; then
            fail "New Web proxy container removal did not reach a stable terminal state"
            return 1
        fi
    fi

    if ! current_id=$(container_id "$WEB_CONTAINER"); then
        fail "Web proxy inventory could not be re-read during rollback"
        return 1
    fi
    if [ "$current_id" != "$OLD_WEB_CONTAINER_ID" ]; then
        if ! previous_id=$(container_id "$WEB_PREVIOUS_CONTAINER"); then
            fail "Preserved Web proxy inventory could not be read during rollback"
            return 1
        fi
        if [ "$previous_id" != "$OLD_WEB_CONTAINER_ID" ]; then
            fail "Exact previous Web proxy container is unavailable for rollback"
            return 1
        fi
        run_bounded_docker_mutation rename "$OLD_WEB_CONTAINER_ID" "$WEB_CONTAINER" \
            >/dev/null 2>&1 || true
        if ! wait_container_mapping "$WEB_CONTAINER" "$OLD_WEB_CONTAINER_ID" \
            || ! wait_container_mapping "$WEB_PREVIOUS_CONTAINER" ""; then
            fail "Exact previous Web proxy rename did not reach a stable terminal state"
            return 1
        fi
    fi
    if ! current_id=$(container_id "$WEB_CONTAINER"); then
        fail "Restored Web proxy inventory could not be read"
        return 1
    fi
    if [ "$current_id" != "$OLD_WEB_CONTAINER_ID" ]; then
        fail "Web proxy rollback restored an unexpected container identity"
        return 1
    fi
    run_bounded_docker_mutation start "$OLD_WEB_CONTAINER_ID" >/dev/null 2>&1 || true
    if ! wait_container_running_id "$OLD_WEB_CONTAINER_ID" true; then
        fail "Exact previous Web proxy start did not reach a stable running state"
        return 1
    fi
    if ! wait_healthy "$OLD_WEB_CONTAINER_ID"; then
        fail "Exact previous Web proxy container did not become healthy"
        return 1
    fi
    WEB_PREVIOUS_PRESERVED=false
    WEB_REPLACEMENT_STARTED=false
    WEB_UPDATED=false
    record_state "web.rollback" "completed"
}

replace_web() {
    local current_id previous_id current_image current_config candidate_tag_id
    WEB_REPLACEMENT_STARTED=true
    record_state "web.update" "started"

    if [ "$WEB_WAS_RUNNING" = "true" ]; then
        if ! current_id=$(container_id "$WEB_CONTAINER"); then
            fail "Web proxy inventory could not be read before replacement"
            return 1
        fi
        if [ "$current_id" != "$OLD_WEB_CONTAINER_ID" ]; then
            fail "Web proxy identity changed before replacement"
            return 1
        fi
        run_bounded_docker_mutation stop --time 30 "$OLD_WEB_CONTAINER_ID" \
            >/dev/null 2>&1 || true
        if ! wait_container_running_id "$OLD_WEB_CONTAINER_ID" false; then
            fail "Previous Web proxy stop did not reach a stable terminal state"
            return 1
        fi
        run_bounded_docker_mutation rename "$OLD_WEB_CONTAINER_ID" "$WEB_PREVIOUS_CONTAINER" \
            >/dev/null 2>&1 || true
        if ! wait_container_mapping "$WEB_CONTAINER" "" \
            || ! wait_container_mapping "$WEB_PREVIOUS_CONTAINER" "$OLD_WEB_CONTAINER_ID"; then
            fail "Previous Web proxy rename did not reach a stable preserved state"
            return 1
        fi
        if ! previous_id=$(container_id "$WEB_PREVIOUS_CONTAINER"); then
            fail "Preserved Web proxy inventory could not be read"
            return 1
        fi
        if [ "$previous_id" != "$OLD_WEB_CONTAINER_ID" ]; then
            fail "Preserved Web proxy identity did not match the preflight container"
            return 1
        fi
        WEB_PREVIOUS_PRESERVED=true
        record_state "web.previous_container" "$WEB_PREVIOUS_CONTAINER"
        record_state "web.previous_container_id" "$previous_id"
    fi

    candidate_tag_id=$(image_ref_id "$WEB_CANDIDATE_IMAGE") \
        || { fail "Pinned Web candidate tag disappeared"; return 1; }
    if [ "$candidate_tag_id" != "$CANDIDATE_WEB_IMAGE_ID" ]; then
        fail "Pinned Web candidate tag changed after validation"
        return 1
    fi
    CREATED_CONTAINER_ID=""
    if ! create_managed_service_container web "$CANDIDATE_WEB_CONFIG_HASH" \
        "$CANDIDATE_WEB_IMAGE_ID" "$CANDIDATE_WEB_IMAGE_ID"; then
        fail "Docker could not create the exact managed Web replacement"
        return 1
    fi
    run_test_hook "web-replaced"
    current_id="$CREATED_CONTAINER_ID"
    if [ "$(container_id "$WEB_CONTAINER")" != "$current_id" ]; then
        fail "New Web proxy inventory could not be read"
        return 1
    fi
    if [ -z "$current_id" ] || [ "$current_id" = "$OLD_WEB_CONTAINER_ID" ]; then
        fail "Web proxy replacement did not create a distinct candidate container"
        return 1
    fi
    current_image=$(container_inspect_value "$current_id" '{{.Image}}') || return 1
    current_config=$(container_inspect_value "$current_id" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    if [ "$current_image" != "$CANDIDATE_WEB_IMAGE_ID" ] \
        || [ "$current_config" != "$CANDIDATE_WEB_CONFIG_HASH" ]; then
        fail "Published Web proxy did not use the validated image/config"
        return 1
    fi
    NEW_WEB_CONTAINER_ID="$current_id"
    if ! wait_healthy "$NEW_WEB_CONTAINER_ID"; then
        fail "New Web proxy did not become healthy"
        return 1
    fi
    current_image=$(container_inspect_value "$NEW_WEB_CONTAINER_ID" '{{.Image}}') || return 1
    current_config=$(container_inspect_value "$NEW_WEB_CONTAINER_ID" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    if [ "$current_image" != "$CANDIDATE_WEB_IMAGE_ID" ] \
        || [ "$current_config" != "$CANDIDATE_WEB_CONFIG_HASH" ]; then
        fail "Published Web proxy image/config changed after readiness"
        return 1
    fi
    WEB_UPDATED=true
    record_state "web.new_container_id" "$current_id"
    record_state "web.update" "completed"
}

finalize_web_replacement() {
    local previous_id
    if [ "$WEB_PREVIOUS_PRESERVED" != "true" ]; then
        return 0
    fi
    if ! previous_id=$(container_id "$WEB_PREVIOUS_CONTAINER"); then
        return 1
    fi
    if [ "$previous_id" != "$OLD_WEB_CONTAINER_ID" ]; then
        return 1
    fi
    # The deployment is committed before this request is sent. A timeout can
    # complete late in dockerd, but it targets only the exact stopped old ID;
    # it must never re-arm rollback of the verified new Web proxy.
    run_bounded_docker_mutation rm "$OLD_WEB_CONTAINER_ID" >/dev/null 2>&1 || true
    if ! wait_container_mapping "$WEB_PREVIOUS_CONTAINER" ""; then
        return 1
    fi
    WEB_PREVIOUS_PRESERVED=false
    WEB_REPLACEMENT_STARTED=false
    record_state "web.previous_cleanup" "completed"
}

finalize_exact_previous_container() {
    local label="$1" previous_container="$2" expected_old_id="$3" previous_id
    previous_id=$(container_id "$previous_container") || return 1
    [ "$previous_id" = "$expected_old_id" ] || return 1
    # This function is called only after the deployment commit point.  A
    # failed/late old-ID removal retains the verified new topology and the
    # durable interlock; it must never re-arm inverse rollback.
    run_bounded_docker_mutation rm "$expected_old_id" >/dev/null 2>&1 || true
    wait_container_mapping "$previous_container" "" || return 1
    record_state "$label.previous_cleanup" "completed"
}

verify_exact_rolling_topology() {
    local current_id image_id config_hash slot expected_new_id previous_container expected_old_id
    local expected_config_hash expected_runtime_sha environment_file

    for slot in api_a api_b; do
        case "$slot" in
            api_a)
                expected_new_id="$NEW_API_A_CONTAINER_ID"
                previous_container="$API_A_PREVIOUS_CONTAINER"
                expected_old_id="$OLD_API_A_CONTAINER_ID"
                expected_runtime_sha="$CANDIDATE_API_A_RUNTIME_SHA256"
                environment_file="$API_A_RUNTIME_ENV_FILE"
                ;;
            api_b)
                expected_new_id="$NEW_API_B_CONTAINER_ID"
                previous_container="$API_B_PREVIOUS_CONTAINER"
                expected_old_id="$OLD_API_B_CONTAINER_ID"
                expected_runtime_sha="$CANDIDATE_API_B_RUNTIME_SHA256"
                environment_file="$API_B_RUNTIME_ENV_FILE"
                ;;
        esac
        expected_config_hash=$(candidate_api_config_for_slot "$slot") || return 1
        [ -n "$expected_new_id" ] || return 1
        current_id=$(container_id "vocadb_$slot") || return 1
        [ "$current_id" = "$expected_new_id" ] || return 1
        if [ "$GATEWAY_WAS_RUNNING" = "true" ]; then
            [ "$(container_id "$previous_container")" = "$expected_old_id" ] || return 1
        fi
        image_id=$(container_inspect_value "$expected_new_id" '{{.Image}}') || return 1
        config_hash=$(container_inspect_value "$expected_new_id" \
            '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
        [ "$image_id" = "$CANDIDATE_API_IMAGE_ID" ] \
            && [ "$config_hash" = "$expected_config_hash" ] \
            && wait_healthy "$expected_new_id" || return 1
        verify_created_runtime_contract "$slot" "$expected_new_id" "$CANDIDATE_API_IMAGE_ID" \
            "$CANDIDATE_API_IMAGE_ID" "$expected_config_hash" \
            "$expected_runtime_sha" "$environment_file" unless-stopped || return 1
    done

    current_id=$(container_id "$GATEWAY_CONTAINER") || return 1
    if [ "$GATEWAY_WAS_RUNNING" != "true" ]; then
        [ -n "$NEW_GATEWAY_CONTAINER_ID" ] \
            && [ "$current_id" = "$NEW_GATEWAY_CONTAINER_ID" ] || return 1
        image_id=$(container_inspect_value "$NEW_GATEWAY_CONTAINER_ID" '{{.Image}}') \
            || return 1
        config_hash=$(container_inspect_value "$NEW_GATEWAY_CONTAINER_ID" \
            '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
        [ "$image_id" = "$CANDIDATE_GATEWAY_IMAGE_ID" ] \
            && [ "$config_hash" = "$CANDIDATE_CONFIG_HASH" ] \
            && wait_healthy "$NEW_GATEWAY_CONTAINER_ID" || return 1
        verify_created_runtime_contract api_gateway "$NEW_GATEWAY_CONTAINER_ID" \
            "$CANDIDATE_GATEWAY_IMAGE_ID" "$CANDIDATE_GATEWAY_IMAGE_ID" \
            "$CANDIDATE_CONFIG_HASH" "$CANDIDATE_GATEWAY_RUNTIME_SHA256" \
            "$GATEWAY_RUNTIME_ENV_FILE" unless-stopped || return 1
    elif [ "$GATEWAY_UPDATED" = "true" ]; then
        [ -n "$NEW_GATEWAY_CONTAINER_ID" ] \
            && [ "$current_id" = "$NEW_GATEWAY_CONTAINER_ID" ] \
            && [ "$(container_id "$GATEWAY_PREVIOUS_CONTAINER")" \
                = "$OLD_GATEWAY_CONTAINER_ID" ] || return 1
        image_id=$(container_inspect_value "$NEW_GATEWAY_CONTAINER_ID" '{{.Image}}') \
            || return 1
        config_hash=$(container_inspect_value "$NEW_GATEWAY_CONTAINER_ID" \
            '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
        [ "$image_id" = "$CANDIDATE_GATEWAY_IMAGE_ID" ] \
            && [ "$config_hash" = "$CANDIDATE_CONFIG_HASH" ] \
            && wait_healthy "$NEW_GATEWAY_CONTAINER_ID" || return 1
        verify_created_runtime_contract api_gateway "$NEW_GATEWAY_CONTAINER_ID" \
            "$CANDIDATE_GATEWAY_IMAGE_ID" "$CANDIDATE_GATEWAY_IMAGE_ID" \
            "$CANDIDATE_CONFIG_HASH" "$CANDIDATE_GATEWAY_RUNTIME_SHA256" \
            "$GATEWAY_RUNTIME_ENV_FILE" unless-stopped || return 1
    else
        [ "$current_id" = "$OLD_GATEWAY_CONTAINER_ID" ] || return 1
    fi
}

commit_published_restart_policies() {
    local id policy
    for id in "$NEW_API_A_CONTAINER_ID" "$NEW_API_B_CONTAINER_ID" \
        "$NEW_GATEWAY_CONTAINER_ID" "$NEW_WEB_CONTAINER_ID"; do
        [ -n "$id" ] || continue
        run_bounded_docker_mutation update --restart unless-stopped "$id" \
            >/dev/null || return 1
        policy=$(container_inspect_value "$id" '{{.HostConfig.RestartPolicy.Name}}') \
            || return 1
        [ "$policy" = unless-stopped ] || return 1
    done
    record_state "runtime.restart_policy" "committed-exact-container-ids"
}

commit_bridge_api_restart_policies() {
    local id policy
    for id in "$NEW_API_A_CONTAINER_ID" "$NEW_API_B_CONTAINER_ID"; do
        [ -n "$id" ] || return 1
        run_bounded_docker_mutation update --restart unless-stopped "$id" \
            >/dev/null || return 1
        policy=$(container_inspect_value "$id" '{{.HostConfig.RestartPolicy.Name}}') \
            || return 1
        [ "$policy" = unless-stopped ] || return 1
    done
    record_state "bridge.api_restart_policy" "committed-exact-api-container-ids"
}

verify_published_web() {
    local expected_restart="${1:-no}"
    local current_id current_image current_config
    current_id=$(container_id "$WEB_CONTAINER") || return 1
    [ "$current_id" = "$NEW_WEB_CONTAINER_ID" ] || return 1
    wait_container_mapping "$WEB_CONTAINER" "$NEW_WEB_CONTAINER_ID" || return 1
    wait_healthy "$NEW_WEB_CONTAINER_ID" || return 1
    current_image=$(container_inspect_value "$NEW_WEB_CONTAINER_ID" '{{.Image}}') || return 1
    current_config=$(container_inspect_value "$NEW_WEB_CONTAINER_ID" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    [ "$current_image" = "$CANDIDATE_WEB_IMAGE_ID" ] \
        && [ "$current_config" = "$CANDIDATE_WEB_CONFIG_HASH" ] \
        && verify_created_runtime_contract web "$NEW_WEB_CONTAINER_ID" \
            "$CANDIDATE_WEB_IMAGE_ID" "$CANDIDATE_WEB_IMAGE_ID" \
            "$CANDIDATE_WEB_CONFIG_HASH" "$CANDIDATE_WEB_RUNTIME_SHA256" \
            "$WEB_RUNTIME_ENV_FILE" "$expected_restart"
}

validate_candidate_gateway() {
    local image_id config_hash
    log "Starting an unexposed candidate gateway"
    if ! bounded_compose "$MUTATION_TIMEOUT_SECONDS" \
        run -d --no-deps --name "$CANDIDATE_CONTAINER" api_gateway >/dev/null; then
        fail "Candidate gateway could not start"
        return 1
    fi
    CANDIDATE_STARTED=true
    if ! CANDIDATE_GATEWAY_ID=$(container_id "$CANDIDATE_CONTAINER") \
        || [ -z "$CANDIDATE_GATEWAY_ID" ]; then
        fail "Candidate gateway identity could not be pinned"
        return 1
    fi
    image_id=$(container_inspect_value "$CANDIDATE_GATEWAY_ID" '{{.Image}}') || return 1
    config_hash=$(container_inspect_value "$CANDIDATE_GATEWAY_ID" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    if [ "$image_id" != "$NEW_GATEWAY_IMAGE" ] || [ -z "$config_hash" ]; then
        fail "Candidate gateway did not use the pinned image/config"
        return 1
    fi
    CANDIDATE_GATEWAY_IMAGE_ID="$image_id"
    CANDIDATE_CONFIG_HASH="$config_hash"
    if ! wait_healthy "$CANDIDATE_GATEWAY_ID"; then
        run_bounded_docker_observe logs --tail 100 "$CANDIDATE_CONTAINER" || true
        remove_candidate_gateway
        fail "Candidate gateway could not reach both API slots"
        return 1
    fi
    image_id=$(container_inspect_value "$CANDIDATE_GATEWAY_ID" '{{.Image}}') || return 1
    config_hash=$(container_inspect_value "$CANDIDATE_GATEWAY_ID" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    if [ "$image_id" != "$CANDIDATE_GATEWAY_IMAGE_ID" ] \
        || [ "$config_hash" != "$CANDIDATE_CONFIG_HASH" ]; then
        fail "Candidate gateway image/config changed during validation"
        return 1
    fi
    CANDIDATE_GATEWAY_RUNTIME_SHA256=$(container_runtime_fingerprint \
        "$CANDIDATE_GATEWAY_ID" api_gateway) || return 1
    capture_candidate_environment_contract api_gateway "$CANDIDATE_GATEWAY_ID" || {
        fail "Candidate gateway environment could not be bound to its exact identity"
        return 1
    }
    remove_candidate_gateway || return 1
    record_state "gateway.candidate" "healthy"
    record_state "gateway.candidate_image" "$CANDIDATE_GATEWAY_IMAGE_ID"
    record_state "gateway.candidate_config_hash" "$CANDIDATE_CONFIG_HASH"
}

rollback_gateway() {
    local api_a_state="$1"
    local api_b_state="$2"
    local current_id previous_id
    log "Rolling back the exact previous API gateway container $OLD_GATEWAY_CONTAINER_ID"
    record_state "gateway.rollback" "started"

    current_id=$(container_id "$GATEWAY_CONTAINER") || return 1
    if [ -z "$current_id" ] && [ -n "$NEW_GATEWAY_CONTAINER_ID" ]; then
        mark_topology_drift_unresolved \
            "gateway-owned-replacement-$NEW_GATEWAY_CONTAINER_ID-disappeared"
        fail "Expected owned gateway replacement disappeared before rollback"
        return 1
    fi
    if [ -n "$current_id" ] && [ "$current_id" != "$OLD_GATEWAY_CONTAINER_ID" ]; then
        if [ -z "$NEW_GATEWAY_CONTAINER_ID" ] \
            || [ "$current_id" != "$NEW_GATEWAY_CONTAINER_ID" ]; then
            mark_topology_drift_unresolved \
                "gateway-rollback-owned-${NEW_GATEWAY_CONTAINER_ID:-absent}-observed-$current_id"
            fail "Canonical gateway name belongs to an unowned third container"
            return 1
        fi
        run_bounded_docker_mutation rm -f "$NEW_GATEWAY_CONTAINER_ID" \
            >/dev/null 2>&1 || true
        if ! wait_container_mapping "$GATEWAY_CONTAINER" ""; then
            fail "Replacement gateway removal did not reach a stable terminal state"
            return 1
        fi
    fi
    current_id=$(container_id "$GATEWAY_CONTAINER") || return 1
    if [ "$current_id" != "$OLD_GATEWAY_CONTAINER_ID" ]; then
        previous_id=$(container_id "$GATEWAY_PREVIOUS_CONTAINER") || return 1
        if [ "$previous_id" != "$OLD_GATEWAY_CONTAINER_ID" ]; then
            fail "Exact previous gateway container is unavailable for rollback"
            return 1
        fi
        run_bounded_docker_mutation rename "$OLD_GATEWAY_CONTAINER_ID" "$GATEWAY_CONTAINER" \
            >/dev/null 2>&1 || true
        if ! wait_container_mapping "$GATEWAY_CONTAINER" "$OLD_GATEWAY_CONTAINER_ID" \
            || ! wait_container_mapping "$GATEWAY_PREVIOUS_CONTAINER" ""; then
            fail "Exact previous gateway rename did not reach a stable terminal state"
            return 1
        fi
    fi
    run_bounded_docker_mutation start "$OLD_GATEWAY_CONTAINER_ID" >/dev/null 2>&1 || true
    if ! wait_container_running_id "$OLD_GATEWAY_CONTAINER_ID" true; then
        fail "Exact previous gateway start did not reach a stable running state"
        return 1
    fi
    if ! wait_healthy "$OLD_GATEWAY_CONTAINER_ID"; then
        fail "Exact previous gateway container did not become healthy"
        return 1
    fi
    PUBLISHED_GATEWAY_ID="$OLD_GATEWAY_CONTAINER_ID"
    if ! restore_gateway_routes "$api_a_state" "$api_b_state"; then
        fail "Previous gateway routes could not be restored"
        return 1
    fi

    GATEWAY_REPLACEMENT_STARTED=false
    GATEWAY_UPDATED=false
    GATEWAY_PREVIOUS_PRESERVED=false
    NEW_GATEWAY_CONTAINER_ID=""
    record_state "gateway.rollback" "completed"
    return 0
}

apply_gateway_image() {
    local old_gateway_image="$1"
    local new_gateway_image="$2"
    local api_a_state="$3"
    local api_b_state="$4"
    local old_config_hash current_id current_image current_config previous_id

    old_config_hash=$(container_compose_config_hash "$GATEWAY_CONTAINER")
    if ! validate_candidate_gateway; then
        return 1
    fi
    record_state "gateway.old_config_hash" "${old_config_hash:-unknown}"

    if [ "$old_gateway_image" = "$new_gateway_image" ] \
        && [ -n "$old_config_hash" ] \
        && [ "$old_config_hash" = "$CANDIDATE_CONFIG_HASH" ]; then
        record_state "gateway.update" "unchanged"
        return 0
    fi

    # HAProxy's config is baked into its image and the current container is
    # not a master-worker process with a host-mounted config. A signal-only
    # reload therefore cannot apply this image safely. Validate an unexposed
    # candidate against both live slots, then use an explicit replace/rollback
    # transaction instead of silently leaving the built image unapplied.
    record_state "gateway.update" "started"
    GATEWAY_REPLACEMENT_STARTED=true
    current_id=$(container_id "$GATEWAY_CONTAINER") || return 1
    if [ "$current_id" != "$OLD_GATEWAY_CONTAINER_ID" ]; then
        fail "Gateway identity changed before exact preservation"
        return 1
    fi
    run_bounded_docker_mutation stop --time 30 "$OLD_GATEWAY_CONTAINER_ID" \
        >/dev/null 2>&1 || true
    if ! wait_container_running_id "$OLD_GATEWAY_CONTAINER_ID" false; then
        fail "Previous gateway stop did not reach a stable terminal state"
        return 1
    fi
    run_bounded_docker_mutation rename "$OLD_GATEWAY_CONTAINER_ID" "$GATEWAY_PREVIOUS_CONTAINER" \
        >/dev/null 2>&1 || true
    if ! wait_container_mapping "$GATEWAY_CONTAINER" "" \
        || ! wait_container_mapping "$GATEWAY_PREVIOUS_CONTAINER" "$OLD_GATEWAY_CONTAINER_ID"; then
        fail "Previous gateway rename did not reach a stable preserved state"
        return 1
    fi
    previous_id=$(container_id "$GATEWAY_PREVIOUS_CONTAINER") || return 1
    if [ "$previous_id" != "$OLD_GATEWAY_CONTAINER_ID" ]; then
        fail "Preserved gateway identity did not match preflight"
        return 1
    fi
    GATEWAY_PREVIOUS_PRESERVED=true
    record_state "gateway.previous_container" "$GATEWAY_PREVIOUS_CONTAINER"
    record_state "gateway.previous_container_id" "$OLD_GATEWAY_CONTAINER_ID"
    CREATED_CONTAINER_ID=""
    if ! create_managed_service_container api_gateway "$CANDIDATE_CONFIG_HASH" \
        "$CANDIDATE_GATEWAY_IMAGE_ID" "$CANDIDATE_GATEWAY_IMAGE_ID"; then
        fail "Docker could not create the exact managed gateway replacement"
        return 1
    fi
    run_test_hook "gateway-replaced"
    current_id="$CREATED_CONTAINER_ID"
    if [ -z "$current_id" ] || [ "$(container_id "$GATEWAY_CONTAINER")" != "$current_id" ]; then
        fail "New gateway identity could not be pinned"
        return 1
    fi
    if [ "$current_id" = "$OLD_GATEWAY_CONTAINER_ID" ]; then
        fail "Gateway replacement reused the preserved old container identity"
        return 1
    fi
    PUBLISHED_GATEWAY_ID="$current_id"
    NEW_GATEWAY_CONTAINER_ID="$current_id"
    current_image=$(container_inspect_value "$current_id" '{{.Image}}') || return 1
    current_config=$(container_inspect_value "$current_id" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    if [ "$current_image" != "$CANDIDATE_GATEWAY_IMAGE_ID" ] \
        || [ "$current_config" != "$CANDIDATE_CONFIG_HASH" ]; then
        fail "New gateway did not use the validated image/config"
        return 1
    fi
    if ! wait_healthy "$current_id"; then
        fail "New gateway did not become healthy"
        return 1
    fi
    if ! wait_container_mapping "$GATEWAY_CONTAINER" "$current_id"; then
        fail "New gateway mapping changed during readiness"
        return 1
    fi
    current_image=$(container_inspect_value "$current_id" '{{.Image}}') || return 1
    current_config=$(container_inspect_value "$current_id" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    if [ "$current_image" != "$CANDIDATE_GATEWAY_IMAGE_ID" ] \
        || [ "$current_config" != "$CANDIDATE_CONFIG_HASH" ]; then
        fail "New gateway image/config changed after readiness"
        return 1
    fi
    if ! restore_gateway_routes "$api_a_state" "$api_b_state"; then
        fail "New gateway did not preserve the saved slot states"
        return 1
    fi

    GATEWAY_UPDATED=true
    record_state "gateway.update" "completed"
    return 0
}

rollback_updated_slots() {
    local api_b_updated="$1"
    local api_a_updated="$2"
    local api_a_state="$3"
    local api_b_state="$4"
    local result=0

    if [ "$api_b_updated" = "true" ]; then
        rollback_slot "api_b" "$api_b_state" || result=1
    fi
    if [ "$api_a_updated" = "true" ]; then
        rollback_slot "api_a" "$api_a_state" || result=1
    fi
    return "$result"
}

prepare_bridge_backup_contract() {
    local postgres_run postgres_status postgres_status_sha postgres_manifest \
        postgres_manifest_sha qdrant_run qdrant_status qdrant_status_sha \
        qdrant_manifest qdrant_manifest_sha attestation_file attestation_sha \
        challenge verifier_host source_host attester_file attester_sha extracted \
        publication_sha binding_sha
    postgres_run=${DIVA_VERIFIED_POSTGRES_BACKUP_RUN_ID:-}
    postgres_status=${DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_FILE:-}
    postgres_status_sha=${DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_SHA256:-}
    postgres_manifest=${DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_FILE:-}
    postgres_manifest_sha=${DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_SHA256:-}
    qdrant_run=${DIVA_VERIFIED_QDRANT_BACKUP_RUN_ID:-}
    qdrant_status=${DIVA_VERIFIED_QDRANT_BACKUP_STATUS_FILE:-}
    qdrant_status_sha=${DIVA_VERIFIED_QDRANT_BACKUP_STATUS_SHA256:-}
    qdrant_manifest=${DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_FILE:-}
    qdrant_manifest_sha=${DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_SHA256:-}
    attestation_file=${DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_FILE:-}
    attestation_sha=${DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_SHA256:-}
    challenge=${DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_CHALLENGE:-}
    verifier_host=${DIVA_EXPECTED_BACKUP_VERIFIER_HOST:-}
    source_host=${DIVA_EXPECTED_BACKUP_SOURCE_HOST:-}
    attester_file="$SOURCE_SNAPSHOT_ROOT/scripts/attest-disaster-backup-payloads.py"
    [ -n "$verifier_host" ] && [ -n "$source_host" ] \
        && [ -f "$attester_file" ] && [ ! -L "$attester_file" ] || return 1
    case "$postgres_run:$qdrant_run:$postgres_status_sha:$postgres_manifest_sha:$qdrant_status_sha:$qdrant_manifest_sha:$attestation_sha:$challenge" in
        *[!0-9a-f:]*|:|*:|*::* ) return 1 ;;
    esac
    [ "${#postgres_run}" -eq 32 ] && [ "${#qdrant_run}" -eq 32 ] \
        && [ "${#postgres_status_sha}" -eq 64 ] \
        && [ "${#postgres_manifest_sha}" -eq 64 ] \
        && [ "${#qdrant_status_sha}" -eq 64 ] \
        && [ "${#qdrant_manifest_sha}" -eq 64 ] \
        && [ "${#attestation_sha}" -eq 64 ] && [ "${#challenge}" -eq 64 ] \
        || return 1
    for evidence in "$postgres_status" "$postgres_manifest" "$qdrant_status" \
        "$qdrant_manifest" "$attestation_file"; do
        [ -f "$evidence" ] && [ ! -L "$evidence" ] || return 1
    done
    [ "$(stat -c '%a' "$attestation_file")" = 600 ] || return 1
    [ "$(sha256sum "$postgres_status" | awk '{print $1}')" = "$postgres_status_sha" ] \
        && [ "$(sha256sum "$postgres_manifest" | awk '{print $1}')" = "$postgres_manifest_sha" ] \
        && [ "$(sha256sum "$qdrant_status" | awk '{print $1}')" = "$qdrant_status_sha" ] \
        && [ "$(sha256sum "$qdrant_manifest" | awk '{print $1}')" = "$qdrant_manifest_sha" ] \
        && [ "$(sha256sum "$attestation_file" | awk '{print $1}')" = "$attestation_sha" ] \
        || return 1
    attester_sha=$(sha256sum "$attester_file" | awk '{print $1}') || return 1
    case "$attester_sha" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#attester_sha}" -eq 64 ] || return 1
    extracted=$(run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" "$PYTHON_COMMAND" -I - \
        "$source_host" "$verifier_host" "$attester_sha" "$challenge" \
        "$postgres_run" "$postgres_status" "$postgres_status_sha" \
        "$postgres_manifest" "$postgres_manifest_sha" \
        "$qdrant_run" "$qdrant_status" "$qdrant_status_sha" \
        "$qdrant_manifest" "$qdrant_manifest_sha" \
        "$attestation_file" "$attestation_sha" <<'PY'
import datetime as dt
import hashlib
import json
import os
import re
import sys

(
    source_host, verifier_host, verifier_sha, challenge,
    postgres_run, postgres_status_path, postgres_status_sha,
    postgres_manifest_path, postgres_manifest_sha,
    qdrant_run, qdrant_status_path, qdrant_status_sha,
    qdrant_manifest_path, qdrant_manifest_sha,
    attestation_path, attestation_sha,
) = sys.argv[1:]

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def load(path, expected_sha):
    with open(path, "rb") as handle:
        raw = handle.read()
    actual = hashlib.sha256(raw).hexdigest()
    require(actual == expected_sha, f"evidence changed after digest check: {path}")
    return json.loads(raw), actual

required_aliases = {
    "song_hybrid_active", "song_metadata_active", "songs_v2_active",
}

def validate_backup(kind, execution_run, status_path, status_sha,
                    manifest_path, manifest_sha, max_age_hours):
    status, _ = load(status_path, status_sha)
    manifest, _ = load(manifest_path, manifest_sha)
    job = f"{kind}_disaster_backup"
    require(status.get("schemaVersion") == 1 and manifest.get("schemaVersion") == 1,
            f"unsupported {kind} evidence schema")
    require(status.get("job") == job and status.get("runId") == execution_run,
            f"{kind} execution identity mismatch")
    require(status.get("status") == "success" and status.get("exitCode") == 0
            and status.get("remoteCleanup") == "confirmed",
            f"{kind} backup was not completely successful")
    require(status.get("manifestSha256") == manifest_sha
            and status.get("source") == manifest.get("source")
            and status.get("publication") == manifest.get("publication"),
            f"{kind} status/manifest binding mismatch")
    require(manifest.get("status") == "complete", f"{kind} manifest is incomplete")
    source = manifest.get("source") or {}
    require(source.get("host") == source_host, f"{kind} source host mismatch")
    for field in ("pipelineCommit", "playerCommit"):
        require(re.fullmatch(r"[0-9a-f]{40}", str(source.get(field, ""))) is not None,
                f"{kind} source commit is invalid")
    finished = dt.datetime.fromisoformat(str(status.get("finishedAt") or "").replace("Z", "+00:00"))
    created = dt.datetime.fromisoformat(str(manifest.get("createdAt") or "").replace("Z", "+00:00"))
    completed = dt.datetime.fromisoformat(str(manifest.get("completedAt") or "").replace("Z", "+00:00"))
    require(all(value.tzinfo is not None for value in (finished, created, completed)),
            f"{kind} evidence timestamp has no timezone")
    now = dt.datetime.now(dt.timezone.utc)
    ages = [(now - value.astimezone(dt.timezone.utc)).total_seconds()
            for value in (finished, created, completed)]
    require(all(-900 <= age <= max_age_hours * 3600 for age in ages),
            f"{kind} evidence is stale or future-dated")
    require(created <= completed <= finished + dt.timedelta(seconds=900),
            f"{kind} timestamp ordering is invalid")
    export_run = str(manifest.get("runId") or "")
    require(re.fullmatch(kind + r"-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", export_run) is not None,
            f"{kind} export run ID is invalid")
    require(os.path.basename(str(status.get("backupPath") or "").replace("\\", "/")) == export_run,
            f"{kind} backup path is not bound to its export run")
    publication = manifest.get("publication") or {}
    generation = publication.get("generation")
    aliases = publication.get("aliases")
    require(isinstance(generation, str) and isinstance(aliases, dict)
            and required_aliases <= set(aliases), f"{kind} publication is incomplete")
    if kind == "qdrant":
        require(set(aliases) == required_aliases and publication.get("qdrantVersion") == "1.9.4",
                "Qdrant publication is ambiguous or not legacy 1.9.4")
    projected_aliases = {name: aliases.get(name) for name in sorted(required_aliases)}
    require(all(isinstance(value, str) and value for value in projected_aliases.values())
            and len(set(projected_aliases.values())) == 3
            and "song_audio" not in projected_aliases.values(),
            f"{kind} publication aliases are invalid")
    if generation == "legacy":
        expected_aliases = {
            "song_hybrid_active": "song_hybrid",
            "song_metadata_active": "song_metadata",
            "songs_v2_active": "songs_v2",
        }
    else:
        require(re.fullmatch(r"[0-9a-f]{64}:[0-9a-f]{32}", generation) is not None,
                f"{kind} generation is invalid")
        basis, build = generation.split(":", 1)
        suffix = f"{basis[:12]}_{build[:8]}"
        expected_aliases = {
            "song_hybrid_active": f"song_hybrid_basis_{suffix}",
            "song_metadata_active": f"song_metadata_basis_{suffix}",
            "songs_v2_active": f"songs_v2_basis_{suffix}",
        }
    require(projected_aliases == expected_aliases, f"{kind} aliases do not match generation")
    collections = publication.get("collections")
    require(isinstance(collections, list) and len(collections) == len(set(collections)),
            f"{kind} collection inventory is invalid")
    active = {"song_audio", *projected_aliases.values()}
    require(active <= set(collections), f"{kind} publication misses an active collection")
    if kind == "qdrant":
        require(set(collections) == active, "Qdrant publication contains inactive collections")
    validation = manifest.get("validation") or {}
    require(validation.get("generationStable") is True
            and validation.get("qdrantReferenceStable") is True,
            f"{kind} publication was not stable")
    if kind == "postgres":
        database = manifest.get("database") or {}
        require(validation.get("pgRestoreList") == "success"
                and database.get("file") == "postgres.dump"
                and re.fullmatch(r"[0-9a-f]{64}", str(database.get("sha256", "")))
                and isinstance(database.get("sizeBytes"), int) and database["sizeBytes"] > 0
                and status.get("dumpSha256") == database.get("sha256")
                and status.get("dumpSizeBytes") == database.get("sizeBytes"),
                "PostgreSQL payload metadata is invalid")
    else:
        snapshots = manifest.get("snapshots") or []
        expected_files = {"song_audio.snapshot", "song_hybrid.snapshot",
                          "song_metadata.snapshot", "songs_v2.snapshot"}
        expected_collections = {
            "song_audio.snapshot": "song_audio",
            "song_hybrid.snapshot": projected_aliases["song_hybrid_active"],
            "song_metadata.snapshot": projected_aliases["song_metadata_active"],
            "songs_v2.snapshot": projected_aliases["songs_v2_active"],
        }
        require(validation.get("collectionStatesStable") is True
                and validation.get("sourceChecksumsVerified") is True
                and isinstance(validation.get("adoptedExistingExport"), bool)
                and isinstance(snapshots, list) and len(snapshots) == 4
                and {item.get("file") for item in snapshots} == expected_files
                and all(item.get("collection") == expected_collections.get(item.get("file"))
                        and re.fullmatch(r"[0-9a-f]{64}", str(item.get("sha256", "")))
                        and isinstance(item.get("sizeBytes"), int) and item["sizeBytes"] > 0
                        for item in snapshots), "Qdrant snapshot inventory is invalid")
        states = manifest.get("collectionStates")
        require(status.get("collectionStates") == states and isinstance(states, dict)
                and set(states) == set(expected_collections.values())
                and all(isinstance(value, dict) and value.get("status") == "green"
                        and isinstance(value.get("pointsCount"), int)
                        and not isinstance(value.get("pointsCount"), bool)
                        and value["pointsCount"] > 0 for value in states.values())
                and status.get("snapshotCount") == 4
                and status.get("totalSizeBytes") == sum(item["sizeBytes"] for item in snapshots)
                and status.get("totalSizeBytes", 0) > 0,
                "Qdrant payload state is invalid")
    projection = {"generation": generation, "aliases": projected_aliases,
                  "collections": sorted(active)}
    projection_sha = hashlib.sha256(json.dumps(
        projection, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode()).hexdigest()
    return status, manifest, projection_sha

postgres_status, postgres_manifest, postgres_projection = validate_backup(
    "postgres", postgres_run, postgres_status_path, postgres_status_sha,
    postgres_manifest_path, postgres_manifest_sha, 48)
qdrant_status, qdrant_manifest, qdrant_projection = validate_backup(
    "qdrant", qdrant_run, qdrant_status_path, qdrant_status_sha,
    qdrant_manifest_path, qdrant_manifest_sha, 192)
require(postgres_projection == qdrant_projection,
        "PostgreSQL and Qdrant backups do not bind one publication")

def valid_security_binding(value):
    return (isinstance(value, dict)
            and set(value) == {"identitySha256", "securityStateSha256"}
            and all(re.fullmatch(r"[0-9a-f]{64}", str(item or "")) for item in value.values()))

attestation, _ = load(attestation_path, attestation_sha)
require(attestation.get("schemaVersion") == 1
        and attestation.get("challenge") == challenge
        and attestation.get("verifierHost") == verifier_host
        and attestation.get("verifierSha256") == verifier_sha
        and attestation.get("allowedWriterSids") == []
        and valid_security_binding(attestation.get("verifierSecurityBinding")),
        "backup attestation identity/security contract is invalid")
verified_at = dt.datetime.fromisoformat(str(attestation.get("verifiedAt") or "").replace("Z", "+00:00"))
require(verified_at.tzinfo is not None, "backup attestation timestamp has no timezone")
attestation_age = (dt.datetime.now(dt.timezone.utc)
                   - verified_at.astimezone(dt.timezone.utc)).total_seconds()
require(-300 <= attestation_age <= 900, "backup attestation is not fresh")
inputs = {
    "postgres": (postgres_status, postgres_manifest, postgres_status_sha,
                 postgres_manifest_sha, postgres_run),
    "qdrant": (qdrant_status, qdrant_manifest, qdrant_status_sha,
               qdrant_manifest_sha, qdrant_run),
}
backups = attestation.get("backups")
require(isinstance(backups, dict) and set(backups) == set(inputs),
        "backup attestation set is not exact")
for kind, (status, manifest, status_sha, manifest_sha, execution_run) in inputs.items():
    record = backups.get(kind)
    require(isinstance(record, dict)
            and record.get("payloadBytesRehashed") is True
            and record.get("directoryInventoryStable") is True
            and record.get("executionRunId") == execution_run
            and record.get("exportRunId") == manifest.get("runId")
            and record.get("statusSha256") == status_sha
            and record.get("manifestSha256") == manifest_sha,
            f"{kind} payload attestation is not bound")
    if kind == "postgres":
        database = manifest.get("database") or {}
        expected = [{"file": database.get("file"), "sha256": database.get("sha256"),
                     "sizeBytes": database.get("sizeBytes")}]
    else:
        expected = [{"file": item.get("file"), "sha256": item.get("sha256"),
                     "sizeBytes": item.get("sizeBytes")} for item in manifest.get("snapshots") or []]
    expected.sort(key=lambda item: str(item.get("file")))
    require(record.get("payloads") == expected,
            f"{kind} attested payloads differ from manifest")
    security = record.get("securityBindings")
    require(isinstance(security, dict)
            and set(security) == {"allowedRoot", "export", "status", "manifest", "payloads"}
            and all(valid_security_binding(security.get(name))
                    for name in ("allowedRoot", "export", "status", "manifest")),
            f"{kind} attestation security bindings are invalid")
    payload_security = security.get("payloads")
    require(isinstance(payload_security, dict)
            and set(payload_security) == {str(item.get("file")) for item in expected}
            and all(valid_security_binding(value) for value in payload_security.values()),
            f"{kind} payload security bindings are invalid")
print(qdrant_manifest["publication"]["generation"], qdrant_projection)
PY
    ) || return 1
    set -- $extracted
    [ "$#" -eq 2 ] || return 1
    BRIDGE_QDRANT_PUBLICATION_GENERATION="$1"
    publication_sha="$2"
    case "$publication_sha" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#publication_sha}" -eq 64 ] || return 1
    binding_sha=$(printf '%s\n' \
        'schema=1' "qdrant_backup_run_id=$qdrant_run" \
        "qdrant_status_sha256=$qdrant_status_sha" \
        "qdrant_manifest_sha256=$qdrant_manifest_sha" \
        "backup_attestation_sha256=$attestation_sha" \
        "publication_sha256=$publication_sha" | sha256sum | awk '{print $1}') \
        || return 1
    BRIDGE_QDRANT_BACKUP_BINDING="off-host-evidence-sha256-$binding_sha"
    record_state bridge.qdrant_backup_binding "$BRIDGE_QDRANT_BACKUP_BINDING"
    record_state bridge.qdrant_publication_generation "$BRIDGE_QDRANT_PUBLICATION_GENERATION"
}

capture_bridge_legacy_contract() {
    BRIDGE_QDRANT_ID=$(container_id vocadb_qdrant) || return 1
    BRIDGE_POSTGRES_ID=$(container_id vocadb_postgres) || return 1
    [ -n "$BRIDGE_QDRANT_ID" ] && [ -n "$BRIDGE_POSTGRES_ID" ] \
        && [ -n "$OLD_GATEWAY_CONTAINER_ID" ] && [ -n "$OLD_WEB_CONTAINER_ID" ] \
        || return 1
    BRIDGE_QDRANT_IMAGE_ID=$(container_inspect_value "$BRIDGE_QDRANT_ID" '{{.Image}}') || return 1
    BRIDGE_POSTGRES_IMAGE_ID=$(container_inspect_value "$BRIDGE_POSTGRES_ID" '{{.Image}}') || return 1
    BRIDGE_GATEWAY_IMAGE_ID=$(container_inspect_value "$OLD_GATEWAY_CONTAINER_ID" '{{.Image}}') || return 1
    BRIDGE_WEB_IMAGE_ID=$(container_inspect_value "$OLD_WEB_CONTAINER_ID" '{{.Image}}') || return 1
    for native_container_id in "$BRIDGE_QDRANT_ID" "$BRIDGE_POSTGRES_ID" \
        "$OLD_GATEWAY_CONTAINER_ID" "$OLD_WEB_CONTAINER_ID" \
        "$OLD_API_A_CONTAINER_ID" "$OLD_API_B_CONTAINER_ID"; do
        verify_container_image_linux_arm64 "$native_container_id" || return 1
    done
    BRIDGE_QDRANT_CONFIG_HASH=$(container_inspect_value "$BRIDGE_QDRANT_ID" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    BRIDGE_POSTGRES_CONFIG_HASH=$(container_inspect_value "$BRIDGE_POSTGRES_ID" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    BRIDGE_GATEWAY_CONFIG_HASH=$(container_inspect_value "$OLD_GATEWAY_CONTAINER_ID" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    BRIDGE_WEB_CONFIG_HASH=$(container_inspect_value "$OLD_WEB_CONTAINER_ID" \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}') || return 1
    for hash in "$BRIDGE_QDRANT_CONFIG_HASH" "$BRIDGE_POSTGRES_CONFIG_HASH" \
        "$BRIDGE_GATEWAY_CONFIG_HASH" "$BRIDGE_WEB_CONFIG_HASH"; do
        printf '%s\n' "$hash" | grep -Eq '^[0-9a-f]{64}$' || return 1
    done
    prepare_bridge_backup_contract || return 1
    record_state bridge.legacy_contract \
        "$BRIDGE_QDRANT_ID:$BRIDGE_POSTGRES_ID:$OLD_GATEWAY_CONTAINER_ID:$OLD_WEB_CONTAINER_ID"
}

verify_bridge_legacy_contract() {
    [ "$(container_id vocadb_qdrant)" = "$BRIDGE_QDRANT_ID" ] \
        && [ "$(container_id vocadb_postgres)" = "$BRIDGE_POSTGRES_ID" ] \
        && [ "$(container_id "$GATEWAY_CONTAINER")" = "$OLD_GATEWAY_CONTAINER_ID" ] \
        && [ "$(container_id "$WEB_CONTAINER")" = "$OLD_WEB_CONTAINER_ID" ] \
        && [ "$(container_inspect_value "$BRIDGE_QDRANT_ID" '{{.Image}}')" = "$BRIDGE_QDRANT_IMAGE_ID" ] \
        && [ "$(container_inspect_value "$BRIDGE_POSTGRES_ID" '{{.Image}}')" = "$BRIDGE_POSTGRES_IMAGE_ID" ] \
        && [ "$(container_inspect_value "$OLD_GATEWAY_CONTAINER_ID" '{{.Image}}')" = "$BRIDGE_GATEWAY_IMAGE_ID" ] \
        && [ "$(container_inspect_value "$OLD_WEB_CONTAINER_ID" '{{.Image}}')" = "$BRIDGE_WEB_IMAGE_ID" ] \
        && [ "$(container_inspect_value "$BRIDGE_QDRANT_ID" '{{index .Config.Labels "com.docker.compose.config-hash"}}')" = "$BRIDGE_QDRANT_CONFIG_HASH" ] \
        && [ "$(container_inspect_value "$BRIDGE_POSTGRES_ID" '{{index .Config.Labels "com.docker.compose.config-hash"}}')" = "$BRIDGE_POSTGRES_CONFIG_HASH" ] \
        && [ "$(container_inspect_value "$OLD_GATEWAY_CONTAINER_ID" '{{index .Config.Labels "com.docker.compose.config-hash"}}')" = "$BRIDGE_GATEWAY_CONFIG_HASH" ] \
        && [ "$(container_inspect_value "$OLD_WEB_CONTAINER_ID" '{{index .Config.Labels "com.docker.compose.config-hash"}}')" = "$BRIDGE_WEB_CONFIG_HASH" ] \
        && verify_container_image_linux_arm64 "$BRIDGE_QDRANT_ID" \
        && verify_container_image_linux_arm64 "$BRIDGE_POSTGRES_ID" \
        && verify_container_image_linux_arm64 "$OLD_GATEWAY_CONTAINER_ID" \
        && verify_container_image_linux_arm64 "$OLD_WEB_CONTAINER_ID"
}

prepare_and_publish_bridge_receipt() {
    local producer helper publisher prepared_sha publish_result
    producer="$SOURCE_SNAPSHOT_ROOT/scripts/sbc-api-bridge-receipt.py"
    helper="$SOURCE_SNAPSHOT_ROOT/scripts/wsl-dr-api-bridge-receipt.py"
    publisher="$SOURCE_SNAPSHOT_ROOT/scripts/sbc-api-bridge-publication.py"
    [ -f "$producer" ] && [ ! -L "$producer" ] \
        && [ -f "$helper" ] && [ ! -L "$helper" ] \
        && [ -f "$publisher" ] && [ ! -L "$publisher" ] || return 1
    [ ! -e "$API_BRIDGE_RECEIPT" ] && [ ! -L "$API_BRIDGE_RECEIPT" ] \
        && [ ! -e "$API_BRIDGE_PREPARED_RECEIPT" ] \
        && [ ! -e "$API_BRIDGE_PREVIOUS_RECEIPT" ] || return 1
    verify_bridge_legacy_contract || return 1
    "$PYTHON_COMMAND" -I "$producer" \
        --docker "$DOCKER_COMMAND" --gateway-id "$OLD_GATEWAY_CONTAINER_ID" \
        --api-a-id "$NEW_API_A_CONTAINER_ID" --api-b-id "$NEW_API_B_CONTAINER_ID" \
        --old-api-a-id "$OLD_API_A_CONTAINER_ID" --old-api-b-id "$OLD_API_B_CONTAINER_ID" \
        --qdrant-id "$BRIDGE_QDRANT_ID" --deployment-id "$DEPLOYMENT_ID" \
        --player-commit "$GIT_COMMIT" --source-entries "$SOURCE_TREE_ENTRIES_FILE" \
        --source-root "$SOURCE_SNAPSHOT_ROOT" \
        --source-snapshot-sha256 "$SOURCE_SNAPSHOT_SHA256" \
        --backup-binding "$BRIDGE_QDRANT_BACKUP_BINDING" \
        --publication-generation "$BRIDGE_QDRANT_PUBLICATION_GENERATION" \
        --api-a-rollback-tag "$API_A_BRIDGE_ROLLBACK_IMAGE" \
        --api-b-rollback-tag "$API_B_BRIDGE_ROLLBACK_IMAGE" \
        --previous-output "$API_BRIDGE_PREVIOUS_RECEIPT" \
        --receipt-output "$API_BRIDGE_PREPARED_RECEIPT" || return 1
    chmod 600 "$API_BRIDGE_PREPARED_RECEIPT" "$API_BRIDGE_PREVIOUS_RECEIPT" || return 1
    "$SYNC_COMMAND" -f "$API_BRIDGE_PREPARED_RECEIPT" 2>/dev/null || "$SYNC_COMMAND" || return 1
    "$SYNC_COMMAND" -f "$API_BRIDGE_PREVIOUS_RECEIPT" 2>/dev/null || "$SYNC_COMMAND" || return 1
    set -- "$PYTHON_COMMAND" -I "$helper" --path "$API_BRIDGE_PREPARED_RECEIPT" \
        --expect-host-scope sbc-primary --require-fresh --verify-previous-api-rollback
    [ "$TEST_MODE" != "1" ] || set -- "$@" --allow-current-owner-for-test
    "$@" > "$DEPLOYMENT_DIR/api-bridge-receipt.validation.json" || return 1
    prepared_sha=$(sha256sum "$API_BRIDGE_PREPARED_RECEIPT" | awk '{print $1}') || return 1
    verify_bridge_legacy_contract || return 1
    verify_exact_rolling_topology || return 1
    verify_private_source_snapshot || return 1
    [ "$(image_ref_id "$API_A_BRIDGE_ROLLBACK_IMAGE")" = "$OLD_API_A_IMAGE" ] \
        && [ "$(image_ref_id "$API_B_BRIDGE_ROLLBACK_IMAGE")" = "$OLD_API_B_IMAGE" ] \
        || return 1
    API_BRIDGE_PREPARED_SHA="$prepared_sha"
    record_state bridge.receipt_publication_intent "$prepared_sha" || return 1
    run_test_hook "before-bridge-receipt-publication"
    API_BRIDGE_PUBLICATION_ARMED=true
    trap '' HUP INT TERM
    if ! publish_result=$("$PYTHON_COMMAND" -I "$publisher" publish \
        --prepared "$API_BRIDGE_PREPARED_RECEIPT" \
        --canonical "$API_BRIDGE_RECEIPT" \
        --expected-sha256 "$prepared_sha"); then
        if [ ! -e "$API_BRIDGE_RECEIPT" ] && [ ! -L "$API_BRIDGE_RECEIPT" ]; then
            API_BRIDGE_PUBLICATION_ARMED=false
        fi
        trap 'handle_signal HUP 129' HUP
        trap 'handle_signal INT 130' INT
        trap 'handle_signal TERM 143' TERM
        return 1
    fi
    if [ "$publish_result" != published ] \
        || [ ! -f "$API_BRIDGE_RECEIPT" ] || [ -L "$API_BRIDGE_RECEIPT" ] \
        || [ "$(stat -c '%a:%h' "$API_BRIDGE_RECEIPT")" != "600:1" ] \
        || [ -e "$API_BRIDGE_PREPARED_RECEIPT" ] || [ -L "$API_BRIDGE_PREPARED_RECEIPT" ] \
        || [ "$(sha256sum "$API_BRIDGE_RECEIPT" | awk '{print $1}')" != "$prepared_sha" ]; then
        trap 'handle_signal HUP 129' HUP
        trap 'handle_signal INT 130' INT
        trap 'handle_signal TERM 143' TERM
        return 1
    fi
    API_BRIDGE_PUBLISHED=true
    DEPLOYMENT_SUCCEEDED=true
    CANONICAL_IMAGES_COMMITTED=true
    RECOVERY_ARMED=false
    API_BRIDGE_PUBLICATION_ARMED=false
    trap 'handle_signal HUP 129' HUP
    trap 'handle_signal INT 130' INT
    trap 'handle_signal TERM 143' TERM
    record_state bridge.receipt_published "$prepared_sha" || true
}

release_active_journal() {
    [ "$ACTIVE_JOURNAL_CREATED" = "true" ] || return 0
    [ -n "$ACTIVE_JOURNAL_ID" ] && [ -n "$STATE_ROOT_ID" ] || return 1
    run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" "$EXACT_PYTHON_COMMAND" -I -c '
import os
import stat
import sys

root, root_expected_raw, path, expected_raw, allow_current = sys.argv[1:]
root_expected = tuple(int(value) for value in root_expected_raw.split(":"))
parts = expected_raw.split(":")
if len(root_expected) != 2 or len(parts) != 5:
    raise SystemExit(2)
expected = (int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3], 16), int(parts[4]))
if allow_current == "1" and os.name == "nt":
    root_info = os.lstat(root)
    if (root_info.st_dev, root_info.st_ino) != root_expected \
            or not stat.S_ISDIR(root_info.st_mode):
        raise RuntimeError("deployment state root identity changed")
    opened = os.lstat(path)
    identity = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink)
    comparable_expected = (expected[0], expected[1], expected[2], expected[4])
    if identity != comparable_expected or not stat.S_ISREG(opened.st_mode):
        raise RuntimeError("active journal identity changed")
    os.unlink(path)
    if os.path.lexists(path):
        raise RuntimeError("active journal path survived release")
    raise SystemExit(0)
flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
directory_flags = flags | getattr(os, "O_DIRECTORY", 0)
directory = os.open(root, directory_flags)
descriptor = None
try:
    root_info = os.fstat(directory)
    if (root_info.st_dev, root_info.st_ino) != root_expected \
            or not stat.S_ISDIR(root_info.st_mode) \
            or (allow_current != "1" and root_info.st_mode & 0o077):
        raise RuntimeError("deployment state root identity changed")
    descriptor = os.open(os.path.basename(path), flags, dir_fd=directory)
    opened = os.fstat(descriptor)
    identity = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mode, opened.st_nlink)
    if identity != expected or not stat.S_ISREG(opened.st_mode) \
            or (allow_current != "1" and opened.st_mode & 0o077):
        raise RuntimeError("active journal identity changed")
    os.unlink(os.path.basename(path), dir_fd=directory)
    os.fsync(directory)
    try:
        os.stat(os.path.basename(path), dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError("active journal path survived release")
finally:
    if descriptor is not None:
        os.close(descriptor)
    os.close(directory)
' "$STATE_ROOT" "$STATE_ROOT_ID" "$ACTIVE_JOURNAL" "$ACTIVE_JOURNAL_ID" \
        "$TEST_MODE" || return 1
    ACTIVE_JOURNAL_CREATED=false
    ACTIVE_JOURNAL_ID=""
    record_state "deployment.journal_cleanup" "durable-exact-inode-release"
}

acquire_deploy_lock() {
    local owner_identity owner_boot_id owner_start_ticks
    if ! mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null; then
        owner=$(cat "$DEPLOY_LOCK_DIR/owner" 2>/dev/null || printf '%s' unknown)
        fail "Another rolling deployment holds $DEPLOY_LOCK_DIR (owner=$owner)"
        return 1
    fi
    DEPLOY_LOCK_HELD=true
    if [ "$TEST_MODE" = "1" ]; then
        owner_boot_id="test-boot-$DEPLOYMENT_ID"
        owner_start_ticks="test-start-$$"
    else
        owner_boot_id=$(cat /proc/sys/kernel/random/boot_id) || return 1
        owner_start_ticks=$(awk '{print $22}' "/proc/$$/stat") || return 1
        case "$owner_boot_id:$owner_start_ticks" in
            *[!0-9a-fA-F:-]*|:|*:) return 1 ;;
        esac
    fi
    printf 'pid=%s\ndeployment_id=%s\ndeployment_dir=%s\nprivate_runtime=%s\nboot_id=%s\nprocess_start_ticks=%s\nstarted=%s\n' \
        "$$" "$DEPLOYMENT_ID" "$DEPLOYMENT_DIR" "$PRIVATE_RUNTIME_ROOT" \
        "$owner_boot_id" "$owner_start_ticks" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        > "$DEPLOY_LOCK_DIR/owner" || return 1
    chmod 600 "$DEPLOY_LOCK_DIR/owner" || return 1
    "$SYNC_COMMAND" -f "$DEPLOY_LOCK_DIR/owner" 2>/dev/null || "$SYNC_COMMAND" \
        || return 1
    "$SYNC_COMMAND" -f "$DEPLOY_LOCK_DIR" 2>/dev/null || "$SYNC_COMMAND" \
        || return 1
    DEPLOY_LOCK_DIR_ID=$(stat -c '%d:%i' "$DEPLOY_LOCK_DIR") || return 1
    owner_identity=$(stat -c '%d:%i:%s:%f:%h' "$DEPLOY_LOCK_DIR/owner") || return 1
    case "$owner_identity" in *:*:*:*:1) ;; *) return 1 ;; esac
    DEPLOY_LOCK_OWNER_ID=$owner_identity
    record_state "deployment.lock" "acquired"
    record_state "deployment.lock_dir_identity" "$DEPLOY_LOCK_DIR_ID"
    record_state "deployment.lock_owner_identity" "$DEPLOY_LOCK_OWNER_ID"
    record_state "deployment.owner_boot_id" "$owner_boot_id"
    record_state "deployment.owner_process_start_ticks" "$owner_start_ticks"
}

release_deploy_lock() {
    [ "$DEPLOY_LOCK_HELD" = "true" ] || return 0
    [ -n "$DEPLOY_LOCK_DIR_ID" ] && [ -n "$DEPLOY_LOCK_OWNER_ID" ] || return 1
    run_with_timeout "$DOCKER_READ_TIMEOUT_SECONDS" "$EXACT_PYTHON_COMMAND" -I -c '
import os
import stat
import sys

root, root_expected_raw, lock_name, tombstone_name, lock_expected_raw, owner_expected_raw, allow_current = sys.argv[1:]
root_expected = tuple(int(value) for value in root_expected_raw.split(":"))
lock_expected = tuple(int(value) for value in lock_expected_raw.split(":"))
owner_parts = owner_expected_raw.split(":")
if len(root_expected) != 2 or len(lock_expected) != 2 or len(owner_parts) != 5:
    raise SystemExit(2)
owner_expected = (int(owner_parts[0]), int(owner_parts[1]), int(owner_parts[2]),
                  int(owner_parts[3], 16), int(owner_parts[4]))
lock_path = os.path.join(root, lock_name)
owner_path = os.path.join(lock_path, "owner")
if os.path.basename(tombstone_name) != tombstone_name or tombstone_name in ("", ".", ".."):
    raise RuntimeError("deployment lock retirement name is unsafe")
if allow_current == "1" and os.name == "nt":
    root_info = os.lstat(root)
    lock_info = os.lstat(lock_path)
    owner_info = os.lstat(owner_path)
    owner_identity = (owner_info.st_dev, owner_info.st_ino, owner_info.st_size,
                      owner_info.st_nlink)
    comparable_owner = (owner_expected[0], owner_expected[1],
                        owner_expected[2], owner_expected[4])
    if (root_info.st_dev, root_info.st_ino) != root_expected \
            or not stat.S_ISDIR(root_info.st_mode) \
            or (lock_info.st_dev, lock_info.st_ino) != lock_expected \
            or not stat.S_ISDIR(lock_info.st_mode) \
            or owner_identity != comparable_owner \
            or not stat.S_ISREG(owner_info.st_mode) \
            or os.listdir(lock_path) != ["owner"]:
        raise RuntimeError("deployment lock identity changed")
    tombstone_path = os.path.join(root, tombstone_name)
    if os.path.lexists(tombstone_path):
        raise RuntimeError("deployment lock retirement tombstone exists")
    os.rename(lock_path, tombstone_path)
    moved = os.lstat(tombstone_path)
    if (moved.st_dev, moved.st_ino) != lock_expected:
        raise RuntimeError("deployment lock retirement identity changed")
    os.unlink(os.path.join(tombstone_path, "owner"))
    if os.listdir(tombstone_path):
        raise RuntimeError("deployment lock did not become empty")
    os.rmdir(tombstone_path)
    raise SystemExit(0)
flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
directory_flags = flags | getattr(os, "O_DIRECTORY", 0)
root_fd = os.open(root, directory_flags)
lock_fd = None
owner_fd = None
try:
    root_info = os.fstat(root_fd)
    if (root_info.st_dev, root_info.st_ino) != root_expected \
            or not stat.S_ISDIR(root_info.st_mode) \
            or (allow_current != "1" and root_info.st_mode & 0o077):
        raise RuntimeError("deployment state root identity changed")
    lock_fd = os.open(lock_name, directory_flags, dir_fd=root_fd)
    lock_info = os.fstat(lock_fd)
    if (lock_info.st_dev, lock_info.st_ino) != lock_expected \
            or not stat.S_ISDIR(lock_info.st_mode) \
            or (allow_current != "1" and lock_info.st_mode & 0o077):
        raise RuntimeError("deployment lock identity changed")
    if os.listdir(lock_fd) != ["owner"]:
        raise RuntimeError("deployment lock contains an unexpected entry")
    owner_fd = os.open("owner", flags, dir_fd=lock_fd)
    owner_info = os.fstat(owner_fd)
    owner_identity = (owner_info.st_dev, owner_info.st_ino, owner_info.st_size,
                      owner_info.st_mode, owner_info.st_nlink)
    if owner_identity != owner_expected or not stat.S_ISREG(owner_info.st_mode) \
            or (allow_current != "1" and owner_info.st_mode & 0o077):
        raise RuntimeError("deployment lock owner identity changed")
    try:
        os.stat(tombstone_name, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError("deployment lock retirement tombstone exists")
    os.rename(lock_name, tombstone_name, src_dir_fd=root_fd, dst_dir_fd=root_fd)
    os.fsync(root_fd)
    moved = os.stat(tombstone_name, dir_fd=root_fd, follow_symlinks=False)
    if (moved.st_dev, moved.st_ino) != lock_expected or not stat.S_ISDIR(moved.st_mode):
        raise RuntimeError("deployment lock retirement identity changed")
    os.unlink("owner", dir_fd=lock_fd)
    os.fsync(lock_fd)
    if os.listdir(lock_fd):
        raise RuntimeError("deployment lock did not become empty")
    os.rmdir(tombstone_name, dir_fd=root_fd)
    os.fsync(root_fd)
finally:
    if owner_fd is not None:
        os.close(owner_fd)
    if lock_fd is not None:
        os.close(lock_fd)
    os.close(root_fd)
' "$STATE_ROOT" "$STATE_ROOT_ID" "${DEPLOY_LOCK_DIR##*/}" \
        "deploy.lock.retiring-$DEPLOYMENT_ID" \
        "$DEPLOY_LOCK_DIR_ID" "$DEPLOY_LOCK_OWNER_ID" "$TEST_MODE" || return 1
    DEPLOY_LOCK_HELD=false
    DEPLOY_LOCK_DIR_ID=""
    DEPLOY_LOCK_OWNER_ID=""
    record_state "deployment.lock_cleanup" "durable-exact-inode-release"
}

unique_receipt_value() {
    local receipt_file="$1"
    local receipt_key="$2"
    awk -F= -v expected="$receipt_key" '
        $1 == expected {
            count += 1
            value = substr($0, length($1) + 2)
        }
        END {
            if (count != 1) {
                exit 1
            }
            print value
        }
    ' "$receipt_file"
}

last_receipt_value() {
    local receipt_file="$1"
    local receipt_key="$2"
    awk -F= -v expected="$receipt_key" '
        $1 == expected {
            found = 1
            value = substr($0, length($1) + 2)
        }
        END {
            if (!found) {
                exit 1
            }
            print value
        }
    ' "$receipt_file"
}

startup_reconcile_stale_run() {
    local stale_active=false stale_lock=false stale_owner stale_id stale_dir
    local stale_state stale_private stale_pid stale_boot stale_start current_start
    local stale_status=""
    local stale_dir_id stale_lock_id stale_owner_id stale_journal_id
    local stale_runtime_id stale_backend_id stale_runtime_path=""
    local stale_runtime_recorded=false reconcile_result=1
    local saved_deployment_id="$DEPLOYMENT_ID"
    local saved_deployment_dir="$DEPLOYMENT_DIR"
    local saved_deployment_dir_id="$DEPLOYMENT_DIR_ID"
    local saved_state_file="$STATE_FILE"
    local saved_private_root="$PRIVATE_RUNTIME_ROOT"
    local saved_private_root_id="$PRIVATE_RUNTIME_ROOT_ID"
    local saved_private_backend_file="$PRIVATE_BACKEND_ENV_FILE"
    local saved_private_backend_id="$PRIVATE_BACKEND_ENV_ID"
    local saved_lock_held="$DEPLOY_LOCK_HELD"
    local saved_lock_dir_id="$DEPLOY_LOCK_DIR_ID"
    local saved_lock_owner_id="$DEPLOY_LOCK_OWNER_ID"
    local saved_journal_created="$ACTIVE_JOURNAL_CREATED"
    local saved_journal_id="$ACTIVE_JOURNAL_ID"

    if [ -e "$ACTIVE_JOURNAL" ] || [ -L "$ACTIVE_JOURNAL" ]; then
        stale_active=true
    fi
    if [ -e "$DEPLOY_LOCK_DIR" ] || [ -L "$DEPLOY_LOCK_DIR" ]; then
        stale_lock=true
    fi
    if [ "$stale_active" = "false" ] && [ "$stale_lock" = "false" ]; then
        return 0
    fi
    # A journal without its owner lock has no authenticated cleanup authority.
    # Preserve it rather than guessing which deployment created it.
    [ "$stale_lock" = "true" ] && [ -d "$DEPLOY_LOCK_DIR" ] \
        && [ ! -L "$DEPLOY_LOCK_DIR" ] \
        && [ -f "$DEPLOY_LOCK_DIR/owner" ] \
        && [ ! -L "$DEPLOY_LOCK_DIR/owner" ] || return 1

    stale_owner="$DEPLOY_LOCK_DIR/owner"
    stale_pid=$(unique_receipt_value "$stale_owner" pid) || return 1
    stale_id=$(unique_receipt_value "$stale_owner" deployment_id) || return 1
    stale_dir=$(unique_receipt_value "$stale_owner" deployment_dir) || return 1
    stale_private=$(unique_receipt_value "$stale_owner" private_runtime) || return 1
    stale_boot=$(unique_receipt_value "$stale_owner" boot_id) || return 1
    stale_start=$(unique_receipt_value "$stale_owner" process_start_ticks) || return 1
    case "$stale_pid" in ''|*[!0-9]*) return 1 ;; esac
    case "$stale_id" in ''|*[!0-9TZ-]*) return 1 ;; esac
    if [ "$TEST_MODE" != "1" ]; then
        [ "$stale_private" = "/run/diva-player-rolling/$stale_id" ] || return 1
    fi
    [ "$stale_dir" = "$STATE_ROOT/$stale_id" ] \
        && [ -d "$stale_dir" ] && [ ! -L "$stale_dir" ] || return 1
    stale_state="$stale_dir/state"
    [ -f "$stale_state" ] && [ ! -L "$stale_state" ] || return 1
    [ "$(unique_receipt_value "$stale_state" deployment.id)" = "$stale_id" ] \
        || return 1
    stale_dir_id=$(unique_receipt_value "$stale_state" deployment.directory_identity) \
        || return 1
    [ "$(stat -c '%d:%i' "$stale_dir")" = "$stale_dir_id" ] || return 1
    stale_lock_id=$(unique_receipt_value "$stale_state" deployment.lock_dir_identity) \
        || return 1
    stale_owner_id=$(unique_receipt_value "$stale_state" deployment.lock_owner_identity) \
        || return 1
    [ "$(stat -c '%d:%i' "$DEPLOY_LOCK_DIR")" = "$stale_lock_id" ] \
        && [ "$(stat -c '%d:%i:%s:%f:%h' "$stale_owner")" = "$stale_owner_id" ] \
        && [ "$(unique_receipt_value "$stale_state" deployment.owner_boot_id)" = "$stale_boot" ] \
        && [ "$(unique_receipt_value "$stale_state" deployment.owner_process_start_ticks)" = "$stale_start" ] \
        || return 1

    # Reconciliation is credential/lock crash recovery, not service recovery.
    # Never auto-release an intentional operational interlock or a deployment
    # that could have been killed while mutating the live Docker topology.
    if grep -q '^deployment\.interlock=' "$stale_state" \
        || [ -e "$stale_dir/daemon-mutation-unresolved" ] \
        || [ -L "$stale_dir/daemon-mutation-unresolved" ]; then
        return 1
    fi
    stale_status=$(last_receipt_value "$stale_state" deployment.status 2>/dev/null \
        || printf '%s' none)
    case "$stale_status" in
        none|preflight|failed|completed|completed-api-only-bridge) ;;
        *) return 1 ;;
    esac

    if [ "$TEST_MODE" = "1" ]; then
        if kill -0 "$stale_pid" 2>/dev/null; then
            return 2
        fi
    elif [ "$stale_boot" = "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" ] \
        && [ -r "/proc/$stale_pid/stat" ]; then
        current_start=$(awk '{print $22}' "/proc/$stale_pid/stat") || return 1
        [ "$current_start" != "$stale_start" ] || return 2
    fi

    if [ "$stale_active" = "true" ]; then
        [ -f "$ACTIVE_JOURNAL" ] && [ ! -L "$ACTIVE_JOURNAL" ] \
            && [ "$(cat "$ACTIVE_JOURNAL")" = "$stale_dir" ] || return 1
        stale_journal_id=$(unique_receipt_value "$stale_state" deployment.journal_identity) \
            || return 1
        [ "$(stat -c '%d:%i:%s:%f:%h' "$ACTIVE_JOURNAL")" = "$stale_journal_id" ] \
            || return 1
    else
        stale_journal_id=""
    fi

    if stale_runtime_path=$(unique_receipt_value "$stale_state" private_runtime.path 2>/dev/null); then
        stale_runtime_recorded=true
        [ "$stale_runtime_path" = "$stale_private" ] || return 1
        stale_runtime_id=$(unique_receipt_value "$stale_state" private_runtime.identity) \
            || return 1
        if [ -e "$stale_private" ] || [ -L "$stale_private" ]; then
            [ -d "$stale_private" ] && [ ! -L "$stale_private" ] \
                && [ "$(stat -c '%d:%i' "$stale_private")" = "$stale_runtime_id" ] \
                || return 1
        else
            stale_runtime_id=""
        fi
    else
        stale_runtime_id=""
        [ ! -e "$stale_private" ] && [ ! -L "$stale_private" ] || return 1
    fi
    if stale_backend_id=$(unique_receipt_value "$stale_state" backend_env.private_identity 2>/dev/null); then
        [ "$stale_runtime_recorded" = "true" ] || return 1
        if [ -e "$stale_private/backend.env.private" ] \
            || [ -L "$stale_private/backend.env.private" ]; then
            [ -f "$stale_private/backend.env.private" ] \
                && [ ! -L "$stale_private/backend.env.private" ] \
                && [ "$(stat -c '%d:%i:%s:%f:%h' "$stale_private/backend.env.private")" = "$stale_backend_id" ] \
                || return 1
        elif [ -e "$stale_private/.backend.env.private.retiring" ] \
            || [ -L "$stale_private/.backend.env.private.retiring" ]; then
            [ -f "$stale_private/.backend.env.private.retiring" ] \
                && [ ! -L "$stale_private/.backend.env.private.retiring" ] \
                && [ "$(stat -c '%d:%i:%s:%f:%h' "$stale_private/.backend.env.private.retiring")" = "$stale_backend_id" ] \
                || return 1
        else
            stale_backend_id=""
        fi
    else
        stale_backend_id=""
        [ ! -e "$stale_private/backend.env.private" ] \
            && [ ! -L "$stale_private/backend.env.private" ] \
            && [ ! -e "$stale_private/.backend.env.private.retiring" ] \
            && [ ! -L "$stale_private/.backend.env.private.retiring" ] || return 1
    fi

    DEPLOYMENT_ID="$stale_id"
    DEPLOYMENT_DIR="$stale_dir"
    DEPLOYMENT_DIR_ID="$stale_dir_id"
    STATE_FILE="$stale_state"
    PRIVATE_RUNTIME_ROOT="$stale_private"
    PRIVATE_RUNTIME_ROOT_ID="$stale_runtime_id"
    PRIVATE_BACKEND_ENV_FILE="$stale_private/backend.env.private"
    PRIVATE_BACKEND_ENV_ID="$stale_backend_id"
    DEPLOY_LOCK_HELD=true
    DEPLOY_LOCK_DIR_ID="$stale_lock_id"
    DEPLOY_LOCK_OWNER_ID="$stale_owner_id"
    ACTIVE_JOURNAL_CREATED="$stale_active"
    ACTIVE_JOURNAL_ID="$stale_journal_id"

    if ! retire_private_backend_environment || ! retire_private_runtime_root; then
        record_state "deployment.interlock" \
            "startup-secret-reconciliation-failed-active-journal-and-lock-retained" || true
        reconcile_result=1
    elif [ "$ACTIVE_JOURNAL_CREATED" = "true" ] && ! release_active_journal; then
        record_state "deployment.interlock" \
            "startup-journal-reconciliation-failed-deploy-lock-retained" || true
        reconcile_result=1
    elif ! release_deploy_lock; then
        record_state "deployment.interlock" "startup-lock-reconciliation-failed" || true
        reconcile_result=1
    else
        record_state "deployment.reconciliation" \
            "stale-owner-exact-secret-journal-lock-cleanup-completed" || true
        reconcile_result=0
    fi

    DEPLOYMENT_ID="$saved_deployment_id"
    DEPLOYMENT_DIR="$saved_deployment_dir"
    DEPLOYMENT_DIR_ID="$saved_deployment_dir_id"
    STATE_FILE="$saved_state_file"
    PRIVATE_RUNTIME_ROOT="$saved_private_root"
    PRIVATE_RUNTIME_ROOT_ID="$saved_private_root_id"
    PRIVATE_BACKEND_ENV_FILE="$saved_private_backend_file"
    PRIVATE_BACKEND_ENV_ID="$saved_private_backend_id"
    DEPLOY_LOCK_HELD="$saved_lock_held"
    DEPLOY_LOCK_DIR_ID="$saved_lock_dir_id"
    DEPLOY_LOCK_OWNER_ID="$saved_lock_owner_id"
    ACTIVE_JOURNAL_CREATED="$saved_journal_created"
    ACTIVE_JOURNAL_ID="$saved_journal_id"
    return "$reconcile_result"
}

for positive_setting in "$HEALTH_ATTEMPTS" "$DRAIN_ATTEMPTS" "$ROUTE_ATTEMPTS" \
    "$MUTATION_TIMEOUT_SECONDS" "$BUILD_TIMEOUT_SECONDS" "$MIGRATION_TIMEOUT_SECONDS" \
    "$DOCKER_READ_TIMEOUT_SECONDS" "$DAEMON_SETTLE_ATTEMPTS" \
    "$DAEMON_STABLE_SAMPLES"; do
    case "$positive_setting" in
        ''|*[!0-9]*|0) fail "deployment attempt/timeout settings must be positive integers"; exit 1 ;;
    esac
done
case "$WAIT_SECONDS" in
    ''|*[!0-9]*) fail "deployment wait seconds must be a non-negative integer"; exit 1 ;;
esac
[ "$ROUTE_ATTEMPTS" -ge 2 ] \
    || { fail "route attempts must allow two stable identity samples"; exit 1; }
[ "$DAEMON_SETTLE_ATTEMPTS" -ge "$DAEMON_STABLE_SAMPLES" ] \
    || { fail "daemon settle attempts must cover every required stable sample"; exit 1; }
for required in "$DOCKER_COMMAND" "$CURL_COMMAND" "$SLEEP_COMMAND" "$TIMEOUT_COMMAND" \
    "$SYNC_COMMAND" "$PYTHON_COMMAND" "$EXACT_PYTHON_COMMAND" "$TRIVY_COMMAND" \
    awk cat dirname env grep git \
    sha256sum stat; do
    command -v "$required" >/dev/null 2>&1 \
        || { fail "required deployment command is unavailable: $required"; exit 1; }
done
[ -f "$BRIDGE_RECEIPT_PRODUCER" ] && [ ! -L "$BRIDGE_RECEIPT_PRODUCER" ] \
    || { fail "SBC API bridge receipt producer is unavailable"; exit 1; }
[ -f "$BRIDGE_RECEIPT_PUBLISHER" ] && [ ! -L "$BRIDGE_RECEIPT_PUBLISHER" ] \
    || { fail "SBC API bridge receipt publisher is unavailable"; exit 1; }
[ -f "$IMAGE_SCAN_VALIDATOR" ] && [ ! -L "$IMAGE_SCAN_VALIDATOR" ] \
    || { fail "container image scan validator is unavailable"; exit 1; }
verify_production_docker_platform \
    || { fail "production host/daemon platform is not native linux/aarch64"; exit 1; }

if [ "$BRIDGE_BOOTSTRAP_MODE" = "true" ] \
    && { [ -e "$API_BRIDGE_RECEIPT" ] || [ -L "$API_BRIDGE_RECEIPT" ]; }; then
    fail "A canonical API bridge receipt already exists; bootstrap is one-time and never overwrites it"
    exit 1
fi

if startup_reconcile_stale_run; then
    :
else
    reconciliation_result=$?
    if [ "$reconciliation_result" -eq 2 ]; then
        fail "A live rolling deployment owns $DEPLOY_LOCK_DIR"
    else
        fail "Stale rolling deployment evidence could not be reconciled exactly; journal and lock were preserved"
    fi
    exit 75
fi
if [ "$TEST_MODE" = "1" ] \
    && [ "${DIVA_DEPLOY_TEST_STOP_AFTER_RECONCILE:-0}" = "1" ]; then
    printf '%s\n' 'startup reconciliation completed'
    exit 0
fi
if [ -e "$STATEFUL_ACTIVE_JOURNAL" ] || [ -L "$STATEFUL_ACTIVE_JOURNAL" ]; then
    fail "unfinished stateful hardening journal exists: $STATEFUL_ACTIVE_JOURNAL"
    exit 75
fi
if ! create_deployment_state_directory; then
    fail "deployment state directory could not be created"
    exit 1
fi
if ! acquire_deploy_lock; then
    exit 75
fi
if [ -e "$STATEFUL_LOCK_DIR" ]; then
    fail "Stateful service hardening holds $STATEFUL_LOCK_DIR"
    exit 75
fi
if [ -e "$STATEFUL_ACTIVE_JOURNAL" ] || [ -L "$STATEFUL_ACTIVE_JOURNAL" ]; then
    fail "stateful hardening journal appeared during rolling deployment preflight"
    exit 75
fi
if ! (umask 077; set -C; printf '%s\n' "$DEPLOYMENT_DIR" > "$ACTIVE_JOURNAL") 2>/dev/null; then
    fail "rolling deployment journal appeared concurrently: $ACTIVE_JOURNAL"
    exit 75
fi
ACTIVE_JOURNAL_CREATED=true
"$SYNC_COMMAND" -f "$ACTIVE_JOURNAL" 2>/dev/null || "$SYNC_COMMAND"
"$SYNC_COMMAND" -f "$STATE_ROOT" 2>/dev/null || "$SYNC_COMMAND"
ACTIVE_JOURNAL_ID=$(stat -c '%d:%i:%s:%f:%h' "$ACTIVE_JOURNAL") \
    || { fail "rolling deployment journal identity could not be captured"; exit 1; }
case "$ACTIVE_JOURNAL_ID" in
    *:*:*:*:1) ;;
    *) fail "rolling deployment journal identity is unsafe"; exit 1 ;;
esac
record_state "deployment.journal_identity" "$ACTIVE_JOURNAL_ID"
if ! create_private_runtime_root; then
    fail "private runtime root could not be created and attested"
    exit 1
fi

if ! verify_official_source_provenance; then
    fail "Player source is not the clean current official main revision"
    exit 1
fi
record_state "git.commit" "$GIT_COMMIT"
record_state "deployment.status" "preflight"
record_state "migration.rollback" "not-attempted-forward-only"
printf '%s\n' "$GIT_COMMIT" | grep -Eq '^[0-9a-f]{40}$' \
    || { fail "Player Git commit identity is unavailable or invalid"; exit 1; }
if ! create_private_source_snapshot; then
    fail "Private immutable Player source snapshot could not be created"
    exit 1
fi
if ! capture_private_backend_environment; then
    fail "Backend environment could not be captured into a stable private file"
    exit 1
fi
run_test_hook "private-runtime-captured"
if [ "$BRIDGE_BOOTSTRAP_MODE" != "true" ]; then
    if ! validate_stateful_runtime_contract; then
        exit 1
    fi
else
    record_state "bridge.bootstrap" "explicit-one-time-pre-stateful-contract"
fi

GATEWAY_WAS_RUNNING=false
API_A_STATE="not-routed"
API_B_STATE="not-routed"
OLD_API_A_CONTAINER_ID=$(container_id vocadb_api_a) \
    || { fail "api_a inventory could not be read during preflight"; exit 1; }
OLD_API_B_CONTAINER_ID=$(container_id vocadb_api_b) \
    || { fail "api_b inventory could not be read during preflight"; exit 1; }
OLD_GATEWAY_CONTAINER_ID=$(container_id "$GATEWAY_CONTAINER") \
    || { fail "gateway inventory could not be read during preflight"; exit 1; }
PREFLIGHT_LEGACY_CONTAINER_ID=$(container_id vocadb_api) \
    || { fail "legacy API inventory could not be read during preflight"; exit 1; }
LEGACY_CONTAINER_ID="$PREFLIGHT_LEGACY_CONTAINER_ID"
PUBLISHED_GATEWAY_ID="$OLD_GATEWAY_CONTAINER_ID"
OLD_API_A_IMAGE=$(container_image vocadb_api_a)
OLD_API_B_IMAGE=$(container_image vocadb_api_b)
OLD_GATEWAY_IMAGE=$(container_image "$GATEWAY_CONTAINER")
OLD_WEB_IMAGE=$(container_image "$WEB_CONTAINER")
if ! OLD_WEB_CONTAINER_ID=$(container_id "$WEB_CONTAINER"); then
    fail "Web proxy inventory could not be read during preflight"
    exit 1
fi

if [ -n "$OLD_WEB_CONTAINER_ID" ]; then
    if ! container_running "$WEB_CONTAINER"; then
        fail "Existing Web proxy container is not running; refusing to replace an ambiguous rollback target"
        exit 1
    fi
    WEB_WAS_RUNNING=true
fi

if [ -n "$OLD_GATEWAY_CONTAINER_ID" ]; then
    # Supported rolling topology: all three canonical containers exist and
    # are running. A stopped gateway or any partial A/B inventory is neither a
    # safe rolling deployment nor a bootstrap candidate.
    [ -n "$OLD_API_A_CONTAINER_ID" ] && [ -n "$OLD_API_B_CONTAINER_ID" ] \
        || { fail "Partial rolling API/gateway topology is not deployable"; exit 1; }
    container_running "$GATEWAY_CONTAINER" \
        || { fail "Existing gateway is stopped; refusing ambiguous bootstrap"; exit 1; }
    container_running vocadb_api_a \
        || { fail "Existing api_a is stopped in rolling topology"; exit 1; }
    container_running vocadb_api_b \
        || { fail "Existing api_b is stopped in rolling topology"; exit 1; }
    if [ -n "$LEGACY_CONTAINER_ID" ] && container_running vocadb_api; then
        fail "Legacy and rolling API topologies are concurrently active"
        exit 1
    fi
    GATEWAY_WAS_RUNNING=true
    API_A_STATE=$(slot_enabled_state api_a)
    API_B_STATE=$(slot_enabled_state api_b)

    # A safe rolling update needs a healthy peer throughout. Do not mutate a
    # partially degraded topology or override a deliberate MAINT state.
    if ! wait_healthy vocadb_api_a || ! wait_healthy vocadb_api_b \
        || ! wait_slot_up api_a || ! wait_slot_up api_b; then
        fail "Rolling preflight requires two healthy, UP API slots"
        exit 1
    fi
    if [ "$API_A_STATE" != "enabled" ] || [ "$API_B_STATE" != "enabled" ]; then
        fail "Rolling preflight will not override an administratively disabled slot"
        exit 1
    fi

else
    # Supported bootstrap topology: the legacy API is the sole API port owner
    # and every future rolling canonical name is conclusively absent.
    if [ -n "$OLD_API_A_CONTAINER_ID" ] || [ -n "$OLD_API_B_CONTAINER_ID" ]; then
        fail "Partial A/B topology is not a valid legacy bootstrap state"
        exit 1
    fi
    if [ -z "$LEGACY_CONTAINER_ID" ] || ! container_running vocadb_api; then
        fail "Bootstrap requires one running legacy API and no A/B/gateway containers"
        exit 1
    fi
    LEGACY_WAS_RUNNING=true
fi

record_state "gateway.was_running" "$GATEWAY_WAS_RUNNING"
record_state "api_a.old_image" "${OLD_API_A_IMAGE:-none}"
record_state "api_b.old_image" "${OLD_API_B_IMAGE:-none}"
record_state "gateway.old_image" "${OLD_GATEWAY_IMAGE:-none}"
record_state "api_a.old_container_id" "${OLD_API_A_CONTAINER_ID:-none}"
record_state "api_b.old_container_id" "${OLD_API_B_CONTAINER_ID:-none}"
record_state "gateway.old_container_id" "${OLD_GATEWAY_CONTAINER_ID:-none}"
record_state "web.was_running" "$WEB_WAS_RUNNING"
record_state "web.old_image" "${OLD_WEB_IMAGE:-none}"
record_state "web.old_container_id" "${OLD_WEB_CONTAINER_ID:-none}"
record_state "api_a.route_state" "$API_A_STATE"
record_state "api_b.route_state" "$API_B_STATE"

if [ "$BRIDGE_BOOTSTRAP_MODE" = "true" ]; then
    [ "$GATEWAY_WAS_RUNNING" = "true" ] \
        && [ -n "$OLD_API_A_CONTAINER_ID" ] && [ -n "$OLD_API_B_CONTAINER_ID" ] \
        && [ -z "$LEGACY_CONTAINER_ID" ] \
        || { fail "Legacy-Qdrant bridge bootstrap requires the healthy A/B/gateway topology"; exit 1; }
    if [ -n "$LEGACY_CONTAINER_ID" ] && container_running vocadb_api; then
        fail "Legacy-Qdrant bridge bootstrap refuses a concurrently running legacy API"
        exit 1
    fi
    capture_bridge_legacy_contract \
        || { fail "Legacy stateful/gateway/Web/backup contract could not be frozen"; exit 1; }
    for rollback_reference in "$API_A_BRIDGE_ROLLBACK_IMAGE" "$API_B_BRIDGE_ROLLBACK_IMAGE"; do
        require_image_ref_absent "$rollback_reference" \
            || { fail "Bridge rollback image tag already exists: $rollback_reference"; exit 1; }
    done
    run_bounded_docker_mutation image tag "$OLD_API_A_IMAGE" "$API_A_BRIDGE_ROLLBACK_IMAGE"
    API_A_BRIDGE_ROLLBACK_TAG_CREATED=true
    run_bounded_docker_mutation image tag "$OLD_API_B_IMAGE" "$API_B_BRIDGE_ROLLBACK_IMAGE"
    API_B_BRIDGE_ROLLBACK_TAG_CREATED=true
    [ "$(image_ref_id "$API_A_BRIDGE_ROLLBACK_IMAGE")" = "$OLD_API_A_IMAGE" ] \
        && [ "$(image_ref_id "$API_B_BRIDGE_ROLLBACK_IMAGE")" = "$OLD_API_B_IMAGE" ] \
        || { fail "Bridge rollback image tags did not bind the exact previous images"; exit 1; }
fi

log "Building immutable deployment candidates"
record_state "deployment.status" "building"
if ! capture_canonical_image_state; then
    fail "Canonical image-tag prestate could not be captured before build"
    exit 1
fi
if [ "$BRIDGE_BOOTSTRAP_MODE" = "true" ]; then
    bounded_compose "$BUILD_TIMEOUT_SECONDS" build api_a
else
    bounded_compose "$BUILD_TIMEOUT_SECONDS" build api_a api_gateway web
fi
NEW_API_IMAGE=$(image_ref_id "$API_IMAGE")
NEW_GATEWAY_IMAGE=$(image_ref_id "$GATEWAY_IMAGE")
NEW_WEB_IMAGE=$(image_ref_id "$WEB_IMAGE")
if [ "$BRIDGE_BOOTSTRAP_MODE" = "true" ]; then
    verify_image_linux_arm64 "$NEW_API_IMAGE" \
        || { fail "API bridge candidate is not a native linux/arm64 image"; exit 1; }
else
    verify_image_linux_arm64 "$NEW_API_IMAGE" \
        && verify_image_linux_arm64 "$NEW_GATEWAY_IMAGE" \
        && verify_image_linux_arm64 "$NEW_WEB_IMAGE" \
        || { fail "A normal rolling candidate is not a native linux/arm64 image"; exit 1; }
    record_state "candidate_images.platform" "all-exact-linux-arm64"
fi
if [ "$BRIDGE_BOOTSTRAP_MODE" = "true" ]; then
    candidate_references="$API_CANDIDATE_IMAGE"
else
    candidate_references="$API_CANDIDATE_IMAGE $GATEWAY_CANDIDATE_IMAGE $WEB_CANDIDATE_IMAGE"
fi
for candidate_reference in $candidate_references; do
    candidate_presence_status=0
    require_image_ref_absent "$candidate_reference" || candidate_presence_status=$?
    case "$candidate_presence_status" in
        0) ;;
        1)
            fail "A deployment-unique candidate image tag already exists: $candidate_reference"
            exit 1
            ;;
        *)
            fail "Candidate image-tag presence could not be determined: $candidate_reference"
            exit 1
            ;;
    esac
done
run_bounded_docker_mutation image tag "$NEW_API_IMAGE" "$API_CANDIDATE_IMAGE"
API_CANDIDATE_TAG_CREATED=true
if [ "$BRIDGE_BOOTSTRAP_MODE" != "true" ]; then
    run_bounded_docker_mutation image tag "$NEW_GATEWAY_IMAGE" "$GATEWAY_CANDIDATE_IMAGE"
    GATEWAY_CANDIDATE_TAG_CREATED=true
    run_bounded_docker_mutation image tag "$NEW_WEB_IMAGE" "$WEB_CANDIDATE_IMAGE"
    WEB_CANDIDATE_TAG_CREATED=true
fi
if [ "$(image_ref_id "$API_CANDIDATE_IMAGE")" != "$NEW_API_IMAGE" ]; then
    fail "A deployment-unique candidate tag did not pin its built image"
    exit 1
fi
if [ "$BRIDGE_BOOTSTRAP_MODE" != "true" ] \
    && { [ "$(image_ref_id "$GATEWAY_CANDIDATE_IMAGE")" != "$NEW_GATEWAY_IMAGE" ] \
        || [ "$(image_ref_id "$WEB_CANDIDATE_IMAGE")" != "$NEW_WEB_IMAGE" ]; }; then
    fail "A gateway/Web candidate tag did not pin its built image"
    exit 1
fi
record_state "api.new_image" "$NEW_API_IMAGE"
record_state "gateway.new_image" "$NEW_GATEWAY_IMAGE"
record_state "web.new_image" "$NEW_WEB_IMAGE"
# Deployment-unique tags are retained as immutable evidence/fallback, while
# runtime containers use the canonical references expected by future Compose
# convergence. Every create is followed by an exact image-ID verification.
if [ "$(image_ref_id "$API_IMAGE")" != "$NEW_API_IMAGE" ] \
    || [ "$(image_ref_id "$GATEWAY_IMAGE")" != "$NEW_GATEWAY_IMAGE" ] \
    || [ "$(image_ref_id "$WEB_IMAGE")" != "$NEW_WEB_IMAGE" ]; then
    fail "Canonical build tags changed before candidate validation"
    exit 1
fi
log "Scanning exact rolling candidates with the reviewed Trivy receipt gate"
if [ "$BRIDGE_BOOTSTRAP_MODE" = "true" ]; then
    if ! scan_bridge_api_candidate_image; then
        fail "The exact bridge API candidate failed the local Trivy receipt gate"
        exit 1
    fi
elif ! scan_all_rolling_candidate_images; then
    fail "An exact rolling candidate failed the local Trivy receipt gate"
    exit 1
fi
if ! capture_resolved_compose_contract; then
    fail "Resolved Compose/environment contract could not be frozen privately"
    exit 1
fi

if [ "$BRIDGE_BOOTSTRAP_MODE" != "true" ]; then
    log "Validating the built HAProxy configuration"
    bounded_compose "$MUTATION_TIMEOUT_SECONDS" run --rm --no-deps api_gateway \
        haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
    record_state "gateway.config_validation" "passed"

# Migrations are deliberately a separate, forward-only phase. Binary rollback
# below never claims to undo schema changes; migrations must remain compatible
# with the prior API image for the duration of a rolling deployment.
run_test_hook "before-migration-publication-quiesce"
if ! quiesce_migration_publication; then
    fail "Could not establish the public-writer barrier before migration"
    exit 1
fi
log "Applying forward-only database migrations"
record_state "deployment.status" "migrating"
record_state "migration.status" "started"
MIGRATION_ACL_UNRESOLVED=true
migration_status=0
bounded_compose "$MIGRATION_TIMEOUT_SECONDS" run --no-deps \
    --name "$MIGRATION_CONTAINER" migrate || migration_status=$?
if ! reconcile_migration_acl_after_run; then
    record_state "migration.container_quiescence" "or-acl-unresolved"
    record_state "migration.acl_reconciliation" "failed"
    fail "Migration container quiescence or control-plane ACL reconciliation failed"
    exit 1
fi
record_state "migration.container_quiescence" "verified"
record_state "migration.acl_reconciliation" "verified"
if [ "$migration_status" -ne 0 ]; then
    record_state "migration.status" "failed"
    fail "Forward-only migration failed before any service was replaced"
    exit 1
fi
record_state "migration.status" "applied"
if ! restore_migration_publication; then
    fail "Could not restore the exact pre-migration public API topology"
    exit 1
fi
else
    record_state "migration.status" "forbidden-by-legacy-qdrant-bridge-bootstrap"
    verify_bridge_legacy_contract \
        || { fail "Stateful/gateway/Web contract drifted during API-only build"; exit 1; }
fi

# Validate the exact runtime credentials/configuration before draining or
# replacing either live slot. A missing versioned login therefore leaves both
# old API containers untouched and serving traffic.
if ! validate_candidate_api; then
    exit 1
fi
if [ "$BRIDGE_BOOTSTRAP_MODE" = "true" ]; then
    if ! verify_bridge_api_candidate_scan_receipt; then
        fail "Bridge API candidate image or Trivy receipt changed before promotion"
        exit 1
    fi
elif ! verify_all_rolling_candidate_scan_receipts; then
    fail "Rolling candidate image or Trivy receipt changed before promotion"
    exit 1
fi

if [ "$GATEWAY_WAS_RUNNING" = "true" ]; then
    RECOVERY_ARMED=true
    record_state "deployment.status" "rolling-api"

    if ! update_slot api_a "$API_A_STATE"; then
        exit 1
    fi
    API_A_UPDATED=true

    if ! update_slot api_b "$API_B_STATE"; then
        exit 1
    fi
    API_B_UPDATED=true

    if [ "$BRIDGE_BOOTSTRAP_MODE" = "true" ]; then
        # The explicit bridge bootstrap is intentionally API-only.  Qdrant,
        # PostgreSQL, HAProxy, Web, and migrations remain frozen at the exact
        # preflight identities while the two new API slots prove compatibility
        # with legacy Qdrant 1.9.4.  Receipt publication is the final commit.
        record_state "deployment.status" "verifying-api-only-bridge"
        wait_http http://127.0.0.1:5000/api/ready 10 \
            || { fail "API-only bridge readiness did not stabilize"; exit 1; }
        wait_http http://127.0.0.1:5000/api/health 30 \
            || { fail "API-only bridge health did not stabilize"; exit 1; }
        verify_bridge_legacy_contract \
            || { fail "Stateful/gateway/Web contract drifted during API A/B update"; exit 1; }
        verify_container_image_linux_arm64 "$NEW_API_A_CONTAINER_ID" \
            || { fail "Published api_a image is not native linux/arm64"; exit 1; }
        verify_container_image_linux_arm64 "$NEW_API_B_CONTAINER_ID" \
            || { fail "Published api_b image is not native linux/arm64"; exit 1; }
        commit_bridge_api_restart_policies \
            || { fail "API-only bridge restart policies could not be committed"; exit 1; }
        verify_exact_rolling_topology \
            || { fail "API-only bridge topology changed before receipt preparation"; exit 1; }
        verify_bridge_legacy_contract \
            || { fail "Frozen stateful/gateway/Web identities changed before receipt preparation"; exit 1; }
        verify_resolved_compose_contract \
            || { fail "Private resolved Compose contract changed before bridge commit"; exit 1; }
        verify_private_source_snapshot \
            || { fail "Private source snapshot changed before bridge commit"; exit 1; }
        [ "$(image_ref_id "$API_IMAGE")" = "$NEW_API_IMAGE" ] \
            && [ "$(image_ref_id "$API_A_BRIDGE_ROLLBACK_IMAGE")" = "$OLD_API_A_IMAGE" ] \
            && [ "$(image_ref_id "$API_B_BRIDGE_ROLLBACK_IMAGE")" = "$OLD_API_B_IMAGE" ] \
            || { fail "API or bridge rollback image tags drifted before receipt preparation"; exit 1; }
        run_test_hook "bridge-api-only-verified"
        prepare_and_publish_bridge_receipt \
            || { fail "Verified API bridge receipt could not be durably published"; exit 1; }
        # prepare_and_publish_bridge_receipt atomically establishes the
        # forward-only commit flags before restoring signal handlers. No
        # service/container/image mutation is permitted after this point.
        # Retain the deployment-unique candidate tag as immutable evidence;
        # EXIT cleanup must not issue a post-receipt Docker mutation.
        API_CANDIDATE_TAG_CREATED=false
        record_state "bridge.api_candidate_image" \
            "$API_CANDIDATE_IMAGE=$NEW_API_IMAGE" || true
        record_state "deployment.status" "completed-api-only-bridge" || true
        record_state "bridge.previous_api_containers" \
            "retained-exact-for-explicit-later-cleanup" || true
        log "API-only legacy-Qdrant bridge bootstrap completed."
        log "Canonical bridge receipt: $API_BRIDGE_RECEIPT"
        log "Deployment state: $STATE_FILE"
        exit 0
    fi

    record_state "deployment.status" "updating-gateway"
    if ! apply_gateway_image "$OLD_GATEWAY_IMAGE" "$NEW_GATEWAY_IMAGE" \
        "$API_A_STATE" "$API_B_STATE"; then
        exit 1
    fi
else
    # Bootstrap/migration from the legacy single API. Nothing is routed to the
    # A/B containers yet, so they may be prepared in parallel before the port
    # owner changes. Preserve the legacy service until the candidate passes.
    record_state "deployment.status" "bootstrap-api"
    BOOTSTRAP_RECOVERY_ARMED=true
    record_state "bootstrap.recovery" "armed-before-first-a-b-mutation"
    bounded_compose "$MUTATION_TIMEOUT_SECONDS" \
        up -d --no-deps --no-build --force-recreate api_a api_b
    BOOTSTRAP_API_A_ID=$(container_id vocadb_api_a) \
        || { fail "Bootstrap api_a identity query failed"; exit 1; }
    BOOTSTRAP_API_B_ID=$(container_id vocadb_api_b) \
        || { fail "Bootstrap api_b identity query failed"; exit 1; }
    [ -n "$BOOTSTRAP_API_A_ID" ] && [ -n "$BOOTSTRAP_API_B_ID" ] \
        && [ "$BOOTSTRAP_API_A_ID" != "$BOOTSTRAP_API_B_ID" ] \
        || { fail "Bootstrap did not create two exact distinct API IDs"; exit 1; }
    NEW_API_A_CONTAINER_ID="$BOOTSTRAP_API_A_ID"
    NEW_API_B_CONTAINER_ID="$BOOTSTRAP_API_B_ID"
    record_state "bootstrap.api_a_id" "$BOOTSTRAP_API_A_ID"
    record_state "bootstrap.api_b_id" "$BOOTSTRAP_API_B_ID"
    wait_healthy vocadb_api_a
    wait_healthy vocadb_api_b
    verify_created_runtime_contract api_a "$BOOTSTRAP_API_A_ID" "$CANDIDATE_API_IMAGE_ID" \
        "$CANDIDATE_API_IMAGE_ID" "$CANDIDATE_API_A_CONFIG_HASH" \
        "$CANDIDATE_API_A_RUNTIME_SHA256" "$API_A_RUNTIME_ENV_FILE" \
        unless-stopped \
        || { fail "Bootstrap api_a runtime differs from its validated candidate"; exit 1; }
    verify_created_runtime_contract api_b "$BOOTSTRAP_API_B_ID" "$CANDIDATE_API_IMAGE_ID" \
        "$CANDIDATE_API_IMAGE_ID" "$CANDIDATE_API_B_CONFIG_HASH" \
        "$CANDIDATE_API_B_RUNTIME_SHA256" "$API_B_RUNTIME_ENV_FILE" \
        unless-stopped \
        || { fail "Bootstrap api_b runtime differs from its validated candidate"; exit 1; }
    validate_candidate_gateway
    current_legacy_id=$(container_id vocadb_api) \
        || { fail "Legacy API identity could not be revalidated"; exit 1; }
    if [ -z "$PREFLIGHT_LEGACY_CONTAINER_ID" ] \
        || [ "$current_legacy_id" != "$PREFLIGHT_LEGACY_CONTAINER_ID" ] \
        || [ "$LEGACY_CONTAINER_ID" != "$PREFLIGHT_LEGACY_CONTAINER_ID" ] \
        || ! require_exact_running_mapping vocadb_api "$PREFLIGHT_LEGACY_CONTAINER_ID"; then
        mark_topology_drift_unresolved \
            "legacy-bootstrap-expected-${PREFLIGHT_LEGACY_CONTAINER_ID:-absent}-observed-${current_legacy_id:-absent}"
        fail "Legacy API identity changed before bootstrap cutover"
        exit 1
    fi
    LEGACY_WAS_RUNNING=true
    LEGACY_STOPPED_BY_DEPLOY=true
    run_bounded_docker_mutation stop --time 30 "$LEGACY_CONTAINER_ID" >/dev/null
    wait_container_running_id "$LEGACY_CONTAINER_ID" false \
        || { fail "Legacy API did not reach a stable stopped state"; exit 1; }
    record_state "legacy.was_running" "$LEGACY_WAS_RUNNING"
    record_state "legacy.container_id" "${LEGACY_CONTAINER_ID:-none}"

    # Once the gateway may own port 5000, any unexpected exit must stop it and
    # restore the legacy port owner when one existed.
    BOOTSTRAP_GATEWAY_MUTATED=true
    if ! bounded_compose "$MUTATION_TIMEOUT_SECONDS" \
        up -d --no-deps --no-build --force-recreate api_gateway; then
        fail "Gateway bootstrap mutation did not complete"
        exit 1
    fi
    BOOTSTRAP_GATEWAY_ID=$(container_id "$GATEWAY_CONTAINER") \
        || { fail "Bootstrap gateway identity query failed"; exit 1; }
    [ -n "$BOOTSTRAP_GATEWAY_ID" ] \
        || { fail "Bootstrap gateway identity was absent after creation"; exit 1; }
    NEW_GATEWAY_CONTAINER_ID="$BOOTSTRAP_GATEWAY_ID"
    PUBLISHED_GATEWAY_ID="$BOOTSTRAP_GATEWAY_ID"
    record_state "bootstrap.gateway_id" "$BOOTSTRAP_GATEWAY_ID"
    if ! wait_healthy "$BOOTSTRAP_GATEWAY_ID"; then
        fail "Gateway bootstrap failed; the legacy API was restored when available"
        exit 1
    fi
    verify_created_runtime_contract api_gateway "$BOOTSTRAP_GATEWAY_ID" \
        "$CANDIDATE_GATEWAY_IMAGE_ID" "$CANDIDATE_GATEWAY_IMAGE_ID" \
        "$CANDIDATE_CONFIG_HASH" "$CANDIDATE_GATEWAY_RUNTIME_SHA256" \
        "$GATEWAY_RUNTIME_ENV_FILE" unless-stopped \
        || { fail "Bootstrap gateway runtime differs from its validated candidate"; exit 1; }
    run_test_hook "bootstrap-gateway-published"

fi

if ! validate_candidate_web; then
    exit 1
fi
if ! replace_web; then
    exit 1
fi

record_state "deployment.status" "verifying"
wait_http http://127.0.0.1:5000/api/ready 10 \
    || { fail "local API readiness did not stabilize"; exit 1; }
wait_http http://127.0.0.1:5000/api/health 30 \
    || { fail "local API health did not stabilize"; exit 1; }
if container_running "$WEB_CONTAINER"; then
    wait_http http://127.0.0.1:8080/backend-api/api/ready 15 \
        || { fail "Web gateway readiness did not stabilize"; exit 1; }
fi
if ! verify_published_web; then
    fail "Published Web proxy changed before the deployment commit point"
    exit 1
fi
if ! commit_published_restart_policies; then
    fail "Published container restart-policy commit did not reach the exact desired state"
    exit 1
fi
if ! verify_exact_rolling_topology; then
    fail "Published API/gateway topology or preserved rollback identities changed before commit"
    exit 1
fi
if ! verify_published_web unless-stopped; then
    fail "Published Web runtime contract changed during restart-policy commit"
    exit 1
fi
if ! verify_container_image_linux_arm64 "$NEW_API_A_CONTAINER_ID" \
    || ! verify_container_image_linux_arm64 "$NEW_API_B_CONTAINER_ID" \
    || ! verify_container_image_linux_arm64 "$NEW_GATEWAY_CONTAINER_ID" \
    || ! verify_container_image_linux_arm64 "$NEW_WEB_CONTAINER_ID"; then
    fail "A published API/gateway/Web container is not bound to linux/arm64"
    exit 1
fi
record_state "published_containers.platform" "all-exact-linux-arm64"
if ! verify_resolved_compose_contract; then
    fail "Private resolved Compose/environment contract changed before commit"
    exit 1
fi
if ! verify_private_source_snapshot; then
    fail "Private immutable Player source snapshot changed before commit"
    exit 1
fi
if [ "$(image_ref_id "$API_IMAGE")" != "$NEW_API_IMAGE" ] \
    || [ "$(image_ref_id "$GATEWAY_IMAGE")" != "$NEW_GATEWAY_IMAGE" ] \
    || [ "$(image_ref_id "$WEB_IMAGE")" != "$NEW_WEB_IMAGE" ]; then
    fail "Canonical image tags changed before deployment commit"
    exit 1
fi

# The new API/gateway/Web topology is fully verified. This is the deployment
# commit point: all rollback is disarmed before any request to remove the exact
# stopped old Web container, because that removal may complete late in dockerd.
record_state "deployment.status" "verified"
DEPLOYMENT_SUCCEEDED=true
CANONICAL_IMAGES_COMMITTED=true
RECOVERY_ARMED=false
BOOTSTRAP_RECOVERY_ARMED=false
if [ "$API_A_PREVIOUS_PRESERVED" = "true" ]; then
    if finalize_exact_previous_container api_a "$API_A_PREVIOUS_CONTAINER" \
        "$OLD_API_A_CONTAINER_ID"; then
        API_A_PREVIOUS_PRESERVED=false
    else
        POSTCOMMIT_CLEANUP_PENDING=true
        record_state "api_a.previous_cleanup" "deferred-safe-retention"
    fi
fi
if [ "$API_B_PREVIOUS_PRESERVED" = "true" ]; then
    if finalize_exact_previous_container api_b "$API_B_PREVIOUS_CONTAINER" \
        "$OLD_API_B_CONTAINER_ID"; then
        API_B_PREVIOUS_PRESERVED=false
    else
        POSTCOMMIT_CLEANUP_PENDING=true
        record_state "api_b.previous_cleanup" "deferred-safe-retention"
    fi
fi
if [ "$GATEWAY_PREVIOUS_PRESERVED" = "true" ]; then
    if finalize_exact_previous_container gateway "$GATEWAY_PREVIOUS_CONTAINER" \
        "$OLD_GATEWAY_CONTAINER_ID"; then
        GATEWAY_PREVIOUS_PRESERVED=false
    else
        POSTCOMMIT_CLEANUP_PENDING=true
        record_state "gateway.previous_cleanup" "deferred-safe-retention"
    fi
fi
if ! finalize_web_replacement; then
    POSTCOMMIT_CLEANUP_PENDING=true
    record_state "web.previous_cleanup" "deferred-safe-retention"
    log "WARNING: at least one stopped previous container was retained for later cleanup."
fi
if [ "$DAEMON_MUTATION_UNRESOLVED" = "true" ] \
    || [ -e "$DAEMON_UNRESOLVED_FILE" ] || [ -L "$DAEMON_UNRESOLVED_FILE" ]; then
    record_state "deployment.status" \
        "committed-daemon-cleanup-unresolved-manual-reconciliation-required"
    # The new topology is the commit point and must remain live.  EXIT cleanup
    # sees the durable unresolved marker first, so it neither rolls back the
    # new Web container nor releases the deployment interlock while an old-ID
    # removal may still finish in dockerd.
    exit 1
fi
if [ "$POSTCOMMIT_CLEANUP_PENDING" = "true" ]; then
    record_state "deployment.status" "completed-postcommit-cleanup-pending"
    record_state "deployment.interlock" \
        "active-journal-retained-for-exact-old-container-cleanup"
else
    record_state "deployment.status" "completed"
fi
log "Rolling API deployment completed with both slots healthy."
log "Deployment state: $STATE_FILE"
