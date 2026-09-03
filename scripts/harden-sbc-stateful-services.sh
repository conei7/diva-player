#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 0 ]; then
    printf 'Usage: %s\n' "$0" >&2
    exit 64
fi

TEST_MODE=${DIVA_STATEFUL_TEST_MODE:-0}
case "$TEST_MODE" in 0|1) ;; *) printf '%s\n' 'ERROR: invalid stateful test mode' >&2; exit 1 ;; esac
if [ "$TEST_MODE" != "1" ]; then
    PATH=/usr/bin:/bin
    export PATH
fi
ROOT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/.." && pwd)
PIPELINE_ROOT=${DIVA_PIPELINE_ROOT:-"$ROOT_DIR/../diva-data-pipeline"}
PLAYER_OFFICIAL_ORIGIN=https://github.com/conei7/diva-player.git
PIPELINE_OFFICIAL_ORIGIN=git@github.com:conei7/diva-data-pipeline.git
GITHUB_ED25519_HOST_KEY='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
PIPELINE_GITHUB_USER=${DIVA_STATEFUL_TEST_GITHUB_USER:-orangepi}
PIPELINE_GITHUB_HOME=${DIVA_STATEFUL_TEST_GITHUB_HOME:-/home/orangepi}
PIPELINE_GITHUB_IDENTITY=${DIVA_STATEFUL_TEST_GITHUB_IDENTITY:-/home/orangepi/.ssh/id_ed25519_diva_data_pipeline_github}
COMPOSE_FILE="$ROOT_DIR/backend/docker-compose.yml"
COMPOSE_PROJECT_DIRECTORY="$ROOT_DIR/backend"
QDRANT_DOCKERFILE="$ROOT_DIR/backend/qdrant/Dockerfile"
QDRANT_AUDIT_CONTRACT_HELPER="$ROOT_DIR/backend/qdrant/audit-contract.sh"
BACKUP_ATTESTER="$ROOT_DIR/scripts/attest-disaster-backup-payloads.py"
QDRANT_UPGRADE_CONTROLLER="$ROOT_DIR/scripts/sbc-qdrant-storage-upgrade.py"
IMAGE_SCAN_VALIDATOR="$ROOT_DIR/scripts/validate-container-image-scan.py"
API_BRIDGE_CONSUMPTION_HELPER="$ROOT_DIR/scripts/sbc-api-bridge-consumption.py"
POSTGRES_DOCKERFILE="$ROOT_DIR/backend/database/Dockerfile.pgvector"
POSTGRES_MIGRATE_DOCKERFILE="$ROOT_DIR/backend/database/Dockerfile.migrate"

DOCKER_COMMAND=${DIVA_DOCKER_COMMAND:-docker}
CURL_COMMAND=${DIVA_CURL_COMMAND:-curl}
PYTHON_COMMAND=${DIVA_PYTHON_COMMAND:-python3}
SLEEP_COMMAND=${DIVA_SLEEP_COMMAND:-sleep}
TIMEOUT_COMMAND=${DIVA_TIMEOUT_COMMAND:-timeout}
TRIVY_COMMAND=${DIVA_TRIVY_COMMAND:-trivy}
FLOCK_COMMAND=${DIVA_FLOCK_COMMAND:-flock}
SETPRIV_COMMAND=${DIVA_SETPRIV_COMMAND:-setpriv}
PIPELINE_PYTHON=${DIVA_PIPELINE_PYTHON:-"$PIPELINE_ROOT/ml_pipeline/.venv/bin/python"}
PIPELINE_VENV=${DIVA_PIPELINE_VENV:-"$PIPELINE_ROOT/ml_pipeline/.venv"}
PIPELINE_RUNTIME_LOCK="$PIPELINE_ROOT/ml_pipeline/.ml-runtime-use.lock"
PIPELINE_RUNTIME_RECEIPT="$PIPELINE_VENV/.diva-runtime-receipt.json"
PIPELINE_RUNTIME_LOCK_FILE="$PIPELINE_ROOT/ml_pipeline/requirements.linux-aarch64-cp310.lock.txt"
PIPELINE_RUNTIME_VERIFIER="$PIPELINE_ROOT/ml_pipeline/verify_production_ml_runtime.py"
PIPELINE_RUNTIME_PATCHER="$PIPELINE_ROOT/ml_pipeline/patch_tensorflow_hub_compat.py"
API_BRIDGE_RECEIPT=${DIVA_API_BRIDGE_RECEIPT:-/var/lib/diva-player-deploy/api-bridge-receipt.json}
BRIDGE_BACKUP_MAX_ELAPSED_SECONDS=14400

if [ "$TEST_MODE" = "1" ]; then
    [ "$(/usr/bin/id -u)" -ne 0 ] || {
        printf '%s\n' 'ERROR: deterministic stateful test mode refuses uid 0' >&2
        exit 1
    }
else
    if [ "${DIVA_DOCKER_COMMAND+x}" = x ] \
        || [ "${DIVA_CURL_COMMAND+x}" = x ] \
        || [ "${DIVA_PYTHON_COMMAND+x}" = x ] \
        || [ "${DIVA_SLEEP_COMMAND+x}" = x ] \
        || [ "${DIVA_TIMEOUT_COMMAND+x}" = x ] \
        || [ "${DIVA_TRIVY_COMMAND+x}" = x ] \
        || [ "${DIVA_FLOCK_COMMAND+x}" = x ] \
        || [ "${DIVA_SETPRIV_COMMAND+x}" = x ] \
        || [ "${DIVA_TRIVY_CACHE_DIR+x}" = x ] \
        || [ "${DIVA_PIPELINE_ROOT+x}" = x ] \
        || [ "${DIVA_PIPELINE_PYTHON+x}" = x ] \
        || [ "${DIVA_PIPELINE_VENV+x}" = x ] \
        || [ "${DIVA_STATEFUL_TEST_GITHUB_USER+x}" = x ] \
        || [ "${DIVA_STATEFUL_TEST_GITHUB_HOME+x}" = x ] \
        || [ "${DIVA_STATEFUL_TEST_GITHUB_IDENTITY+x}" = x ] \
        || [ "${DIVA_API_BRIDGE_RECEIPT+x}" = x ] \
        || [ "${DIVA_DEPLOY_STATE_DIR+x}" = x ] \
        || [ "${DIVA_STATEFUL_STATE_DIR+x}" = x ]; then
        printf '%s\n' 'ERROR: production stateful command/runtime path overrides are forbidden' >&2
        exit 1
    fi
    if [ "${DOCKER_DEFAULT_PLATFORM+x}" = x ] \
        || [ "${DOCKER_HOST+x}" = x ] \
        || [ "${DOCKER_CONTEXT+x}" = x ] \
        || [ "${DOCKER_API_VERSION+x}" = x ] \
        || [ "${DOCKER_TLS+x}" = x ] \
        || [ "${DOCKER_TLS_VERIFY+x}" = x ] \
        || [ "${DOCKER_CERT_PATH+x}" = x ] \
        || [ "${BUILDX_BUILDER+x}" = x ]; then
        printf '%s\n' 'ERROR: production Docker platform/context overrides are forbidden' >&2
        exit 1
    fi
    [ "$(/usr/bin/id -u)" -eq 0 ] || {
        printf '%s\n' 'ERROR: production stateful hardening requires uid 0' >&2
        exit 1
    }
    PIPELINE_ROOT=$(CDPATH= cd -- "$ROOT_DIR/../diva-data-pipeline" && pwd -P) || {
        printf '%s\n' 'ERROR: production pipeline repository path could not be canonicalized' >&2
        exit 1
    }
    DOCKER_COMMAND=/usr/bin/docker
    CURL_COMMAND=/usr/bin/curl
    PYTHON_COMMAND=/usr/bin/python3
    SLEEP_COMMAND=/usr/bin/sleep
    TIMEOUT_COMMAND=/usr/bin/timeout
    TRIVY_COMMAND=/usr/local/libexec/diva-player/trivy-0.74.0
    FLOCK_COMMAND=/usr/bin/flock
    SETPRIV_COMMAND=/usr/bin/setpriv
    PIPELINE_PYTHON="$PIPELINE_ROOT/ml_pipeline/.venv/bin/python"
    PIPELINE_VENV="$PIPELINE_ROOT/ml_pipeline/.venv"
    PIPELINE_RUNTIME_LOCK="$PIPELINE_ROOT/ml_pipeline/.ml-runtime-use.lock"
    PIPELINE_RUNTIME_RECEIPT="$PIPELINE_VENV/.diva-runtime-receipt.json"
    PIPELINE_RUNTIME_LOCK_FILE="$PIPELINE_ROOT/ml_pipeline/requirements.linux-aarch64-cp310.lock.txt"
    PIPELINE_RUNTIME_VERIFIER="$PIPELINE_ROOT/ml_pipeline/verify_production_ml_runtime.py"
    PIPELINE_RUNTIME_PATCHER="$PIPELINE_ROOT/ml_pipeline/patch_tensorflow_hub_compat.py"
    PIPELINE_GITHUB_USER=orangepi
    PIPELINE_GITHUB_HOME=/home/orangepi
    PIPELINE_GITHUB_IDENTITY=/home/orangepi/.ssh/id_ed25519_diva_data_pipeline_github
    API_BRIDGE_RECEIPT=/var/lib/diva-player-deploy/api-bridge-receipt.json

    validate_trusted_system_directory() {
        local directory="$1" mode
        [ -d "$directory" ] && [ ! -L "$directory" ] \
            && [ "$(/usr/bin/stat -c '%u:%g' "$directory")" = 0:0 ] || return 1
        mode=$(/usr/bin/stat -c '%a' "$directory") || return 1
        [ $((0$mode & 022)) -eq 0 ]
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
            && [ "$(/usr/bin/stat -c '%u:%g' "$final")" = 0:0 ] || return 1
        mode=$(/usr/bin/stat -c '%a' "$final") || return 1
        [ $((0$mode & 022)) -eq 0 ]
    }
    for trusted_binary in \
        "$DOCKER_COMMAND" "$CURL_COMMAND" "$PYTHON_COMMAND" \
        "$SLEEP_COMMAND" "$TIMEOUT_COMMAND" "$FLOCK_COMMAND" "$SETPRIV_COMMAND" \
        /usr/bin/awk /usr/bin/cat /usr/bin/chmod /usr/bin/cmp /usr/bin/cp \
        /usr/bin/date /usr/bin/dirname /usr/bin/env /usr/bin/getent /usr/bin/git /usr/bin/grep \
        /usr/bin/hostname /usr/bin/id /usr/bin/find /usr/bin/mkdir /usr/bin/mv \
        /usr/bin/od /usr/bin/readlink /usr/bin/rm \
        /usr/bin/sha256sum /usr/bin/ssh /usr/bin/stat /usr/bin/sync /usr/bin/tar /usr/bin/tr \
        /usr/bin/uname /usr/bin/wc; do
        validate_trusted_system_binary "$trusted_binary" || {
            printf '%s\n' "ERROR: production binary is not trusted: $trusted_binary" >&2
            exit 1
        }
    done
    validate_trusted_system_ancestry "$TRIVY_COMMAND" \
        || { printf '%s\n' 'ERROR: Trivy ancestry is not trusted' >&2; exit 1; }
    [ -f "$TRIVY_COMMAND" ] && [ ! -L "$TRIVY_COMMAND" ] \
        && [ "$(/usr/bin/stat -c '%u:%g' "$TRIVY_COMMAND")" = 0:0 ] \
        && [ "$(/usr/bin/stat -c '%a' "$TRIVY_COMMAND")" = 555 ] \
        || { printf '%s\n' 'ERROR: Trivy binary mode/owner is not trusted' >&2; exit 1; }
    [ "$(/usr/bin/sha256sum "$TRIVY_COMMAND" | /usr/bin/awk '{print $1}')" \
        = fed2c9ca7d27191ada34524b5eaf5216a845c6d6f3246143c3b475552ffe5358 ] \
        || { printf '%s\n' 'ERROR: Trivy binary digest is invalid' >&2; exit 1; }
    verify_aarch64_elf_header() {
        local path="$1"
        set -- $(/usr/bin/od -An -tx1 -N20 "$path")
        [ "$#" -eq 20 ] \
            && [ "$1:$2:$3:$4" = 7f:45:4c:46 ] \
            && [ "$5:$6:$7" = 02:01:01 ] || return 1
        shift 16
        [ "$1:$2:$3:$4" = 02:00:b7:00 ]
    }
    verify_aarch64_elf_header "$TRIVY_COMMAND" \
        || { printf '%s\n' 'ERROR: Trivy is not an AArch64 ELF executable' >&2; exit 1; }
    [ "$(/usr/bin/uname -s)" = Linux ] \
        || { printf '%s\n' 'ERROR: production stateful hardening requires Linux' >&2; exit 1; }
    case "$(/usr/bin/uname -m)" in
        aarch64|arm64) ;;
        *) printf '%s\n' 'ERROR: production stateful hardening requires an AArch64 host' >&2; exit 1 ;;
    esac
    /usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin \
        "$TRIVY_COMMAND" --version | /usr/bin/grep -Fx 'Version: 0.74.0' >/dev/null \
        || { printf '%s\n' 'ERROR: Trivy version is invalid' >&2; exit 1; }
    [ "$(/usr/bin/docker context show)" = default ] \
        && [ "$(/usr/bin/docker context inspect --format '{{.Endpoints.docker.Host}}' default)" \
            = unix:///var/run/docker.sock ] \
        || { printf '%s\n' 'ERROR: production stateful hardening requires the local default Docker socket' >&2; exit 1; }
    daemon_platform=$(/usr/bin/timeout 30 /usr/bin/docker info \
        --format '{{.OSType}}|{{.Architecture}}') \
        || { printf '%s\n' 'ERROR: Docker daemon platform is unavailable' >&2; exit 1; }
    case "$daemon_platform" in
        linux\|aarch64|linux\|arm64) ;;
        *) printf '%s\n' "ERROR: Docker daemon must be linux/arm64, observed $daemon_platform" >&2; exit 1 ;;
    esac
fi

if [ -n "${DIVA_DEPLOY_STATE_DIR:-}" ] && [ -n "${DIVA_STATEFUL_STATE_DIR:-}" ] \
    && [ "$DIVA_DEPLOY_STATE_DIR" != "$DIVA_STATEFUL_STATE_DIR" ]; then
    printf '%s\n' 'ERROR: deploy and stateful state-root overrides must be identical' >&2
    exit 1
fi
if [ "$TEST_MODE" = "1" ]; then
    STATE_ROOT=${DIVA_DEPLOY_STATE_DIR:-${DIVA_STATEFUL_STATE_DIR:-"$ROOT_DIR/.deploy-state"}}
else
    STATE_ROOT=/var/lib/diva-player-deploy
fi
TRIVY_CACHE_DIR=${DIVA_TRIVY_CACHE_DIR:-"$STATE_ROOT/trivy-cache"}
LOCK_DIR="$STATE_ROOT/stateful-hardening.lock"
DEPLOY_LOCK_DIR="$STATE_ROOT/deploy.lock"
ACTIVE_JOURNAL="$STATE_ROOT/stateful-hardening-active"
ROLLING_ACTIVE_JOURNAL="$STATE_ROOT/rolling-deployment-active"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="$STATE_ROOT/stateful-$RUN_ID"
if [ "$TEST_MODE" = "1" ]; then
    GITHUB_HOST_KEY_FILE="$STATE_ROOT/github-known-hosts-$RUN_ID"
else
    GITHUB_HOST_KEY_FILE="/run/diva-player-github-known-hosts-$RUN_ID"
fi
STATE_FILE="$RUN_DIR/state"
DAEMON_READ_UNRESOLVED_FILE="$RUN_DIR/daemon-read-unresolved"
PIPELINE_RUNTIME_ATTESTATION_FILE="$RUN_DIR/evidence/pipeline-runtime-attestation.json"

HEALTH_ATTEMPTS=${DIVA_STATEFUL_HEALTH_ATTEMPTS:-60}
WAIT_SECONDS=${DIVA_STATEFUL_WAIT_SECONDS:-2}
READ_TIMEOUT_SECONDS=${DIVA_STATEFUL_READ_TIMEOUT_SECONDS:-120}
FINGERPRINT_TIMEOUT_SECONDS=${DIVA_STATEFUL_FINGERPRINT_TIMEOUT_SECONDS:-7200}
QDRANT_UPGRADE_TIMEOUT_SECONDS=${DIVA_QDRANT_UPGRADE_TIMEOUT_SECONDS:-21600}
MUTATION_TIMEOUT_SECONDS=${DIVA_STATEFUL_MUTATION_TIMEOUT_SECONDS:-180}
DATA_MUTATION_TIMEOUT_SECONDS=${DIVA_STATEFUL_DATA_MUTATION_TIMEOUT_SECONDS:-3600}
BUILD_TIMEOUT_SECONDS=${DIVA_STATEFUL_BUILD_TIMEOUT_SECONDS:-1800}
DAEMON_SETTLE_ATTEMPTS=${DIVA_STATEFUL_DAEMON_SETTLE_ATTEMPTS:-30}
DAEMON_STABLE_SAMPLES=${DIVA_STATEFUL_DAEMON_STABLE_SAMPLES:-10}
WRITER_SETTLE_SECONDS=${DIVA_STATEFUL_WRITER_SETTLE_SECONDS:-30}

QDRANT_CONTAINER=vocadb_qdrant
POSTGRES_CONTAINER=vocadb_postgres
QDRANT_PREVIOUS_CONTAINER="diva_qdrant_previous_$RUN_ID"
POSTGRES_PREVIOUS_CONTAINER="diva_postgres_previous_$RUN_ID"
QDRANT_FALLBACK_CONTAINER="diva_qdrant_verified_$RUN_ID"
POSTGRES_FALLBACK_CONTAINER="diva_postgres_verified_$RUN_ID"
QDRANT_AUDIT_CONTAINER="diva_qdrant_audit_$RUN_ID"
QDRANT_OWNER_AUDIT_CONTAINER="diva_qdrant_owner_audit_$RUN_ID"
ALPINE_ATTEST_CONTAINER="diva_qdrant_alpine_attest_$RUN_ID"
CANDIDATE_PROJECT="diva-stateful-$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
CANDIDATE_OVERRIDE="$RUN_DIR/candidate-compose.override.yml"
QDRANT_IMAGE=diva-player-qdrant:v1.19.0-hardened-r1
QDRANT_CANDIDATE_IMAGE="diva-player-qdrant:candidate-$RUN_ID"
QDRANT_ROLLBACK_IMAGE="diva-player-qdrant:rollback-$RUN_ID"
QDRANT_AUDIT_TOOL_IMAGE="diva-player-qdrant-audit:candidate-$RUN_ID"
QDRANT_BASE_DIGEST=sha256:a0e04fe623cb064502cd869cefc1dc7ce359d8edd481063b5bd351c0a0a2c91e
QDRANT_RUNTIME_CONTRACT=rootless-readonly-scratch-v3
AUDIT_BASE_DIGEST=sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659
AUDIT_BASE_REFERENCE="alpine:3.23.3@$AUDIT_BASE_DIGEST"
AUDIT_INVENTORY_SHA256=3f18c4f5c16154eeba3ffd4970bf886c1699a3b901a3ddcf7948f99a8d2b8c53
QDRANT_CANDIDATE_VOLUME="diva_qdrant_v119_$RUN_ID"
QDRANT_UPGRADE_NETWORK="diva_qdrant_upgrade_$RUN_ID"
QDRANT_UPGRADE_JOURNAL="$RUN_DIR/qdrant-storage-upgrade.json"
QDRANT_UPGRADE_RESULT="$RUN_DIR/qdrant-storage-upgrade-result.json"
QDRANT_CONTROLLER_LOG="$RUN_DIR/qdrant-storage-upgrade-controller.log"
QDRANT_CONTROLLER_SETTLEMENT="$RUN_DIR/qdrant-storage-upgrade-controller-settlement.json"
QDRANT_CONTROLLER_DAEMON_SETTLEMENT="$RUN_DIR/qdrant-storage-upgrade-daemon-settlement.json"
QDRANT_FINAL_UPGRADE_CONTAINER="diva_qfinal_$RUN_ID"
POSTGRES_IMAGE=diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1
POSTGRES_CANDIDATE_IMAGE="diva-player-postgres:candidate-$RUN_ID"
POSTGRES_ROLLBACK_IMAGE="diva-player-postgres:rollback-$RUN_ID"
POSTGRES_MIGRATE_IMAGE=diva-player-postgres-migrate:16.15-hardened-r1
POSTGRES_MIGRATE_CANDIDATE_IMAGE="diva-player-postgres-migrate:candidate-$RUN_ID"

LOCK_HELD=false
LOCK_OWNER_TOKEN=""
LOCK_OWNER_BOOT_ID=""
LOCK_OWNER_START_TICKS=""
ACTIVE_JOURNAL_CREATED=false
QDRANT_MUTATED=false
POSTGRES_MUTATED=false
QDRANT_PREVIOUS_PRESERVED=false
POSTGRES_PREVIOUS_PRESERVED=false
QDRANT_FALLBACK_PRESERVED=false
POSTGRES_FALLBACK_PRESERVED=false
MANAGEMENT_RECONCILIATION_REQUIRED=false
PROMOTION_ARMED=false
PROMOTION_COMMITTED=false
PROMOTION_MANIFEST="$RUN_DIR/promotion-transaction"
PROMOTED_MARKER="$RUN_DIR/promoted"
COMPLETED_MARKER="$RUN_DIR/completed"
RUNTIME_CONTRACT="$STATE_ROOT/stateful-runtime-contract"
API_BRIDGE_CONSUME_INTENT="$STATE_ROOT/api-bridge-consume-intent.json"
RUNTIME_CONTRACT_PREPARED="$RUN_DIR/stateful-runtime-contract.prepared"
STATEFUL_PROJECTION="$RUN_DIR/stateful-compose-projection.json"
RESOLVED_COMPOSE_PRIVATE="$RUN_DIR/resolved-compose.private.json"
RESOLVED_COMPOSE_PRIVATE_OWNED=false
PRIVATE_BACKEND_ENV_FILE="$STATE_ROOT/backend.env.private"
PIPELINE_WRITER_GATE_FILE="$RUN_DIR/pipeline-writer-gate"
PIPELINE_WRITER_GATE_RESULT="$RUN_DIR/pipeline-writer-gate-result"
PIPELINE_WRITER_RELEASE_RESULT="$RUN_DIR/pipeline-writer-release-result"
PIPELINE_WRITER_GATE_TOKEN="$RUN_ID"
PIPELINE_WRITER_ROLES_KEY=diva_stateful_maintenance_login_roles
FULL_PUBLICATION_JOURNAL="$PIPELINE_ROOT/ml_pipeline/logs/recommendation_publication_journal.json"
INCREMENTAL_PUBLICATION_JOURNAL="$PIPELINE_ROOT/ml_pipeline/logs/recommendation_incremental_journal.json"
SUCCEEDED=false
OLD_QDRANT_ID=""
OLD_QDRANT_IMAGE_ID=""
OLD_QDRANT_CONFIG_HASH=""
OLD_QDRANT_VOLUME_IDENTITY=""
OLD_QDRANT_VOLUME_IDENTITY_SHA=""
QDRANT_ROLLBACK_SCAN_RECEIPT_SHA=""
OLD_POSTGRES_ID=""
OLD_POSTGRES_IMAGE_ID=""
POSTGRES_ROLLBACK_SCAN_RECEIPT_SHA=""
NEW_QDRANT_ID=""
NEW_QDRANT_AUDIT_ID=""
AUDIT_BUSYBOX_SHA256=""
AUDIT_CONTRACT_SHA256=""
NEW_POSTGRES_ID=""
NEW_POSTGRES_MIGRATE_ID=""
NEW_QDRANT_CONTAINER_ID=""
NEW_POSTGRES_CONTAINER_ID=""
QDRANT_FALLBACK_ID=""
POSTGRES_FALLBACK_ID=""
ORIGINAL_PROJECT=""
STATEFUL_NETWORK=""
STATEFUL_NETWORK_ID=""
QDRANT_VOLUME=""
OLD_QDRANT_VOLUME=""
POSTGRES_VOLUME=""
OLD_STABLE_QDRANT_IMAGE_ID="absent"
STABLE_QDRANT_TAG_MUTATED=false
OLD_STABLE_POSTGRES_IMAGE_ID="absent"
OLD_STABLE_POSTGRES_MIGRATE_IMAGE_ID="absent"
STABLE_POSTGRES_TAG_MUTATED=false
STABLE_POSTGRES_MIGRATE_TAG_MUTATED=false
PIPELINE_WRITER_GATED=false
DAEMON_MUTATION_UNRESOLVED=false
DAEMON_MUTATION_IN_FLIGHT=false
DAEMON_READ_UNRESOLVED=false
PLAYER_RELEASE_COMMIT=""
PIPELINE_RELEASE_COMMIT=""
EXPECTED_BACKUP_ATTESTER_SHA=""
QDRANT_RELEASE_BUILD_CONTEXT=""
POSTGRES_RELEASE_BUILD_CONTEXT=""
IMAGE_SCAN_VALIDATOR_RELEASE=""
API_BRIDGE_CONSUMPTION_HELPER_RELEASE=""
BACKEND_ENV_FILE="$ROOT_DIR/backend/.env"
BACKEND_ENV_BACKUP="$RUN_DIR/backend.env.before-qdrant-volume"
BACKEND_ENV_OWNER_UID=""
BACKEND_ENV_OWNER_GID=""
BACKEND_ENV_BACKUP_OWNED=false
BACKEND_ENV_MUTATED=false
API_BRIDGE_RECEIPT_SHA=""
API_BRIDGE_RECEIPT_CREATED_AT=""
API_BRIDGE_COMPATIBILITY_SHA=""
API_BRIDGE_VERIFY_COUNT=0
QDRANT_BACKUP_BINDING=""
API_A_BRIDGE_IMAGE_ID=""
API_B_BRIDGE_IMAGE_ID=""
API_A_BRIDGE_CONTAINER_ID=""
API_B_BRIDGE_CONTAINER_ID=""
API_BRIDGE_SEED_SONG_ID=""
TRIVY_RUN_CACHE=""
TRIVY_EMPTY_CONFIG=""
TRIVY_EMPTY_IGNORE=""
TRIVY_SCANNER_SHA=""
SCAN_CALIBRATION_REQUIRED=false
PIPELINE_RUNTIME_LOCK_HELD=false
PIPELINE_RUNTIME_UID=""
PIPELINE_RUNTIME_GID=""
PIPELINE_RUNTIME_IDENTITY=""
PIPELINE_RUNTIME_ATTESTATION=""
PIPELINE_RUNTIME_ATTESTATION_SHA=""
PIPELINE_GITHUB_SSH_IDENTITY=""
GITHUB_HOST_KEY_FILE_IDENTITY=""
GITHUB_HOST_KEY_FILE_OWNED=false

fail() {
    printf '%s\n' "ERROR: $*" >&2
    return 1
}

validate_lock_boot_id() {
    local boot_id="$1"
    [ "${#boot_id}" -eq 36 ] || return 1
    case "$boot_id" in
        ????????-????-????-????-????????????) ;;
        *) return 1 ;;
    esac
    case "$boot_id" in *[!0-9a-f-]*) return 1 ;; esac
}

read_process_start_ticks() {
    local target_pid="$1" proc_stat proc_tail
    case "$target_pid" in ''|*[!0-9]*|0) return 1 ;; esac
    proc_stat=$(cat "/proc/$target_pid/stat") || return 1
    case "$proc_stat" in "$target_pid ("*') '*) ;; *) return 1 ;; esac
    # Remove through the final ") "; the kernel comm field itself may contain
    # spaces or parentheses.  The remaining field 20 is proc stat starttime.
    proc_tail=${proc_stat##*) }
    set -- $proc_tail
    [ "$#" -ge 20 ] || return 1
    shift 19
    case "$1" in ''|*[!0-9]*|0) return 1 ;; esac
    printf '%s\n' "$1"
}

prepare_state_root() {
    local mode
    if [ "$TEST_MODE" = "1" ]; then
        mkdir -p "$STATE_ROOT" || return 1
        [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || return 1
        chmod 700 "$STATE_ROOT" || return 1
        return 0
    fi
    [ "$STATE_ROOT" = /var/lib/diva-player-deploy ] || return 1
    validate_trusted_system_directory / \
        && validate_trusted_system_directory /var \
        && validate_trusted_system_directory /var/lib || return 1
    if [ ! -e "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ]; then
        mkdir --mode=700 "$STATE_ROOT" || return 1
        sync -f /var/lib 2>/dev/null || sync
    fi
    [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] \
        && [ "$(stat -c '%u:%g' "$STATE_ROOT")" = 0:0 ] || return 1
    mode=$(stat -c '%a' "$STATE_ROOT") || return 1
    [ "$mode" = 700 ]
}

validate_pipeline_runtime_structure() {
    local expected_python="$PIPELINE_VENV/bin/python" ml_root mode unsafe resolved_python \
        runtime_path docker_socket_gid
    [ "$PIPELINE_PYTHON" = "$expected_python" ] \
        && [ -d "$PIPELINE_ROOT" ] && [ ! -L "$PIPELINE_ROOT" ] \
        && [ -d "$PIPELINE_ROOT/ml_pipeline" ] \
        && [ ! -L "$PIPELINE_ROOT/ml_pipeline" ] \
        && [ -d "$PIPELINE_VENV" ] && [ ! -L "$PIPELINE_VENV" ] \
        && [ -f "$PIPELINE_PYTHON" ] && [ -x "$PIPELINE_PYTHON" ] \
        && [ -f "$PIPELINE_RUNTIME_LOCK" ] && [ ! -L "$PIPELINE_RUNTIME_LOCK" ] \
        && [ -f "$PIPELINE_RUNTIME_RECEIPT" ] \
        && [ ! -L "$PIPELINE_RUNTIME_RECEIPT" ] || return 1
    for runtime_path in "$PIPELINE_RUNTIME_LOCK_FILE" "$PIPELINE_RUNTIME_VERIFIER" \
        "$PIPELINE_RUNTIME_PATCHER"; do
        [ -f "$runtime_path" ] && [ ! -L "$runtime_path" ] || return 1
    done
    ml_root=$(CDPATH= cd -- "$PIPELINE_VENV/.." && pwd -P) || return 1
    [ "$ml_root" = "$(CDPATH= cd -- "$PIPELINE_ROOT/ml_pipeline" && pwd -P)" ] \
        || return 1

    if [ "$TEST_MODE" = "1" ]; then
        PIPELINE_RUNTIME_UID=$(/usr/bin/id -u) || return 1
        PIPELINE_RUNTIME_GID=$(/usr/bin/id -g) || return 1
        [ "$PIPELINE_RUNTIME_UID" -ne 0 ] || return 1
        return 0
    fi

    PIPELINE_RUNTIME_UID=$(stat -c '%u' "$PIPELINE_ROOT") || return 1
    PIPELINE_RUNTIME_GID=$(stat -c '%g' "$PIPELINE_ROOT") || return 1
    case "$PIPELINE_RUNTIME_UID:$PIPELINE_RUNTIME_GID" in
        ''|*[!0-9:]*) return 1 ;;
    esac
    [ "$PIPELINE_RUNTIME_UID" -ne 0 ] || return 1
    [ "$(stat -c '%u:%g' "$PIPELINE_ROOT/ml_pipeline")" \
        = "$PIPELINE_RUNTIME_UID:$PIPELINE_RUNTIME_GID" ] \
        && [ "$(stat -c '%u:%g' "$PIPELINE_VENV")" \
        = "$PIPELINE_RUNTIME_UID:$PIPELINE_RUNTIME_GID" ] \
        && [ "$(stat -c '%u:%g' "$PIPELINE_PYTHON")" \
        = "$PIPELINE_RUNTIME_UID:$PIPELINE_RUNTIME_GID" ] || return 1
    for runtime_path in "$PIPELINE_RUNTIME_LOCK" "$PIPELINE_RUNTIME_RECEIPT"; do
        [ "$(stat -c '%u:%g:%a:%h' "$runtime_path")" \
            = "$PIPELINE_RUNTIME_UID:$PIPELINE_RUNTIME_GID:600:1" ] || return 1
    done
    for runtime_path in "$PIPELINE_RUNTIME_LOCK_FILE" "$PIPELINE_RUNTIME_VERIFIER" \
        "$PIPELINE_RUNTIME_PATCHER"; do
        [ "$(stat -c '%u:%g' "$runtime_path")" \
            = "$PIPELINE_RUNTIME_UID:$PIPELINE_RUNTIME_GID" ] || return 1
        mode=$(stat -c '%a' "$runtime_path") || return 1
        [ $((0$mode & 022)) -eq 0 ] || return 1
    done
    mode=$(stat -c '%a' "$PIPELINE_VENV") || return 1
    [ $((0$mode & 022)) -eq 0 ] || return 1
    unsafe=$(find "$PIPELINE_VENV" -xdev \
        \( ! -uid "$PIPELINE_RUNTIME_UID" -o ! -gid "$PIPELINE_RUNTIME_GID" \
        -o \( ! -type l -perm /022 \) \) -print -quit) || return 1
    [ -z "$unsafe" ] || return 1
    resolved_python=$(readlink -f -- "$PIPELINE_PYTHON") || return 1
    [ "$resolved_python" = /usr/bin/python3.10 ] \
        && validate_trusted_system_binary "$resolved_python" || return 1
    [ -S /var/run/docker.sock ] && [ ! -L /var/run/docker.sock ] || return 1
    docker_socket_gid=$(stat -c '%g' /var/run/docker.sock) || return 1
    [ "$PIPELINE_RUNTIME_GID" != "$docker_socket_gid" ]
}

capture_pipeline_runtime_identity() {
    local resolved_python runtime_path
    [ -d "$PIPELINE_VENV" ] && [ ! -L "$PIPELINE_VENV" ] \
        && [ -f "$PIPELINE_RUNTIME_LOCK" ] && [ ! -L "$PIPELINE_RUNTIME_LOCK" ] \
        && [ -f "$PIPELINE_RUNTIME_RECEIPT" ] && [ ! -L "$PIPELINE_RUNTIME_RECEIPT" ] \
        && [ -f "$PIPELINE_RUNTIME_LOCK_FILE" ] && [ ! -L "$PIPELINE_RUNTIME_LOCK_FILE" ] \
        && [ -f "$PIPELINE_RUNTIME_VERIFIER" ] && [ ! -L "$PIPELINE_RUNTIME_VERIFIER" ] \
        && [ -f "$PIPELINE_RUNTIME_PATCHER" ] && [ ! -L "$PIPELINE_RUNTIME_PATCHER" ] \
        || return 1
    resolved_python=$(readlink -f -- "$PIPELINE_PYTHON") || return 1
    printf 'venv=%s\n' "$(stat -c '%d:%i:%u:%g:%a' "$PIPELINE_VENV")" \
        || return 1
    printf 'python-link=%s\n' "$(stat -c '%d:%i:%u:%g:%a:%s:%Y' "$PIPELINE_PYTHON")" \
        || return 1
    printf 'python-target=%s:%s\n' "$resolved_python" \
        "$(stat -Lc '%d:%i:%u:%g:%a:%s:%Y' "$PIPELINE_PYTHON")" || return 1
    for runtime_path in "$PIPELINE_RUNTIME_LOCK" "$PIPELINE_RUNTIME_RECEIPT" \
        "$PIPELINE_RUNTIME_LOCK_FILE" "$PIPELINE_RUNTIME_VERIFIER" \
        "$PIPELINE_RUNTIME_PATCHER"; do
        printf '%s=%s:%s\n' "${runtime_path##*/}" \
            "$(stat -c '%d:%i:%u:%g:%a:%s:%Y' "$runtime_path")" \
            "$(sha256sum "$runtime_path" | awk '{print $1}')" || return 1
    done
}

verify_pipeline_runtime_identity_unchanged() {
    local current
    [ "$PIPELINE_RUNTIME_LOCK_HELD" = true ] \
        && [ -n "$PIPELINE_RUNTIME_IDENTITY" ] || return 1
    current=$(capture_pipeline_runtime_identity) || return 1
    [ "$current" = "$PIPELINE_RUNTIME_IDENTITY" ]
}

acquire_pipeline_runtime_lock() {
    local lock_identity descriptor_identity
    validate_pipeline_runtime_structure || return 1
    exec 9< "$PIPELINE_RUNTIME_LOCK" || return 1
    if ! "$FLOCK_COMMAND" --shared --timeout 900 9; then
        exec 9<&-
        return 1
    fi
    PIPELINE_RUNTIME_LOCK_HELD=true
    if [ "$TEST_MODE" != "1" ]; then
        lock_identity=$(stat -c '%d:%i' "$PIPELINE_RUNTIME_LOCK") || return 1
        descriptor_identity=$(stat -Lc '%d:%i' "/proc/$$/fd/9") || return 1
        [ "$lock_identity" = "$descriptor_identity" ] || return 1
    fi
    PIPELINE_RUNTIME_IDENTITY=$(capture_pipeline_runtime_identity) || return 1
    verify_pipeline_runtime_identity_unchanged
}

release_pipeline_runtime_lock() {
    local release_status=0
    [ "$PIPELINE_RUNTIME_LOCK_HELD" = true ] || return 0
    "$FLOCK_COMMAND" --unlock 9 || release_status=$?
    exec 9<&-
    PIPELINE_RUNTIME_LOCK_HELD=false
    return "$release_status"
}

run_pipeline_venv_python() {
    local probe_status=0 identity_status=0
    verify_pipeline_runtime_identity_unchanged || return 1
    (
        exec 9<&-
        run_bounded_command "$READ_TIMEOUT_SECONDS" /usr/bin/env -i \
            HOME=/var/empty PATH=/usr/bin:/bin \
            PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 \
            "$SETPRIV_COMMAND" \
            --reuid="$PIPELINE_RUNTIME_UID" --regid="$PIPELINE_RUNTIME_GID" \
            --clear-groups --no-new-privs \
            --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
            "$PIPELINE_PYTHON" -I -B "$@"
    ) || probe_status=$?
    verify_pipeline_runtime_identity_unchanged || identity_status=$?
    [ "$identity_status" -eq 0 ] || return 125
    return "$probe_status"
}

verify_pipeline_venv_provenance() {
    local attestation normalized
    attestation=$(run_pipeline_venv_python - runtime-attestation \
        "$PIPELINE_VENV" "$PIPELINE_RUNTIME_RECEIPT" \
        "$PIPELINE_RUNTIME_LOCK_FILE" "$PIPELINE_RUNTIME_VERIFIER" \
        "$PIPELINE_RUNTIME_PATCHER" "$PIPELINE_RUNTIME_UID" \
        "$PIPELINE_RUNTIME_GID" <<'PY'
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import site
import stat
import sys

(
    marker, venv_text, receipt_text, lock_text, verifier_text, patcher_text,
    expected_uid_text, expected_gid_text,
) = sys.argv[1:]
if marker != "runtime-attestation":
    raise SystemExit(2)
venv = Path(venv_text).resolve(strict=True)
receipt_path = Path(receipt_text)
lock_path = Path(lock_text)
verifier_path = Path(verifier_text)
patcher_path = Path(patcher_text)

def bounded_regular(path: Path, maximum: int) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
        raise SystemExit(3)
    data = path.read_bytes()
    if not data or len(data) > maximum:
        raise SystemExit(4)
    return data

if Path(sys.prefix).resolve(strict=True) != venv or Path(sys.base_prefix).resolve() == venv:
    raise SystemExit(5)
if site.ENABLE_USER_SITE:
    raise SystemExit(6)
if (
    os.getuid() == 0
    or os.getuid() != int(expected_uid_text)
    or os.getgid() != int(expected_gid_text)
):
    raise SystemExit(7)
if os.getgroups():
    raise SystemExit(8)
status = {}
for line in Path("/proc/self/status").read_text(encoding="ascii").splitlines():
    key, separator, value = line.partition(":")
    if separator:
        status[key] = value.strip()
if status.get("NoNewPrivs") != "1" or any(
    status.get(name) != "0000000000000000"
    for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")
):
    raise SystemExit(9)

import qdrant_client

module_path = Path(qdrant_client.__file__).resolve(strict=True)
if os.path.commonpath([str(venv), str(module_path)]) != str(venv):
    raise SystemExit(10)
if importlib.metadata.version("qdrant-client") != "1.19.0":
    raise SystemExit(11)

verifier_bytes = bounded_regular(verifier_path, 2 * 1024 * 1024)
lock_bytes = bounded_regular(lock_path, 2 * 1024 * 1024)
patcher_bytes = bounded_regular(patcher_path, 256 * 1024)
receipt_bytes = bounded_regular(receipt_path, 2 * 1024 * 1024)
stored = json.loads(receipt_bytes)
if receipt_bytes != (json.dumps(stored, sort_keys=True, separators=(",", ":")) + "\n").encode():
    raise SystemExit(12)
spec = importlib.util.spec_from_file_location("diva_verified_runtime_contract", verifier_path)
if spec is None or spec.loader is None:
    raise SystemExit(13)
verifier = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = verifier
spec.loader.exec_module(verifier)
fresh = verifier.validate_runtime("linux-aarch64", lock_path)
stored_comparable = dict(stored)
fresh_comparable = dict(fresh)
stored_generated = stored_comparable.pop("generatedAt", None)
fresh_comparable.pop("generatedAt", None)
if not isinstance(stored_generated, str) or stored_comparable != fresh_comparable:
    raise SystemExit(14)
document = {
    "baseExecutable": str(Path(sys.executable).resolve(strict=True)),
    "contract": "linux-aarch64",
    "executable": str(Path(sys.executable).absolute()),
    "gid": os.getgid(),
    "lockSha256": hashlib.sha256(lock_bytes).hexdigest(),
    "patcherSha256": hashlib.sha256(patcher_bytes).hexdigest(),
    "privilegeBoundary": "uid-gid-no-groups-no-caps-nnp",
    "qdrantClientVersion": "1.19.0",
    "qdrantModule": str(module_path),
    "runtimeReceiptSha256": hashlib.sha256(receipt_bytes).hexdigest(),
    "schema": "diva.pipeline-qdrant-probe-runtime.v1",
    "uid": os.getuid(),
    "verifierSha256": hashlib.sha256(verifier_bytes).hexdigest(),
}
print(json.dumps(document, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
PY
    ) || return 1
    [ "${#attestation}" -le 65536 ] || return 1
    normalized=$(printf '%s\n' "$attestation" | "$PYTHON_COMMAND" -I -B -c '
import json,re,sys
raw=sys.stdin.buffer.read(65537)
if len(raw)>65536: raise SystemExit(2)
d=json.loads(raw)
expected={"baseExecutable","contract","executable","gid","lockSha256","patcherSha256",
"privilegeBoundary","qdrantClientVersion","qdrantModule","runtimeReceiptSha256","schema","uid",
"verifierSha256"}
if set(d)!=expected or d["schema"]!="diva.pipeline-qdrant-probe-runtime.v1" \
or d["contract"]!="linux-aarch64" or d["qdrantClientVersion"]!="1.19.0" \
or d["privilegeBoundary"]!="uid-gid-no-groups-no-caps-nnp" \
or not isinstance(d["uid"],int) or d["uid"]<=0 or not isinstance(d["gid"],int) or d["gid"]<0 \
or any(not isinstance(d[k],str) or re.fullmatch(r"[0-9a-f]{64}",d[k]) is None \
       for k in ("lockSha256","patcherSha256","runtimeReceiptSha256","verifierSha256")):
    raise SystemExit(3)
print(json.dumps(d,ensure_ascii=True,sort_keys=True,separators=(",",":")))
') || return 1
    if [ -n "$PIPELINE_RUNTIME_ATTESTATION" ]; then
        [ "$normalized" = "$PIPELINE_RUNTIME_ATTESTATION" ] || return 1
    else
        PIPELINE_RUNTIME_ATTESTATION="$normalized"
    fi
}

write_pipeline_runtime_attestation() {
    local temporary
    [ "$PIPELINE_RUNTIME_LOCK_HELD" = true ] \
        && [ -n "$PIPELINE_RUNTIME_ATTESTATION" ] || return 1
    [ ! -e "$PIPELINE_RUNTIME_ATTESTATION_FILE" ] \
        && [ ! -L "$PIPELINE_RUNTIME_ATTESTATION_FILE" ] || return 1
    temporary="$PIPELINE_RUNTIME_ATTESTATION_FILE.tmp"
    [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || return 1
    "$PYTHON_COMMAND" -I -B - "$temporary" "$PIPELINE_RUNTIME_ATTESTATION_FILE" \
        "$PIPELINE_RUNTIME_ATTESTATION" <<'PY' || return 1
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

temporary, destination = map(Path, sys.argv[1:3])
raw = sys.argv[3].encode("utf-8") + b"\n"
if not raw or len(raw) > 65536:
    raise SystemExit(2)
document = json.loads(raw)
expected = {
    "baseExecutable", "contract", "executable", "gid", "lockSha256", "patcherSha256",
    "privilegeBoundary", "qdrantClientVersion", "qdrantModule", "runtimeReceiptSha256",
    "schema", "uid", "verifierSha256",
}
if (
    set(document) != expected
    or document.get("schema") != "diva.pipeline-qdrant-probe-runtime.v1"
    or document.get("contract") != "linux-aarch64"
    or document.get("qdrantClientVersion") != "1.19.0"
    or document.get("privilegeBoundary") != "uid-gid-no-groups-no-caps-nnp"
    or not isinstance(document.get("uid"), int) or document["uid"] <= 0
    or not isinstance(document.get("gid"), int) or document["gid"] < 0
    or any(not isinstance(document.get(key), str)
           or re.fullmatch(r"[0-9a-f]{64}", document[key]) is None
           for key in ("lockSha256", "patcherSha256", "runtimeReceiptSha256", "verifierSha256"))
):
    raise SystemExit(3)
canonical = (json.dumps(document, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode()
if raw != canonical or temporary.exists() or temporary.is_symlink() or destination.exists() or destination.is_symlink():
    raise SystemExit(4)
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
descriptor = os.open(temporary, flags, 0o600)
try:
    os.write(descriptor, canonical)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.replace(temporary, destination)
os.chmod(destination, 0o600)
try:
    directory = os.open(destination.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
except PermissionError:
    if os.name != "nt":
        raise
else:
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
print(hashlib.sha256(canonical).hexdigest())
PY
    PIPELINE_RUNTIME_ATTESTATION_SHA=$(sha256sum "$PIPELINE_RUNTIME_ATTESTATION_FILE" | awk '{print $1}') \
        || return 1
    case "$PIPELINE_RUNTIME_ATTESTATION_SHA" in
        ''|*[!0-9a-f]*) return 1 ;;
    esac
    [ "${#PIPELINE_RUNTIME_ATTESTATION_SHA}" -eq 64 ] \
        && verify_pipeline_runtime_identity_unchanged
}

validate_trivy_db_metadata() {
    local metadata_path="$1" evidence_path="$2"
    [ -f "$metadata_path" ] && [ ! -L "$metadata_path" ] || return 1
    "$PYTHON_COMMAND" -I -B - "$metadata_path" "$evidence_path" <<'PY'
import datetime as dt
import json
import os
import stat
import sys

source, destination = sys.argv[1:]
info = os.lstat(source)
if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > 1024 * 1024:
    raise SystemExit(2)
with open(source, "rb") as handle:
    raw = handle.read()
document = json.loads(raw)
updated_raw = document.get("UpdatedAt")
if not isinstance(updated_raw, str):
    raise SystemExit(3)
updated = dt.datetime.fromisoformat(updated_raw.replace("Z", "+00:00"))
if updated.tzinfo is None:
    raise SystemExit(4)
now = dt.datetime.now(dt.timezone.utc)
age = (now - updated.astimezone(dt.timezone.utc)).total_seconds()
if age < -300 or age > 24 * 60 * 60:
    raise SystemExit(5)
evidence = {
    "databaseMetadata": document,
    "maximumAgeSeconds": 86400,
    "observedAgeSeconds": int(max(age, 0)),
    "validatedAt": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
}
payload = (json.dumps(evidence, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":")) + "\n").encode("utf-8")
descriptor = os.open(
    destination,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0),
    0o600,
)
try:
    os.write(descriptor, payload)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

validate_trivy_scan_report() {
    local report_path="$1" expected_image_id="$2" expected_os="$3"
    case "$expected_os" in alpine|debian) ;; *) return 1 ;; esac
    [ -f "$report_path" ] && [ ! -L "$report_path" ] || return 1
    "$PYTHON_COMMAND" -I -B - "$report_path" "$expected_image_id" "$expected_os" <<'PY'
import json
import os
import stat
import sys

path, expected_image_id, expected_os = sys.argv[1:]
info = os.lstat(path)
if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > 128 * 1024 * 1024:
    raise SystemExit(2)
with open(path, "rb") as handle:
    document = json.load(handle)
metadata = document.get("Metadata")
if not isinstance(metadata, dict) or metadata.get("ImageID") != expected_image_id:
    raise SystemExit(3)
results = document.get("Results")
if not isinstance(results, list) or not results:
    raise SystemExit(4)
os_inventory_seen = False
for result in results:
    if not isinstance(result, dict):
        raise SystemExit(5)
    vulnerabilities = result.get("Vulnerabilities")
    if vulnerabilities not in (None, []):
        raise SystemExit(6)
    target = result.get("Target")
    if not isinstance(target, str) or not target or target == "-":
        raise SystemExit(7)
    if result.get("Class") == "os-pkgs" and result.get("Type") == expected_os:
        packages = result.get("Packages")
        if not isinstance(packages, list) or not packages:
            raise SystemExit(8)
        os_inventory_seen = True
if not os_inventory_seen:
    raise SystemExit(9)
PY
}

reviewed_inventory_bounds() {
    local service="$1" architecture="$2" os_family="$3" image_id="$4"
    if [ "$TEST_MODE" = "1" ]; then
        case "$service" in
            qdrant-rollback|postgres-rollback)
                [ "${DIVA_STATEFUL_TEST_LEGACY_SCAN_CONTRACT:-reviewed}" = reviewed ] \
                    || return 1
                ;;
        esac
        printf 'os-pkgs:%s:1:1:1\n' "$os_family"
        return 0
    fi
    case "$service:$os_family:$architecture" in
        postgres-runtime:alpine:amd64|postgres-runtime:alpine:arm64)
            printf '%s\n' 'os-pkgs:alpine:46:46:1'
            return 0
            ;;
        postgres-migrate:alpine:amd64|postgres-migrate:alpine:arm64)
            printf '%s\n' 'os-pkgs:alpine:24:24:1'
            return 0
            ;;
    esac
    case "$service:$os_family:$architecture" in
        qdrant-runtime:debian:amd64|qdrant-runtime:debian:arm64)
            printf '%s\n' 'os-pkgs:debian:7:7:1'
            ;;
        qdrant-audit:alpine:amd64|qdrant-audit:alpine:arm64)
            printf '%s\n' 'os-pkgs:alpine:3:3:1'
            ;;
        api-a:alpine:amd64|api-a:alpine:arm64|api-b:alpine:amd64|api-b:alpine:arm64)
            printf '%s\n' 'lang-pkgs:dotnet-core:13:13:3' \
                'lang-pkgs:nuget:12:12:1' \
                'os-pkgs:alpine:21:21:1'
            ;;
        api-gateway:alpine:amd64|api-gateway:alpine:arm64)
            printf '%s\n' 'os-pkgs:alpine:24:24:1'
            ;;
        web:alpine:amd64|web:alpine:arm64)
            printf '%s\n' 'os-pkgs:alpine:70:70:1'
            ;;
        qdrant-rollback:debian:arm64)
            [ "$image_id" = sha256:138fbed447b2b20020d431b9dafee347995dd2ae390c4edd9d7c76dff429f9c9 ] \
                || return 1
            printf '%s\n' 'lang-pkgs:node-pkg:665:665:1' \
                'os-pkgs:debian:92:92:1'
            ;;
        postgres-rollback:debian:arm64)
            [ "$image_id" = sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc ] \
                || return 1
            printf '%s\n' 'lang-pkgs:gobinary:4:4:1' \
                'os-pkgs:debian:144:144:1'
            ;;
        # Every unlisted architecture/family/image tuple remains fail-closed.
        *) return 1 ;;
    esac
}

reviewed_legacy_finding_sha256() {
    local service="$1" architecture="$2" os_family="$3" image_id="$4" value
    case "$service" in qdrant-rollback|postgres-rollback) ;; *) return 1 ;; esac
    if [ "$TEST_MODE" = "1" ]; then
        [ "${DIVA_STATEFUL_TEST_LEGACY_SCAN_CONTRACT:-reviewed}" = reviewed ] \
            || return 1
        case "$service" in
            qdrant-rollback) value=${DIVA_STATEFUL_TEST_QDRANT_FINDING_SHA256:-} ;;
            postgres-rollback) value=${DIVA_STATEFUL_TEST_POSTGRES_FINDING_SHA256:-} ;;
        esac
        if [ -n "$value" ]; then
            case "$value" in *[!0-9a-f]* ) return 1 ;; esac
            [ "${#value}" -eq 64 ] || return 1
            printf '%s\n' "$value"
        fi
        return 0
    fi
    # Findings are allowed only for the exact offline rollback image IDs
    # reviewed from the one-time ARM64 calibration.  Candidate images retain
    # the normal zero-finding contract enforced by Trivy's non-zero exit code.
    case "$service:$architecture:$os_family:$image_id" in
        qdrant-rollback:arm64:debian:sha256:138fbed447b2b20020d431b9dafee347995dd2ae390c4edd9d7c76dff429f9c9)
            # The 2026-09-02 Trivy DB adds CVE-2026-16742 projections for
            # libsystemd0 and libudev1.  The vulnerable systemd-homed service is
            # absent from this exact offline-only rollback image contract.
            printf '%s\n' \
            '01f8c121ff73677fe215ebd1278dbab4fcd41e922fe7aceaa4d347ab4c012822' \
            '034573dabcf07de7b9e05715fe4821d2e982ca0620ddf4d2bd44088250ce1a97' \
            '03c949ee2f3cc4e0fce7c17c579a1f3120cffaa0735e5a732f8fb56b3c293465' \
            '08fc6b20850ebe27610a3a87d08f4e7efa6d2892fa262f1bc363dd34a8f1d924' \
            '0c78abaa172bdb13f6f2018ba1827ef6ff2b6dfa35fb7e74c98a9f42fc56dd6b' \
            '0cb4e4751d7dd0e79c5c64a4c59aba03dadb65ff7ab98ffb26fd56bcb0a22580' \
            '100d8630404ff121ce7ffd84e268c8d8de0a3b0637ab762e81db699b235ee090' \
            '12da5c8f0e87149dd3378b871c17f2051437970afa8835c55fa3ab0a566440a0' \
            '156f3a684a92a4a841242384edf7f7f4afb45e2029268eafbef312a596c47937' \
            '17e5be0729e2f67e900b5dd3dcf2b06e20e1f15faefdeb0b67f3d519c45a0337' \
            '1b413fe5feca8a43141716bef322db1aab7d011888f5d35eb72e22847384d523' \
            '1c2699d7365a2dfdc802503ce9e925b45c0b87da3b3e9c3b7fb88a0f1fe04596' \
            '1edab37b08f3aaf6eeec74eea594c57516b42751bb710def093032990cbc757c' \
            '2195f61a175fd410da7dea64a50518bc8c32660ae040340bd314f311d850aead' \
            '24b3c3708569e23dc71b0023f1625545e22858d9cd9f08e6a08e256388279cb7' \
            '2980782881a41107d60774d89cd49adac16d4597849be5d16f35a166d7bb41f8' \
            '2f8dd01bbc3eefaaf25d53f95e245aa06b37d0982a6aa7c2ab710341f829b034' \
            '308273adad64445d057ef62851e776b00bd7703c7ea81e9cdce691fff965e047' \
            '379afe27840094971d7ba5c543da3977cad0b336d44d39fca6e59ef5959d06b5' \
            '3e97ea5516f374d8844339562ad0187b9cda55a88f6bf7ecf89714be9a5f5856' \
            '401d2904185df47b2f21771d69a12573f65a2777adb78ef12e0a2fb5bc1000ff' \
            '417c5c0adabca297a2e94c18d21d268dde7884abc35c6ba413adedf73822b5c9' \
            '45c3f69da75c3f951cc9bfc1ed8fb687b9bac2efe31dea64e4aff43556b38089' \
            '4641b9031d2681793ae2f03f5eb802db945450d784c7a47df85bfaf45f03eb95' \
            '475797e9c4f43f87674ba593425e7b3c45064bc2db38f8f93004dc4292e3c777' \
            '47c873f2e6c6bfc2608186ee92b095e66109e72d7843f1ee7df704865541b292' \
            '49597ababbbf00658324946e819e2749fad72fefb8401229070ea2ab0a070b73' \
            '49d3d121d4647cfff6d7ac708e1c99f8ea4b581de203a24f4b2c9f6d2b65e4a3' \
            '4a5d63ac97bfd08e33ede9267c5047a0538c7d2f46c640fb6e3f9206df78a6c8' \
            '4db55127f25a11419d57d42712c59a2d37a2974aba6cd3236653244605cd5bcd' \
            '52185968f608b7f295114f3a0cafd6a1daabebb4426f7be69acb28468453afd0' \
            '52609fdbd354b476d9c00a47c81f9de1c9bd262b6770c372dbf68b30ce9ef064' \
            '5359a7ac87c17022c03862d6e55712ada615297151c119249c5c7f9b0e41fbd0' \
            '546cd62e8dd7e0c9dfbaf0be02f4a0a1b91e858eee9865e43b073b1b8d39ecda' \
            '557d1c70b2b54b1081f80adba165a8d2b3b798023dac019e847ed6b2b7deb713' \
            '58d30b071ff9f80120e976989e311c9c19aeb4d548840937984d47272beb31af' \
            '5a2852756519192df15e6b7f1aa13f3a81c73722b249ff1ac6ab87555296851d' \
            '5b1aeac614eabfd7f7dc52790dda3bbc14d1a4f030fa2c8de4bcbf0801af4c0f' \
            '5eff39e8187e3baef0882fa8db0c754b6c22f038edf8032f8ec678b89f72e19d' \
            '60870d2c5f501ab9257d05307fb19b9969a3fd5585eb9300af734d4712f4f3f7' \
            '62847ffdd01262733ca2629a1ed18a5847ccb9fffce63374d029834b5b0c69ff' \
            '6406a84197655552c729e89da5b1ec68b2141f7161e3a905f584be5081117efd' \
            '64fcff8d5ada261ff1d19179baeb299a184aa23862f6bf3d257f761c9e25f661' \
            '6c6eceda10499df05cd80b5c6f92c83fc3bcda3d70a1dc6ec249c37433342f67' \
            '6cb615e7877151dc14222e0722bd99e3931ac1a71b2b4fdd4d3098e35470484f' \
            '6fad563c569b30b5f547674ddfbd41d7fff5596da15c778ec48be21b14dc4384' \
            '72dda40b0b4fce9c8ba1ceb20e31494c892f65cf025cf199f9531fc8d9f381ee' \
            '736e07ce87a5f0ac35391b29210fa0458adb556100ff509e8763898f87870577' \
            '7ab4bfb91c95b6b08930f25c67cd5c37b89a57bc2f4d87b69311156ad39a56b1' \
            '7e4d5e3fff0f3f15d939cd62c363b2f7b80a61d48861ddfb74ebffc6760103c2' \
            '7f42b8de7c38a190a908b01ff0dc5a410f85da9d25bf95ad9cebe77827d6ad3c' \
            '80cd64782835b9204c057d0666b0341677cd06214e0f9970b1eae087cb38f732' \
            '828e7e893971dc662eefcf8dce8f4e86b0f03bcc52b5519fcab4ac4359a7c579' \
            '8450af0cde14c385ce72244d811d6eaf139270a6d62b58b4085ae5dfecce1f7b' \
            '8c70da0989d23551fe4805aafd35b1470088f4630a4dd4a82ebe8e827866a1eb' \
            '8e265bb425728ba41678d226fbe64aa48e176d85d063b80fb3bb727d7fdca043' \
            '8e7c508d2be10daebb063519195d5321c62e629b2d5ceca9f785aab9b9a1867e' \
            '8f3a53e834be1092cccc292bfc644792ebd3c40325bf2f5fd33b60e62a173946' \
            '91b1db51c4e092bd9bfe9cd8d883066e3d99452fb1a76fba17a789b44d6a6f9c' \
            '94d594cb80696d6254ff53357f0b3db17614e026dc1ba83f8bd703f5dc2b1f73' \
            '960186dceefbbfdd487704be2d6769f0197681c0735a5ff1ac9ae8f093f8107d' \
            '989012707ee8bed91ab6b3eb16c464efad926ad736fb9aba5ddb064d977d638c' \
            '989f3d18736d7d6366ec26106bae3202686835e273e5e77a0fed728063a26a3a' \
            '998c7d2ceadbaac53241d4d24679b8ed5a2340964b76af426c0ab086721cb67a' \
            '9a5a4de9745f0c9cf6ac34655106c5b2a2bb949daf99a42f1353d7148879a0ac' \
            '9b0457e3409dcafaf2f95baf32238fa82cb9ccb3967863d98c25df7c2ed8197f' \
            '9bd0ad2b0ace2aa0193edfae0fa4f32de87f6d32b394e014d431f8181d42a928' \
            '9c58b235d7463ad5397e694ba30dbf98e50590139507aac7d0f1a6ceea839ed2' \
            '9dccaa62ccd85c6418f30d842b783692ef5cef739806ceda9ddc5042281e6ab0' \
            '9f3e33eca94909d585823de09b11301869195604470192079122fc97d2e4d7bd' \
            '9fe2c9a607eea708e4a4b6bf9a767655b11358d99bd7d6421f3cc86e7fcbbb34' \
            'a0dbd570861e5dc90e05fe3166c319c2bbbdcc190b03c45afedc7ad36b90bd6e' \
            'a1c4a23aa2e6b1197c6fa6c0ecef531ded7d126d0323d520feb48b939f03972f' \
            'a383c28abd450784907d1ad5e4c30c94410309474f0c87b5dfb1ee47db2659df' \
            'a578a7fca993ef4bf4168d37e9ca9014a617ce2a5201a81b70d337469481cc41' \
            'a8149e12611702d5126b8ad83e551c8c852872bed61a7d73783835c87d49978f' \
            'a9e15f104a44a6b8be3e08d5cb1b4d5b749603f2d4d35fea5e0e6481251e6645' \
            'aa2996b4c9cffb351dc7fe95c1e815a4fe26a425de790bd779429d305ce59020' \
            'ad544905b2f8232179c9d39fbb4bc67a2f28e9a76b04fbe12389f5226d53c8be' \
            'af1f414f1fa79eb2aea0ac25a1ea20108d0d37a472061d78db6a008dffbc69a2' \
            'b040c2eb80e153694d22c213d7dbdb1fc4b77eb092c5d218b0268e116d1f5539' \
            'bacf1f1ceb5de6920df3c0e6c72a070b391aae45b93198b57b4e8a7b745959cc' \
            'bc853cb1bee5f96f614b2be8e58804af2a7c60b7f66d2153dce8f7946c871a3e' \
            'be1dd938ff5d89fc0f09986dc6825b42f916531d526ddb646ddc2c39028988d4' \
            'bec3c0838469fa0f1c3900876dfe15e5426e77a722504ae664c58b999c18fe70' \
            'c1e1fc3e0ded189345bb1c95e1cfcf6e2fba03029e6a3af3539dfb7387fe934d' \
            'c4c4399084bfabbab7a0303d6599e8cd0dcecef06bd005fc740989ca130bd467' \
            'c56d821aadba1b6bf5737e9fc4b086867452510be0fa56cd63ddd635211e28e7' \
            'c6c91d755110ad0738a0d77fce743c5309c5da610e70473b5cd63977e85ccaa6' \
            'c82e8d529c692a930e56134f2b9c881caabb45233bc7d60832c135428dab9159' \
            'c8c407fd5a38d09660a610335323099ae4519e3e10820f6a37758359a93fe522' \
            'cc3eb957cecb441d3a71b9e27ce1298f7979518a93e35aa9f6d83474c809879a' \
            'cdfaada11be701f0eb0d49672a6078786e83626e225e6300fcd4f74aff99758c' \
            'cf2ce868f9ad85c56ddc056cc44583b0d913b6c559b15b44bcc06fa623777b90' \
            'd57ddeea05c3a8ccf266d2d0a2b24e04b4f1e5aee195413658fae98063cda32d' \
            'd3b4c531b152a2ca7eaa7fb2b53d6ce972141f387facaeed2991145c2ec37d90' \
            'd70f3cf7cf628467ec296c3f6a21db8dfdea067183c9934fe3ad53243ab00a78' \
            'd78778ecde83b0674a31f9d4f21272cce1883b9f041d9fe52e5f9c9f0538a738' \
            'dd990c2e0594c0c6f1950218c13cbf725ae13b7ed313086c6deaf27d2b2e7b10' \
            'e0b5ca55b9386012db2f369e8f24de4faada59571839f8b2cbdb628f40c0b1a8' \
            'e18f81b70611390e97aa69f99d44be45802d07b46f24722b5fcf58750d210735' \
            'e2651d5b2b053131a15c83dd5806d965ffc0d723aac404c702b1afbbc122494f' \
            'e30cb901bae68bbac3bdfdc38d23f84595b68b792f4d2c256ea8ca2997449b74' \
            'e50c4f22a2fe9aedfd1dd2066012c6f8b17a4167933da81f0744dfc126b01e49' \
            'e5febbbd2b64a9d7416df5b90cfbe4d2304c5c13d1830c9f06e5215c7b0d523b' \
            'e66e6f6297cdf7b96d04e94f695f20e0271a2dd3a62d5cd016f8f0f0ab8377e2' \
            'e727da259d9e0e3eeb84343c215040cc695ad8aeac252ed62efa08a5957c4c48' \
            'e765d69e05bab0c3a5ede68cbf070db1d408a7fc511b7500e2e21260c23df2c9' \
            'eb710b8377af91e7dc38ab89c9a5b0fcf721a83f3cd31a6af138ab3fb9ac7259' \
            'ef4f81bc839f325a349eef9b292ac61d319a322adb139c0b6260f2665baa5c07' \
            'f37374ae2cfe712b5ee4411a8aa33d9297bbcd8c6e4c32160205c59745f32ce3' \
            'f37fe77f98c4dffa7ba3d13a1f3f07e218792055204c6f53a0ea7340164bd550' \
            'f7a2b229034beec27cc029b444844190982cdb43b96b75ce013fc88a9099f37e' \
            'fd1fc059787ef743d01cacc8933aa4a97cd033be1538c2af6356e9f96361657e'
            ;;
        postgres-rollback:arm64:debian:sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc)
            # The same database adds exact libsystemd0/libudev1 projections to
            # this offline-only rollback image; systemd-homed is not present.
            printf '%s\n' \
            '00deed9f7614378b22ff364e134f124023c54f984155bcb78c1109938f1f8eee' \
            '0358e4d26d70a427a4ead13c2b044785a88941edc4465ddaed05f446cc0f17b1' \
            '07f3b597a365e4c2a00faa7ae82ffbbf6094d062dc1cbfb9c38cdd3c88c3b009' \
            '0fb991c3578aa5466ae6822198d10e53bcac733bc62d210486c6664d133408b4' \
            '1389bf4ee39cf6a9ee08cfd5aa000f6f8df01c8722292676f35c3e04e91327da' \
            '14158fc81000eb06c5d1ff0c23d77d7d8277a2ad9ac93667b9b7ecb65908eb89' \
            '16572ed13f111127ee34844d2348d7b01acd1572005e719d84e49fd1be97aee9' \
            '16fff6dc60c132f8c5c19323c24bba6108f25783a37ddd638f5ecea9fad991f1' \
            '1afa6a11ecbc484970022d4af4240c0d0e2fc4c45327eb19ba7a52819fab7913' \
            '1cec2ca91a39f3b91a5520aa77516208c201f0932a38b7b00bf7fe91b30b10db' \
            '209c8a7bf2b330dcb1d3a3ec2833000cad7af0f66de48e907a960f6258030bf5' \
            '26a0d3c6b20be4f7635c30970c924675b9b1b9b982d8106c301a765293568435' \
            '291feecc1746da6cacbacf391acdefa6a7e4959bc1a4d30ee21d60373b698212' \
            '2925b6b5efa7746bfcc9410042504c16e90ccdab5e9ddbd81912723f89e6b7d1' \
            '2d6e7bf21c97e198618a5a02f4ecfe81b5b0763a999a3135d679a60532a54b3a' \
            '305aa7b72760db2ed6fb8449df4474ddeb7ba737939eea311de0d600e207bf24' \
            '31da332e359598dec4741a4e9fbf8bb567e236856ed1491b2dfbbcfdd692bd89' \
            '327b5e2fd4fd4bdc84e5bcf3149943c3873ed1fab1f61046343918942071ab8b' \
            '34c80b4437c875ab3acfce2e29811bcce19bc30fe6314ebb24ebe114294e60b2' \
            '3a1571d0de2bf7969970bcc4d9c99edd75be9a1a0408ab78edcd6f225b2c7500' \
            '3a21615704c8eaee1ff3b43456e7825a83a07e6972b59f7599017e5205f7db27' \
            '3a58f7e34fe868c292f50fa385fb35119cfba6f6e10c1c510f849247cff579db' \
            '40760a843a5e1c58361232eb08e46f67389ebdeeed8cf94a5c50a037de3a7b79' \
            '4434c923e4729c411aa23a46ad3e383adbe764097811b8889d8aa1babc87979c' \
            '44d1f76e09b0b22cc9c799c29d92464c6e9b9ad1fc0995cab27470b4f5902e6e' \
            '46500e301595f9abe2b3082f48926fa650e8bb0f8f477274108bd10b8596aea0' \
            '46d0b4a407376552020079d46ffbb802dad703cb4ca4ba61387cd1839859e745' \
            '47837296cc4b6db9a6bac438a05d758f807311c49f6ecf03be73dad776faef87' \
            '4b8c6df51a4393b0c0aebf395bd4a7acf3ce58105f1bee1244e05ea6a8f7e757' \
            '4fe53d48e85f6f344ae37004d8909d95834184219902327e82dd31f78175ea9c' \
            '50e1405500757737fbadfd228e7323e2590a1eba76c6d859e10039e9cfa6d995' \
            '545b72454d43e9454242b446e2640ec793cc21eb4016c18da4619ae36c99aa58' \
            '56de263f312ab4ef6fdb38be428c067fa30005a02acb98bcf572a63d4f71efef' \
            '5ea19f59078315c1aa4c1020c17efea0bb3488ac56a8456aeb1d86857b2afa53' \
            '63604e4b35287310548d8b6478cffe8ac3ada072ac3affa0c4c215a4aaa221f0' \
            '64167b7991fe225366bf7e626dd6f0dc543a6126d5c5e99289b1dfe16d8edea7' \
            '647b6c38e0e6b423b173bc5c257b98a626bdaeafeff38007906ee03e87f2f0b5' \
            '64b219466f41e6fcd87668bf9fdd16b7df0fe7274222b40ccc955c974c4ba25f' \
            '65e561f73b9b0c9100e3200d48c912c25b3839d134710341ba6c3bd445d54422' \
            '6a2fc2df82eb859e8352141116b4f6e28cb2ac49b371b69d20c6d41e11998ed4' \
            '71038fb4a9c3074c58bd3ec2a1e6a629560934a410d88357bb0650bddc871bc9' \
            '7113b09cc6174320bde1480becc7aa7eb4c5c74933945e5e34cce944730ce9cd' \
            '78f0a42d5b0b600cf6e7481e275fda609c2d2192e2ae8e8cca08ce655727b2d1' \
            '79774aa63472baaefb3a92c793393333d8787d9993563ebe9b4f00aa64ae3d82' \
            '79c37708bd9cd64e323b11eb774845f518cadcbaeef35b021111af6c0fc87444' \
            '7ff09de4ebe1270e32e9ed2abc06bd3bc9c1228966e60cba94f35589877e4cd4' \
            '81eb20352f5fc979a047fe27d2825bdb6949cbb219766a16081fe5dbe7549e91' \
            '84ae129db7df6bd6203dec09df864640b58ed205c0126ff445429065eeaea5ee' \
            '851107ce1dbf6eb3f38d8e242082d531dd63ad7e299feaef6fa1baf2cac4663a' \
            '885a1009fba6c2d51f65ec433c6084d7276a9675da0d5d8090af339c8c406cec' \
            '88adcd56eeefba96310fc38a5161faf9e5e6bf6d1192a017a92638947ab2b74a' \
            '8c75834aa790dbf3c27c60bd2403efcf5c56472cceeb69331be70c2e499e0963' \
            '9725022b434c5f2bd5c9496b5a484e7cd91a299fd3ae6d90d52bd0ffb9280ff0' \
            '98d27299008f20dcae0d85b594d6714d84b575c07e0ec135d88f5ca4ad5f80c8' \
            '9b5d075d7f5a1e574ade0397ce2fee35c690d9a00f47dfc09ed3938c7adc81ac' \
            '9bb0f5b49dac54f8734bfc65d7bb35c3e0266aa316a6b30bd501afbb2f463e1b' \
            '9ec11a6ce83a597cf38f00ac31daf928a05a72e976157c1018003aa9a8de05aa' \
            '9f02341ea3891c79fd3770484edea04738d349cf5220624c08936f1ca97f5f8d' \
            '9f7c083ac3ee140b192896343c79e44e23085d1fb67320ea6a17a7efda9b5b97' \
            'a2b640a3a252114816cd15acc56c54b478969a747865937f5eb97bb68d79f9ee' \
            'a52e1bfe3f04456b0ac8264388e541950136677b43c6ce2d84c5cc911f661d94' \
            'a7319484ac9da237334c1079e3e17e1797de428dee29cb1faf58e2892d48b18b' \
            'a78a1dc981503ec10a864e9f9eafcd8b3e63de736be53eeb327458f494839282' \
            'a9644c29523fa9911d2b47cec279404f2d83c790c426032d8cfbb9d87f894227' \
            'ada22b586a1c058987ca76af8254dbedf700ffc74cb1a369bf037f9b910109b8' \
            'b07911a0c5a44f5748d86711800af2db9c330930c33c388a0697e00a6274b30d' \
            'b576fb54319c45f97d48fdf2779bd2de2f4905ab5e4d868709a07d7f692f7b93' \
            'b735b42a188645f4214fb11cfe6f4406a05f96e60b92488eb76b879f2acb8d55' \
            'b95ce43cbc9cd11cf52923b933f813c22f903d3250792dacd2c79066209291a9' \
            'bb73aa9f5badad10f79b85e5d2ae62f1503212b04539fa6425efe0c5701fb413' \
            'c37a4d143be8bbd93fbca06480baa2ce7eca36a124f7ff700e1d1a54e268c1cc' \
            'c53729d3851b7823d33fb49ae429e6b94499f3bb80529f611d1c0373d5aecf18' \
            'c7889e37ea5dfa09cb67ca121114d5aa56dbf1502a865fff525cbb327820b249' \
            'c82abd42f78c281491d204c55820ccc18b0a046996f150db6da0087d7c7d25f8' \
            'cb1e3bba9e57ff78f4a83e64b10e5ed2d856bccdd683f0006d2c814bea239735' \
            'cb4a833df805c4a942480955d4ebc73f51a9384a9971aeb71e17c1d3f76c00a3' \
            'cdff53ee916bb12c4ed1304aa25f81c86d8b553ccca41de9af4d19f6b1fd012e' \
            'd1eaa61e9f0220b53fef113fa10295abe2fdce43bbe0e06ca2a9044ae3baa688' \
            'd45e0a2e875323dfb72c74e9603b3bfe0d1e56e00a57d11f135f0f94e5e985f8' \
            'd5018189775a8c3eb08165bac3b3ebca01914501cb87a0d318b2c581a48f071a' \
            'd7533b988d289ccf7c5fcf84e6d6a167d73c3568a5d32967ceafa46b3aebf267' \
            'e5b30dd449644ce915cc084dfe0e1a20ee7c5e6259adb3e0b4d115a455374f83' \
            'e79d022751df7c5fd49ac5dfa4fc396775ae2e99bd44bb5a19d0cb3fbf7a51d1' \
            'ee127d59370756c15a918df5e7b18e58f19ceb930f17fbc1266c6b199da144bd' \
            'f47aca2c73e131b0f9aea6e2eada554372664983c47d76974f5e54a05d47db0c' \
            'f47f73fa79990c214b1d0993ec2076ef144db60b4887a0b1771e691951e9a06c' \
            'f673b7df5f482b588ffc62c3eb6bd6ffbf9303bdd0a8212aeb65650d8a100d5a' \
            'f76fcc45804fb051bfb6ff322bc4d912649653c9882e502adfc092ec2d71f927' \
            'f8407278eb265783a368bfd9deaa51759c1e95adeb468633c2db18f0ba4b6515' \
            'f885d8917eac4813c1d6f28167b662b1a5fe219410e7c3ac757ad63df2dec626' \
            'fc68062213dbd7d79e8a96d07d5bbd5d753a76624bfc2a607fd1d2285877af74' \
            'fc97058064205d668845636e8abc07d3202b60629e76be93e8fc25b41a0af71c'
            ;;
        *) return 1 ;;
    esac
}

prepare_image_scan_database() {
    TRIVY_RUN_CACHE="$RUN_DIR/trivy-cache"
    TRIVY_EMPTY_CONFIG="$RUN_DIR/trivy-empty.yaml"
    TRIVY_EMPTY_IGNORE="$RUN_DIR/trivy-empty.ignore"
    [ ! -e "$TRIVY_RUN_CACHE" ] && [ ! -L "$TRIVY_RUN_CACHE" ] || return 1
    mkdir "$TRIVY_RUN_CACHE" || return 1
    chmod 700 "$TRIVY_RUN_CACHE" || return 1
    : > "$TRIVY_EMPTY_CONFIG"
    : > "$TRIVY_EMPTY_IGNORE"
    chmod 600 "$TRIVY_EMPTY_CONFIG" "$TRIVY_EMPTY_IGNORE" || return 1
    TRIVY_SCANNER_SHA=$(sha256sum "$TRIVY_COMMAND" | awk '{print $1}') || return 1
    case "$TRIVY_SCANNER_SHA" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#TRIVY_SCANNER_SHA}" -eq 64 ] || return 1
    if [ "$TEST_MODE" = "1" ]; then
        run_bounded_command "$BUILD_TIMEOUT_SECONDS" env -i \
            PATH=/usr/bin:/bin "FAKE_STATE=${FAKE_STATE:-}" \
            "FAKE_SCENARIO=${FAKE_SCENARIO:-}" \
            "$TRIVY_COMMAND" --config "$TRIVY_EMPTY_CONFIG" \
            --cache-dir "$TRIVY_RUN_CACHE" image --download-db-only \
            || return 1
    else
        run_bounded_command "$BUILD_TIMEOUT_SECONDS" env -i \
            PATH=/usr/bin:/bin HOME="$RUN_DIR/trivy-home" \
            XDG_CACHE_HOME="$RUN_DIR/trivy-xdg-cache" \
            "$TRIVY_COMMAND" --config "$TRIVY_EMPTY_CONFIG" \
            --cache-dir "$TRIVY_RUN_CACHE" image --download-db-only \
            || return 1
    fi
    [ -f "$TRIVY_RUN_CACHE/db/metadata.json" ] \
        && [ ! -L "$TRIVY_RUN_CACHE/db/metadata.json" ] \
        && [ -f "$TRIVY_RUN_CACHE/db/trivy.db" ] \
        && [ ! -L "$TRIVY_RUN_CACHE/db/trivy.db" ] || return 1
    chmod -R go-rwx "$TRIVY_RUN_CACHE" || return 1
    if [ "$TEST_MODE" != "1" ]; then
        [ "$(stat -c '%u:%g:%a' "$TRIVY_RUN_CACHE")" = 0:0:700 ] || return 1
        unsafe_scan_cache=$(find "$TRIVY_RUN_CACHE" -xdev \
            \( -type l -o ! -user root -o ! -group root -o -perm /077 \) \
            -print -quit) || return 1
        [ -z "$unsafe_scan_cache" ] || return 1
    fi
    durable_sync_path "$TRIVY_RUN_CACHE/db/metadata.json" || return 1
    durable_sync_path "$TRIVY_RUN_CACHE/db/trivy.db" || return 1
    durable_sync_path "$TRIVY_RUN_CACHE/db" || return 1
    durable_sync_path "$TRIVY_RUN_CACHE" || return 1
}

write_scan_calibration_evidence() {
    local service="$1" report="$2" image_id="$3" architecture="$4" \
        expected_os="$5" expected_family="$6" allow_findings="$7" output="$8"
    case "$allow_findings" in 0|1) ;; *) return 1 ;; esac
    "$PYTHON_COMMAND" -I -B - "$service" "$report" "$image_id" "$architecture" \
        "$expected_os" "$expected_family" "$allow_findings" \
        "$IMAGE_SCAN_VALIDATOR_RELEASE" \
        "$TRIVY_RUN_CACHE/db/metadata.json" \
        "$TRIVY_RUN_CACHE/db/trivy.db" "$output" <<'PY'
import hashlib
import importlib.util
import json
import os
import stat
import sys

(service, report_path, image_id, architecture, expected_os, expected_family,
 allow_findings_text, validator_path, metadata_path, database_path,
 output_path) = sys.argv[1:]
allow_findings = allow_findings_text == "1"
if allow_findings_text not in {"0", "1"}:
    raise RuntimeError("invalid calibration finding policy")
if allow_findings and service not in {"qdrant-rollback", "postgres-rollback"}:
    raise RuntimeError("only rollback images may calibrate vulnerability findings")
MAX_TRIVY_DATABASE_BYTES = 2 * 1024 * 1024 * 1024
spec = importlib.util.spec_from_file_location("diva_image_scan_validator", validator_path)
if spec is None or spec.loader is None:
    raise RuntimeError("image scan validator helper cannot be loaded")
validator = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = validator
spec.loader.exec_module(validator)

def open_plain(path, maximum):
    before = os.lstat(path)
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or before.st_size <= 0 or before.st_size > maximum):
        raise RuntimeError(f"unsafe scan artifact: {path}")
    flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
             | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    descriptor = os.open(path, flags)
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink, opened.st_size) != (
        before.st_dev, before.st_ino, before.st_mode, before.st_nlink, before.st_size
    ):
        os.close(descriptor)
        raise RuntimeError(f"scan artifact changed while opening: {path}")
    return descriptor, opened

def consume_plain(path, maximum, *, capture):
    descriptor, opened = open_plain(path, maximum)
    digest = hashlib.sha256()
    payload = bytearray() if capture else None
    remaining = opened.st_size
    try:
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise RuntimeError(f"scan artifact was truncated: {path}")
            digest.update(chunk)
            if payload is not None:
                payload.extend(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise RuntimeError(f"scan artifact grew while reading: {path}")
        after = os.fstat(descriptor)
        if (after.st_dev, after.st_ino, after.st_mode, after.st_nlink, after.st_size) != (
            opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink, opened.st_size
        ):
            raise RuntimeError(f"scan artifact changed while reading: {path}")
    finally:
        os.close(descriptor)
    return (bytes(payload) if payload is not None else None), digest.hexdigest()

report_raw, report_sha256 = consume_plain(
    report_path, 128 * 1024 * 1024, capture=True
)
metadata_raw, metadata_sha256 = consume_plain(
    metadata_path, 1024 * 1024, capture=True
)
_, database_sha256 = consume_plain(
    database_path, MAX_TRIVY_DATABASE_BYTES, capture=False
)
report = json.loads(report_raw)
if report.get("SchemaVersion") != 2 or report.get("ArtifactType") != "container_image":
    raise RuntimeError("scan report schema is not exact")
metadata = report.get("Metadata")
if not isinstance(metadata, dict) or metadata.get("ImageID") != image_id:
    raise RuntimeError("scan report image ID is not exact")
image_config = metadata.get("ImageConfig")
os_document = metadata.get("OS")
if not isinstance(image_config, dict) or not isinstance(os_document, dict):
    raise RuntimeError("scan report platform metadata is missing")
if image_config.get("architecture") != architecture or image_config.get("os") != expected_os:
    raise RuntimeError("scan report platform changed")
family = os_document.get("Family")
if not isinstance(family, str) or not family:
    raise RuntimeError("scan report OS family is missing")
if expected_family != "auto" and family != expected_family:
    raise RuntimeError("scan report OS family changed")
inventory = {}
total = 0
findings = []
results = report.get("Results")
if not isinstance(results, list) or not results:
    raise RuntimeError("scan report results are empty")
for result in results:
    if not isinstance(result, dict):
        raise RuntimeError("scan result is malformed")
    key = (result.get("Class"), result.get("Type"))
    if not all(isinstance(value, str) and value for value in key):
        raise RuntimeError("scan inventory key is invalid")
    target = result.get("Target")
    if not isinstance(target, str) or not target or target == "-" or len(target) > 4096:
        raise RuntimeError("scan target is invalid")
    packages = result.get("Packages")
    if not isinstance(packages, list) or not packages:
        raise RuntimeError("scan inventory is empty")
    for package in packages:
        if (not isinstance(package, dict) or not isinstance(package.get("Name"), str)
                or not package.get("Name") or not isinstance(package.get("Version"), str)
                or not package.get("Version")):
            raise RuntimeError("scan package inventory is malformed")
    row = inventory.setdefault(key, {"packageCount": 0, "resultCount": 0})
    row["packageCount"] += len(packages)
    row["resultCount"] += 1
    total += len(packages)
    vulnerabilities = result.get("Vulnerabilities")
    if vulnerabilities is None:
        vulnerabilities = []
    if not isinstance(vulnerabilities, list):
        raise RuntimeError("scan findings are malformed")
    if vulnerabilities and not allow_findings:
        raise RuntimeError("non-rollback calibration contains a vulnerability finding")
    for vulnerability in vulnerabilities:
        projection = validator.canonical_finding_projection(result, vulnerability)
        findings.append({
            **projection,
            "sha256": validator.finding_fingerprint_sha256(result, vulnerability),
        })
        if len(findings) > 10000:
            raise RuntimeError("scan finding count exceeds the calibration safety limit")
evidence = {
    "architecture": architecture,
    "databaseMetadataSha256": metadata_sha256,
    "databaseSha256": database_sha256,
    "imageId": image_id,
    "findings": sorted(findings, key=lambda item: (
        item["sha256"], item["Target"], item.get("PkgName") or ""
    )),
    "highCriticalCount": len(findings),
    "inventory": [
        {"class": key[0], "type": key[1], **inventory[key]}
        for key in sorted(inventory)
    ],
    "os": expected_os,
    "osFamily": family,
    "packageCount": total,
    "reportSha256": report_sha256,
    "service": service,
    "status": "requires-reviewed-exact-inventory-and-finding-contract",
}
payload = (json.dumps(evidence, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":")) + "\n").encode()
descriptor = os.open(
    output_path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0),
    0o600,
)
try:
    os.write(descriptor, payload)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

scan_exact_image() {
    local service="$1" source_reference="$2" expected_image_id="$3" \
        expected_family="$4" before_id after_id architecture expected_os report receipt \
        validation_result verification_result started_at completed_at actual_family bounds \
        inventory_bound receipt_sha calibration scan_exit_code allow_findings \
        finding_contract_reviewed finding_sha256 allowed_finding
    case "$service" in
        qdrant-rollback|postgres-rollback)
            scan_exit_code=0
            allow_findings=1
            ;;
        *)
            scan_exit_code=1
            allow_findings=0
            ;;
    esac
    before_id=$(query_image_id "$source_reference") || return 1
    [ "$before_id" = "$expected_image_id" ] || return 1
    architecture=$(run_bounded_docker_read image inspect --format '{{.Architecture}}' \
        "$expected_image_id") || return 1
    if [ "$TEST_MODE" = "1" ]; then
        case "$architecture" in amd64|arm64) ;; *) return 1 ;; esac
    else
        [ "$architecture" = arm64 ] || return 1
    fi
    expected_os=$(run_bounded_docker_read image inspect --format '{{.Os}}' \
        "$expected_image_id") || return 1
    [ "$expected_os" = linux ] || return 1
    report="$RUN_DIR/evidence/image-scan-$service.json"
    receipt="$RUN_DIR/evidence/image-scan-$service.receipt.json"
    validation_result="$RUN_DIR/evidence/image-scan-$service.validation.json"
    verification_result="$RUN_DIR/evidence/image-scan-$service.verification.json"
    for target in "$report" "$receipt" "$validation_result" "$verification_result"; do
        [ ! -e "$target" ] && [ ! -L "$target" ] || return 1
    done
    started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [ "$TEST_MODE" = "1" ]; then
        run_bounded_command "$BUILD_TIMEOUT_SECONDS" env -i \
            PATH=/usr/bin:/bin "FAKE_STATE=${FAKE_STATE:-}" \
            "FAKE_SCENARIO=${FAKE_SCENARIO:-}" \
            "$TRIVY_COMMAND" --config "$TRIVY_EMPTY_CONFIG" \
            --cache-dir "$TRIVY_RUN_CACHE" image --ignorefile "$TRIVY_EMPTY_IGNORE" \
            --skip-db-update --image-src docker --scanners vuln \
            --severity HIGH,CRITICAL --format json --list-all-pkgs \
            --exit-code "$scan_exit_code" \
            --output "$report" "$expected_image_id" || return 1
    else
        run_bounded_command "$BUILD_TIMEOUT_SECONDS" env -i \
            PATH=/usr/bin:/bin HOME="$RUN_DIR/trivy-home" \
            XDG_CACHE_HOME="$RUN_DIR/trivy-xdg-cache" \
            "$TRIVY_COMMAND" --config "$TRIVY_EMPTY_CONFIG" \
            --cache-dir "$TRIVY_RUN_CACHE" image --ignorefile "$TRIVY_EMPTY_IGNORE" \
            --skip-db-update --image-src docker --scanners vuln \
            --severity HIGH,CRITICAL --format json --list-all-pkgs \
            --exit-code "$scan_exit_code" \
            --output "$report" "$expected_image_id" || return 1
    fi
    completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    chmod 600 "$report" || return 1
    durable_sync_path "$report" || return 1
    after_id=$(query_image_id "$source_reference") || return 1
    [ "$after_id" = "$expected_image_id" ] || return 1
    actual_family=$("$PYTHON_COMMAND" -I -B -c \
        'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["Metadata"]["OS"]["Family"])' \
        "$report") || return 1
    case "$actual_family" in ''|*[!a-zA-Z0-9_.-]*) return 1 ;; esac
    [ "$expected_family" = auto ] || [ "$actual_family" = "$expected_family" ] || return 1
    bounds=$(reviewed_inventory_bounds "$service" "$architecture" "$actual_family" \
        "$expected_image_id" 2>/dev/null) || bounds=""
    finding_contract_reviewed=true
    finding_sha256=""
    if [ "$allow_findings" = 1 ]; then
        if ! finding_sha256=$(reviewed_legacy_finding_sha256 "$service" \
            "$architecture" "$actual_family" "$expected_image_id" 2>/dev/null); then
            finding_contract_reviewed=false
            finding_sha256=""
        fi
    fi
    if [ -z "$bounds" ] || [ "$finding_contract_reviewed" != true ]; then
        calibration="$RUN_DIR/evidence/image-scan-$service.calibration.json"
        [ ! -e "$calibration" ] && [ ! -L "$calibration" ] || return 1
        write_scan_calibration_evidence "$service" "$report" "$expected_image_id" \
            "$architecture" "$expected_os" "$expected_family" "$allow_findings" \
            "$calibration" || return 1
        chmod 600 "$calibration" || return 1
        durable_sync_path "$calibration" || return 1
        SCAN_CALIBRATION_REQUIRED=true
        record_state "image_scan.$service.calibration_sha256" \
            "$(sha256sum "$calibration" | awk '{print $1}')"
        return 0
    fi
    set -- "$PYTHON_COMMAND" -I -B "$IMAGE_SCAN_VALIDATOR_RELEASE" validate \
        --service "$service" --expected-image-id "$expected_image_id" \
        --expected-architecture "$architecture" --expected-os "$expected_os" \
        --expected-os-family "$actual_family" --report "$report" \
        --db-metadata "$TRIVY_RUN_CACHE/db/metadata.json" \
        --db "$TRIVY_RUN_CACHE/db/trivy.db" --receipt "$receipt"
    for inventory_bound in $bounds; do
        set -- "$@" --inventory-bound "$inventory_bound"
    done
    for allowed_finding in $finding_sha256; do
        set -- "$@" --allowed-finding-sha256 "$allowed_finding"
    done
    set -- "$@" --scanner-version 0.74.0 --scanner-sha256 "$TRIVY_SCANNER_SHA" \
        --scan-started-at "$started_at" --scan-completed-at "$completed_at"
    "$@" > "$validation_result" || return 1
    chmod 600 "$receipt" "$validation_result" || return 1
    receipt_sha=$(sha256sum "$receipt" | awk '{print $1}') || return 1
    "$PYTHON_COMMAND" -I -B "$IMAGE_SCAN_VALIDATOR_RELEASE" verify \
        --service "$service" --expected-image-id "$expected_image_id" \
        --expected-architecture "$architecture" --expected-os "$expected_os" \
        --expected-os-family "$actual_family" --report "$report" \
        --db-metadata "$TRIVY_RUN_CACHE/db/metadata.json" \
        --db "$TRIVY_RUN_CACHE/db/trivy.db" --receipt "$receipt" \
        --expected-receipt-sha256 "$receipt_sha" \
        --maximum-receipt-age-seconds 21600 > "$verification_result" || return 1
    chmod 600 "$verification_result" || return 1
    durable_sync_path "$receipt" || return 1
    durable_sync_path "$validation_result" || return 1
    durable_sync_path "$verification_result" || return 1
    record_state "image_scan.$service.receipt_sha256" "$receipt_sha"
}

verify_exact_image_scan_receipt() {
    local service="$1" source_reference="$2" expected_image_id="$3" report receipt \
        receipt_sha architecture expected_os actual_family count verification_result
    [ "$(query_image_id "$source_reference")" = "$expected_image_id" ] || return 1
    report="$RUN_DIR/evidence/image-scan-$service.json"
    receipt="$RUN_DIR/evidence/image-scan-$service.receipt.json"
    verification_result="$RUN_DIR/evidence/image-scan-$service.reverification.json"
    [ ! -e "$verification_result" ] && [ ! -L "$verification_result" ] || return 1
    count=$(grep -Fc "image_scan.$service.receipt_sha256=" "$STATE_FILE") || return 1
    [ "$count" -eq 1 ] || return 1
    receipt_sha=$(awk -F= -v key="image_scan.$service.receipt_sha256" \
        '$1 == key { print $2 }' "$STATE_FILE") || return 1
    case "$receipt_sha" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#receipt_sha}" -eq 64 ] || return 1
    architecture=$(run_bounded_docker_read image inspect --format '{{.Architecture}}' \
        "$expected_image_id") || return 1
    expected_os=$(run_bounded_docker_read image inspect --format '{{.Os}}' \
        "$expected_image_id") || return 1
    [ "$expected_os" = linux ] || return 1
    if [ "$TEST_MODE" != "1" ]; then
        [ "$architecture" = arm64 ] || return 1
    fi
    actual_family=$("$PYTHON_COMMAND" -I -B -c \
        'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["Metadata"]["OS"]["Family"])' \
        "$report") || return 1
    "$PYTHON_COMMAND" -I -B "$IMAGE_SCAN_VALIDATOR_RELEASE" verify \
        --service "$service" --expected-image-id "$expected_image_id" \
        --expected-architecture "$architecture" --expected-os "$expected_os" \
        --expected-os-family "$actual_family" --report "$report" \
        --db-metadata "$TRIVY_RUN_CACHE/db/metadata.json" \
        --db "$TRIVY_RUN_CACHE/db/trivy.db" --receipt "$receipt" \
        --expected-receipt-sha256 "$receipt_sha" \
        --maximum-receipt-age-seconds 21600 > "$verification_result" || return 1
    chmod 600 "$verification_result" || return 1
    durable_sync_path "$verification_result" || return 1
}

verify_all_exact_image_scan_receipts() {
    verify_exact_image_scan_receipt qdrant-runtime "$QDRANT_CANDIDATE_IMAGE" \
        "$NEW_QDRANT_ID" || return 1
    verify_exact_image_scan_receipt qdrant-audit "$QDRANT_AUDIT_TOOL_IMAGE" \
        "$NEW_QDRANT_AUDIT_ID" || return 1
    verify_exact_image_scan_receipt postgres-runtime "$POSTGRES_CANDIDATE_IMAGE" \
        "$NEW_POSTGRES_ID" || return 1
    verify_exact_image_scan_receipt postgres-migrate "$POSTGRES_MIGRATE_CANDIDATE_IMAGE" \
        "$NEW_POSTGRES_MIGRATE_ID" || return 1
    verify_exact_image_scan_receipt qdrant-rollback "$old_qdrant_scan_image_id" \
        "$old_qdrant_scan_image_id" || return 1
    verify_exact_image_scan_receipt postgres-rollback "$old_postgres_scan_image_id" \
        "$old_postgres_scan_image_id" || return 1
    verify_exact_image_scan_receipt api-a "$API_A_BRIDGE_IMAGE_ID" \
        "$API_A_BRIDGE_IMAGE_ID" || return 1
    verify_exact_image_scan_receipt api-b "$API_B_BRIDGE_IMAGE_ID" \
        "$API_B_BRIDGE_IMAGE_ID" || return 1
    verify_exact_image_scan_receipt api-gateway "$api_gateway_image_id" \
        "$api_gateway_image_id" || return 1
    verify_exact_image_scan_receipt web "$web_image_id" "$web_image_id"
}

record_state() {
    printf '%s=%s\n' "$1" "$2" >> "$STATE_FILE"
    sync -f "$STATE_FILE" 2>/dev/null || sync
}

run_bounded_read_command() {
    run_bounded_command "$READ_TIMEOUT_SECONDS" "$@"
}

run_bounded_command() {
    local timeout_seconds="$1"
    shift
    "$TIMEOUT_COMMAND" --signal=TERM --kill-after=10 \
        "$timeout_seconds" "$@"
}

mark_daemon_read_unresolved() {
    local read_status="$1"
    DAEMON_READ_UNRESOLVED=true
    if [ -d "$RUN_DIR" ] && [ ! -L "$RUN_DIR" ]; then
        printf '%s\n' "$read_status" > "$DAEMON_READ_UNRESOLVED_FILE"
        sync -f "$DAEMON_READ_UNRESOLVED_FILE" 2>/dev/null || sync
    fi
    if [ "$ACTIVE_JOURNAL_CREATED" = "true" ]; then
        record_state daemon.read_uncertain_exit "$read_status"
    fi
}

run_bounded_docker_read() {
    run_bounded_docker_read_with_timeout "$READ_TIMEOUT_SECONDS" "$@"
}

run_bounded_docker_read_with_timeout() {
    local timeout_seconds="$1"
    local read_status=0
    shift
    # docker exec -i must remain in the SSH TTY foreground process group.
    # Without --foreground, GNU timeout backgrounds the Docker client and a
    # read from its inherited terminal can stop it with SIGTTIN indefinitely.
    "$TIMEOUT_COMMAND" --foreground --signal=TERM --kill-after=10 \
        "$timeout_seconds" "$DOCKER_COMMAND" "$@" || read_status=$?
    if [ "$read_status" -ne 0 ]; then
        mark_daemon_read_unresolved "$read_status"
        return "$read_status"
    fi
}

# Health probes have documented non-zero results while a service is starting.
# Those results are conclusive and may be retried; a timeout is not conclusive
# and must retain the fail-stop interlock before any further daemon mutation.
run_bounded_docker_health_probe() {
    local probe_status=0
    run_bounded_read_command "$DOCKER_COMMAND" "$@" || probe_status=$?
    case "$probe_status" in
        0) return 0 ;;
        1|2|3) return "$probe_status" ;;
        *)
            mark_daemon_read_unresolved "$probe_status"
            return "$probe_status"
            ;;
    esac
}

read_pipeline_github_identity_digest_as_owner() {
    local digest_record old_ifs
    digest_record=$(
        (
            exec 9<&-
            if [ "$TEST_MODE" = "1" ]; then
                run_bounded_command 30 /usr/bin/env -i \
                    HOME="$PIPELINE_GITHUB_HOME" PATH=/usr/bin:/bin \
                    "$SETPRIV_COMMAND" \
                    --reuid="$PIPELINE_RUNTIME_UID" --regid="$PIPELINE_RUNTIME_GID" \
                    --clear-groups --no-new-privs \
                    --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
                    /usr/bin/sha256sum -- "$PIPELINE_GITHUB_IDENTITY"
            else
                run_bounded_command 30 /usr/bin/env -i \
                    HOME="$PIPELINE_GITHUB_HOME" PATH=/usr/bin:/bin \
                    /usr/bin/setpriv \
                    --reuid="$PIPELINE_RUNTIME_UID" --regid="$PIPELINE_RUNTIME_GID" \
                    --clear-groups --no-new-privs \
                    --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
                    /usr/bin/sha256sum -- "$PIPELINE_GITHUB_IDENTITY"
            fi
        )
    ) || return 1
    old_ifs=$IFS
    IFS=' '
    set -- $digest_record
    IFS=$old_ifs
    [ "$#" -eq 2 ] \
        && { [ "$2" = "$PIPELINE_GITHUB_IDENTITY" ] \
            || [ "$2" = "*$PIPELINE_GITHUB_IDENTITY" ]; } || return 1
    case "$1" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#1}" -eq 64 ] || return 1
    printf '%s\n' "$1"
}

capture_pipeline_github_ssh_identity() {
    local identity_digest
    identity_digest=$(read_pipeline_github_identity_digest_as_owner) || return 1
    /usr/bin/stat -c 'home=%d:%i:%u:%g:%a' "$PIPELINE_GITHUB_HOME" \
        && /usr/bin/stat -c 'ssh=%d:%i:%u:%g:%a' "$PIPELINE_GITHUB_HOME/.ssh" \
        && /usr/bin/stat -c 'key=%d:%i:%u:%g:%a:%h:%s:%Y' \
            "$PIPELINE_GITHUB_IDENTITY" \
        && printf 'key-sha256=%s\n' "$identity_digest"
}

validate_pipeline_github_ssh_identity() {
    local expected_uid expected_gid expected_home_mode passwd_record old_ifs current_identity
    case "$PIPELINE_GITHUB_USER:$PIPELINE_GITHUB_HOME:$PIPELINE_GITHUB_IDENTITY" in
        *[!A-Za-z0-9_./:-]*) fail "pipeline GitHub SSH path contract is invalid"; return 1 ;;
    esac
    [ "$PIPELINE_GITHUB_IDENTITY" \
        = "$PIPELINE_GITHUB_HOME/.ssh/id_ed25519_diva_data_pipeline_github" ] \
        || { fail "pipeline GitHub SSH identity path is not the fixed dedicated key"; return 1; }
    if [ "$TEST_MODE" = "1" ]; then
        expected_uid=$(/usr/bin/id -u) || return 1
        expected_gid=$(/usr/bin/id -g) || return 1
        expected_home_mode=700
    else
        [ "$PIPELINE_GITHUB_USER" = orangepi ] \
            && [ "$PIPELINE_GITHUB_HOME" = /home/orangepi ] \
            || { fail "pipeline GitHub SSH account is not the fixed production account"; return 1; }
        passwd_record=$(/usr/bin/getent passwd "$PIPELINE_GITHUB_USER") \
            || { fail "pipeline GitHub SSH account is unavailable"; return 1; }
        old_ifs=$IFS
        IFS=:
        set -- $passwd_record
        IFS=$old_ifs
        [ "$#" -eq 7 ] && [ "$1" = "$PIPELINE_GITHUB_USER" ] \
            && [ "$6" = "$PIPELINE_GITHUB_HOME" ] \
            || { fail "pipeline GitHub SSH passwd identity is invalid"; return 1; }
        expected_uid=$3
        expected_gid=$4
        expected_home_mode=750
        [ "$(/usr/bin/readlink -f -- /home)" = /home ] \
            && [ "$(/usr/bin/stat -c '%u:%g:%a' /home)" = 0:0:755 ] \
            || { fail "pipeline GitHub SSH /home ancestry is invalid"; return 1; }
    fi
    case "$expected_uid:$expected_gid" in
        *[!0-9:]*|:|*:|*::*|0:*) fail "pipeline GitHub SSH uid/gid is invalid"; return 1 ;;
    esac
    [ "$PIPELINE_RUNTIME_UID:$PIPELINE_RUNTIME_GID" = "$expected_uid:$expected_gid" ] \
        && [ "$(/usr/bin/stat -c '%u:%g' "$PIPELINE_ROOT")" \
            = "$expected_uid:$expected_gid" ] \
        || { fail "pipeline GitHub SSH account does not own the pipeline repository"; return 1; }
    [ "$(/usr/bin/readlink -f -- "$PIPELINE_GITHUB_HOME")" \
        = "$PIPELINE_GITHUB_HOME" ] \
        && [ "$(/usr/bin/readlink -f -- "$PIPELINE_GITHUB_HOME/.ssh")" \
            = "$PIPELINE_GITHUB_HOME/.ssh" ] \
        && [ "$(/usr/bin/readlink -f -- "$PIPELINE_GITHUB_IDENTITY")" \
            = "$PIPELINE_GITHUB_IDENTITY" ] \
        || { fail "pipeline GitHub SSH ancestry contains a link"; return 1; }
    [ -d "$PIPELINE_GITHUB_HOME" ] && [ ! -L "$PIPELINE_GITHUB_HOME" ] \
        && [ "$(/usr/bin/stat -c '%u:%g:%a' "$PIPELINE_GITHUB_HOME")" \
            = "$expected_uid:$expected_gid:$expected_home_mode" ] \
        || { fail "pipeline GitHub SSH home metadata is invalid"; return 1; }
    [ -d "$PIPELINE_GITHUB_HOME/.ssh" ] && [ ! -L "$PIPELINE_GITHUB_HOME/.ssh" ] \
        && [ "$(/usr/bin/stat -c '%u:%g:%a' "$PIPELINE_GITHUB_HOME/.ssh")" \
            = "$expected_uid:$expected_gid:700" ] \
        || { fail "pipeline GitHub SSH directory metadata is invalid"; return 1; }
    [ -f "$PIPELINE_GITHUB_IDENTITY" ] && [ ! -L "$PIPELINE_GITHUB_IDENTITY" ] \
        && [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$PIPELINE_GITHUB_IDENTITY")" \
            = "$expected_uid:$expected_gid:600:1" ] \
        || { fail "pipeline GitHub SSH private-key metadata is invalid"; return 1; }
    current_identity=$(capture_pipeline_github_ssh_identity) \
        || { fail "pipeline GitHub SSH private-key identity could not be captured as owner"; return 1; }
    if [ -z "$PIPELINE_GITHUB_SSH_IDENTITY" ]; then
        PIPELINE_GITHUB_SSH_IDENTITY=$current_identity
    else
        [ "$current_identity" = "$PIPELINE_GITHUB_SSH_IDENTITY" ] \
            || { fail "pipeline GitHub SSH private-key identity changed"; return 1; }
    fi
}

validate_github_host_key_file() {
    local expected_owner expected_mode current_identity
    [ -n "$GITHUB_HOST_KEY_FILE_IDENTITY" ] || return 1
    if [ "$TEST_MODE" = "1" ]; then
        expected_owner="$(/usr/bin/id -u):$(/usr/bin/id -g)"
        expected_mode=400
    else
        expected_owner=0:0
        expected_mode=444
    fi
    [ -f "$GITHUB_HOST_KEY_FILE" ] && [ ! -L "$GITHUB_HOST_KEY_FILE" ] \
        && [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$GITHUB_HOST_KEY_FILE")" \
            = "$expected_owner:$expected_mode:1" ] \
        && [ "$(/usr/bin/cat "$GITHUB_HOST_KEY_FILE")" = "$GITHUB_ED25519_HOST_KEY" ] \
        && [ "$(/usr/bin/wc -l < "$GITHUB_HOST_KEY_FILE")" -eq 1 ] || return 1
    current_identity=$(/usr/bin/stat -c '%d:%i' "$GITHUB_HOST_KEY_FILE") || return 1
    [ "$current_identity" = "$GITHUB_HOST_KEY_FILE_IDENTITY" ]
}

prepare_github_host_key_file() {
    local parent mode
    parent=${GITHUB_HOST_KEY_FILE%/*}
    [ -n "$parent" ] || return 1
    if [ "$TEST_MODE" = "1" ]; then
        [ "$parent" = "$STATE_ROOT" ] \
            && [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
    else
        [ "$parent" = /run ] \
            && validate_trusted_system_directory /run \
            && [ "$(/usr/bin/readlink -f -- /run)" = /run ] || return 1
    fi
    [ ! -e "$GITHUB_HOST_KEY_FILE" ] && [ ! -L "$GITHUB_HOST_KEY_FILE" ] \
        || return 1
    if ! (set -C; printf '%s\n' "$GITHUB_ED25519_HOST_KEY" \
        > "$GITHUB_HOST_KEY_FILE") 2>/dev/null; then
        return 1
    fi
    GITHUB_HOST_KEY_FILE_OWNED=true
    if [ "$TEST_MODE" = "1" ]; then
        mode=400
    else
        mode=444
    fi
    /usr/bin/chmod "$mode" "$GITHUB_HOST_KEY_FILE" || return 1
    GITHUB_HOST_KEY_FILE_IDENTITY=$(/usr/bin/stat -c '%d:%i' \
        "$GITHUB_HOST_KEY_FILE") || return 1
    validate_github_host_key_file \
        && durable_sync_path "$GITHUB_HOST_KEY_FILE" \
        && durable_sync_path "$parent"
}

release_github_host_key_file() {
    local parent current_identity expected_owner
    [ "$GITHUB_HOST_KEY_FILE_OWNED" = "true" ] || return 0
    [ -n "$GITHUB_HOST_KEY_FILE_IDENTITY" ] || return 1
    parent=${GITHUB_HOST_KEY_FILE%/*}
    if [ "$TEST_MODE" = "1" ]; then
        [ "$parent" = "$STATE_ROOT" ] || return 1
        expected_owner="$(/usr/bin/id -u):$(/usr/bin/id -g)"
    else
        [ "$parent" = /run ] || return 1
        expected_owner=0:0
    fi
    [ -f "$GITHUB_HOST_KEY_FILE" ] && [ ! -L "$GITHUB_HOST_KEY_FILE" ] \
        && [ "$(/usr/bin/stat -c '%u:%g:%h' "$GITHUB_HOST_KEY_FILE")" \
            = "$expected_owner:1" ] || return 1
    current_identity=$(/usr/bin/stat -c '%d:%i' "$GITHUB_HOST_KEY_FILE") || return 1
    [ "$current_identity" = "$GITHUB_HOST_KEY_FILE_IDENTITY" ] || return 1
    /usr/bin/rm -f -- "$GITHUB_HOST_KEY_FILE" || return 1
    [ ! -e "$GITHUB_HOST_KEY_FILE" ] && [ ! -L "$GITHUB_HOST_KEY_FILE" ] \
        || return 1
    durable_sync_path "$parent" || return 1
    GITHUB_HOST_KEY_FILE_OWNED=false
    GITHUB_HOST_KEY_FILE_IDENTITY=""
}

trusted_git() {
    if [ "$TEST_MODE" = "1" ]; then
        run_bounded_read_command /usr/bin/env -i \
            HOME="${HOME:-/var/empty}" PATH="$PATH" \
            FAKE_STATE="${FAKE_STATE:-}" FAKE_SCENARIO="${FAKE_SCENARIO:-}" \
            GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
            GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 \
            git -c "safe.directory=$ROOT_DIR" -c "safe.directory=$PIPELINE_ROOT" \
            -c protocol.allow=never -c protocol.https.allow=always \
            -c credential.helper= -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
    else
        run_bounded_read_command /usr/bin/env -i \
            HOME=/var/empty PATH=/usr/bin:/bin \
            GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
            GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 \
            /usr/bin/setpriv \
            --reuid="$PIPELINE_RUNTIME_UID" --regid="$PIPELINE_RUNTIME_GID" \
            --clear-groups --no-new-privs \
            --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
            /usr/bin/git -c "safe.directory=$ROOT_DIR" \
            -c "safe.directory=$PIPELINE_ROOT" \
            -c protocol.allow=never -c protocol.https.allow=always \
            -c credential.helper= -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
    fi
}

trusted_pipeline_remote_git() {
    local remote_url="$1" remote_ref="$2" ssh_command remote_status=0
    case "$remote_url:$remote_ref" in
        git@github.com:conei7/diva-data-pipeline.git:refs/heads/main) ;;
        *) return 1 ;;
    esac
    validate_pipeline_github_ssh_identity \
        && validate_github_host_key_file || return 1
    ssh_command="/usr/bin/ssh -F /dev/null -o HostName=github.com -o User=git -o Port=22 -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o IdentityFile=$PIPELINE_GITHUB_IDENTITY -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$GITHUB_HOST_KEY_FILE -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519 -o CheckHostIP=no -o UpdateHostKeys=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PreferredAuthentications=publickey -o ConnectTimeout=20 -o ConnectionAttempts=1 -o ControlMaster=no -o ControlPath=none -o ProxyCommand=none -o ProxyJump=none -o PermitLocalCommand=no -o LogLevel=ERROR"
    if [ "$TEST_MODE" = "1" ]; then
        (
            exec 9<&-
            run_bounded_command 30 /usr/bin/env -i \
                HOME="$PIPELINE_GITHUB_HOME" PATH="$PATH" \
                GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
                GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 \
                GIT_SSH_VARIANT=ssh GIT_SSH_COMMAND="$ssh_command" \
                FAKE_STATE="${FAKE_STATE:-}" FAKE_SCENARIO="${FAKE_SCENARIO:-}" \
                FAKE_GITHUB_HOST_KEY_FILE="$GITHUB_HOST_KEY_FILE" \
                FAKE_PIPELINE_GITHUB_HOME="$PIPELINE_GITHUB_HOME" \
                FAKE_PIPELINE_GITHUB_IDENTITY="$PIPELINE_GITHUB_IDENTITY" \
                "$SETPRIV_COMMAND" \
                --reuid="$PIPELINE_RUNTIME_UID" --regid="$PIPELINE_RUNTIME_GID" \
                --clear-groups --no-new-privs \
                --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
                git -c "safe.directory=$ROOT_DIR" -c "safe.directory=$PIPELINE_ROOT" \
                -c protocol.allow=never -c protocol.ssh.allow=always \
                -c credential.helper= -c core.fsmonitor=false \
                -c core.hooksPath=/dev/null -C / ls-remote --exit-code \
                "$remote_url" "$remote_ref"
        ) || remote_status=$?
    else
        (
            exec 9<&-
            run_bounded_command 30 /usr/bin/env -i \
                HOME="$PIPELINE_GITHUB_HOME" PATH=/usr/bin:/bin \
                GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
                GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 \
                GIT_SSH_VARIANT=ssh GIT_SSH_COMMAND="$ssh_command" \
                /usr/bin/setpriv \
                --reuid="$PIPELINE_RUNTIME_UID" --regid="$PIPELINE_RUNTIME_GID" \
                --clear-groups --no-new-privs \
                --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
                /usr/bin/git -c "safe.directory=$ROOT_DIR" \
                -c "safe.directory=$PIPELINE_ROOT" \
                -c protocol.allow=never -c protocol.ssh.allow=always \
                -c credential.helper= -c core.fsmonitor=false \
                -c core.hooksPath=/dev/null -C / ls-remote --exit-code \
                "$remote_url" "$remote_ref"
        ) || remote_status=$?
    fi
    validate_pipeline_github_ssh_identity \
        && validate_github_host_key_file || return 1
    [ "$remote_status" -eq 0 ]
}

verify_release_repository_provenance() {
    local repository="$1" expected_origin="$2" expected_head="$3" \
        branch fetch_url push_url origin_main live_main expected_live
    branch=$(trusted_git -C "$repository" symbolic-ref --quiet --short HEAD) \
        || return 1
    [ "$branch" = main ] || return 1
    fetch_url=$(trusted_git -C "$repository" remote get-url --all origin) \
        || return 1
    push_url=$(trusted_git -C "$repository" remote get-url --push --all origin) \
        || return 1
    [ "$fetch_url" = "$expected_origin" ] \
        && [ "$push_url" = "$expected_origin" ] || return 1
    origin_main=$(trusted_git -C "$repository" rev-parse --verify \
        'refs/remotes/origin/main^{commit}') || return 1
    [ "$origin_main" = "$expected_head" ] || return 1
    if [ "$repository" = "$PIPELINE_ROOT" ] \
        && [ "$expected_origin" = "$PIPELINE_OFFICIAL_ORIGIN" ]; then
        live_main=$(trusted_pipeline_remote_git "$expected_origin" refs/heads/main) \
            || return 1
    elif [ "$repository" = "$ROOT_DIR" ] \
        && [ "$expected_origin" = "$PLAYER_OFFICIAL_ORIGIN" ]; then
        live_main=$(trusted_git -C / ls-remote --exit-code "$expected_origin" \
            refs/heads/main) || return 1
    else
        return 1
    fi
    expected_live=$(printf '%s\trefs/heads/main' "$expected_head") || return 1
    [ "$live_main" = "$expected_live" ]
}

verify_tracked_runtime_source() {
    local repository="$1" relative_path="$2" revision="${3:-HEAD}" \
        object_type head_sha working_sha
    trusted_git -C "$repository" ls-files --error-unmatch -- "$relative_path" \
        >/dev/null 2>&1 || return 1
    object_type=$(trusted_git -C "$repository" cat-file -t "$revision:$relative_path") \
        || return 1
    [ "$object_type" = "blob" ] || return 1
    head_sha=$(trusted_git -C "$repository" cat-file blob "$revision:$relative_path" \
        | sha256sum | awk '{print $1}') || return 1
    working_sha=$(sha256sum "$repository/$relative_path" | awk '{print $1}') \
        || return 1
    case "$head_sha:$working_sha" in
        *[!0-9a-f:]*|:|*:|*::* ) return 1 ;;
    esac
    [ "${#head_sha}" -eq 64 ] && [ "$head_sha" = "$working_sha" ]
}

verify_release_sources_unchanged() {
    local player_status pipeline_status player_index pipeline_index sparse_setting repository
    [ -n "$PLAYER_RELEASE_COMMIT" ] && [ -n "$PIPELINE_RELEASE_COMMIT" ] || return 1
    [ "$(trusted_git -C "$ROOT_DIR" rev-parse HEAD)" = "$PLAYER_RELEASE_COMMIT" ] \
        || return 1
    [ "$(trusted_git -C "$PIPELINE_ROOT" rev-parse HEAD)" = "$PIPELINE_RELEASE_COMMIT" ] \
        || return 1
    player_status=$(trusted_git -C "$ROOT_DIR" status --porcelain=v1 \
        --untracked-files=all) || return 1
    pipeline_status=$(trusted_git -C "$PIPELINE_ROOT" status --porcelain=v1 \
        --untracked-files=all) || return 1
    [ -z "$player_status" ] && [ -z "$pipeline_status" ] || return 1
    player_index=$(trusted_git -C "$ROOT_DIR" ls-files -v) || return 1
    pipeline_index=$(trusted_git -C "$PIPELINE_ROOT" ls-files -v) || return 1
    printf '%s\n' "$player_index" | awk 'NF && substr($0, 1, 2) != "H " { exit 1 }' \
        || return 1
    printf '%s\n' "$pipeline_index" | awk 'NF && substr($0, 1, 2) != "H " { exit 1 }' \
        || return 1
    for repository in "$ROOT_DIR" "$PIPELINE_ROOT"; do
        sparse_setting=$(trusted_git -C "$repository" config --bool core.sparseCheckout \
            2>/dev/null || printf '%s' false)
        [ "$sparse_setting" != "true" ] || return 1
    done
    trusted_git -C "$ROOT_DIR" diff --quiet --no-ext-diff "$PLAYER_RELEASE_COMMIT" -- \
        backend/qdrant/.dockerignore backend/qdrant/Dockerfile \
        backend/qdrant/audit-contract.sh backend/docker-compose.yml \
        backend/database/.dockerignore backend/database/Dockerfile.pgvector \
        backend/database/Dockerfile.migrate backend/database/schema.sql \
        scripts/harden-sbc-stateful-services.sh scripts/attest-disaster-backup-payloads.py \
        scripts/sbc-qdrant-storage-upgrade.py scripts/wsl-dr-api-bridge-receipt.py \
        scripts/sbc-api-bridge-consumption.py \
        scripts/validate-container-image-scan.py \
        || return 1
    for runtime_source in backend/qdrant/.dockerignore backend/qdrant/Dockerfile \
        backend/qdrant/audit-contract.sh \
        backend/database/.dockerignore backend/database/Dockerfile.pgvector \
        backend/database/Dockerfile.migrate backend/database/schema.sql \
        backend/docker-compose.yml \
        scripts/harden-sbc-stateful-services.sh scripts/attest-disaster-backup-payloads.py \
        scripts/sbc-qdrant-storage-upgrade.py scripts/wsl-dr-api-bridge-receipt.py \
        scripts/sbc-api-bridge-consumption.py \
        scripts/validate-container-image-scan.py; do
        verify_tracked_runtime_source "$ROOT_DIR" "$runtime_source" "$PLAYER_RELEASE_COMMIT" \
            || return 1
    done
    trusted_git -C "$PIPELINE_ROOT" diff --quiet --no-ext-diff \
        "$PIPELINE_RELEASE_COMMIT" -- \
        ml_pipeline/utils/pipeline_lock.py ml_pipeline/utils/runtime_contracts.py \
        ml_pipeline/utils/qdrant_cleanup.py || return 1
    for runtime_source in ml_pipeline/utils/pipeline_lock.py \
        ml_pipeline/utils/runtime_contracts.py ml_pipeline/utils/qdrant_cleanup.py; do
        verify_tracked_runtime_source "$PIPELINE_ROOT" "$runtime_source" \
            "$PIPELINE_RELEASE_COMMIT" || return 1
    done
}

query_container_id() {
    local name="$1" output
    if ! output=$(run_bounded_docker_read container ls -a --no-trunc \
        --filter "name=^/${name}$" --format '{{.ID}}'); then
        return 1
    fi
    case "$output" in
        "") ;;
        *[!0-9a-f]* ) return 1 ;;
        *) [ "${#output}" -eq 64 ] || return 1 ;;
    esac
    printf '%s\n' "$output"
}

query_image_id() {
    local reference="$1" output digest
    if ! output=$(run_bounded_docker_read image inspect --format '{{.Id}}' "$reference" 2>/dev/null); then
        return 1
    fi
    case "$output" in sha256:*) ;; *) return 1 ;; esac
    digest=${output#sha256:}
    case "$digest" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#digest}" -eq 64 ] || return 1
    printf '%s\n' "$output"
}

verify_image_linux_native() {
    local image_id="$1" image_os image_architecture
    image_os=$(run_bounded_docker_read image inspect --format '{{.Os}}' "$image_id") \
        || return 1
    image_architecture=$(run_bounded_docker_read image inspect --format \
        '{{.Architecture}}' "$image_id") || return 1
    [ "$image_os" = linux ] || return 1
    if [ "$TEST_MODE" = "1" ]; then
        case "$image_architecture" in amd64|arm64) ;; *) return 1 ;; esac
    else
        [ "$image_architecture" = arm64 ] || return 1
    fi
}

query_optional_image_id() {
    local reference="$1" output digest
    if ! output=$(run_bounded_docker_read image ls --no-trunc \
        --filter "reference=$reference" --format '{{.ID}}'); then
        return 1
    fi
    set -- $output
    if [ "$#" -eq 0 ]; then
        printf '%s\n' absent
        return 0
    fi
    [ "$#" -eq 1 ] || return 1
    case "$1" in sha256:*) ;; *) return 1 ;; esac
    digest=${1#sha256:}
    case "$digest" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#digest}" -eq 64 ] || return 1
    printf '%s\n' "$1"
}

container_compose_label() {
    local container="$1" label="$2" output
    output=$(run_bounded_docker_read inspect --format \
        "{{index .Config.Labels \"$label\"}}" "$container") || return 1
    case "$output" in ''|*[!a-zA-Z0-9_.-]*) return 1 ;; esac
    printf '%s\n' "$output"
}

container_named_volume() {
    local container="$1" destination="$2" output
    case "$destination" in
        /qdrant/storage)
            output=$(run_bounded_docker_read inspect --format \
                '{{range .Mounts}}{{if eq .Destination "/qdrant/storage"}}{{println .Name}}{{end}}{{end}}' \
                "$container") || return 1
            ;;
        /var/lib/postgresql/data)
            output=$(run_bounded_docker_read inspect --format \
                '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{println .Name}}{{end}}{{end}}' \
                "$container") || return 1
            ;;
        *) return 1 ;;
    esac
    set -- $output
    [ "$#" -eq 1 ] || return 1
    case "$1" in ''|*[!a-zA-Z0-9_.-]*) return 1 ;; esac
    printf '%s\n' "$1"
}

container_single_network() {
    local container="$1" output
    output=$(run_bounded_docker_read inspect --format \
        '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
        "$container") || return 1
    set -- $output
    [ "$#" -eq 1 ] || return 1
    case "$1" in ''|*[!a-zA-Z0-9_.-]*) return 1 ;; esac
    printf '%s\n' "$1"
}

query_network_id() {
    local network="$1" output
    output=$(run_bounded_docker_read network inspect --format '{{.Id}}' "$network") || return 1
    case "$output" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#output}" -eq 64 ] || return 1
    printf '%s\n' "$output"
}

verify_named_volume() {
    local volume="$1" output
    output=$(run_bounded_docker_read volume inspect --format '{{.Name}}' "$volume") || return 1
    [ "$output" = "$volume" ]
}

verify_compose_resource_identity() {
    local container="$1" project="$2" service="$3" volume="$4" \
        destination="$5" network="$6" actual aliases alias_found=false
    actual=$(container_compose_label "$container" com.docker.compose.project) || return 1
    [ "$actual" = "$project" ] || return 1
    actual=$(container_compose_label "$container" com.docker.compose.service) || return 1
    [ "$actual" = "$service" ] || return 1
    actual=$(container_named_volume "$container" "$destination") || return 1
    [ "$actual" = "$volume" ] || return 1
    actual=$(container_single_network "$container") || return 1
    [ "$actual" = "$network" ] || return 1
    aliases=$(run_bounded_docker_read inspect --format \
        '{{range .NetworkSettings.Networks}}{{range .Aliases}}{{println .}}{{end}}{{end}}' \
        "$container") || return 1
    for actual in $aliases; do
        [ "$actual" = "$service" ] && alias_found=true
    done
    [ "$alias_found" = "true" ]
}

verify_container_restart_policy() {
    local container="$1" expected="$2" actual
    case "$expected" in no|unless-stopped) ;; *) return 1 ;; esac
    actual=$(run_bounded_docker_read inspect --format \
        '{{.HostConfig.RestartPolicy.Name}}' "$container") || return 1
    [ "$actual" = "$expected" ]
}

verify_loopback_port_bindings() {
    local bindings="$1"
    shift
    run_bounded_read_command "$PYTHON_COMMAND" -I -B - verify-port-bindings "$bindings" "$@" <<'PY'
import json
import sys

marker, raw, *ports = sys.argv[1:]
if marker != "verify-port-bindings" or not ports:
    raise RuntimeError("invalid port-binding verifier invocation")
bindings = json.loads(raw)
expected = {f"{port}/tcp" for port in ports}
if not isinstance(bindings, dict) or set(bindings) != expected:
    raise RuntimeError("unexpected published port set")
for port in ports:
    rows = bindings[f"{port}/tcp"]
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise RuntimeError("published port is ambiguous")
    if rows[0] != {"HostIp": "127.0.0.1", "HostPort": port}:
        raise RuntimeError("published port is not exact loopback binding")
PY
}

run_guarded_docker_mutation() {
    local timeout_seconds="$1" kill_after="$2" mutation_status=0
    shift 2
    if [ "$DAEMON_READ_UNRESOLVED" = "true" ] \
        || [ -f "$DAEMON_READ_UNRESOLVED_FILE" ]; then
        if [ "$ACTIVE_JOURNAL_CREATED" = "true" ]; then
            record_state daemon.mutation_blocked prior-read-unresolved
        fi
        return 125
    fi
    DAEMON_MUTATION_IN_FLIGHT=true
    "$TIMEOUT_COMMAND" --signal=TERM --kill-after="$kill_after" \
        "$timeout_seconds" "$DOCKER_COMMAND" "$@" || mutation_status=$?
    if [ "$mutation_status" -ne 0 ]; then
        DAEMON_MUTATION_UNRESOLVED=true
        if [ "$ACTIVE_JOURNAL_CREATED" = "true" ]; then
            record_state daemon.mutation_uncertain_exit "$mutation_status"
        fi
        DAEMON_MUTATION_IN_FLIGHT=false
        return "$mutation_status"
    fi
    DAEMON_MUTATION_IN_FLIGHT=false
}

run_bounded_docker_mutation() {
    run_guarded_docker_mutation "$MUTATION_TIMEOUT_SECONDS" 10 "$@"
}

run_bounded_docker_with_timeout() {
    local timeout_seconds="$1"
    shift
    run_guarded_docker_mutation "$timeout_seconds" 30 "$@"
}

run_bounded_candidate_compose_mutation() {
    run_guarded_docker_mutation "$MUTATION_TIMEOUT_SECONDS" 10 \
        compose --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
        --project-name "$CANDIDATE_PROJECT" -f "$COMPOSE_FILE" \
        -f "$CANDIDATE_OVERRIDE" "$@"
}

run_bounded_original_compose_mutation() {
    run_guarded_docker_mutation "$MUTATION_TIMEOUT_SECONDS" 10 \
        compose --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
        --project-name "$ORIGINAL_PROJECT" -f "$COMPOSE_FILE" "$@"
}

run_bounded_original_candidate_qdrant_compose_mutation() {
    [ -n "$QDRANT_CANDIDATE_VOLUME" ] || return 1
    DIVA_QDRANT_VOLUME="$QDRANT_CANDIDATE_VOLUME" \
    run_guarded_docker_mutation "$MUTATION_TIMEOUT_SECONDS" 10 \
        compose --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
        --project-name "$ORIGINAL_PROJECT" -f "$COMPOSE_FILE" "$@"
}

run_bounded_data_mutation() {
    run_guarded_docker_mutation "$DATA_MUTATION_TIMEOUT_SECONDS" 30 "$@"
}

verify_backend_env_metadata() {
    local path="${1:-$BACKEND_ENV_FILE}"
    [ -n "$BACKEND_ENV_OWNER_UID" ] && [ -n "$BACKEND_ENV_OWNER_GID" ] \
        && [ -f "$path" ] && [ ! -L "$path" ] \
        && [ "$(stat -c '%u:%g:%a:%h' "$path")" \
            = "$BACKEND_ENV_OWNER_UID:$BACKEND_ENV_OWNER_GID:600:1" ]
}

write_backend_qdrant_volume_binding() {
    local expected_current="$1" next_volume="$2"
    [ "$BACKEND_ENV_MUTATED" = "false" ] || return 1
    verify_backend_env_metadata || return 1
    [ ! -e "$BACKEND_ENV_BACKUP" ] && [ ! -L "$BACKEND_ENV_BACKUP" ] || return 1
    BACKEND_ENV_BACKUP_OWNED=true
    cp --preserve=mode,ownership,timestamps -- "$BACKEND_ENV_FILE" "$BACKEND_ENV_BACKUP" \
        || return 1
    chmod 600 "$BACKEND_ENV_BACKUP" || return 1
    verify_backend_env_metadata "$BACKEND_ENV_BACKUP" || return 1
    durable_sync_path "$BACKEND_ENV_BACKUP" || return 1
    record_state qdrant.compose_volume_binding intent-before-env-replace
    # Arm recovery before entering the replace operation.  The helper can fail
    # after os.replace() (for example while syncing the parent directory), so
    # setting this only after it returned would lose the rollback boundary.
    BACKEND_ENV_MUTATED=true
    "$PYTHON_COMMAND" -I -B - "$BACKEND_ENV_FILE" "$expected_current" "$next_volume" \
        "$BACKEND_ENV_OWNER_UID" "$BACKEND_ENV_OWNER_GID" <<'PY' \
        || return 1
import os
import re
import stat
import sys

path, expected, replacement, expected_uid_text, expected_gid_text = sys.argv[1:]
expected_uid = int(expected_uid_text)
expected_gid = int(expected_gid_text)
if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", replacement) is None:
    raise SystemExit(2)
info = os.lstat(path)
windows_contract_test = (
    os.name == "nt" and os.environ.get("DIVA_STATEFUL_TEST_MODE") == "1"
)
if (
    not stat.S_ISREG(info.st_mode)
    or info.st_nlink != 1
    or (not windows_contract_test and stat.S_IMODE(info.st_mode) != 0o600)
    or (not windows_contract_test and (info.st_uid, info.st_gid) != (expected_uid, expected_gid))
):
    raise SystemExit(3)
with open(path, "rb") as handle:
    payload = handle.read(1024 * 1024 + 1)
if len(payload) > 1024 * 1024 or b"\0" in payload or b"\r" in payload:
    raise SystemExit(4)
lines = payload.decode("utf-8").splitlines()
matches = [index for index, line in enumerate(lines) if line.startswith("DIVA_QDRANT_VOLUME=")]
if len(matches) > 1:
    raise SystemExit(5)
current = "backend_qdrant_data" if not matches else lines[matches[0]].split("=", 1)[1]
if current != expected:
    raise SystemExit(6)
new_line = "DIVA_QDRANT_VOLUME=" + replacement
if matches:
    lines[matches[0]] = new_line
else:
    lines.append(new_line)
encoded = ("\n".join(lines) + "\n").encode("utf-8")
temporary = path + ".qdrant-volume.tmp"
flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
         | getattr(os, "O_BINARY", 0))
descriptor = os.open(temporary, flags, 0o600)
try:
    if not windows_contract_test:
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, expected_uid, expected_gid)
    with os.fdopen(descriptor, "wb", closefd=False) as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
finally:
    os.close(descriptor)
os.replace(temporary, path)
os.chmod(path, 0o600)
replaced = os.lstat(path)
if (
    not stat.S_ISREG(replaced.st_mode)
    or replaced.st_nlink != 1
    or (not windows_contract_test and stat.S_IMODE(replaced.st_mode) != 0o600)
    or (
        not windows_contract_test
        and (replaced.st_uid, replaced.st_gid) != (expected_uid, expected_gid)
    )
):
    raise RuntimeError("backend environment ownership contract changed after replacement")
try:
    directory = os.open(
        os.path.dirname(path), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    )
except PermissionError:
    # Windows does not expose a durable directory fsync primitive.  Production
    # runs on POSIX and remain fail-closed if the parent cannot be opened.
    if os.name != "nt":
        raise
else:
    try:
        os.fsync(directory)
    except PermissionError:
        if os.name != "nt":
            raise
    finally:
        os.close(directory)
PY
    verify_backend_env_metadata || return 1
    verify_backend_qdrant_volume_binding "$next_volume" || return 1
    record_state qdrant.compose_volume_binding "$next_volume"
}

verify_backend_qdrant_volume_binding() {
    local expected="$1"
    verify_backend_env_metadata || return 1
    "$PYTHON_COMMAND" -I -B - "$BACKEND_ENV_FILE" "$expected" \
        "$BACKEND_ENV_OWNER_UID" "$BACKEND_ENV_OWNER_GID" <<'PY' || return 1
import os
import stat
import sys
path, expected, expected_uid_text, expected_gid_text = sys.argv[1:]
expected_uid = int(expected_uid_text)
expected_gid = int(expected_gid_text)
info = os.lstat(path)
windows_contract_test = (
    os.name == "nt" and os.environ.get("DIVA_STATEFUL_TEST_MODE") == "1"
)
if (
    not stat.S_ISREG(info.st_mode)
    or info.st_nlink != 1
    or (not windows_contract_test and stat.S_IMODE(info.st_mode) != 0o600)
    or (
        not windows_contract_test
        and (info.st_uid, info.st_gid) != (expected_uid, expected_gid)
    )
):
    raise SystemExit(2)
values = []
with open(path, encoding="utf-8") as handle:
    for raw in handle:
        if raw.startswith("DIVA_QDRANT_VOLUME="):
            values.append(raw.rstrip("\n").split("=", 1)[1])
if values != [expected]:
    raise SystemExit(3)
PY
}

restore_backend_qdrant_volume_binding() {
    [ "$BACKEND_ENV_MUTATED" = "true" ] || return 0
    verify_backend_env_metadata "$BACKEND_ENV_BACKUP" || return 1
    record_state qdrant.compose_volume_binding restore-intent
    cp --preserve=mode,ownership,timestamps -- "$BACKEND_ENV_BACKUP" \
        "$BACKEND_ENV_FILE.restore.tmp" || return 1
    chmod 600 "$BACKEND_ENV_FILE.restore.tmp" || return 1
    verify_backend_env_metadata "$BACKEND_ENV_FILE.restore.tmp" || return 1
    durable_sync_path "$BACKEND_ENV_FILE.restore.tmp" || return 1
    mv -f -- "$BACKEND_ENV_FILE.restore.tmp" "$BACKEND_ENV_FILE" || return 1
    durable_sync_path "$(dirname "$BACKEND_ENV_FILE")" || return 1
    verify_backend_env_metadata || return 1
    BACKEND_ENV_MUTATED=false
    record_state qdrant.compose_volume_binding restored
    discard_backend_env_backup || return 1
}

wait_container_mapping() {
    local name="$1" expected="$2" attempts=0 stable=0 actual
    while [ "$attempts" -lt "$HEALTH_ATTEMPTS" ]; do
        if actual=$(query_container_id "$name") && [ "$actual" = "$expected" ]; then
            stable=$((stable + 1))
            [ "$stable" -ge 2 ] && return 0
        else
            stable=0
        fi
        attempts=$((attempts + 1))
        "$SLEEP_COMMAND" "$WAIT_SECONDS"
    done
    return 1
}

wait_container_running_id() {
    local id="$1" expected="$2" attempts=0 stable=0 actual
    while [ "$attempts" -lt "$HEALTH_ATTEMPTS" ]; do
        if actual=$(run_bounded_docker_read inspect --format '{{.State.Running}}' "$id" 2>/dev/null) \
            && [ "$actual" = "$expected" ]; then
            stable=$((stable + 1))
            [ "$stable" -ge 2 ] && return 0
        else
            stable=0
        fi
        attempts=$((attempts + 1))
        "$SLEEP_COMMAND" "$WAIT_SECONDS"
    done
    return 1
}

container_runtime_snapshot() {
    local name="$1" id runtime
    id=$(query_container_id "$name") || return 1
    if [ -z "$id" ]; then
        printf '%s\n' absent
        return 0
    fi
    runtime=$(run_bounded_docker_read inspect --format \
        '{{.Id}}|{{.Image}}|{{.Name}}|{{.State.Status}}|{{.State.Running}}|{{.State.Restarting}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{.RestartCount}}|{{json .HostConfig.PortBindings}}|{{json .Mounts}}' \
        "$id" 2>/dev/null) || return 1
    printf '%s\n' "$runtime"
}

wait_stateful_daemon_stable() {
    local attempts=0 stable=0 previous="" current name snapshot
    while [ "$attempts" -lt "$DAEMON_SETTLE_ATTEMPTS" ]; do
        current=""
        for name in "$QDRANT_CONTAINER" "$QDRANT_PREVIOUS_CONTAINER" \
            "$POSTGRES_CONTAINER" "$POSTGRES_PREVIOUS_CONTAINER"; do
            snapshot=$(container_runtime_snapshot "$name") || return 1
            current="${current}${name}=${snapshot};"
        done
        if [ "$current" = "$previous" ]; then
            stable=$((stable + 1))
            [ "$stable" -ge "$DAEMON_STABLE_SAMPLES" ] && return 0
        else
            previous="$current"
            stable=1
        fi
        attempts=$((attempts + 1))
        "$SLEEP_COMMAND" "$WAIT_SECONDS"
    done
    return 1
}

wait_qdrant_controller_daemon_stable() {
    local attempts=0 stable=0 previous="" current name snapshot
    while [ "$attempts" -lt "$DAEMON_SETTLE_ATTEMPTS" ]; do
        current=""
        for name in "$QDRANT_CONTAINER" "$QDRANT_FINAL_UPGRADE_CONTAINER"; do
            snapshot=$(container_runtime_snapshot "$name") || return 1
            current="${current}${name}=${snapshot};"
        done
        if [ "$current" = "$previous" ]; then
            stable=$((stable + 1))
            [ "$stable" -ge "$DAEMON_STABLE_SAMPLES" ] && return 0
        else
            previous="$current"
            stable=1
        fi
        attempts=$((attempts + 1))
        "$SLEEP_COMMAND" "$WAIT_SECONDS"
    done
    return 1
}

validate_backup_evidence() {
    local job="$1" run_id="$2" status_file="$3" status_sha="$4" \
        manifest_file="$5" manifest_sha="$6" max_age_hours="$7" \
        expected_host="$8" actual
    for evidence_file in "$status_file" "$manifest_file"; do
        [ -f "$evidence_file" ] && [ ! -L "$evidence_file" ] || return 1
    done
    case "$status_sha:$manifest_sha" in
        *[!0-9a-f:]*|:|*:|*::* ) return 1 ;;
    esac
    [ "${#status_sha}" -eq 64 ] && [ "${#manifest_sha}" -eq 64 ] || return 1
    actual=$(sha256sum "$status_file" | awk '{print $1}') || return 1
    [ "$actual" = "$status_sha" ] || return 1
    actual=$(sha256sum "$manifest_file" | awk '{print $1}') || return 1
    [ "$actual" = "$manifest_sha" ] || return 1
    run_bounded_read_command "$PYTHON_COMMAND" -I -B - "$job" "$run_id" "$status_file" "$status_sha" \
        "$manifest_file" "$manifest_sha" "$max_age_hours" "$expected_host" <<'PY'
import datetime as dt
import hashlib
import json
import os
import re
import sys

(
    job, run_id, status_path, expected_status_sha,
    manifest_path, expected_manifest_sha, max_age_hours, expected_host,
) = sys.argv[1:]
with open(status_path, "rb") as handle:
    status_bytes = handle.read()
with open(manifest_path, "rb") as handle:
    manifest_bytes = handle.read()
if hashlib.sha256(status_bytes).hexdigest() != expected_status_sha:
    raise RuntimeError("status evidence changed after its shell digest check")
if hashlib.sha256(manifest_bytes).hexdigest() != expected_manifest_sha:
    raise RuntimeError("manifest evidence changed after its shell digest check")
status = json.loads(status_bytes)
manifest = json.loads(manifest_bytes)

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

require(status.get("schemaVersion") == 1, "unsupported backup status schema")
require(manifest.get("schemaVersion") == 1, "unsupported backup manifest schema")
require(status.get("job") == job, "backup job mismatch")
require(status.get("runId") == run_id, "backup execution run ID mismatch")
require(status.get("status") == "success" and status.get("exitCode") == 0,
        "backup execution was not successful")
require(status.get("remoteCleanup") == "confirmed", "remote cleanup was not confirmed")
finished_at = status.get("finishedAt")
created_at = manifest.get("createdAt")
completed_at = manifest.get("completedAt")
require(finished_at and created_at and completed_at, "backup timestamps are missing")
finished = dt.datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
created = dt.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
completed = dt.datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
require(finished.tzinfo is not None and created.tzinfo is not None
        and completed.tzinfo is not None, "backup timestamp has no timezone")
finished = finished.astimezone(dt.timezone.utc)
created = created.astimezone(dt.timezone.utc)
completed = completed.astimezone(dt.timezone.utc)
now = dt.datetime.now(dt.timezone.utc)
if os.environ.get("DIVA_STATEFUL_TEST_MODE") == "1":
    offset_text = os.environ.get("DIVA_STATEFUL_TEST_BACKUP_CLOCK_SKEW_HOURS", "0")
    require(re.fullmatch(r"[0-9]{1,4}", offset_text) is not None,
            "invalid deterministic backup clock skew")
    now += dt.timedelta(hours=int(offset_text))
finished_age = (now - finished).total_seconds()
created_age = (now - created).total_seconds()
completed_age = (now - completed).total_seconds()
require(finished_age >= -900 and created_age >= -900 and completed_age >= -900,
        "backup timestamp is too far in the future")
require(finished_age <= float(max_age_hours) * 3600
        and created_age <= float(max_age_hours) * 3600
        and completed_age <= float(max_age_hours) * 3600,
        "backup evidence is stale")
require(created <= completed <= finished + dt.timedelta(seconds=900),
        "backup timestamp ordering is invalid")
require(status.get("manifestSha256") == hashlib.sha256(manifest_bytes).hexdigest(),
        "manifest digest is not bound to status")
require(status.get("source") == manifest.get("source"), "backup source provenance mismatch")
require(status.get("publication") == manifest.get("publication"),
        "backup publication fingerprint mismatch")
source = manifest.get("source") or {}
require(source.get("host") == expected_host, "backup source host mismatch")
for field in ("pipelineCommit", "playerCommit"):
    require(re.fullmatch(r"[0-9a-f]{40}", str(source.get(field, ""))) is not None,
            f"invalid source {field}")
require(manifest.get("status") == "complete", "backup manifest is incomplete")
manifest_run_id = str(manifest.get("runId") or "")
expected_run_prefix = "postgres" if job == "postgres_disaster_backup" else "qdrant"
require(re.fullmatch(expected_run_prefix + r"-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", manifest_run_id)
        is not None, "backup export run ID is invalid")
backup_path = status.get("backupPath") or ""
require(os.path.basename(backup_path.replace("\\", "/")) == manifest_run_id,
        "status path is not bound to manifest run ID")
publication = manifest.get("publication")
require(isinstance(publication, dict), "backup publication is missing")
generation = publication.get("generation")
require(isinstance(generation, str), "publication generation is invalid")
required_aliases = {
    "song_hybrid_active",
    "song_metadata_active",
    "songs_v2_active",
}

aliases = publication.get("aliases")
require(isinstance(aliases, dict) and required_aliases <= set(aliases),
        "publication aliases are incomplete")
if job == "qdrant_disaster_backup":
    require(set(aliases) == required_aliases, "Qdrant publication aliases are ambiguous")
projected_aliases = {name: aliases.get(name) for name in sorted(required_aliases)}
require(all(isinstance(value, str) and value for value in projected_aliases.values())
        and len(set(projected_aliases.values())) == 3
        and "song_audio" not in projected_aliases.values(),
        "publication alias targets are invalid")
if generation == "legacy":
    expected_aliases = {
        "song_hybrid_active": "song_hybrid",
        "song_metadata_active": "song_metadata",
        "songs_v2_active": "songs_v2",
    }
else:
    require(re.fullmatch(r"[0-9a-f]{64}:[0-9a-f]{32}", generation) is not None,
            "publication generation format is invalid")
    basis, build = generation.split(":", 1)
    suffix = f"{basis[:12]}_{build[:8]}"
    expected_aliases = {
        "song_hybrid_active": f"song_hybrid_basis_{suffix}",
        "song_metadata_active": f"song_metadata_basis_{suffix}",
        "songs_v2_active": f"songs_v2_basis_{suffix}",
    }
require(projected_aliases == expected_aliases,
        "publication aliases do not match the declared generation")
collections = publication.get("collections")
require(isinstance(collections, list)
        and all(isinstance(value, str) and value for value in collections)
        and len(collections) == len(set(collections)),
        "publication collection inventory is invalid")
active_collections = {"song_audio", *projected_aliases.values()}
require(active_collections <= set(collections),
        "publication is missing an active collection")
if job == "qdrant_disaster_backup":
    require(set(collections) == active_collections,
            "Qdrant publication has a non-active collection")
    require(publication.get("qdrantVersion") == "1.9.4",
            "Qdrant backup runtime version is incompatible")
publication_projection = {
    "generation": generation,
    "aliases": projected_aliases,
    "collections": sorted(active_collections),
}
validation = manifest.get("validation") or {}
require(validation.get("generationStable") is True
        and validation.get("qdrantReferenceStable") is True,
        "backup publication validation is incomplete")

if job == "postgres_disaster_backup":
    database = manifest.get("database") or {}
    require(validation.get("pgRestoreList") == "success", "pg_restore listing was not verified")
    require(database.get("file") == "postgres.dump", "PostgreSQL dump filename is invalid")
    require(re.fullmatch(r"[0-9a-f]{64}", str(database.get("sha256", ""))) is not None,
            "PostgreSQL dump digest is invalid")
    require(isinstance(database.get("sizeBytes"), int) and database["sizeBytes"] > 0,
            "PostgreSQL dump size is invalid")
    require(status.get("dumpSha256") == database.get("sha256"), "PostgreSQL dump digest mismatch")
    require(status.get("dumpSizeBytes") == database.get("sizeBytes"), "PostgreSQL dump size mismatch")
elif job == "qdrant_disaster_backup":
    snapshots = manifest.get("snapshots") or []
    expected_files = {
        "song_audio.snapshot",
        "song_hybrid.snapshot",
        "song_metadata.snapshot",
        "songs_v2.snapshot",
    }
    expected_file_collections = {
        "song_audio.snapshot": "song_audio",
        "song_hybrid.snapshot": projected_aliases["song_hybrid_active"],
        "song_metadata.snapshot": projected_aliases["song_metadata_active"],
        "songs_v2.snapshot": projected_aliases["songs_v2_active"],
    }
    expected_collections = set(expected_file_collections.values())
    require(validation.get("collectionStatesStable") is True
            and validation.get("sourceChecksumsVerified") is True,
            "Qdrant snapshot validation is incomplete")
    require(isinstance(validation.get("adoptedExistingExport"), bool),
            "Qdrant adoption provenance is missing")
    require(isinstance(snapshots, list) and len(snapshots) == 4,
            "Qdrant backup must contain exactly four snapshots")
    require(all(isinstance(item, dict) for item in snapshots),
            "Qdrant snapshot record is invalid")
    require({item.get("file") for item in snapshots} == expected_files,
            "Qdrant snapshot filenames are invalid")
    require(all(item.get("collection") == expected_file_collections.get(item.get("file"))
                for item in snapshots), "Qdrant snapshot collections are invalid")
    require(all(isinstance(item.get("sizeBytes"), int) and item["sizeBytes"] > 0
                for item in snapshots), "Qdrant snapshot size is invalid")
    require(status.get("collectionStates") == manifest.get("collectionStates"),
            "Qdrant collection state mismatch")
    require(isinstance(manifest.get("collectionStates"), dict)
            and set(manifest["collectionStates"]) == expected_collections,
            "Qdrant collection state set is invalid")
    require(all(isinstance(value, dict) and value.get("status") == "green"
                for value in manifest["collectionStates"].values()),
            "Qdrant collection state is not healthy")
    require(all(isinstance(value.get("pointsCount"), int)
                and not isinstance(value.get("pointsCount"), bool)
                and value["pointsCount"] > 0
                for value in manifest["collectionStates"].values()),
            "Qdrant collection state has no usable points")
    require(status.get("snapshotCount") == len(snapshots), "Qdrant snapshot count mismatch")
    require(status.get("totalSizeBytes") == sum(item.get("sizeBytes", -1) for item in snapshots),
            "Qdrant snapshot total size mismatch")
    require(status.get("totalSizeBytes", 0) > 0, "Qdrant snapshot total size is invalid")
    require(all(re.fullmatch(r"[0-9a-f]{64}", str(item.get("sha256", "")))
                for item in snapshots), "invalid Qdrant snapshot digest")
else:
    raise RuntimeError("unsupported backup evidence job")
publication_bytes = json.dumps(
    publication_projection, sort_keys=True, separators=(",", ":"), ensure_ascii=True
).encode("utf-8")
print(hashlib.sha256(publication_bytes).hexdigest())
PY
}

validate_backup_payload_attestation() {
    local attestation_file="$1" attestation_sha="$2" challenge="$3" \
        expected_host="$4" postgres_status="$5" postgres_manifest="$6" \
        qdrant_status="$7" qdrant_manifest="$8" \
        expected_postgres_status_sha="$9" expected_postgres_manifest_sha="${10}" \
        expected_qdrant_status_sha="${11}" expected_qdrant_manifest_sha="${12}" \
        expected_postgres_run="${13}" expected_qdrant_run="${14}" \
        bridge_receipt_created_at="${15}" actual verifier_sha
    [ -f "$attestation_file" ] && [ ! -L "$attestation_file" ] || return 1
    [ "$(stat -c '%a' "$attestation_file")" = "600" ] || return 1
    case "$attestation_sha:$challenge" in
        *[!0-9a-f:]*|:|*:|*::* ) return 1 ;;
    esac
    [ "${#attestation_sha}" -eq 64 ] && [ "${#challenge}" -eq 64 ] || return 1
    case "$expected_postgres_status_sha:$expected_postgres_manifest_sha:$expected_qdrant_status_sha:$expected_qdrant_manifest_sha" in
        *[!0-9a-f:]*|:*|*:|*::* ) return 1 ;;
    esac
    for expected_evidence_sha in "$expected_postgres_status_sha" \
        "$expected_postgres_manifest_sha" "$expected_qdrant_status_sha" \
        "$expected_qdrant_manifest_sha"; do
        [ "${#expected_evidence_sha}" -eq 64 ] || return 1
    done
    actual=$(sha256sum "$attestation_file" | awk '{print $1}') || return 1
    [ "$actual" = "$attestation_sha" ] || return 1
    verifier_sha=$EXPECTED_BACKUP_ATTESTER_SHA
    case "$verifier_sha" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#verifier_sha}" -eq 64 ] || return 1
    run_bounded_read_command "$PYTHON_COMMAND" -I -B - "$attestation_file" "$attestation_sha" \
        "$challenge" "$expected_host" "$verifier_sha" \
        "$postgres_status" "$postgres_manifest" \
        "$qdrant_status" "$qdrant_manifest" \
        "$expected_postgres_status_sha" "$expected_postgres_manifest_sha" \
        "$expected_qdrant_status_sha" "$expected_qdrant_manifest_sha" \
        "$expected_postgres_run" "$expected_qdrant_run" \
        "$bridge_receipt_created_at" "$BRIDGE_BACKUP_MAX_ELAPSED_SECONDS" <<'PY'
import datetime as dt
import hashlib
import json
import re
import sys

(
    attestation_path, expected_attestation_sha, challenge, expected_host, verifier_sha,
    postgres_status_path, postgres_manifest_path,
    qdrant_status_path, qdrant_manifest_path,
    expected_postgres_status_sha, expected_postgres_manifest_sha,
    expected_qdrant_status_sha, expected_qdrant_manifest_sha,
    expected_postgres_run, expected_qdrant_run, bridge_receipt_created_at,
    bridge_backup_max_elapsed_seconds,
) = sys.argv[1:]

def load(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def valid_security_binding(value):
    return (
        isinstance(value, dict)
        and set(value) == {"identitySha256", "securityStateSha256"}
        and all(re.fullmatch(r"[0-9a-f]{64}", str(item or "")) for item in value.values())
    )

attestation, parsed_attestation_sha = load(attestation_path)
require(parsed_attestation_sha == expected_attestation_sha,
        "backup attestation changed after its shell digest check")
require(attestation.get("schemaVersion") == 1, "unsupported backup attestation schema")
require(attestation.get("challenge") == challenge, "backup attestation challenge mismatch")
require(attestation.get("verifierHost") == expected_host, "backup attestation host mismatch")
require(attestation.get("verifierSha256") == verifier_sha,
        "backup attestation verifier mismatch")
require(attestation.get("allowedWriterSids") == [],
        "backup attestation used an unexpected additional writer identity")
require(valid_security_binding(attestation.get("verifierSecurityBinding")),
        "backup attestation verifier security binding is invalid")
verified_at = dt.datetime.fromisoformat(
    str(attestation.get("verifiedAt") or "").replace("Z", "+00:00")
)
require(verified_at.tzinfo is not None, "backup attestation timestamp has no timezone")
receipt_created_at = dt.datetime.fromisoformat(
    str(bridge_receipt_created_at or "").replace("Z", "+00:00")
)
require(receipt_created_at.tzinfo is not None,
        "API bridge receipt timestamp has no timezone")
# The canonical receipt is independently required to remain inside its fixed
# 24-hour window. Its trusted producer admits a fresh attestation first, then
# enforces this fixed four-hour deployment window with CLOCK_BOOTTIME. Bind the
# same exact attestation to that immutable commit point without reimposing the
# shorter initial-admission window after long local builds and scans.
attestation_offset = (
    receipt_created_at.astimezone(dt.timezone.utc)
    - verified_at.astimezone(dt.timezone.utc)
).total_seconds()
maximum_attestation_offset = int(bridge_backup_max_elapsed_seconds)
require(maximum_attestation_offset > 0,
        "API bridge backup lifetime bound is invalid")
require(-300 <= attestation_offset < maximum_attestation_offset,
        "backup payload attestation is not anchored to the API bridge receipt")

inputs = {
    "postgres": (
        postgres_status_path, postgres_manifest_path,
        expected_postgres_status_sha, expected_postgres_manifest_sha,
        expected_postgres_run,
    ),
    "qdrant": (
        qdrant_status_path, qdrant_manifest_path,
        expected_qdrant_status_sha, expected_qdrant_manifest_sha,
        expected_qdrant_run,
    ),
}
backups = attestation.get("backups")
require(isinstance(backups, dict) and set(backups) == set(inputs),
        "backup attestation set is not exact")
for kind, (
    status_path, manifest_path, expected_status_sha, expected_manifest_sha,
    expected_execution_run,
) in inputs.items():
    status, status_sha = load(status_path)
    manifest, manifest_sha = load(manifest_path)
    require(status_sha == expected_status_sha and manifest_sha == expected_manifest_sha,
            f"{kind} evidence changed between validation stages")
    require(status.get("runId") == expected_execution_run,
            f"{kind} execution run changed between validation stages")
    record = backups.get(kind)
    require(isinstance(record, dict), f"{kind} attestation is missing")
    require(record.get("payloadBytesRehashed") is True
            and record.get("directoryInventoryStable") is True,
            f"{kind} payloads were not freshly rehashed")
    require(record.get("executionRunId") == status.get("runId")
            and record.get("exportRunId") == manifest.get("runId"),
            f"{kind} attestation run IDs are not bound")
    require(record.get("statusSha256") == status_sha
            and record.get("manifestSha256") == manifest_sha,
            f"{kind} attestation evidence digests are not bound")
    if kind == "postgres":
        database = manifest.get("database") or {}
        expected = [{
            "file": database.get("file"),
            "sha256": database.get("sha256"),
            "sizeBytes": database.get("sizeBytes"),
        }]
    else:
        expected = [{
            "file": item.get("file"),
            "sha256": item.get("sha256"),
            "sizeBytes": item.get("sizeBytes"),
        } for item in manifest.get("snapshots") or []]
    expected.sort(key=lambda item: str(item.get("file")))
    require(record.get("payloads") == expected,
            f"{kind} attestation payload set does not match the manifest")
    security = record.get("securityBindings")
    require(isinstance(security, dict)
            and set(security) == {"allowedRoot", "export", "status", "manifest", "payloads"},
            f"{kind} attestation security binding set is invalid")
    require(all(valid_security_binding(security.get(name))
                for name in ("allowedRoot", "export", "status", "manifest")),
            f"{kind} attestation directory/evidence security binding is invalid")
    payload_security = security.get("payloads")
    require(isinstance(payload_security, dict)
            and set(payload_security) == {str(item.get("file")) for item in expected}
            and all(valid_security_binding(value) for value in payload_security.values()),
            f"{kind} attestation payload security bindings are invalid")
    require(all(re.fullmatch(r"[0-9a-f]{64}", str(item.get("sha256") or ""))
                and isinstance(item.get("sizeBytes"), int)
                and item["sizeBytes"] > 0 for item in expected),
            f"{kind} attestation payload metadata is invalid")
PY
}

capture_fresh_api_bridge_attestation_anchor() {
    local before_sha after_sha created_at
    [ -f "$API_BRIDGE_RECEIPT" ] && [ ! -L "$API_BRIDGE_RECEIPT" ] \
        && [ "$(stat -c '%a' "$API_BRIDGE_RECEIPT")" = 600 ] \
        && [ "$(stat -c '%u:%g' "$API_BRIDGE_RECEIPT")" = 0:0 ] || return 1
    [ -f "$BRIDGE_RECEIPT_HELPER" ] && [ ! -L "$BRIDGE_RECEIPT_HELPER" ] || return 1
    # Freeze the exact canonical receipt around the isolated verifier read.
    # Later full topology checks require this same SHA before any mutation.
    before_sha=$(sha256sum "$API_BRIDGE_RECEIPT" | awk '{print $1}') || return 1
    case "$before_sha" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#before_sha}" -eq 64 ] || return 1
    created_at=$("$PYTHON_COMMAND" -I -B "$BRIDGE_RECEIPT_HELPER" \
        --path "$API_BRIDGE_RECEIPT" --expect-host-scope sbc-primary \
        --require-fresh --field createdAt) || return 1
    case "$created_at" in ''|*[!0-9TZ:+.-]*) return 1 ;; esac
    [ "${#created_at}" -le 64 ] || return 1
    after_sha=$(sha256sum "$API_BRIDGE_RECEIPT" | awk '{print $1}') || return 1
    [ "$after_sha" = "$before_sha" ] || return 1
    if [ -n "$API_BRIDGE_RECEIPT_SHA" ]; then
        [ "$API_BRIDGE_RECEIPT_SHA" = "$after_sha" ] || return 1
    fi
    if [ -n "$API_BRIDGE_RECEIPT_CREATED_AT" ]; then
        [ "$API_BRIDGE_RECEIPT_CREATED_AT" = "$created_at" ] || return 1
    fi
    API_BRIDGE_RECEIPT_SHA="$after_sha"
    API_BRIDGE_RECEIPT_CREATED_AT="$created_at"
    record_state api_bridge.receipt_sha256 "$API_BRIDGE_RECEIPT_SHA"
    record_state api_bridge.attestation_anchor_created_at "$API_BRIDGE_RECEIPT_CREATED_AT"
}

validate_backup_source_ancestry() {
    local status_file="$1" commits source_player source_pipeline
    commits=$(run_bounded_read_command "$PYTHON_COMMAND" -I -B - "$status_file" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    source = json.load(handle)["source"]
print(source["playerCommit"], source["pipelineCommit"])
PY
    ) || return 1
    set -- $commits
    [ "$#" -eq 2 ] || return 1
    source_player="$1"
    source_pipeline="$2"
    trusted_git -C "$ROOT_DIR" merge-base --is-ancestor \
        "$source_player" "$PLAYER_RELEASE_COMMIT" || return 1
    trusted_git -C "$PIPELINE_ROOT" merge-base --is-ancestor \
        "$source_pipeline" "$PIPELINE_RELEASE_COMMIT" || return 1
}

verify_api_bridge_receipt() {
    local wrapper temporary helper_sha receipt_sha qdrant_image_id qdrant_reference \
        qdrant_repo_digests qdrant_volume_json qdrant_device_inode api_a_id api_b_id \
        api_a_image api_b_image api_a_config api_b_config extracted deployment_id \
        source_dir source_entries source_root source_manifest_sha source_snapshot_tar \
        source_snapshot_sha expected_entries qdrant_backup volume_labels volume_options \
        gateway_id gateway_image gateway_reference gateway_config web_id web_image \
        web_reference web_config image_scan_dir scan_path scan_metadata api_scan_sha \
        gateway_scan_sha web_scan_sha unsafe
    [ -f "$API_BRIDGE_RECEIPT" ] && [ ! -L "$API_BRIDGE_RECEIPT" ] \
        && [ "$(stat -c '%a' "$API_BRIDGE_RECEIPT")" = 600 ] \
        && [ "$(stat -c '%u:%g' "$API_BRIDGE_RECEIPT")" = 0:0 ] || return 1
    [ -f "$BRIDGE_RECEIPT_HELPER" ] && [ ! -L "$BRIDGE_RECEIPT_HELPER" ] || return 1
    API_BRIDGE_VERIFY_COUNT=$((API_BRIDGE_VERIFY_COUNT + 1))
    wrapper="$RUN_DIR/api-bridge-receipt-verified-$API_BRIDGE_VERIFY_COUNT.json"
    temporary="$wrapper.tmp"
    [ ! -e "$wrapper" ] && [ ! -L "$wrapper" ] \
        && [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || return 1
    "$PYTHON_COMMAND" -I -B "$BRIDGE_RECEIPT_HELPER" \
        --path "$API_BRIDGE_RECEIPT" --expect-host-scope sbc-primary \
        --require-fresh --verify-previous-api-rollback > "$temporary" || return 1
    chmod 600 "$temporary" || return 1
    durable_sync_path "$temporary" || return 1
    mv "$temporary" "$wrapper" || return 1
    durable_sync_path "$RUN_DIR" || return 1
    helper_sha=$(sha256sum "$BRIDGE_RECEIPT_HELPER" | awk '{print $1}') || return 1
    receipt_sha=$(sha256sum "$API_BRIDGE_RECEIPT" | awk '{print $1}') || return 1
    deployment_id=$("$PYTHON_COMMAND" -I -B - "$wrapper" <<'PY'
import json
import re
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)["receipt"]["deploymentId"]
if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value) is None:
    raise SystemExit(2)
print(value)
PY
    ) || return 1
    source_dir="$STATE_ROOT/$deployment_id"
    source_entries="$source_dir/source-tree.entries"
    source_root="$source_dir/source-root"
    image_scan_dir="$source_dir/image-scan"
    [ -d "$source_dir" ] && [ ! -L "$source_dir" ] \
        && [ -f "$source_entries" ] && [ ! -L "$source_entries" ] \
        && [ -d "$source_root" ] && [ ! -L "$source_root" ] \
        && [ -d "$image_scan_dir" ] && [ ! -L "$image_scan_dir" ] || return 1
    if [ "$TEST_MODE" != "1" ]; then
        [ "$(stat -c '%u:%g:%a' "$source_dir")" = 0:0:700 ] \
            && [ "$(stat -c '%u:%g:%a' "$source_entries")" = 0:0:600 ] \
            && [ "$(stat -c '%u:%g:%a' "$source_root")" = 0:0:700 ] \
            && [ "$(stat -c '%u:%g:%a' "$image_scan_dir")" = 0:0:700 ] || return 1
        unsafe=$(find "$source_root" -xdev \
            \( -type l -o ! -user root -o ! -group root -o -perm /022 \) \
            -print -quit) || return 1
        [ -z "$unsafe" ] || return 1
    fi
    expected_entries="$RUN_DIR/api-bridge-source-tree-$API_BRIDGE_VERIFY_COUNT.expected"
    [ ! -e "$expected_entries" ] && [ ! -L "$expected_entries" ] || return 1
    (set -C; trusted_git -C "$ROOT_DIR" ls-tree -rz --full-tree \
        "$PLAYER_RELEASE_COMMIT" > "$expected_entries") || return 1
    chmod 600 "$expected_entries" || return 1
    cmp -s "$expected_entries" "$source_entries" || return 1
    source_manifest_sha=$(sha256sum "$source_entries" | awk '{print $1}') || return 1
    if [ "$TEST_MODE" != "1" ]; then
        "$PYTHON_COMMAND" -I -B - "$source_entries" "$source_root" <<'PY' || return 1
import hashlib
import os
import stat
import sys

entries_path, root_path = sys.argv[1:]
payload = open(entries_path, "rb").read()
parts = payload.split(b"\0")
if parts[-1:] != [b""]:
    raise SystemExit(2)
expected = {}
for raw in parts[:-1]:
    metadata, separator, relative = raw.partition(b"\t")
    fields = metadata.split(b" ")
    if separator != b"\t" or len(fields) != 3:
        raise SystemExit(3)
    mode, kind, object_id = fields
    if mode not in (b"100644", b"100755") or kind != b"blob" or len(object_id) not in (40, 64):
        raise SystemExit(4)
    if not relative or relative.startswith(b"/") or b".." in relative.split(b"/"):
        raise SystemExit(5)
    expected[relative] = (int(mode[-3:], 8), object_id.decode("ascii"))
root = os.fsencode(os.path.realpath(root_path))
actual = {}
for directory, directories, files in os.walk(root, topdown=True, followlinks=False):
    directory_info = os.lstat(directory)
    if not stat.S_ISDIR(directory_info.st_mode) or (directory != root and stat.S_IMODE(directory_info.st_mode) != 0o755):
        raise SystemExit(6)
    for name in directories:
        child = os.path.join(directory, name)
        if not stat.S_ISDIR(os.lstat(child).st_mode):
            raise SystemExit(7)
    for name in files:
        path = os.path.join(directory, name)
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise SystemExit(8)
        relative = os.path.relpath(path, root).replace(b"\\", b"/")
        expected_row = expected.get(relative)
        if expected_row is None or stat.S_IMODE(info.st_mode) != expected_row[0]:
            raise SystemExit(9)
        data = open(path, "rb").read()
        header = b"blob " + str(len(data)).encode("ascii") + b"\0"
        algorithm = hashlib.sha1 if len(expected_row[1]) == 40 else hashlib.sha256
        if algorithm(header + data).hexdigest() != expected_row[1]:
            raise SystemExit(10)
        actual[relative] = True
if set(actual) != set(expected):
    raise SystemExit(11)
PY
    fi
    [ "$(sha256sum "$source_root/scripts/wsl-dr-api-bridge-receipt.py" | awk '{print $1}')" = "$helper_sha" ] \
        || return 1
    source_snapshot_tar="$RUN_DIR/api-bridge-source-snapshot-$API_BRIDGE_VERIFY_COUNT.tar"
    [ ! -e "$source_snapshot_tar" ] && [ ! -L "$source_snapshot_tar" ] || return 1
    run_bounded_read_command tar --sort=name --format=gnu --mtime=@0 \
        --owner=0 --group=0 --numeric-owner -C "$source_root" \
        -cf "$source_snapshot_tar" . || return 1
    chmod 600 "$source_snapshot_tar" || return 1
    durable_sync_path "$source_snapshot_tar" || return 1
    source_snapshot_sha=$(sha256sum "$source_snapshot_tar" | awk '{print $1}') || return 1
    qdrant_image_id=$(container_image_id "$OLD_QDRANT_ID") || return 1
    qdrant_reference=$(run_bounded_docker_read inspect --format '{{.Config.Image}}' \
        "$OLD_QDRANT_ID") || return 1
    qdrant_repo_digests=$(run_bounded_docker_read image inspect --format \
        '{{json .RepoDigests}}' "$qdrant_image_id") || return 1
    qdrant_volume_json=$(run_bounded_docker_read volume inspect "$OLD_QDRANT_VOLUME") \
        || return 1
    qdrant_device_inode=$(run_bounded_docker_read exec "$OLD_QDRANT_ID" \
        stat -c '%d:%i' /qdrant/storage) || return 1
    qdrant_backup="$QDRANT_BACKUP_BINDING"
    case "$qdrant_backup" in off-host-evidence-sha256-*) ;;
        *) return 1 ;;
    esac
    volume_labels=$(run_bounded_docker_read volume inspect --format \
        '{{json .Labels}}' "$OLD_QDRANT_VOLUME") || return 1
    volume_options=$(run_bounded_docker_read volume inspect --format \
        '{{json .Options}}' "$OLD_QDRANT_VOLUME") || return 1
    api_a_id=$(query_container_id vocadb_api_a) || return 1
    api_b_id=$(query_container_id vocadb_api_b) || return 1
    [ -n "$api_a_id" ] && [ -n "$api_b_id" ] || return 1
    api_a_image=$(container_image_id "$api_a_id") || return 1
    api_b_image=$(container_image_id "$api_b_id") || return 1
    api_a_config=$(run_bounded_docker_read inspect --format \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$api_a_id") || return 1
    api_b_config=$(run_bounded_docker_read inspect --format \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$api_b_id") || return 1
    gateway_id=$(query_container_id vocadb_api_gateway) || return 1
    web_id=$(query_container_id vocadb_web) || return 1
    [ -n "$gateway_id" ] && [ -n "$web_id" ] || return 1
    gateway_image=$(container_image_id "$gateway_id") || return 1
    web_image=$(container_image_id "$web_id") || return 1
    gateway_reference=$(run_bounded_docker_read inspect --format '{{.Config.Image}}' \
        "$gateway_id") || return 1
    web_reference=$(run_bounded_docker_read inspect --format '{{.Config.Image}}' \
        "$web_id") || return 1
    gateway_config=$(run_bounded_docker_read inspect --format \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$gateway_id") \
        || return 1
    web_config=$(run_bounded_docker_read inspect --format \
        '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$web_id") \
        || return 1
    for scan_service in api gateway web; do
        scan_path="$image_scan_dir/$scan_service.receipt.json"
        [ -f "$scan_path" ] && [ ! -L "$scan_path" ] \
            && [ "$(stat -c '%a:%h' "$scan_path")" = 600:1 ] || return 1
        if [ "$TEST_MODE" != "1" ]; then
            [ "$(stat -c '%u:%g' "$scan_path")" = 0:0 ] || return 1
        fi
        scan_metadata=$(sha256sum "$scan_path" | awk '{print $1}') || return 1
        case "$scan_metadata" in ''|*[!0-9a-f]*) return 1 ;; esac
        [ "${#scan_metadata}" -eq 64 ] || return 1
        case "$scan_service" in
            api) api_scan_sha="$scan_metadata" ;;
            gateway) gateway_scan_sha="$scan_metadata" ;;
            web) web_scan_sha="$scan_metadata" ;;
        esac
    done
    extracted=$("$PYTHON_COMMAND" -I -B - \
        "$qdrant_volume_json" "$wrapper" "$PLAYER_RELEASE_COMMIT" "$helper_sha" "$receipt_sha" \
        "$source_manifest_sha" "$source_snapshot_sha" "$qdrant_backup" \
        "$volume_labels" "$volume_options" \
        "$OLD_QDRANT_ID" "$qdrant_image_id" "$qdrant_reference" \
        "$qdrant_repo_digests" "$OLD_QDRANT_VOLUME" "$qdrant_device_inode" \
        "$api_a_id" "$api_a_image" "$api_a_config" \
        "$api_b_id" "$api_b_image" "$api_b_config" \
        "$gateway_id" "$gateway_image" "$gateway_reference" "$gateway_config" \
        "$web_id" "$web_image" "$web_reference" "$web_config" \
        "$api_scan_sha" "$gateway_scan_sha" "$web_scan_sha" \
        "$RUN_DIR/evidence/qdrant-manifest.json" <<'PY'
import hashlib
import json
import re
import sys

(
    volume_json_raw, wrapper_path, player_commit, helper_sha, receipt_sha,
    source_manifest_sha, source_snapshot_sha, qdrant_backup,
    volume_labels_raw, volume_options_raw,
    old_id, old_image, old_reference, repo_digests_raw, old_volume, device_inode,
    api_a_id, api_a_image, api_a_config, api_b_id, api_b_image, api_b_config,
    gateway_id, gateway_image, gateway_reference, gateway_config,
    web_id, web_image, web_reference, web_config,
    api_scan_sha, gateway_scan_sha, web_scan_sha,
    backup_manifest_path,
) = sys.argv[1:]
with open(wrapper_path, encoding="utf-8") as handle:
    wrapper = json.load(handle)
if set(wrapper) != {"previousApiRollback", "receipt"}:
    raise SystemExit(2)
previous = wrapper["previousApiRollback"]
if (
    not isinstance(previous, dict)
    or set(previous) != {
        "apiSlots", "provenance", "scanReceipts", "schemaVersion", "statelessServices"
    }
    or previous.get("schemaVersion") != 2
    or previous.get("provenance") != "legacy-pre-contract-unattested"
):
    raise SystemExit(16)
stateless = previous.get("statelessServices")
scans = previous.get("scanReceipts")
if not isinstance(stateless, dict) or set(stateless) != {"api_gateway", "web"}:
    raise SystemExit(17)
if not isinstance(scans, dict) or set(scans) != {"api", "gateway", "web"}:
    raise SystemExit(18)
stateless_facts = {
    "api_gateway": (gateway_id, gateway_image, gateway_reference, gateway_config),
    "web": (web_id, web_image, web_reference, web_config),
}
for service, (container_id, image_id, image_reference, config_hash) in stateless_facts.items():
    fact = stateless.get(service) or {}
    if (
        set(fact) != {
            "canonicalName", "configHash", "containerId", "imageId", "imageReference"
        }
        or fact.get("canonicalName") != f"vocadb_{service}"
        or fact.get("containerId") != container_id
        or fact.get("imageId") != image_id
        or fact.get("imageReference") != image_reference
        or fact.get("configHash") != config_hash
    ):
        raise SystemExit(19)
scan_facts = {
    "api": (api_a_image, api_scan_sha),
    "gateway": (gateway_image, gateway_scan_sha),
    "web": (web_image, web_scan_sha),
}
for service, (image_id, receipt_digest) in scan_facts.items():
    fact = scans.get(service) or {}
    if (
        set(fact) != {"imageId", "sha256"}
        or fact.get("imageId") != image_id
        or fact.get("sha256") != receipt_digest
    ):
        raise SystemExit(20)
if api_a_image != api_b_image:
    raise SystemExit(21)
receipt = wrapper["receipt"]
canonical = lambda value: (json.dumps(value, ensure_ascii=True, sort_keys=True,
                                      separators=(",", ":")) + "\n").encode()
receipt_keys = {
    "apiSlots", "clientPackageVersion", "compatibilityMatrix",
    "compatibilityMatrixSha256", "createdAt", "deploymentId", "helperSha256",
    "hostScope", "mode", "oldQdrant", "payloadSha256", "playerCommit",
    "previousApiRollback", "schemaVersion", "smoke", "sourceManifestSha256",
    "sourceSnapshotSha256", "validOnlyWhileOldQExact", "validUntil",
}
if (
    not isinstance(receipt, dict)
    or set(receipt) != receipt_keys
    or receipt.get("schemaVersion") != 3
    or receipt.get("hostScope") != "sbc-primary"
    or receipt.get("mode") != "qdrant-legacy-api-bridge"
    or receipt.get("validOnlyWhileOldQExact") is not True
    or receipt.get("clientPackageVersion") != "1.19.0"
    or receipt.get("playerCommit") != player_commit
    or receipt.get("helperSha256") != helper_sha
    or receipt.get("sourceManifestSha256") != source_manifest_sha
    or receipt.get("sourceSnapshotSha256") != source_snapshot_sha
):
    raise SystemExit(3)
matrix = receipt.get("compatibilityMatrix")
matrix_keys = {
    "endpoints", "endpointResponsesSha256", "readMatrix", "readMatrixSha256",
    "requiredQueryPath", "schemaVersion", "seedSelection", "seedSongId",
    "semanticSha256", "slots",
}
if not isinstance(matrix, dict) or set(matrix) != matrix_keys:
    raise SystemExit(12)
smoke = receipt.get("smoke") or {}
seed = smoke.get("seedSongId")
selection = matrix.get("seedSelection")
read_matrix = matrix.get("readMatrix")
endpoints = matrix.get("endpoints")
matrix_slots = matrix.get("slots")
if (
    matrix.get("schemaVersion") != 1
    or matrix.get("requiredQueryPath") != "legacy-search-fallback"
    or matrix.get("seedSongId") != seed
    or not isinstance(selection, dict)
    or set(selection) != {"collectionNames", "scanLimit", "sha256"}
    or selection.get("collectionNames") != [
        "song_audio", "song_hybrid_active", "song_metadata_active", "songs_v2_active"
    ]
    or selection.get("scanLimit") != 64
    or not re.fullmatch(r"[0-9a-f]{64}", str(selection.get("sha256") or ""))
    or not isinstance(read_matrix, dict)
    or not isinstance(endpoints, dict)
    or set(endpoints) != {"audio", "dig", "metadata", "multi", "recommend", "similar"}
    or not isinstance(matrix_slots, dict)
    or set(matrix_slots) != {"api_a", "api_b"}
):
    raise SystemExit(13)
operations = read_matrix.get("operations")
expected_operations = [
    "named-audio", "named-meta", "hybrid-default", "metadata-default", "audio-default"
]
if (
    not isinstance(operations, list)
    or [item.get("operation") for item in operations if isinstance(item, dict)]
       != expected_operations
    or any(item.get("queryPath") != "legacy-search-fallback" for item in operations)
):
    raise SystemExit(14)
read_hash = hashlib.sha256(canonical(read_matrix)).hexdigest()
endpoint_hash = hashlib.sha256(canonical(endpoints)).hexdigest()
semantic_hash = hashlib.sha256(canonical({
    "endpoints": endpoints, "readMatrix": read_matrix, "schemaVersion": 1,
    "seedSongId": seed,
})).hexdigest()
expected_slot_hashes = {
    "endpointResponsesSha256": endpoint_hash,
    "readMatrixSha256": read_hash,
    "semanticSha256": semantic_hash,
}
compatibility_sha = hashlib.sha256(canonical(matrix)).hexdigest()
if (
    matrix.get("readMatrixSha256") != read_hash
    or matrix.get("endpointResponsesSha256") != endpoint_hash
    or matrix.get("semanticSha256") != semantic_hash
    or matrix_slots.get("api_a") != expected_slot_hashes
    or matrix_slots.get("api_b") != expected_slot_hashes
    or receipt.get("compatibilityMatrixSha256") != compatibility_sha
):
    raise SystemExit(15)
qdrant = receipt.get("oldQdrant") or {}
if (
    qdrant.get("containerName") != "vocadb_qdrant"
    or qdrant.get("containerId") != old_id
    or qdrant.get("imageId") != old_image
    or qdrant.get("imageReference") != old_reference
    or qdrant.get("imageIndexDigest")
       != "sha256:8f9011596cb03595a340cf2388083e36e38421eb49cb3fdc0ab7666cf14a90c1"
):
    raise SystemExit(4)
repo_digests = json.loads(repo_digests_raw)
qdrant_digests = [value for value in repo_digests
                   if isinstance(value, str) and value.startswith("qdrant/qdrant@sha256:")]
if len(qdrant_digests) != 1 or qdrant.get("imageRepoDigest") != qdrant_digests[0].split("@", 1)[1]:
    raise SystemExit(5)
volume_rows = json.loads(volume_json_raw)
if not isinstance(volume_rows, list) or len(volume_rows) != 1:
    raise SystemExit(6)
volume = volume_rows[0]
expected_volume = {
    "createdAt": volume.get("CreatedAt"),
    "driver": volume.get("Driver"),
    "labelsSha256": hashlib.sha256((volume_labels_raw + "\n").encode()).hexdigest(),
    "mountpoint": volume.get("Mountpoint"),
    "mountpointDeviceInode": device_inode,
    "name": volume.get("Name"),
    "optionsSha256": hashlib.sha256((volume_options_raw + "\n").encode()).hexdigest(),
    "scope": volume.get("Scope"),
}
if volume.get("Name") != old_volume or qdrant.get("volume") != expected_volume:
    raise SystemExit(7)
with open(backup_manifest_path, encoding="utf-8") as handle:
    backup = json.load(handle)
generation = ((backup.get("publication") or {}).get("generation"))
if (
    not isinstance(generation, str)
    or qdrant.get("publicationGeneration") != generation
    or qdrant.get("backup") != qdrant_backup
):
    raise SystemExit(8)
slots = receipt.get("apiSlots") or {}
facts = {
    "api_a": (api_a_id, api_a_image, api_a_config),
    "api_b": (api_b_id, api_b_image, api_b_config),
}
for service, (container_id, image_id, config_hash) in facts.items():
    slot = slots.get(service) or {}
    if (
        slot.get("containerName") != f"vocadb_{service}"
        or slot.get("containerId") != container_id
        or slot.get("imageId") != image_id
        or slot.get("configHash") != config_hash
        or slot.get("sourceCommit") != player_commit
        or slot.get("clientPackageVersion") != "1.19.0"
    ):
        raise SystemExit(9)
dimensions = smoke.get("retrieveVectorDimensions") or {}
if (
    not isinstance(seed, int)
    or any((smoke.get(service) or {}).get("resultCount", 0) < 1
           or (smoke.get(service) or {}).get("path") != "retrieve-query-legacy-search-passed"
           for service in ("api_a", "api_b"))
    or not all(isinstance(dimensions.get(key), int) and dimensions[key] > 0
               for key in ("audio", "meta"))
):
    raise SystemExit(10)
if not re.fullmatch(r"[0-9a-f]{64}", receipt_sha):
    raise SystemExit(11)
print(json.dumps({"apiAContainer": api_a_id, "apiAImage": api_a_image,
                  "apiBContainer": api_b_id, "apiBImage": api_b_image,
                  "compatibilitySha": compatibility_sha,
                  "receiptSha": receipt_sha, "seedSongId": seed},
                 ensure_ascii=True, sort_keys=True, separators=(",", ":")))
PY
    ) || return 1
    set -- $(printf '%s' "$extracted" | "$PYTHON_COMMAND" -I -B -c \
        'import json,sys; d=json.load(sys.stdin); print(d["apiAContainer"],d["apiAImage"],d["apiBContainer"],d["apiBImage"],d["seedSongId"],d["receiptSha"],d["compatibilitySha"])') \
        || return 1
    [ "$#" -eq 7 ] || return 1
    if [ -n "$API_BRIDGE_RECEIPT_SHA" ]; then
        [ "$API_BRIDGE_RECEIPT_SHA" = "$6" ] || return 1
    fi
    if [ -n "$API_BRIDGE_COMPATIBILITY_SHA" ]; then
        [ "$API_BRIDGE_COMPATIBILITY_SHA" = "$7" ] || return 1
    fi
    API_A_BRIDGE_CONTAINER_ID="$1"
    API_A_BRIDGE_IMAGE_ID="$2"
    API_B_BRIDGE_CONTAINER_ID="$3"
    API_B_BRIDGE_IMAGE_ID="$4"
    API_BRIDGE_SEED_SONG_ID="$5"
    API_BRIDGE_RECEIPT_SHA="$6"
    API_BRIDGE_COMPATIBILITY_SHA="$7"
    record_state api_bridge.verify_count "$API_BRIDGE_VERIFY_COUNT"
    record_state api_bridge.receipt_sha256 "$API_BRIDGE_RECEIPT_SHA"
    record_state api_bridge.compatibility_matrix_sha256 "$API_BRIDGE_COMPATIBILITY_SHA"
}

consume_verified_api_bridge_receipt() {
    local reason="$1" archive settlement
    case "$reason" in calibration|completed) ;;
        *) return 1 ;;
    esac
    case "$API_BRIDGE_RECEIPT_SHA" in ''|*[!0-9a-f]*) return 1 ;; esac
    [ "${#API_BRIDGE_RECEIPT_SHA}" -eq 64 ] || return 1
    archive="$RUN_DIR/api-bridge-receipt.$reason.$API_BRIDGE_RECEIPT_SHA.json"
    [ ! -e "$archive" ] && [ ! -L "$archive" ] || return 1
    [ -f "$API_BRIDGE_RECEIPT" ] && [ ! -L "$API_BRIDGE_RECEIPT" ] \
        && [ "$(sha256sum "$API_BRIDGE_RECEIPT" | awk '{print $1}')" \
            = "$API_BRIDGE_RECEIPT_SHA" ] || return 1
    [ -n "$API_BRIDGE_CONSUMPTION_HELPER_RELEASE" ] \
        && [ -f "$API_BRIDGE_CONSUMPTION_HELPER_RELEASE" ] \
        && [ ! -L "$API_BRIDGE_CONSUMPTION_HELPER_RELEASE" ] || return 1
    settlement="$archive.consumption-settlement.json"
    "$PYTHON_COMMAND" -I -B "$API_BRIDGE_CONSUMPTION_HELPER_RELEASE" consume \
        --canonical "$API_BRIDGE_RECEIPT" \
        --archive "$archive" \
        --intent "$API_BRIDGE_CONSUME_INTENT" \
        --reason "$reason" \
        --run-id "$RUN_ID" \
        --state-root "$STATE_ROOT" \
        --active-journal "$ACTIVE_JOURNAL" \
        --lock-dir "$LOCK_DIR" \
        --expected-sha256 "$API_BRIDGE_RECEIPT_SHA" \
        >/dev/null || return 1
    [ ! -e "$API_BRIDGE_RECEIPT" ] && [ ! -L "$API_BRIDGE_RECEIPT" ] \
        && [ -f "$archive" ] && [ ! -L "$archive" ] \
        && [ "$(stat -c '%a' "$archive")" = 600 ] \
        && [ "$(sha256sum "$archive" | awk '{print $1}')" = "$API_BRIDGE_RECEIPT_SHA" ] \
        && [ -f "$settlement" ] && [ ! -L "$settlement" ] \
        && [ "$(stat -c '%a' "$settlement")" = 600 ] \
        && [ ! -e "$API_BRIDGE_CONSUME_INTENT" ] \
        && [ ! -L "$API_BRIDGE_CONSUME_INTENT" ] \
        && [ ! -e "$API_BRIDGE_CONSUME_INTENT.prepared" ] \
        && [ ! -L "$API_BRIDGE_CONSUME_INTENT.prepared" ] \
        || return 1
    durable_sync_path "$archive" || return 1
    durable_sync_path "$settlement" || return 1
    durable_sync_path "$RUN_DIR" || return 1
    durable_sync_path "$STATE_ROOT" || return 1
    record_state api_bridge.receipt_consumed "$reason:$archive:$API_BRIDGE_RECEIPT_SHA"
    record_state api_bridge.receipt_consumption_settlement "$settlement"
}

verify_candidate_api_semantics() {
    local phase="$1" slot container expected_image output
    case "$phase" in candidate|promoted) ;; *) return 1 ;; esac
    for slot in api_a api_b; do
        case "$slot" in
            api_a) container="$API_A_BRIDGE_CONTAINER_ID"; expected_image="$API_A_BRIDGE_IMAGE_ID" ;;
            api_b) container="$API_B_BRIDGE_CONTAINER_ID"; expected_image="$API_B_BRIDGE_IMAGE_ID" ;;
            *) return 1 ;;
        esac
        [ "$(query_container_id "vocadb_$slot")" = "$container" ] || return 1
        [ "$(container_image_id "$container")" = "$expected_image" ] || return 1
        output="$RUN_DIR/qdrant-$phase-$slot-semantic.json"
        [ ! -e "$output" ] && [ ! -L "$output" ] || return 1
        run_bounded_docker_read exec "$container" /bin/busybox wget -q -T 60 -O - \
            "http://127.0.0.1:5000/api/recommend/similar?songId=$API_BRIDGE_SEED_SONG_ID&count=5" \
            > "$output" || return 1
        chmod 600 "$output" || return 1
        "$PYTHON_COMMAND" -I -B - "$output" "$API_BRIDGE_SEED_SONG_ID" <<'PY' || return 1
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
items = payload.get("items") if isinstance(payload, dict) else None
if not isinstance(items, list) or not items or len(items) > 5:
    raise SystemExit(2)
for item in items:
    if not isinstance(item, dict) or not isinstance(item.get("songId"), int):
        raise SystemExit(3)
PY
        record_state "qdrant.${phase}_api_$slot" retrieve-query-passed
    done
}

verify_candidate_python_semantics() {
    local phase="$1" output temporary
    case "$phase" in candidate|promoted) ;; *) return 1 ;; esac
    output="$RUN_DIR/qdrant-$phase-python-semantic.json"
    temporary="$output.tmp"
    [ ! -e "$output" ] && [ ! -L "$output" ] \
        && [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || return 1
    if ! (umask 077; ulimit -f 128; run_pipeline_venv_python - \
        qdrant-semantic "$RUN_ID-$phase" > "$temporary" <<'PY'
import importlib.metadata
import json
import re
import sys

from qdrant_client import QdrantClient, models

marker, run_id = sys.argv[1:]
if marker != "qdrant-semantic":
    raise SystemExit(1)
if importlib.metadata.version("qdrant-client") != "1.19.0":
    raise SystemExit(2)
suffix = re.sub(r"[^a-z0-9_]", "_", run_id.lower())[-48:]
collection = "diva_upgrade_probe_" + suffix
alias = collection + "_alias"
client = QdrantClient(host="127.0.0.1", port=6333, grpc_port=6334,
                      prefer_grpc=True, timeout=30)
created = False
alias_created = False
snapshot_name = None
failure = None
try:
    client.create_collection(
        collection_name=collection,
        vectors_config=models.VectorParams(size=3, distance=models.Distance.COSINE),
    )
    created = True
    client.upsert(
        collection_name=collection,
        points=[
            models.PointStruct(id=1, vector=[1.0, 0.0, 0.0], payload={"probe": "seed"}),
            models.PointStruct(id=2, vector=[0.9, 0.1, 0.0], payload={"probe": "result"}),
        ],
        wait=True,
    )
    retrieved = client.retrieve(collection_name=collection, ids=[1], with_vectors=True)
    if len(retrieved) != 1 or len(retrieved[0].vector) != 3:
        raise RuntimeError("typed Retrieve vector dimension mismatch")
    queried = client.query_points(collection_name=collection, query=[1.0, 0.0, 0.0],
                                  limit=2, with_vectors=True)
    points = list(queried.points)
    if len(points) != 2 or any(len(point.vector) != 3 for point in points):
        raise RuntimeError("Query typed-vector result mismatch")
    client.update_collection_aliases([
        models.CreateAliasOperation(
            create_alias=models.CreateAlias(collection_name=collection, alias_name=alias)
        )
    ])
    alias_created = True
    aliases = {(item.alias_name, item.collection_name) for item in client.get_aliases().aliases}
    if (alias, collection) not in aliases:
        raise RuntimeError("scratch alias was not listed")
    snapshot = client.create_snapshot(collection)
    if snapshot is None or not snapshot.name:
        raise RuntimeError("scratch snapshot was not created")
    snapshot_name = snapshot.name
    if not client.delete_snapshot(collection, snapshot_name):
        raise RuntimeError("scratch snapshot was not deleted")
    snapshot_name = None
except BaseException as error:
    failure = error
finally:
    cleanup_failures = []
    if snapshot_name is not None:
        try:
            client.delete_snapshot(collection, snapshot_name)
        except BaseException as error:
            cleanup_failures.append(f"snapshot:{error}")
    if alias_created:
        try:
            client.update_collection_aliases([
                models.DeleteAliasOperation(delete_alias=models.DeleteAlias(alias_name=alias))
            ])
        except BaseException as error:
            cleanup_failures.append(f"alias:{error}")
    if created:
        try:
            if not client.delete_collection(collection):
                cleanup_failures.append("collection:false")
        except BaseException as error:
            cleanup_failures.append(f"collection:{error}")
    client.close()
    if cleanup_failures:
        raise RuntimeError("scratch cleanup failed: " + ";".join(cleanup_failures)) from failure
if failure is not None:
    raise failure
document = {
    "aliasList": "passed",
    "clientPackageVersion": "1.19.0",
    "queryResultCount": len(points),
    "retrieveVectorDimensions": 3,
    "scratchAliasCleanup": "confirmed",
    "scratchCollectionCleanup": "confirmed",
    "scratchSnapshotCleanup": "confirmed",
    "scratchUpsertDelete": "passed",
}
print(json.dumps(document, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
PY
    ); then
        rm -f -- "$temporary"
        return 1
    fi
    [ -f "$temporary" ] && [ ! -L "$temporary" ] \
        && [ "$(stat -c '%a' "$temporary")" = 600 ] \
        && [ "$(stat -c '%s' "$temporary")" -le 65536 ] || return 1
    "$PYTHON_COMMAND" -I -B - "$temporary" <<'PY' || return 1
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
raw = path.read_bytes()
if not raw or len(raw) > 65536:
    raise SystemExit(2)
document = json.loads(raw)
expected = {
    "aliasList": "passed",
    "clientPackageVersion": "1.19.0",
    "queryResultCount": 2,
    "retrieveVectorDimensions": 3,
    "scratchAliasCleanup": "confirmed",
    "scratchCollectionCleanup": "confirmed",
    "scratchSnapshotCleanup": "confirmed",
    "scratchUpsertDelete": "passed",
}
if document != expected:
    raise SystemExit(3)
if raw != (json.dumps(document, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":")) + "\n").encode():
    raise SystemExit(4)
PY
    chmod 600 "$temporary" || return 1
    mv "$temporary" "$output" || return 1
    durable_sync_path "$output" || return 1
    record_state "qdrant.${phase}_python_semantic" verified
}

container_image_id() {
    run_bounded_docker_read inspect --format '{{.Image}}' "$1"
}

wait_qdrant() {
    local attempts=0
    while [ "$attempts" -lt "$HEALTH_ATTEMPTS" ]; do
        if "$CURL_COMMAND" -fsS --connect-timeout 2 --max-time 5 \
            http://127.0.0.1:6333/readyz >/dev/null 2>&1; then
            return 0
        fi
        attempts=$((attempts + 1))
        "$SLEEP_COMMAND" "$WAIT_SECONDS"
    done
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
        "$SLEEP_COMMAND" "$WAIT_SECONDS"
    done
    return 1
}

wait_postgres() {
    local container=${1:-$POSTGRES_CONTAINER} attempts=0
    while [ "$attempts" -lt "$HEALTH_ATTEMPTS" ]; do
        if run_bounded_docker_health_probe exec "$container" sh -ec \
            'exec pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
            >/dev/null 2>&1; then
            return 0
        fi
        attempts=$((attempts + 1))
        "$SLEEP_COMMAND" "$WAIT_SECONDS"
    done
    return 1
}

verify_pipeline_writer_gate() {
    local container=${1:-$POSTGRES_CONTAINER} gate_state
    [ "$PIPELINE_WRITER_GATED" = "true" ] || return 1
    [ -s "$PIPELINE_WRITER_GATE_FILE" ] && [ ! -L "$PIPELINE_WRITER_GATE_FILE" ] || return 1
    [ "$(cat "$PIPELINE_WRITER_GATE_FILE")" = "$PIPELINE_WRITER_GATE_TOKEN" ] || return 1
    gate_state=$(run_bounded_docker_read exec -i "$container" sh -ec \
        'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt' <<'SQL'
WITH locks AS MATERIALIZED (
    SELECT
        pg_try_advisory_xact_lock(hashtext('diva-data-pipeline-publication-v1')) AS pipeline,
        pg_try_advisory_xact_lock(hashtext('diva-data-pipeline-child-v1')) AS child,
        pg_try_advisory_xact_lock(hashtextextended('diva-recommendation-publication-v1', 0)) AS publication
)
SELECT
    COALESCE((SELECT value FROM sync_state WHERE key = 'diva_stateful_maintenance_gate'), '')
    || '|' || pipeline::text
    || '|' || child::text
    || '|' || publication::text
    || '|' || (SELECT count(*) FROM sync_state WHERE key IN (
        'diva_pipeline_lock_owner', 'recommendation_publication_in_progress'
    ))::text
    || '|' || (SELECT count(*)
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
    )::text
    || '|' || (
        SELECT (
            jsonb_typeof(value::jsonb) = 'array'
            AND jsonb_array_length(value::jsonb) > 0
            AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(value::jsonb) AS listed(role_name)
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
            ) = jsonb_array_length(value::jsonb)
        )::text
        FROM sync_state
        WHERE key = 'diva_stateful_maintenance_login_roles'
    )
    /* diva-writer-gate-verify */
FROM locks;
SQL
    ) || return 1
    [ "$gate_state" = "$PIPELINE_WRITER_GATE_TOKEN|true|true|true|0|0|true" ] \
        || return 1
}

gate_pipeline_writers() {
    local temporary="$PIPELINE_WRITER_GATE_FILE.tmp" gate_result actual_gate
    [ "$PIPELINE_WRITER_GATED" = "false" ] || return 1
    [ ! -e "$PIPELINE_WRITER_GATE_FILE" ] && [ ! -L "$PIPELINE_WRITER_GATE_FILE" ] \
        && [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || return 1
    printf '%s\n' "$PIPELINE_WRITER_GATE_TOKEN" > "$temporary" || return 1
    chmod 600 "$temporary" || return 1
    durable_sync_path "$temporary" || return 1
    mv "$temporary" "$PIPELINE_WRITER_GATE_FILE" || return 1
    durable_sync_path "$RUN_DIR" || return 1
    PIPELINE_WRITER_GATED=true
    record_state pipeline_writer.status gating
    [ ! -e "$PIPELINE_WRITER_GATE_RESULT" ] && [ ! -L "$PIPELINE_WRITER_GATE_RESULT" ] \
        || return 1
    if ! run_bounded_docker_mutation exec -i "$POSTGRES_CONTAINER" sh -ec \
        'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v "token=$1" -qAt' \
        sh "$PIPELINE_WRITER_GATE_TOKEN" > "$PIPELINE_WRITER_GATE_RESULT" <<'SQL'
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
SQL
    then
        return 1
    fi
    gate_result=$(cat "$PIPELINE_WRITER_GATE_RESULT") || return 1
    if [ "$gate_result" != "$PIPELINE_WRITER_GATE_TOKEN" ]; then
        actual_gate=$(run_bounded_docker_read exec -i "$POSTGRES_CONTAINER" sh -ec \
            'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt' <<'SQL'
SELECT value FROM sync_state WHERE key = 'diva_stateful_maintenance_gate';
SQL
        ) || return 1
        if [ "$actual_gate" != "$PIPELINE_WRITER_GATE_TOKEN" ]; then
            PIPELINE_WRITER_GATED=false
            rm -f "$PIPELINE_WRITER_GATE_FILE" "$PIPELINE_WRITER_GATE_RESULT"
            durable_sync_path "$RUN_DIR" || return 1
            record_state pipeline_writer.status refused-busy
        fi
        return 1
    fi
    verify_pipeline_writer_gate || return 1
    record_state pipeline_writer.status gated
}

release_pipeline_writers() {
    local release_result remaining_gate
    [ "$PIPELINE_WRITER_GATED" = "true" ] || return 0
    verify_pipeline_writer_gate || return 1
    [ ! -e "$PIPELINE_WRITER_RELEASE_RESULT" ] && [ ! -L "$PIPELINE_WRITER_RELEASE_RESULT" ] \
        || return 1
    if ! run_bounded_docker_mutation exec -i "$POSTGRES_CONTAINER" sh -ec \
        'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v "token=$1" -qAt' \
        sh "$PIPELINE_WRITER_GATE_TOKEN" > "$PIPELINE_WRITER_RELEASE_RESULT" <<'SQL'
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
SQL
    then
        return 1
    fi
    release_result=$(cat "$PIPELINE_WRITER_RELEASE_RESULT") || return 1
    [ "$release_result" = "$PIPELINE_WRITER_GATE_TOKEN" ] || return 1
    remaining_gate=$(run_bounded_docker_read exec -i "$POSTGRES_CONTAINER" sh -ec \
        'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt' <<'SQL'
SELECT value FROM sync_state WHERE key = 'diva_stateful_maintenance_gate';
SQL
    ) || return 1
    [ -z "$remaining_gate" ] || return 1
    PIPELINE_WRITER_GATED=false
    record_state pipeline_writer.status released
    rm -f "$PIPELINE_WRITER_GATE_FILE" "$PIPELINE_WRITER_GATE_RESULT" \
        "$PIPELINE_WRITER_RELEASE_RESULT"
    durable_sync_path "$RUN_DIR" || return 1
}

qdrant_fingerprint() {
    run_bounded_read_command "$PYTHON_COMMAND" -I -B - "$1" <<'PY'
import json
import sys
import urllib.parse
import urllib.request

def fetch(path):
    with urllib.request.urlopen("http://127.0.0.1:6333" + path, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError(f"unexpected Qdrant HTTP status {response.status} for {path}")
        return json.load(response)

root = fetch("/")
collections = sorted(item["name"] for item in fetch("/collections")["result"]["collections"])
details = {}
for name in collections:
    result = fetch("/collections/" + urllib.parse.quote(name, safe=""))["result"]
    if result.get("status") != "green":
        raise RuntimeError(f"Qdrant collection is not green: {name}")
    points_count = result.get("points_count")
    if not isinstance(points_count, int) or isinstance(points_count, bool) or points_count < 0:
        raise RuntimeError(f"Qdrant collection point count is invalid: {name}")
    config = result.get("config")
    payload_schema = result.get("payload_schema")
    if not isinstance(config, dict) or not isinstance(payload_schema, dict):
        raise RuntimeError(f"Qdrant collection schema is invalid: {name}")
    params = config.get("params") or {}
    details[name] = {
        "config": config,
        "onDiskPayload": params.get("on_disk_payload"),
        "payloadSchema": payload_schema,
        "pointsCount": points_count,
        "replicationFactor": params.get("replication_factor"),
        "shardNumber": params.get("shard_number"),
        "uuid": result.get("uuid"),
        "vectors": params.get("vectors"),
        "writeConsistencyFactor": params.get("write_consistency_factor"),
    }
aliases = sorted(
    (item["alias_name"], item["collection_name"])
    for item in fetch("/aliases")["result"]["aliases"]
)
document = {
    "aliases": aliases,
    "collections": details,
    "version": root.get("version"),
}
with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as handle:
    json.dump(document, handle, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
PY
}

qdrant_fingerprints_equivalent() {
    "$PYTHON_COMMAND" -I -B - "$1" "$2" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    before = json.load(handle)
with open(sys.argv[2], encoding="utf-8") as handle:
    after = json.load(handle)
if before.get("aliases") != after.get("aliases"):
    raise SystemExit(2)
before_collections = before.get("collections")
after_collections = after.get("collections")
if not isinstance(before_collections, dict) or set(before_collections) != set(after_collections or {}):
    raise SystemExit(3)
stable_fields = (
    "onDiskPayload", "payloadSchema", "pointsCount", "replicationFactor",
    "shardNumber", "uuid", "vectors", "writeConsistencyFactor",
)
for name, expected in before_collections.items():
    actual = after_collections[name]
    if any(expected.get(field) != actual.get(field) for field in stable_fields):
        raise SystemExit(4)
PY
}

qdrant_volume_identity_json() {
    local volume="$1" output
    output=$(run_bounded_docker_read volume inspect "$volume") || return 1
    printf '%s' "$output" | "$PYTHON_COMMAND" -I -B -c '
import hashlib, json, sys
rows=json.load(sys.stdin)
if not isinstance(rows,list) or len(rows)!=1 or not isinstance(rows[0],dict): raise SystemExit(2)
item=rows[0]
canonical=lambda value: (json.dumps(value,ensure_ascii=True,sort_keys=True,separators=(",",":"))+"\n").encode()
projection={
 "name":item.get("Name"),"driver":item.get("Driver"),"scope":item.get("Scope"),
 "mountpoint":item.get("Mountpoint"),"createdAt":item.get("CreatedAt"),
 "labelsSha256":hashlib.sha256(canonical(item.get("Labels") or {})).hexdigest(),
 "optionsSha256":hashlib.sha256(canonical(item.get("Options") or {})).hexdigest(),
}
if not all(isinstance(value,str) and value for value in projection.values()): raise SystemExit(3)
print(json.dumps(projection,ensure_ascii=True,sort_keys=True,separators=(",",":")))
' || return 1
}

verify_qdrant_rollback_assets() {
    local tag_image_id volume_identity volume_identity_sha receipt_sha state_receipt_sha count
    tag_image_id=$(query_optional_image_id "$QDRANT_ROLLBACK_IMAGE") || return 1
    [ "$tag_image_id" = "$OLD_QDRANT_IMAGE_ID" ] || return 1
    volume_identity=$(qdrant_volume_identity_json "$OLD_QDRANT_VOLUME") || return 1
    [ "$volume_identity" = "$OLD_QDRANT_VOLUME_IDENTITY" ] || return 1
    volume_identity_sha=$(printf '%s\n' "$volume_identity" | sha256sum | awk '{print $1}') \
        || return 1
    [ "$volume_identity_sha" = "$OLD_QDRANT_VOLUME_IDENTITY_SHA" ] || return 1
    receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-qdrant-rollback.receipt.json" | awk '{print $1}') \
        || return 1
    [ "$receipt_sha" = "$QDRANT_ROLLBACK_SCAN_RECEIPT_SHA" ] || return 1
    count=$(grep -Fc 'qdrant.rollback_scan_receipt_sha256=' "$STATE_FILE") || return 1
    [ "$count" -eq 1 ] || return 1
    state_receipt_sha=$(awk -F= '$1 == "qdrant.rollback_scan_receipt_sha256" { print $2 }' \
        "$STATE_FILE") || return 1
    [ "$state_receipt_sha" = "$QDRANT_ROLLBACK_SCAN_RECEIPT_SHA" ]
}

verify_postgres_rollback_assets() {
    local tag_image_id receipt_sha state_receipt_sha count
    tag_image_id=$(query_optional_image_id "$POSTGRES_ROLLBACK_IMAGE") || return 1
    [ "$tag_image_id" = "$OLD_POSTGRES_IMAGE_ID" ] || return 1
    receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-postgres-rollback.receipt.json" | awk '{print $1}') \
        || return 1
    [ "$receipt_sha" = "$POSTGRES_ROLLBACK_SCAN_RECEIPT_SHA" ] || return 1
    count=$(grep -Fc 'postgres.rollback_scan_receipt_sha256=' "$STATE_FILE") || return 1
    [ "$count" -eq 1 ] || return 1
    state_receipt_sha=$(awk -F= \
        '$1 == "postgres.rollback_scan_receipt_sha256" { print $2 }' "$STATE_FILE") \
        || return 1
    [ "$state_receipt_sha" = "$POSTGRES_ROLLBACK_SCAN_RECEIPT_SHA" ]
}

verify_retained_image_offline() {
    local image_id="$1" inventory
    case "$image_id" in sha256:*) ;; *) return 1 ;; esac
    inventory=$(run_bounded_docker_read container ls --all --no-trunc \
        --filter "ancestor=$image_id" --format '{{.ID}}') || return 1
    [ -z "$inventory" ]
}

verify_qdrant_previous_container_contract() {
    local current config_hash
    current=$(query_container_id "$QDRANT_PREVIOUS_CONTAINER") || return 1
    [ "$current" = "$OLD_QDRANT_ID" ] || return 1
    [ "$(container_image_id "$OLD_QDRANT_ID")" = "$OLD_QDRANT_IMAGE_ID" ] || return 1
    config_hash=$(container_compose_label "$OLD_QDRANT_ID" \
        com.docker.compose.config-hash) || return 1
    [ "$config_hash" = "$OLD_QDRANT_CONFIG_HASH" ] || return 1
    wait_container_running_id "$OLD_QDRANT_ID" false || return 1
    verify_compose_resource_identity "$OLD_QDRANT_ID" "$ORIGINAL_PROJECT" qdrant \
        "$OLD_QDRANT_VOLUME" /qdrant/storage "$STATEFUL_NETWORK"
}

remove_verified_qdrant_previous_container_if_present() {
    local current
    current=$(query_container_id "$QDRANT_PREVIOUS_CONTAINER") || return 1
    if [ -z "$current" ]; then
        QDRANT_PREVIOUS_PRESERVED=false
        return 0
    fi
    [ "$current" = "$OLD_QDRANT_ID" ] || return 1
    verify_qdrant_rollback_assets || return 1
    verify_qdrant_previous_container_contract || return 1
    run_bounded_docker_mutation rm "$OLD_QDRANT_ID" >/dev/null || return 1
    wait_container_mapping "$QDRANT_PREVIOUS_CONTAINER" "" || return 1
    QDRANT_PREVIOUS_PRESERVED=false
    verify_qdrant_rollback_assets
}

postgres_fingerprint() {
    local output_file="$1" container=${2:-$POSTGRES_CONTAINER}
    run_bounded_docker_read_with_timeout "$FINGERPRINT_TIMEOUT_SECONDS" \
        exec -i "$container" sh -ec \
        'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt' \
        > "$output_file" <<'SQL'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
CREATE TEMP TABLE diva_relation_fingerprint (
    relation_name text PRIMARY KEY,
    row_count text NOT NULL,
    content_sum_seed_0 text NOT NULL,
    content_sum_seed_1 text NOT NULL
) ON COMMIT DROP;
CREATE TEMP TABLE diva_sequence_fingerprint (
    sequence_name text PRIMARY KEY,
    last_value text,
    is_called text NOT NULL
) ON COMMIT DROP;
DO $diva_postgres_logical_fingerprint$
DECLARE
    relation_record record;
    sequence_record record;
    row_predicate text;
BEGIN
    FOR relation_record IN
        SELECT
            namespace.nspname || '.' || relation.relname AS identity,
            format('%I.%I', namespace.nspname, relation.relname) AS qualified_name
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE relation.relkind IN ('r', 'p', 'm')
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND NOT (
              namespace.nspname = 'public'
              AND relation.relname IN (
                  'youtube_playlist_cache',
                  'nico_playlist_cache'
              )
          )
        ORDER BY namespace.nspname, relation.relname
    LOOP
        row_predicate := CASE
            WHEN relation_record.identity = 'public.sync_state' THEN
                $$WHERE key NOT IN (
                    'diva_stateful_maintenance_gate',
                    'diva_stateful_maintenance_login_roles'
                )$$
            ELSE ''
        END;
        EXECUTE format(
            'INSERT INTO diva_relation_fingerprint '
            || '(relation_name, row_count, content_sum_seed_0, content_sum_seed_1) '
            || 'SELECT %L, count(*)::text, '
            || 'COALESCE(sum(hashtextextended(to_jsonb(row_value)::text, 0)::numeric), 0)::text, '
            || 'COALESCE(sum(hashtextextended(to_jsonb(row_value)::text, 20260830)::numeric), 0)::text '
            || 'FROM %s AS row_value %s',
            relation_record.identity,
            relation_record.qualified_name,
            row_predicate
        );
    END LOOP;

    FOR sequence_record IN
        SELECT
            namespace.nspname || '.' || sequence.relname AS identity,
            format('%I.%I', namespace.nspname, sequence.relname) AS qualified_name
        FROM pg_class AS sequence
        JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
        WHERE sequence.relkind = 'S'
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
        ORDER BY namespace.nspname, sequence.relname
    LOOP
        EXECUTE format(
            'INSERT INTO diva_sequence_fingerprint '
            || '(sequence_name, last_value, is_called) '
            || 'SELECT %L, last_value::text, is_called::text FROM %s',
            sequence_record.identity,
            sequence_record.qualified_name
        );
    END LOOP;
END;
$diva_postgres_logical_fingerprint$;
SELECT jsonb_build_object(
    'databaseOid', (SELECT oid FROM pg_database WHERE datname = current_database()),
    'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
    'publicationGeneration', (
        SELECT value FROM public.sync_state
        WHERE key = 'recommendation_publication_generation'
    ),
    'migrations', (
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', migration_id,
                    'sha256', content_sha256,
                    'mode', execution_mode
                ) ORDER BY migration_id
            ),
            '[]'::jsonb
        )
        FROM public.schema_migrations
    ),
    'ephemeralRelationsExcluded', jsonb_build_array(
        'public.nico_playlist_cache',
        'public.youtube_playlist_cache'
    ),
    'relations', (
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'name', relation_name,
                    'rows', row_count,
                    'sum0', content_sum_seed_0,
                    'sum1', content_sum_seed_1
                ) ORDER BY relation_name
            ),
            '[]'::jsonb
        )
        FROM diva_relation_fingerprint
    ),
    'sequences', (
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'name', sequence_name,
                    'lastValue', last_value,
                    'isCalled', is_called
                ) ORDER BY sequence_name
            ),
            '[]'::jsonb
        )
        FROM diva_sequence_fingerprint
    )
)::text;
ROLLBACK;
SQL
}

verify_qdrant_runtime() {
    local expected_id="$1" container="$2" actual_id user read_only cap_drop cap_add security \
        port_bindings mount_name
    actual_id=$(container_image_id "$container") || return 1
    [ "$actual_id" = "$expected_id" ] || return 1
    user=$(run_bounded_docker_read inspect --format '{{.Config.User}}' "$container") || return 1
    [ "$user" = "1000:1000" ] || return 1
    read_only=$(run_bounded_docker_read inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container") || return 1
    [ "$read_only" = "true" ] || return 1
    cap_drop=$(run_bounded_docker_read inspect --format '{{json .HostConfig.CapDrop}}' "$container") || return 1
    [ "$cap_drop" = '["ALL"]' ] || return 1
    cap_add=$(run_bounded_docker_read inspect --format '{{json .HostConfig.CapAdd}}' "$container") || return 1
    case "$cap_add" in null|'[]') ;; *) return 1 ;; esac
    security=$(run_bounded_docker_read inspect --format '{{json .HostConfig.SecurityOpt}}' "$container") || return 1
    case "$security" in '["no-new-privileges:true"]'|'["no-new-privileges"]') ;; *) return 1 ;; esac
    port_bindings=$(run_bounded_docker_read inspect --format '{{json .HostConfig.PortBindings}}' "$container") || return 1
    verify_loopback_port_bindings "$port_bindings" 6333 6334 || return 1
    mount_name=$(run_bounded_docker_read inspect --format '{{range .Mounts}}{{if eq .Destination "/qdrant/storage"}}{{.Name}}{{end}}{{end}}' "$container") || return 1
    [ -n "$mount_name" ] || return 1
}

verify_image_label() {
    local image_id="$1" label="$2" expected="$3" actual
    actual=$(run_bounded_docker_read image inspect --format \
        "{{index .Config.Labels \"$label\"}}" "$image_id") || return 1
    [ "$actual" = "$expected" ]
}

verify_postgres_candidate_image() {
    local image_id="$1" dockerfile_sha="$2" schema_sha="$3" source_bundle_sha="$4" \
        build_timestamp="$5" user entrypoint command
    verify_image_label "$image_id" com.diva.postgres.base-digest \
        sha256:421b84e07a72bb8f3715f20501a1fdbe1219aad1fa4af7786a49d9a3f2480296 \
        || return 1
    verify_image_label "$image_id" com.diva.postgres.pg-major 16 || return 1
    verify_image_label "$image_id" com.diva.postgres.pg-version 16.15 || return 1
    verify_image_label "$image_id" com.diva.postgres.pgvector-version 0.8.6 || return 1
    verify_image_label "$image_id" com.diva.postgres.pgvector-commit \
        8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c || return 1
    verify_image_label "$image_id" com.diva.postgres.dockerfile-sha256 \
        "$dockerfile_sha" || return 1
    verify_image_label "$image_id" com.diva.postgres.schema-sha256 \
        "$schema_sha" || return 1
    verify_image_label "$image_id" com.diva.postgres.source-bundle-sha256 \
        "$source_bundle_sha" || return 1
    verify_image_label "$image_id" com.diva.postgres.build-timestamp \
        "$build_timestamp" || return 1
    verify_image_label "$image_id" com.diva.postgres.runtime-contract \
        alpine-root-init-su-exec-uid999-v1 || return 1
    user=$(run_bounded_docker_read image inspect --format '{{.Config.User}}' "$image_id") \
        || return 1
    [ -z "$user" ] || [ "$user" = 0 ] || [ "$user" = 0:0 ] || return 1
    entrypoint=$(run_bounded_docker_read image inspect --format \
        '{{json .Config.Entrypoint}}' "$image_id") || return 1
    [ "$entrypoint" = '["docker-entrypoint.sh"]' ] || return 1
    command=$(run_bounded_docker_read image inspect --format '{{json .Config.Cmd}}' "$image_id") \
        || return 1
    [ "$command" = '["postgres"]' ]
}

verify_postgres_migrate_candidate_image() {
    local image_id="$1" dockerfile_sha="$2" build_timestamp="$3" user entrypoint command
    verify_image_label "$image_id" com.diva.postgres-migrate.base-digest \
        sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659 \
        || return 1
    verify_image_label "$image_id" com.diva.postgres-migrate.pg-major 16 || return 1
    verify_image_label "$image_id" com.diva.postgres-migrate.pg-version 16.15 || return 1
    verify_image_label "$image_id" com.diva.postgres-migrate.dockerfile-sha256 \
        "$dockerfile_sha" || return 1
    verify_image_label "$image_id" com.diva.postgres-migrate.build-timestamp \
        "$build_timestamp" || return 1
    verify_image_label "$image_id" com.diva.postgres-migrate.runtime-contract \
        rootless-readonly-psql-client-v1 || return 1
    user=$(run_bounded_docker_read image inspect --format '{{.Config.User}}' "$image_id") \
        || return 1
    [ "$user" = 65534:65534 ] || return 1
    entrypoint=$(run_bounded_docker_read image inspect --format \
        '{{json .Config.Entrypoint}}' "$image_id") || return 1
    [ "$entrypoint" = '["psql"]' ] || return 1
    command=$(run_bounded_docker_read image inspect --format '{{json .Config.Cmd}}' "$image_id") \
        || return 1
    [ "$command" = null ] || [ "$command" = '[]' ]
}

verify_postgres_runtime() {
    local expected_id="$1" container="$2" actual_id version extension port_bindings \
        cap_drop cap_add security
    actual_id=$(container_image_id "$container") || return 1
    [ "$actual_id" = "$expected_id" ] || return 1
    version=$(run_bounded_docker_read exec "$container" sh -ec \
        'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SHOW server_version_num"') || return 1
    [ "$version" = "160015" ] || return 1
    extension=$(run_bounded_docker_read exec "$container" sh -ec \
        'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT extversion FROM pg_extension WHERE extname='"'"'vector'"'"'"') || return 1
    [ "$extension" = "0.8.2" ] || return 1
    port_bindings=$(run_bounded_docker_read inspect --format '{{json .HostConfig.PortBindings}}' "$container") || return 1
    verify_loopback_port_bindings "$port_bindings" 5432 || return 1
    cap_drop=$(run_bounded_docker_read inspect --format '{{json .HostConfig.CapDrop}}' "$container") || return 1
    [ "$cap_drop" = '["ALL"]' ] || return 1
    cap_add=$(run_bounded_docker_read inspect --format '{{json .HostConfig.CapAdd}}' "$container") || return 1
    [ "$cap_add" = '["CAP_CHOWN","CAP_DAC_OVERRIDE","CAP_FOWNER","CAP_SETGID","CAP_SETUID"]' ] \
        || return 1
    security=$(run_bounded_docker_read inspect --format '{{json .HostConfig.SecurityOpt}}' "$container") || return 1
    case "$security" in '["no-new-privileges:true"]'|'["no-new-privileges"]') ;; *) return 1 ;; esac
}

restore_qdrant() {
    local current archived
    current=$(query_container_id "$QDRANT_CONTAINER") || return 1
    if [ -n "$current" ] && [ "$current" != "$OLD_QDRANT_ID" ]; then
        [ "$current" = "$NEW_QDRANT_CONTAINER_ID" ] \
            || [ "$current" = "$QDRANT_FALLBACK_ID" ] || return 1
        run_bounded_docker_mutation stop --time 120 "$current" >/dev/null 2>&1 \
            || return 1
        wait_container_running_id "$current" false || return 1
        run_bounded_docker_mutation rm "$current" >/dev/null 2>&1 || return 1
        wait_container_mapping "$QDRANT_CONTAINER" "" || return 1
    fi
    current=$(query_container_id "$QDRANT_CONTAINER") || return 1
    if [ "$current" != "$OLD_QDRANT_ID" ]; then
        archived=$(query_container_id "$QDRANT_PREVIOUS_CONTAINER") || return 1
        [ "$archived" = "$OLD_QDRANT_ID" ] || return 1
        run_bounded_docker_mutation rename "$OLD_QDRANT_ID" "$QDRANT_CONTAINER" \
            >/dev/null 2>&1 || return 1
        wait_container_mapping "$QDRANT_CONTAINER" "$OLD_QDRANT_ID" || return 1
        wait_container_mapping "$QDRANT_PREVIOUS_CONTAINER" "" || return 1
    fi
    run_bounded_docker_mutation start "$OLD_QDRANT_ID" >/dev/null 2>&1 || return 1
    wait_container_running_id "$OLD_QDRANT_ID" true || return 1
    wait_qdrant || return 1
    qdrant_fingerprint "$RUN_DIR/qdrant-restored.json" || return 1
    cmp -s "$RUN_DIR/qdrant-before.json" "$RUN_DIR/qdrant-restored.json" || return 1
    verify_compose_resource_identity "$OLD_QDRANT_ID" "$ORIGINAL_PROJECT" qdrant \
        "$OLD_QDRANT_VOLUME" /qdrant/storage "$STATEFUL_NETWORK" || return 1
    MANAGEMENT_RECONCILIATION_REQUIRED=true
    record_state qdrant.management candidate-artifacts-retained-for-inspection
    QDRANT_PREVIOUS_PRESERVED=false
    QDRANT_FALLBACK_PRESERVED=false
    QDRANT_MUTATED=false
}

restore_postgres() {
    local current recovery_id archive_name recovery_project
    recovery_id="$OLD_POSTGRES_ID"
    archive_name="$POSTGRES_PREVIOUS_CONTAINER"
    recovery_project="$ORIGINAL_PROJECT"
    if [ "$POSTGRES_FALLBACK_PRESERVED" = "true" ]; then
        recovery_id="$POSTGRES_FALLBACK_ID"
        archive_name="$POSTGRES_FALLBACK_CONTAINER"
        recovery_project="$CANDIDATE_PROJECT"
    fi
    if ! current=$(query_container_id "$POSTGRES_CONTAINER"); then return 1; fi
    if [ -n "$current" ] && [ "$current" != "$recovery_id" ]; then
        run_bounded_docker_mutation rm -f "$current" >/dev/null 2>&1 || return 1
        wait_container_mapping "$POSTGRES_CONTAINER" "" || return 1
    fi
    if ! current=$(query_container_id "$POSTGRES_CONTAINER"); then return 1; fi
    if [ "$current" != "$recovery_id" ]; then
        if ! current=$(query_container_id "$archive_name"); then return 1; fi
        [ "$current" = "$recovery_id" ] || return 1
        run_bounded_docker_mutation rename "$recovery_id" "$POSTGRES_CONTAINER" \
            >/dev/null 2>&1 || return 1
        wait_container_mapping "$POSTGRES_CONTAINER" "$recovery_id" || return 1
        wait_container_mapping "$archive_name" "" || return 1
    fi
    run_bounded_docker_mutation start "$recovery_id" >/dev/null 2>&1 || return 1
    wait_container_running_id "$recovery_id" true || return 1
    wait_postgres || return 1
    postgres_fingerprint "$RUN_DIR/postgres-restored.json" || return 1
    cmp -s "$RUN_DIR/postgres-before.json" "$RUN_DIR/postgres-restored.json" || return 1
    verify_compose_resource_identity "$recovery_id" "$recovery_project" postgres \
        "$POSTGRES_VOLUME" /var/lib/postgresql/data "$STATEFUL_NETWORK" || return 1
    MANAGEMENT_RECONCILIATION_REQUIRED=true
    if [ "$POSTGRES_FALLBACK_PRESERVED" = "true" ]; then
        record_state postgres.management original-compose-reconciliation-required
    else
        record_state postgres.management legacy-runtime-compose-reconciliation-required
    fi
    POSTGRES_PREVIOUS_PRESERVED=false
    POSTGRES_FALLBACK_PRESERVED=false
    POSTGRES_MUTATED=false
}

durable_sync_path() {
    local path="$1"
    if sync -f "$path" 2>/dev/null; then
        return 0
    fi
    sync
}

durable_unlink_exact() {
    local path="$1" parent
    case "$path" in
        "$RUN_DIR"/*|"$STATE_ROOT/backend.env.private") ;;
        *) return 1 ;;
    esac
    parent=$(dirname "$path") || return 1
    if [ -e "$path" ] || [ -L "$path" ]; then
        rm -f -- "$path" || return 1
        [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
    fi
    durable_sync_path "$parent"
}

release_stateful_lock_exact() {
    local owner="$LOCK_DIR/owner" entry_count owner_token
    [ "$LOCK_HELD" = "true" ] || return 0
    [ -n "$LOCK_OWNER_TOKEN" ] || return 1
    [ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ] \
        && [ "$(stat -c '%a' "$LOCK_DIR")" = 700 ] \
        && [ "$(stat -c '%u:%g' "$LOCK_DIR")" = "$(stat -c '%u:%g' "$STATE_ROOT")" ] \
        || return 1
    entry_count=$(find "$LOCK_DIR" -mindepth 1 -maxdepth 1 -print | wc -l) \
        || return 1
    if [ -e "$owner" ] || [ -L "$owner" ]; then
        [ "$entry_count" -eq 1 ] \
            && [ -f "$owner" ] && [ ! -L "$owner" ] \
            && [ "$(stat -c '%a' "$owner")" = 600 ] \
            && [ "$(stat -c '%u:%g' "$owner")" = "$(stat -c '%u:%g' "$STATE_ROOT")" ] \
            || return 1
        owner_token=$(cat "$owner") || return 1
        [ "$owner_token" = "$LOCK_OWNER_TOKEN" ] || return 1
        rm -f -- "$owner" || return 1
        [ ! -e "$owner" ] && [ ! -L "$owner" ] || return 1
        durable_sync_path "$LOCK_DIR" || return 1
    else
        [ "$entry_count" -eq 0 ] || return 1
    fi
    rmdir "$LOCK_DIR" || return 1
    [ ! -e "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ] || return 1
    durable_sync_path "$STATE_ROOT" || return 1
    LOCK_HELD=false
}

release_active_journal_exact() {
    local journal_value
    [ "$ACTIVE_JOURNAL_CREATED" = "true" ] || return 0
    if [ -e "$ACTIVE_JOURNAL" ] || [ -L "$ACTIVE_JOURNAL" ]; then
        [ -f "$ACTIVE_JOURNAL" ] && [ ! -L "$ACTIVE_JOURNAL" ] || return 1
        journal_value=$(cat "$ACTIVE_JOURNAL") || return 1
        [ "$journal_value" = "$RUN_DIR" ] || return 1
        rm -f -- "$ACTIVE_JOURNAL" || return 1
        [ ! -e "$ACTIVE_JOURNAL" ] && [ ! -L "$ACTIVE_JOURNAL" ] || return 1
    fi
    durable_sync_path "$STATE_ROOT" || return 1
    ACTIVE_JOURNAL_CREATED=false
}

discard_backend_env_backup() {
    [ "$BACKEND_ENV_BACKUP_OWNED" = "true" ] || return 0
    durable_unlink_exact "$BACKEND_ENV_BACKUP" || return 1
    BACKEND_ENV_BACKUP_OWNED=false
    record_state qdrant.compose_volume_backup durable-unlinked
}

run_qdrant_controller_supervised() {
    local test_controller_python test_controller_runner test_controller_state
    [ ! -e "$QDRANT_CONTROLLER_LOG" ] && [ ! -L "$QDRANT_CONTROLLER_LOG" ] \
        && [ ! -e "$QDRANT_CONTROLLER_SETTLEMENT" ] \
        && [ ! -L "$QDRANT_CONTROLLER_SETTLEMENT" ] || return 1
    if [ "$TEST_MODE" = "1" ]; then
        test_controller_python=${DIVA_STATEFUL_TEST_CONTROLLER_PYTHON:-}
        test_controller_runner=${DIVA_STATEFUL_TEST_CONTROLLER_RUNNER:-}
        test_controller_state=${DIVA_STATEFUL_TEST_CONTROLLER_STATE:-}
        [ -n "$test_controller_python" ] && [ -n "$test_controller_runner" ] \
            && [ -n "$test_controller_state" ] && [ "$#" -ge 1 ] || return 1
        shift
        set -- "$test_controller_python" "$test_controller_runner" \
            "$test_controller_state" "$@"
    fi
    "$PYTHON_COMMAND" -I -B - \
        "$RUN_ID" "$QDRANT_CONTROLLER_SETTLEMENT" "$QDRANT_CONTROLLER_LOG" \
        "$QDRANT_UPGRADE_JOURNAL" "$QDRANT_UPGRADE_RESULT" \
        "$QDRANT_UPGRADE_TIMEOUT_SECONDS" "$@" <<'PY'
import datetime as dt
import hashlib
import json
import os
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

(
    run_id, settlement_text, log_text, journal_text, result_text,
    timeout_text, *command,
) = sys.argv[1:]
if not command or not timeout_text.isdecimal() or int(timeout_text) <= 0:
    raise SystemExit(126)
timeout_seconds = int(timeout_text)
settlement_path = Path(settlement_text)
log_path = Path(log_text)
journal_path = Path(journal_text)
result_path = Path(result_text)
for target in (settlement_path, log_path):
    if target.exists() or target.is_symlink():
        raise SystemExit(126)

def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

def artifact(path, *, json_required=False, allow_empty=False):
    try:
        before = os.lstat(path)
    except FileNotFoundError:
        return {"status": "missing"}
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or (before.st_size == 0 and not allow_empty)
            or before.st_size > 128 * 1024 * 1024):
        return {"status": "unsafe"}
    flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
             | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink, opened.st_size) != (
            before.st_dev, before.st_ino, before.st_mode, before.st_nlink, before.st_size
        ):
            return {"status": "unsafe"}
        payload = bytearray()
        while len(payload) < opened.st_size:
            chunk = os.read(descriptor, min(1024 * 1024, opened.st_size - len(payload)))
            if not chunk:
                return {"status": "unsafe"}
            payload.extend(chunk)
        if os.read(descriptor, 1):
            return {"status": "unsafe"}
        after = os.fstat(descriptor)
        if (after.st_dev, after.st_ino, after.st_mode, after.st_nlink, after.st_size) != (
            opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink, opened.st_size
        ):
            return {"status": "unsafe"}
    finally:
        os.close(descriptor)
    raw = bytes(payload)
    if json_required:
        try:
            document = json.loads(raw)
        except (UnicodeDecodeError, ValueError):
            return {"status": "unsafe"}
        canonical = (json.dumps(document, ensure_ascii=True, sort_keys=True,
                                separators=(",", ":")) + "\n").encode()
        if canonical != raw:
            return {"status": "unsafe"}
    return {
        "status": "captured",
        "sha256": hashlib.sha256(raw).hexdigest(),
        "size": len(raw),
    }

def group_exists(process_group_id):
    if os.name != "posix":
        return child.poll() is None
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True

def signal_group(process_group_id, selected_signal):
    try:
        if os.name == "posix":
            os.killpg(process_group_id, selected_signal)
        elif child.poll() is None:
            child.terminate() if selected_signal == signal.SIGTERM else child.kill()
    except ProcessLookupError:
        pass

def drain_group(process_group_id):
    signal_group(process_group_id, signal.SIGTERM)
    deadline = time.monotonic() + 30
    while group_exists(process_group_id) and time.monotonic() < deadline:
        time.sleep(0.1)
    if group_exists(process_group_id):
        signal_group(process_group_id, getattr(signal, "SIGKILL", signal.SIGTERM))
        deadline = time.monotonic() + 10
        while group_exists(process_group_id) and time.monotonic() < deadline:
            time.sleep(0.1)
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        signal_group(process_group_id, getattr(signal, "SIGKILL", signal.SIGTERM))
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    return not group_exists(process_group_id)

termination_signal = None
def request_termination(signum, _frame):
    global termination_signal
    termination_signal = signum

for signal_name in ("SIGHUP", "SIGINT", "SIGTERM"):
    candidate_signal = getattr(signal, signal_name, None)
    if candidate_signal is None:
        continue
    try:
        signal.signal(candidate_signal, request_termination)
    except (AttributeError, OSError, ValueError):
        pass

started_at = utc_now()
log_descriptor = os.open(
    log_path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_BINARY", 0),
    0o600,
)
child = None
process_group_id = None
timed_out = False
unexpected_survivor = False
spawn_error = None
try:
    try:
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        child = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=log_descriptor,
            stderr=subprocess.STDOUT,
            close_fds=True,
            start_new_session=(os.name == "posix"),
            creationflags=creationflags,
        )
        process_group_id = child.pid
    except OSError as error:
        spawn_error = f"{type(error).__name__}:{getattr(error, 'errno', None)}"

    if child is not None:
        deadline = time.monotonic() + timeout_seconds
        while child.poll() is None and termination_signal is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            time.sleep(min(0.1, remaining))
        forced = timed_out or termination_signal is not None
        if forced:
            drained = drain_group(process_group_id)
        else:
            exit_code = child.wait()
            if group_exists(process_group_id):
                unexpected_survivor = True
                drained = drain_group(process_group_id)
            else:
                drained = True
    else:
        exit_code = None
        drained = True
finally:
    os.fsync(log_descriptor)
    os.close(log_descriptor)

exit_code = child.returncode if child is not None else None
if not drained:
    status = "process-group-drain-failed"
elif spawn_error is not None:
    status = "spawn-failed"
elif timed_out:
    status = "timed-out-drained"
elif termination_signal is not None:
    status = "signal-drained"
elif unexpected_survivor:
    status = "unexpected-descendant-drained"
elif exit_code == 0:
    status = "completed"
else:
    status = "controller-failed"

receipt = {
    "schemaVersion": 1,
    "kind": "diva-qdrant-controller-process-settlement",
    "runId": run_id,
    "startedAt": started_at,
    "completedAt": utc_now(),
    "status": status,
    "exitCode": exit_code,
    "terminationSignal": termination_signal,
    "timedOut": timed_out,
    "processId": child.pid if child is not None else None,
    "processGroupId": process_group_id,
    "processGroupDrained": drained,
    "platform": os.name,
    "commandSha256": hashlib.sha256("\0".join(command).encode()).hexdigest(),
    "spawnError": spawn_error,
    "log": artifact(log_path, allow_empty=True),
    "journal": artifact(journal_path, json_required=True),
    "result": artifact(result_path, json_required=True),
}
payload = (json.dumps(receipt, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":")) + "\n").encode()
descriptor = os.open(
    settlement_path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_BINARY", 0),
    0o600,
)
try:
    os.write(descriptor, payload)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
try:
    directory = os.open(settlement_path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
except PermissionError:
    if os.name != "nt":
        raise
else:
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

if status == "completed":
    raise SystemExit(0)
if status == "timed-out-drained":
    raise SystemExit(124)
if status == "signal-drained" and termination_signal is not None:
    raise SystemExit(min(255, 128 + termination_signal))
raise SystemExit(125)
PY
}

verify_qdrant_controller_settlement() {
    local expected_status="$1"
    case "$expected_status" in success|failure) ;; *) return 1 ;; esac
    "$PYTHON_COMMAND" -I -B - \
        "$expected_status" "$RUN_ID" "$QDRANT_CONTROLLER_SETTLEMENT" \
        "$QDRANT_CONTROLLER_LOG" "$QDRANT_UPGRADE_JOURNAL" \
        "$QDRANT_UPGRADE_RESULT" "$OLD_QDRANT_ID" "$OLD_QDRANT_VOLUME" \
        "$QDRANT_CANDIDATE_VOLUME" "$NEW_QDRANT_ID" "$NEW_QDRANT_AUDIT_ID" <<'PY'
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

(
    expected_status, run_id, settlement_text, log_text, journal_text, result_text,
    old_container_id, old_volume, candidate_volume, final_image_id, audit_image_id,
) = sys.argv[1:]

def read_safe(path_text, maximum=128 * 1024 * 1024, *, allow_empty=False):
    path = Path(path_text)
    before = os.lstat(path)
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or (before.st_size == 0 and not allow_empty) or before.st_size > maximum
            or (os.name == "posix" and stat.S_IMODE(before.st_mode) & 0o077)):
        raise RuntimeError(f"unsafe settlement artifact: {path.name}")
    flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
             | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink, opened.st_size) != (
            before.st_dev, before.st_ino, before.st_mode, before.st_nlink, before.st_size
        ):
            raise RuntimeError("settlement artifact changed while opening")
        payload = bytearray()
        while len(payload) < opened.st_size:
            chunk = os.read(descriptor, min(1024 * 1024, opened.st_size - len(payload)))
            if not chunk:
                raise RuntimeError("settlement artifact was truncated")
            payload.extend(chunk)
        if os.read(descriptor, 1):
            raise RuntimeError("settlement artifact grew")
        after = os.fstat(descriptor)
        if (after.st_dev, after.st_ino, after.st_mode, after.st_nlink, after.st_size) != (
            opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink, opened.st_size
        ):
            raise RuntimeError("settlement artifact changed while reading")
    finally:
        os.close(descriptor)
    return bytes(payload)

def parse_canonical(path_text):
    raw = read_safe(path_text)
    document = json.loads(raw)
    canonical = (json.dumps(document, ensure_ascii=True, sort_keys=True,
                            separators=(",", ":")) + "\n").encode()
    if canonical != raw:
        raise RuntimeError("settlement artifact is not canonical JSON")
    return raw, document

settlement_raw, settlement = parse_canonical(settlement_text)
if (settlement.get("schemaVersion") != 1
        or settlement.get("kind") != "diva-qdrant-controller-process-settlement"
        or settlement.get("runId") != run_id
        or settlement.get("processGroupDrained") is not True):
    raise RuntimeError("controller process settlement is invalid")

def verify_capture(record, path_text, *, required, allow_empty=False):
    if record == {"status": "missing"}:
        if required:
            raise RuntimeError("required controller artifact is missing")
        return None
    if not isinstance(record, dict) or record.get("status") != "captured":
        raise RuntimeError("controller artifact settlement is unsafe")
    raw = read_safe(path_text, allow_empty=allow_empty)
    if (record.get("sha256") != hashlib.sha256(raw).hexdigest()
            or record.get("size") != len(raw)):
        raise RuntimeError("controller artifact changed after settlement")
    return raw

verify_capture(settlement.get("log"), log_text, required=True, allow_empty=True)
success = expected_status == "success"
journal_raw = verify_capture(settlement.get("journal"), journal_text, required=success)
result_raw = verify_capture(settlement.get("result"), result_text, required=success)
if success:
    if (settlement.get("status") != "completed" or settlement.get("exitCode") != 0
            or settlement.get("timedOut") is not False
            or settlement.get("terminationSignal") is not None):
        raise RuntimeError("controller did not settle as a successful process")
    journal = json.loads(journal_raw)
    result = json.loads(result_raw)
    if (journal.get("schemaVersion") != 1
            or journal.get("runId") != run_id
            or journal.get("phase") != "ready-for-coupled-cutover"):
        raise RuntimeError("controller journal did not reach the cutover barrier")
    expected = {
        "status": "ready-for-coupled-cutover",
        "runId": run_id,
        "oldContainerId": old_container_id,
        "oldVolume": old_volume,
        "candidateVolume": candidate_volume,
        "candidateImageId": final_image_id,
        "hardenedFinalImageId": final_image_id,
        "offlineAuditImageId": audit_image_id,
    }
    if any(result.get(key) != value for key, value in expected.items()):
        raise RuntimeError("controller result identity does not match the requested migration")
    if result.get("journalSha256") != hashlib.sha256(journal_raw).hexdigest():
        raise RuntimeError("controller result does not bind the durable journal")
    journal_result = journal.get("result")
    if not isinstance(journal_result, dict):
        raise RuntimeError("controller journal result is missing")
    published_without_journal = dict(result)
    published_without_journal.pop("journalSha256", None)
    if journal_result != published_without_journal:
        raise RuntimeError("published result differs from the journaled result")
else:
    if settlement.get("status") == "completed":
        raise RuntimeError("failure settlement unexpectedly records success")
    allowed_failure_statuses = {
        "controller-failed", "signal-drained", "spawn-failed",
        "timed-out-drained", "unexpected-descendant-drained",
    }
    if settlement.get("status") not in allowed_failure_statuses:
        raise RuntimeError("controller failure settlement status is invalid")
    if (settlement.get("timedOut") is True) != (
        settlement.get("status") == "timed-out-drained"
    ):
        raise RuntimeError("controller timeout settlement is inconsistent")

print(hashlib.sha256(settlement_raw).hexdigest())
PY
}

write_qdrant_controller_daemon_settlement() {
    local final_container_id old_runtime final_runtime network_id \
        process_sha journal_sha result_sha temporary
    final_container_id=$(query_container_id "$QDRANT_FINAL_UPGRADE_CONTAINER") || return 1
    [ -n "$final_container_id" ] || return 1
    [ "$(query_container_id "$QDRANT_CONTAINER")" = "$OLD_QDRANT_ID" ] || return 1
    old_runtime=$(container_runtime_snapshot "$QDRANT_CONTAINER") || return 1
    final_runtime=$(container_runtime_snapshot "$QDRANT_FINAL_UPGRADE_CONTAINER") || return 1
    network_id=$(query_network_id "$QDRANT_UPGRADE_NETWORK") || return 1
    verify_named_volume "$QDRANT_CANDIDATE_VOLUME" || return 1
    process_sha=$(sha256sum "$QDRANT_CONTROLLER_SETTLEMENT" | awk '{print $1}') || return 1
    journal_sha=$(sha256sum "$QDRANT_UPGRADE_JOURNAL" | awk '{print $1}') || return 1
    result_sha=$(sha256sum "$QDRANT_UPGRADE_RESULT" | awk '{print $1}') || return 1
    temporary="$QDRANT_CONTROLLER_DAEMON_SETTLEMENT.tmp"
    [ ! -e "$QDRANT_CONTROLLER_DAEMON_SETTLEMENT" ] \
        && [ ! -L "$QDRANT_CONTROLLER_DAEMON_SETTLEMENT" ] \
        && [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || return 1
    "$PYTHON_COMMAND" -I -B - \
        "$temporary" "$RUN_ID" "$OLD_QDRANT_ID" "$final_container_id" \
        "$NEW_QDRANT_ID" "$OLD_QDRANT_VOLUME" "$QDRANT_CANDIDATE_VOLUME" \
        "$QDRANT_UPGRADE_NETWORK" "$network_id" "$old_runtime" "$final_runtime" \
        "$process_sha" "$journal_sha" "$result_sha" <<'PY'
import json
import os
import sys
from pathlib import Path

(
    output_text, run_id, old_id, candidate_id, image_id, old_volume,
    candidate_volume, network, network_id, old_runtime, candidate_runtime,
    process_sha, journal_sha, result_sha,
) = sys.argv[1:]
document = {
    "schemaVersion": 1,
    "kind": "diva-qdrant-controller-daemon-settlement",
    "runId": run_id,
    "oldContainerId": old_id,
    "candidateContainerId": candidate_id,
    "candidateImageId": image_id,
    "oldVolume": old_volume,
    "candidateVolume": candidate_volume,
    "upgradeNetwork": network,
    "upgradeNetworkId": network_id,
    "oldRuntimeSnapshot": old_runtime,
    "candidateRuntimeSnapshot": candidate_runtime,
    "processSettlementSha256": process_sha,
    "controllerJournalSha256": journal_sha,
    "controllerResultSha256": result_sha,
}
payload = (json.dumps(document, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":")) + "\n").encode()
path = Path(output_text)
descriptor = os.open(
    path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_BINARY", 0),
    0o600,
)
try:
    os.write(descriptor, payload)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
    chmod 600 "$temporary" || return 1
    durable_sync_path "$temporary" || return 1
    mv "$temporary" "$QDRANT_CONTROLLER_DAEMON_SETTLEMENT" || return 1
    durable_sync_path "$RUN_DIR" || return 1
    record_state qdrant.controller_daemon_settlement_sha256 \
        "$(sha256sum "$QDRANT_CONTROLLER_DAEMON_SETTLEMENT" | awk '{print $1}')"
}

write_promotion_manifest() {
    local temporary="$PROMOTION_MANIFEST.tmp" qdrant_fingerprint_sha postgres_fingerprint_sha \
        pipeline_writer_gate_sha qdrant_scan_receipt_sha qdrant_audit_scan_receipt_sha \
        postgres_scan_receipt_sha postgres_migrate_scan_receipt_sha \
        qdrant_rollback_scan_receipt_sha postgres_rollback_scan_receipt_sha \
        qdrant_rollback_volume_identity_sha
    if [ -e "$PROMOTION_MANIFEST" ] || [ -L "$PROMOTION_MANIFEST" ] \
        || [ -e "$temporary" ] || [ -L "$temporary" ]; then
        return 1
    fi
    qdrant_fingerprint_sha=$(sha256sum "$RUN_DIR/qdrant-after.json" | awk '{print $1}') \
        || return 1
    postgres_fingerprint_sha=$(sha256sum "$RUN_DIR/postgres-after.json" | awk '{print $1}') \
        || return 1
    pipeline_writer_gate_sha=$(sha256sum "$PIPELINE_WRITER_GATE_FILE" | awk '{print $1}') \
        || return 1
    qdrant_scan_receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-qdrant-runtime.receipt.json" | awk '{print $1}') \
        || return 1
    qdrant_audit_scan_receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-qdrant-audit.receipt.json" | awk '{print $1}') \
        || return 1
    postgres_scan_receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-postgres-runtime.receipt.json" | awk '{print $1}') \
        || return 1
    postgres_migrate_scan_receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-postgres-migrate.receipt.json" | awk '{print $1}') \
        || return 1
    qdrant_rollback_scan_receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-qdrant-rollback.receipt.json" | awk '{print $1}') \
        || return 1
    postgres_rollback_scan_receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-postgres-rollback.receipt.json" | awk '{print $1}') \
        || return 1
    qdrant_rollback_volume_identity_sha=$(printf '%s\n' "$OLD_QDRANT_VOLUME_IDENTITY" \
        | sha256sum | awk '{print $1}') || return 1
    [ "$qdrant_rollback_scan_receipt_sha" = "$QDRANT_ROLLBACK_SCAN_RECEIPT_SHA" ] \
        && [ "$postgres_rollback_scan_receipt_sha" \
            = "$POSTGRES_ROLLBACK_SCAN_RECEIPT_SHA" ] \
        && [ "$qdrant_rollback_volume_identity_sha" = "$OLD_QDRANT_VOLUME_IDENTITY_SHA" ] \
        || return 1
    case "$qdrant_fingerprint_sha:$postgres_fingerprint_sha:$pipeline_writer_gate_sha:$qdrant_scan_receipt_sha:$qdrant_audit_scan_receipt_sha:$postgres_scan_receipt_sha:$postgres_migrate_scan_receipt_sha:$qdrant_rollback_scan_receipt_sha:$postgres_rollback_scan_receipt_sha:$qdrant_rollback_volume_identity_sha:$OLD_QDRANT_CONFIG_HASH:$dockerfile_sha:$PLAYER_RELEASE_COMMIT" in
        *[!0-9a-f:]*|:|*:|*::* ) return 1 ;;
    esac
    [ "${#qdrant_fingerprint_sha}" -eq 64 ] \
        && [ "${#postgres_fingerprint_sha}" -eq 64 ] \
        && [ "${#pipeline_writer_gate_sha}" -eq 64 ] \
        && [ "${#qdrant_scan_receipt_sha}" -eq 64 ] \
        && [ "${#qdrant_audit_scan_receipt_sha}" -eq 64 ] \
        && [ "${#postgres_scan_receipt_sha}" -eq 64 ] \
        && [ "${#postgres_migrate_scan_receipt_sha}" -eq 64 ] \
        && [ "${#qdrant_rollback_scan_receipt_sha}" -eq 64 ] \
        && [ "${#postgres_rollback_scan_receipt_sha}" -eq 64 ] \
        && [ "${#qdrant_rollback_volume_identity_sha}" -eq 64 ] \
        && [ "${#OLD_QDRANT_CONFIG_HASH}" -eq 64 ] \
        && [ "${#dockerfile_sha}" -eq 64 ] \
        && [ "${#PLAYER_RELEASE_COMMIT}" -eq 40 ] || return 1
    if ! (set -C; {
        printf 'schema=1\nstatus=armed\nrun=%s\n' "$RUN_ID"
        printf 'original_project=%s\ncandidate_project=%s\n' "$ORIGINAL_PROJECT" "$CANDIDATE_PROJECT"
        printf 'qdrant_old_id=%s\nqdrant_candidate_id=%s\nqdrant_image_id=%s\n' \
            "$OLD_QDRANT_ID" "$QDRANT_FALLBACK_ID" "$NEW_QDRANT_ID"
        printf 'qdrant_candidate_tag=%s\nqdrant_stable_tag=%s\n' \
            "$QDRANT_CANDIDATE_IMAGE" "$QDRANT_IMAGE"
        printf 'qdrant_source_commit=%s\nqdrant_dockerfile_sha256=%s\n' \
            "$PLAYER_RELEASE_COMMIT" "$dockerfile_sha"
        printf 'qdrant_rollback_tag=%s\nqdrant_rollback_image_id=%s\n' \
            "$QDRANT_ROLLBACK_IMAGE" "$OLD_QDRANT_IMAGE_ID"
        printf 'qdrant_rollback_volume=%s\nqdrant_rollback_volume_identity_sha256=%s\n' \
            "$OLD_QDRANT_VOLUME" "$qdrant_rollback_volume_identity_sha"
        printf 'qdrant_rollback_compose_project=%s\nqdrant_rollback_compose_service=qdrant\n' \
            "$ORIGINAL_PROJECT"
        printf 'qdrant_rollback_compose_config_hash=%s\n' "$OLD_QDRANT_CONFIG_HASH"
        printf 'qdrant_rollback_scan_receipt_sha256=%s\n' \
            "$qdrant_rollback_scan_receipt_sha"
        printf 'qdrant_previous_stable_image_id=%s\nqdrant_stable_next_image_id=%s\n' \
            "$OLD_STABLE_QDRANT_IMAGE_ID" "$NEW_QDRANT_ID"
        printf 'postgres_old_id=%s\npostgres_candidate_id=%s\npostgres_image_id=%s\n' \
            "$OLD_POSTGRES_ID" "$POSTGRES_FALLBACK_ID" "$NEW_POSTGRES_ID"
        printf 'postgres_candidate_tag=%s\npostgres_stable_tag=%s\n' \
            "$POSTGRES_CANDIDATE_IMAGE" "$POSTGRES_IMAGE"
        printf 'postgres_rollback_tag=%s\npostgres_rollback_image_id=%s\n' \
            "$POSTGRES_ROLLBACK_IMAGE" "$OLD_POSTGRES_IMAGE_ID"
        printf 'postgres_rollback_scan_receipt_sha256=%s\n' \
            "$postgres_rollback_scan_receipt_sha"
        printf '%s\n' 'postgres_rollback_scope=image-only-no-data-rollback'
        printf 'postgres_previous_stable_image_id=%s\npostgres_stable_next_image_id=%s\n' \
            "$OLD_STABLE_POSTGRES_IMAGE_ID" "$NEW_POSTGRES_ID"
        printf 'postgres_migrate_candidate_tag=%s\npostgres_migrate_stable_tag=%s\n' \
            "$POSTGRES_MIGRATE_CANDIDATE_IMAGE" "$POSTGRES_MIGRATE_IMAGE"
        printf 'postgres_migrate_previous_stable_image_id=%s\npostgres_migrate_stable_next_image_id=%s\n' \
            "$OLD_STABLE_POSTGRES_MIGRATE_IMAGE_ID" "$NEW_POSTGRES_MIGRATE_ID"
        printf 'qdrant_volume=%s\npostgres_volume=%s\nnetwork=%s\nnetwork_id=%s\n' \
            "$QDRANT_VOLUME" "$POSTGRES_VOLUME" "$STATEFUL_NETWORK" "$STATEFUL_NETWORK_ID"
        printf 'qdrant_fingerprint_sha256=%s\n' "$qdrant_fingerprint_sha"
        printf 'postgres_fingerprint_sha256=%s\n' "$postgres_fingerprint_sha"
        printf 'pipeline_writer_gate_sha256=%s\n' "$pipeline_writer_gate_sha"
        printf 'qdrant_scan_receipt_sha256=%s\nqdrant_audit_scan_receipt_sha256=%s\n' \
            "$qdrant_scan_receipt_sha" "$qdrant_audit_scan_receipt_sha"
        printf 'postgres_scan_receipt_sha256=%s\npostgres_migrate_scan_receipt_sha256=%s\n' \
            "$postgres_scan_receipt_sha" "$postgres_migrate_scan_receipt_sha"
        printf '%s\n' \
            'steps=rollback-image-bind-qdrant,rollback-image-bind-postgres,stable-image-bind-qdrant,stable-image-bind-postgres,stable-image-bind-postgres-migrate,qdrant-fallback,qdrant-original,postgres-fallback,postgres-original,public-verify,promoted-marker,cleanup,completed-marker'
    } > "$temporary") 2>/dev/null; then
        return 1
    fi
    chmod 600 "$temporary" || return 1
    durable_sync_path "$temporary" || return 1
    mv "$temporary" "$PROMOTION_MANIFEST" || return 1
    durable_sync_path "$RUN_DIR" || return 1
}

write_promoted_marker() {
    local temporary="$PROMOTED_MARKER.tmp"
    if [ -e "$PROMOTED_MARKER" ] || [ -L "$PROMOTED_MARKER" ] \
        || [ -e "$temporary" ] || [ -L "$temporary" ]; then
        return 1
    fi
    if ! (set -C; {
        printf 'schema=1\nstatus=promoted\nrun=%s\n' "$RUN_ID"
        printf 'qdrant_container_id=%s\npostgres_container_id=%s\n' \
            "$NEW_QDRANT_CONTAINER_ID" "$NEW_POSTGRES_CONTAINER_ID"
        printf 'project=%s\nnetwork_id=%s\n' "$ORIGINAL_PROJECT" "$STATEFUL_NETWORK_ID"
    } > "$temporary") 2>/dev/null; then
        return 1
    fi
    chmod 600 "$temporary" || return 1
    durable_sync_path "$temporary" || return 1
    mv "$temporary" "$PROMOTED_MARKER" || return 1
    durable_sync_path "$RUN_DIR" || return 1
}

write_completed_marker() {
    local temporary="$COMPLETED_MARKER.tmp"
    if [ -e "$COMPLETED_MARKER" ] || [ -L "$COMPLETED_MARKER" ] \
        || [ -e "$temporary" ] || [ -L "$temporary" ]; then
        return 1
    fi
    if ! (set -C; printf 'schema=1\nstatus=completed\nrun=%s\n' "$RUN_ID" > "$temporary") \
        2>/dev/null; then
        return 1
    fi
    chmod 600 "$temporary" || return 1
    durable_sync_path "$temporary" || return 1
    mv "$temporary" "$COMPLETED_MARKER" || return 1
    durable_sync_path "$RUN_DIR" || return 1
}

write_stateful_compose_projection() {
    local command_status=0 cleanup_status=0
    [ ! -e "$STATEFUL_PROJECTION" ] && [ ! -L "$STATEFUL_PROJECTION" ] \
        && [ ! -e "$RESOLVED_COMPOSE_PRIVATE" ] && [ ! -L "$RESOLVED_COMPOSE_PRIVATE" ] \
        || return 1
    # Redirection creates this file before Docker starts.  Mark it as ours first
    # so the EXIT/signal cleanup can remove partial output even if Docker hangs
    # or the shell is interrupted between the redirection and command return.
    RESOLVED_COMPOSE_PRIVATE_OWNED=true
    run_bounded_docker_read compose --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
        --project-name "$ORIGINAL_PROJECT" \
        -f "$COMPOSE_FILE" config --format json > "$RESOLVED_COMPOSE_PRIVATE" \
        || command_status=$?
    if [ "$command_status" -eq 0 ]; then
        chmod 600 "$RESOLVED_COMPOSE_PRIVATE" || command_status=$?
    fi
    if [ "$command_status" -eq 0 ]; then
        run_bounded_read_command "$PYTHON_COMMAND" -I -B - \
            "$RESOLVED_COMPOSE_PRIVATE" "$STATEFUL_PROJECTION" <<'PY' \
            || command_status=$?
import copy
import hashlib
import json
import sys

source_path, output_path = sys.argv[1:]
with open(source_path, "rb") as handle:
    source_bytes = handle.read(4 * 1024 * 1024 + 1)
if len(source_bytes) > 4 * 1024 * 1024:
    raise RuntimeError("resolved Compose document exceeds the projection limit")
source = json.loads(source_bytes.decode("utf-8"))
if not isinstance(source, dict):
    raise RuntimeError("resolved Compose document is invalid")
all_services = source.get("services")
all_volumes = source.get("volumes") or {}
all_networks = source.get("networks") or {}
if not isinstance(all_services, dict) or not isinstance(all_volumes, dict) \
        or not isinstance(all_networks, dict):
    raise RuntimeError("resolved Compose resources are invalid")

services = {}
volume_sources = set()
network_sources = set()
for service_name in ("postgres", "qdrant"):
    service = copy.deepcopy(all_services.get(service_name))
    if not isinstance(service, dict):
        raise RuntimeError(f"stateful Compose service is missing: {service_name}")
    environment = service.get("environment")
    if environment is not None:
        if not isinstance(environment, dict):
            raise RuntimeError(f"stateful environment is not normalized: {service_name}")
        service["environment"] = {
            key: hashlib.sha256(json.dumps(
                [key, value],
                ensure_ascii=True,
                separators=(",", ":"),
            ).encode("utf-8")).hexdigest()
            for key, value in sorted(environment.items())
        }
    for mount in service.get("volumes") or []:
        if not isinstance(mount, dict):
            raise RuntimeError(f"stateful volume mount is not normalized: {service_name}")
        if mount.get("type") == "volume":
            source_name = mount.get("source")
            if not isinstance(source_name, str) or not source_name:
                raise RuntimeError(f"stateful volume source is invalid: {service_name}")
            volume_sources.add(source_name)
    networks = service.get("networks") or {}
    if isinstance(networks, dict):
        network_sources.update(networks)
    elif isinstance(networks, list) and all(isinstance(item, str) for item in networks):
        network_sources.update(networks)
    else:
        raise RuntimeError(f"stateful network list is not normalized: {service_name}")
    services[service_name] = service

def project_resources(resources, referenced, label):
    projected = {}
    for source_name in sorted(referenced):
        matches = [
            (key, value)
            for key, value in resources.items()
            if key == source_name
            or (isinstance(value, dict) and value.get("name") == source_name)
        ]
        if len(matches) != 1:
            raise RuntimeError(f"{label} source is not uniquely defined: {source_name}")
        key, value = matches[0]
        projected[key] = value
    return projected

projection = {
    "networks": project_resources(all_networks, network_sources, "network"),
    "schema": 1,
    "services": services,
    "volumes": project_resources(all_volumes, volume_sources, "volume"),
}
with open(output_path, "x", encoding="utf-8", newline="\n") as handle:
    json.dump(projection, handle, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
PY
    fi
    durable_unlink_exact "$RESOLVED_COMPOSE_PRIVATE" || cleanup_status=$?
    if [ -e "$RESOLVED_COMPOSE_PRIVATE" ] || [ -L "$RESOLVED_COMPOSE_PRIVATE" ]; then
        cleanup_status=1
    else
        RESOLVED_COMPOSE_PRIVATE_OWNED=false
    fi
    [ "$cleanup_status" -eq 0 ] || return 1
    [ "$command_status" -eq 0 ] || {
        rm -f -- "$STATEFUL_PROJECTION" 2>/dev/null || true
        return "$command_status"
    }
    chmod 600 "$STATEFUL_PROJECTION" || return 1
    durable_sync_path "$STATEFUL_PROJECTION" || return 1
    durable_sync_path "$RUN_DIR" || return 1
}

prepare_runtime_contract() {
    local projection_sha promotion_sha player_commit pipeline_commit stable_image_id \
        postgres_image_id postgres_migrate_image_id qdrant_scan_receipt_sha \
        qdrant_audit_scan_receipt_sha postgres_scan_receipt_sha \
        postgres_migrate_scan_receipt_sha
    [ ! -e "$RUNTIME_CONTRACT_PREPARED" ] && [ ! -L "$RUNTIME_CONTRACT_PREPARED" ] \
        || return 1
    write_stateful_compose_projection || return 1
    projection_sha=$(sha256sum "$STATEFUL_PROJECTION" | awk '{print $1}') || return 1
    promotion_sha=$(sha256sum "$PROMOTION_MANIFEST" | awk '{print $1}') || return 1
    verify_release_sources_unchanged || return 1
    player_commit=$PLAYER_RELEASE_COMMIT
    pipeline_commit=$PIPELINE_RELEASE_COMMIT
    stable_image_id=$(query_optional_image_id "$QDRANT_IMAGE") || return 1
    postgres_image_id=$(query_image_id "$POSTGRES_IMAGE") || return 1
    postgres_migrate_image_id=$(query_image_id "$POSTGRES_MIGRATE_IMAGE") || return 1
    [ "$stable_image_id" = "$NEW_QDRANT_ID" ] \
        && [ "$postgres_image_id" = "$NEW_POSTGRES_ID" ] \
        && [ "$postgres_migrate_image_id" = "$NEW_POSTGRES_MIGRATE_ID" ] || return 1
    qdrant_scan_receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-qdrant-runtime.receipt.json" | awk '{print $1}') \
        || return 1
    qdrant_audit_scan_receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-qdrant-audit.receipt.json" | awk '{print $1}') \
        || return 1
    postgres_scan_receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-postgres-runtime.receipt.json" | awk '{print $1}') \
        || return 1
    postgres_migrate_scan_receipt_sha=$(sha256sum \
        "$RUN_DIR/evidence/image-scan-postgres-migrate.receipt.json" | awk '{print $1}') \
        || return 1
    case "$projection_sha:$promotion_sha" in
        *[!0-9a-f:]*|:|*:|*::* ) return 1 ;;
    esac
    [ "${#projection_sha}" -eq 64 ] && [ "${#promotion_sha}" -eq 64 ] || return 1
    for contract_sha in "$qdrant_scan_receipt_sha" "$qdrant_audit_scan_receipt_sha" \
        "$postgres_scan_receipt_sha" "$postgres_migrate_scan_receipt_sha" \
        "$postgres_dockerfile_sha" "$postgres_schema_sha" \
        "$postgres_source_bundle_sha" "$postgres_migrate_dockerfile_sha" \
        "$dockerfile_sha"; do
        case "$contract_sha" in ''|*[!0-9a-f]*) return 1 ;; esac
        [ "${#contract_sha}" -eq 64 ] || return 1
    done
    case "$player_commit:$pipeline_commit" in
        *[!0-9a-f:]*|:|*:|*::* ) return 1 ;;
    esac
    [ "${#player_commit}" -eq 40 ] && [ "${#pipeline_commit}" -eq 40 ] || return 1
    if ! (set -C; {
        printf 'schema=1\nstatus=completed\nrun=%s\n' "$RUN_ID"
        printf 'qdrant_stable_tag=%s\nqdrant_image_id=%s\n' \
            "$QDRANT_IMAGE" "$NEW_QDRANT_ID"
        printf 'qdrant_source_commit=%s\nqdrant_dockerfile_sha256=%s\n' \
            "$player_commit" "$dockerfile_sha"
        printf 'postgres_image_reference=%s\npostgres_image_id=%s\n' \
            "$POSTGRES_IMAGE" "$NEW_POSTGRES_ID"
        printf 'postgres_migrate_image_reference=%s\npostgres_migrate_image_id=%s\n' \
            "$POSTGRES_MIGRATE_IMAGE" "$NEW_POSTGRES_MIGRATE_ID"
        printf 'qdrant_image_scan_receipt_sha256=%s\nqdrant_audit_image_scan_receipt_sha256=%s\n' \
            "$qdrant_scan_receipt_sha" "$qdrant_audit_scan_receipt_sha"
        printf 'postgres_image_scan_receipt_sha256=%s\npostgres_migrate_image_scan_receipt_sha256=%s\n' \
            "$postgres_scan_receipt_sha" "$postgres_migrate_scan_receipt_sha"
        printf 'postgres_dockerfile_sha256=%s\npostgres_schema_sha256=%s\n' \
            "$postgres_dockerfile_sha" "$postgres_schema_sha"
        printf 'postgres_source_bundle_sha256=%s\npostgres_migrate_dockerfile_sha256=%s\n' \
            "$postgres_source_bundle_sha" "$postgres_migrate_dockerfile_sha"
        printf 'stateful_compose_projection_sha256=%s\npromotion_manifest_sha256=%s\n' \
            "$projection_sha" "$promotion_sha"
        printf 'player_commit=%s\npipeline_commit=%s\n' \
            "$player_commit" "$pipeline_commit"
    } > "$RUNTIME_CONTRACT_PREPARED") 2>/dev/null; then
        return 1
    fi
    chmod 600 "$RUNTIME_CONTRACT_PREPARED" || return 1
    durable_sync_path "$RUNTIME_CONTRACT_PREPARED" || return 1
    durable_sync_path "$RUN_DIR" || return 1
}

publish_runtime_contract() {
    local state_owner contract_owner
    [ -f "$RUNTIME_CONTRACT_PREPARED" ] && [ ! -L "$RUNTIME_CONTRACT_PREPARED" ] \
        || return 1
    [ "$(stat -c '%a' "$RUNTIME_CONTRACT_PREPARED")" = "600" ] || return 1
    state_owner=$(stat -c '%u:%g' "$STATE_ROOT") || return 1
    [ "$(stat -c '%u:%g' "$RUNTIME_CONTRACT_PREPARED")" = "$state_owner" ] || return 1
    if [ -e "$RUNTIME_CONTRACT" ] || [ -L "$RUNTIME_CONTRACT" ]; then
        [ -f "$RUNTIME_CONTRACT" ] && [ ! -L "$RUNTIME_CONTRACT" ] || return 1
        [ "$(stat -c '%a' "$RUNTIME_CONTRACT")" = "600" ] || return 1
        contract_owner=$(stat -c '%u:%g' "$RUNTIME_CONTRACT") || return 1
        [ "$contract_owner" = "$state_owner" ] || return 1
    fi
    mv -f "$RUNTIME_CONTRACT_PREPARED" "$RUNTIME_CONTRACT" || return 1
    durable_sync_path "$RUNTIME_CONTRACT" || return 1
    durable_sync_path "$STATE_ROOT" || return 1
}

restore_previous_stable_qdrant_tag() {
    local current
    [ "$STABLE_QDRANT_TAG_MUTATED" = "true" ] || return 0
    current=$(query_optional_image_id "$QDRANT_IMAGE") || return 1
    if [ "$OLD_STABLE_QDRANT_IMAGE_ID" = "absent" ]; then
        if [ "$current" != "absent" ]; then
            run_bounded_docker_mutation image rm "$QDRANT_IMAGE" >/dev/null 2>&1 || return 1
        fi
        [ "$(query_optional_image_id "$QDRANT_IMAGE")" = "absent" ] || return 1
    else
        case "$OLD_STABLE_QDRANT_IMAGE_ID" in sha256:*) ;; *) return 1 ;; esac
        if [ "$current" != "$OLD_STABLE_QDRANT_IMAGE_ID" ]; then
            run_bounded_docker_mutation image tag "$OLD_STABLE_QDRANT_IMAGE_ID" \
                "$QDRANT_IMAGE" >/dev/null 2>&1 || return 1
        fi
        [ "$(query_optional_image_id "$QDRANT_IMAGE")" = "$OLD_STABLE_QDRANT_IMAGE_ID" ] \
            || return 1
    fi
    STABLE_QDRANT_TAG_MUTATED=false
    record_state qdrant.stable_tag_recovery restored-previous-mapping
}

restore_previous_stable_postgres_tag() {
    local current
    [ "$STABLE_POSTGRES_TAG_MUTATED" = "true" ] || return 0
    current=$(query_optional_image_id "$POSTGRES_IMAGE") || return 1
    if [ "$OLD_STABLE_POSTGRES_IMAGE_ID" = "absent" ]; then
        if [ "$current" != "absent" ]; then
            run_bounded_docker_mutation image rm "$POSTGRES_IMAGE" >/dev/null 2>&1 || return 1
        fi
        [ "$(query_optional_image_id "$POSTGRES_IMAGE")" = "absent" ] || return 1
    else
        case "$OLD_STABLE_POSTGRES_IMAGE_ID" in sha256:*) ;; *) return 1 ;; esac
        if [ "$current" != "$OLD_STABLE_POSTGRES_IMAGE_ID" ]; then
            run_bounded_docker_mutation image tag "$OLD_STABLE_POSTGRES_IMAGE_ID" \
                "$POSTGRES_IMAGE" >/dev/null 2>&1 || return 1
        fi
        [ "$(query_optional_image_id "$POSTGRES_IMAGE")" = "$OLD_STABLE_POSTGRES_IMAGE_ID" ] \
            || return 1
    fi
    STABLE_POSTGRES_TAG_MUTATED=false
    record_state postgres.stable_tag_recovery restored-previous-mapping
}

restore_previous_stable_postgres_migrate_tag() {
    local current
    [ "$STABLE_POSTGRES_MIGRATE_TAG_MUTATED" = "true" ] || return 0
    current=$(query_optional_image_id "$POSTGRES_MIGRATE_IMAGE") || return 1
    if [ "$OLD_STABLE_POSTGRES_MIGRATE_IMAGE_ID" = "absent" ]; then
        if [ "$current" != "absent" ]; then
            run_bounded_docker_mutation image rm "$POSTGRES_MIGRATE_IMAGE" >/dev/null 2>&1 || return 1
        fi
        [ "$(query_optional_image_id "$POSTGRES_MIGRATE_IMAGE")" = "absent" ] || return 1
    else
        case "$OLD_STABLE_POSTGRES_MIGRATE_IMAGE_ID" in sha256:*) ;; *) return 1 ;; esac
        if [ "$current" != "$OLD_STABLE_POSTGRES_MIGRATE_IMAGE_ID" ]; then
            run_bounded_docker_mutation image tag "$OLD_STABLE_POSTGRES_MIGRATE_IMAGE_ID" \
                "$POSTGRES_MIGRATE_IMAGE" >/dev/null 2>&1 || return 1
        fi
        [ "$(query_optional_image_id "$POSTGRES_MIGRATE_IMAGE")" \
            = "$OLD_STABLE_POSTGRES_MIGRATE_IMAGE_ID" ] || return 1
    fi
    STABLE_POSTGRES_MIGRATE_TAG_MUTATED=false
    record_state postgres_migrate.stable_tag_recovery restored-previous-mapping
}

restore_verified_qdrant_candidate() {
    local current archived
    current=$(query_container_id "$QDRANT_CONTAINER") || return 1
    if [ -n "$current" ] && [ "$current" != "$QDRANT_FALLBACK_ID" ]; then
        run_bounded_docker_mutation rm -f "$current" >/dev/null 2>&1 || return 1
        wait_container_mapping "$QDRANT_CONTAINER" "" || return 1
    fi
    current=$(query_container_id "$QDRANT_CONTAINER") || return 1
    if [ "$current" != "$QDRANT_FALLBACK_ID" ]; then
        archived=$(query_container_id "$QDRANT_FALLBACK_CONTAINER") || return 1
        [ "$archived" = "$QDRANT_FALLBACK_ID" ] || return 1
        run_bounded_docker_mutation rename "$QDRANT_FALLBACK_ID" "$QDRANT_CONTAINER" \
            >/dev/null 2>&1 || return 1
        wait_container_mapping "$QDRANT_CONTAINER" "$QDRANT_FALLBACK_ID" || return 1
    fi
    run_bounded_docker_mutation start "$QDRANT_FALLBACK_ID" >/dev/null 2>&1 || return 1
    wait_container_running_id "$QDRANT_FALLBACK_ID" true || return 1
    wait_qdrant || return 1
    verify_qdrant_runtime "$NEW_QDRANT_ID" "$QDRANT_FALLBACK_ID" || return 1
    verify_compose_resource_identity "$QDRANT_FALLBACK_ID" "$CANDIDATE_PROJECT" qdrant \
        "$QDRANT_VOLUME" /qdrant/storage "$STATEFUL_NETWORK" || return 1
    qdrant_fingerprint "$RUN_DIR/qdrant-forward-recovered.json" || return 1
    cmp -s "$RUN_DIR/qdrant-after.json" "$RUN_DIR/qdrant-forward-recovered.json" || return 1
}

restore_verified_postgres_candidate() {
    local current archived
    current=$(query_container_id "$POSTGRES_CONTAINER") || return 1
    if [ -n "$current" ] && [ "$current" != "$POSTGRES_FALLBACK_ID" ]; then
        run_bounded_docker_mutation rm -f "$current" >/dev/null 2>&1 || return 1
        wait_container_mapping "$POSTGRES_CONTAINER" "" || return 1
    fi
    current=$(query_container_id "$POSTGRES_CONTAINER") || return 1
    if [ "$current" != "$POSTGRES_FALLBACK_ID" ]; then
        archived=$(query_container_id "$POSTGRES_FALLBACK_CONTAINER") || return 1
        [ "$archived" = "$POSTGRES_FALLBACK_ID" ] || return 1
        run_bounded_docker_mutation rename "$POSTGRES_FALLBACK_ID" "$POSTGRES_CONTAINER" \
            >/dev/null 2>&1 || return 1
        wait_container_mapping "$POSTGRES_CONTAINER" "$POSTGRES_FALLBACK_ID" || return 1
    fi
    run_bounded_docker_mutation start "$POSTGRES_FALLBACK_ID" >/dev/null 2>&1 || return 1
    wait_container_running_id "$POSTGRES_FALLBACK_ID" true || return 1
    wait_postgres "$POSTGRES_FALLBACK_ID" || return 1
    verify_postgres_runtime "$NEW_POSTGRES_ID" "$POSTGRES_FALLBACK_ID" || return 1
    verify_compose_resource_identity "$POSTGRES_FALLBACK_ID" "$CANDIDATE_PROJECT" postgres \
        "$POSTGRES_VOLUME" /var/lib/postgresql/data "$STATEFUL_NETWORK" || return 1
    postgres_fingerprint "$RUN_DIR/postgres-forward-recovered.json" "$POSTGRES_FALLBACK_ID" || return 1
    cmp -s "$RUN_DIR/postgres-after.json" "$RUN_DIR/postgres-forward-recovered.json" || return 1
}

cleanup() {
    original_status=$?
    trap - EXIT HUP INT TERM
    trap '' HUP INT TERM
    recovery_status=0
    forward_recovery_status=0
    private_cleanup_status=0
    if [ "$GITHUB_HOST_KEY_FILE_OWNED" = "true" ]; then
        if ! release_github_host_key_file; then
            printf '%s\n' \
                "Run-specific GitHub host-key trust file could not be removed exactly." >&2
            private_cleanup_status=1
            recovery_status=1
        fi
    fi
    if [ "$RESOLVED_COMPOSE_PRIVATE_OWNED" = "true" ]; then
        durable_unlink_exact "$RESOLVED_COMPOSE_PRIVATE" 2>/dev/null \
            || private_cleanup_status=1
        if [ -e "$RESOLVED_COMPOSE_PRIVATE" ] || [ -L "$RESOLVED_COMPOSE_PRIVATE" ]; then
            private_cleanup_status=1
        else
            RESOLVED_COMPOSE_PRIVATE_OWNED=false
        fi
        if [ "$private_cleanup_status" -ne 0 ]; then
            printf '%s\n' \
                "Sensitive resolved Compose cleanup failed at $RESOLVED_COMPOSE_PRIVATE." >&2
            recovery_status=1
        fi
    fi
    if [ -e "$PRIVATE_BACKEND_ENV_FILE" ] || [ -L "$PRIVATE_BACKEND_ENV_FILE" ]; then
        if ! durable_unlink_exact "$PRIVATE_BACKEND_ENV_FILE" 2>/dev/null; then
            printf '%s\n' \
                "Sensitive rolling deployment environment cleanup failed at $PRIVATE_BACKEND_ENV_FILE." >&2
            private_cleanup_status=1
            recovery_status=1
        fi
    fi
    if [ "$BACKEND_ENV_BACKUP_OWNED" = "true" ] \
        && [ "$BACKEND_ENV_MUTATED" = "false" ]; then
        if ! discard_backend_env_backup; then
            printf '%s\n' \
                "Sensitive Qdrant volume-binding backup cleanup failed at $BACKEND_ENV_BACKUP." >&2
            private_cleanup_status=1
            recovery_status=1
        fi
    fi
    if [ "$SUCCEEDED" != "true" ] && [ "$ACTIVE_JOURNAL_CREATED" = "true" ]; then
        set +e
        record_state deployment.status failed
        if [ "$DAEMON_MUTATION_IN_FLIGHT" = "true" ] \
            || [ "$DAEMON_MUTATION_UNRESOLVED" = "true" ] \
            || [ "$DAEMON_READ_UNRESOLVED" = "true" ] \
            || [ -f "$DAEMON_READ_UNRESOLVED_FILE" ]; then
            record_state daemon.reconciliation fail-stop-manual-intervention-required
            recovery_status=1
        fi
        if [ "$PROMOTION_ARMED" = "true" ]; then
            if [ "$PROMOTION_COMMITTED" = "true" ]; then
                record_state promotion.reconciliation post-commit-manual-intervention-required
                recovery_status=1
            elif [ "$recovery_status" -eq 0 ]; then
                record_state promotion.forward_recovery started
                restore_verified_postgres_candidate || forward_recovery_status=1
                restore_verified_qdrant_candidate || forward_recovery_status=1
                restore_previous_stable_qdrant_tag || forward_recovery_status=1
                restore_previous_stable_postgres_tag || forward_recovery_status=1
                restore_previous_stable_postgres_migrate_tag || forward_recovery_status=1
                wait_http http://127.0.0.1:5000/api/ready 10 \
                    || forward_recovery_status=1
                wait_http http://127.0.0.1:5000/api/health 30 \
                    || forward_recovery_status=1
                wait_http http://127.0.0.1:8080/backend-api/api/ready 15 \
                    || forward_recovery_status=1
                if [ "$forward_recovery_status" -eq 0 ]; then
                    record_state promotion.forward_recovery verified-candidate-topology-restored
                    MANAGEMENT_RECONCILIATION_REQUIRED=true
                else
                    record_state promotion.forward_recovery incomplete-manual-intervention-required
                fi
                recovery_status=1
            fi
        elif [ "$POSTGRES_MUTATED" = "true" ] && [ "$recovery_status" -eq 0 ]; then
            record_state postgres.rollback started
            if restore_postgres; then
                record_state postgres.rollback completed
            else
                record_state postgres.rollback incomplete-manual-intervention-required
                recovery_status=1
            fi
        fi
        if [ "$PROMOTION_ARMED" != "true" ] \
            && [ "$QDRANT_MUTATED" = "true" ] && [ "$recovery_status" -eq 0 ] \
            && [ "$DAEMON_MUTATION_UNRESOLVED" != "true" ]; then
            record_state qdrant.rollback started
            if restore_qdrant; then
                record_state qdrant.rollback completed
            else
                record_state qdrant.rollback incomplete-manual-intervention-required
                recovery_status=1
            fi
        fi
        if [ "$PROMOTION_ARMED" != "true" ] && [ "$recovery_status" -eq 0 ]; then
            wait_http http://127.0.0.1:5000/api/ready 10 || recovery_status=1
            wait_http http://127.0.0.1:5000/api/health 30 || recovery_status=1
            wait_http http://127.0.0.1:8080/backend-api/api/ready 15 || recovery_status=1
        fi
        if [ "$DAEMON_MUTATION_IN_FLIGHT" = "true" ] \
            || [ "$DAEMON_MUTATION_UNRESOLVED" = "true" ] \
            || [ "$DAEMON_READ_UNRESOLVED" = "true" ] \
            || [ -f "$DAEMON_READ_UNRESOLVED_FILE" ]; then
            record_state daemon.reconciliation fail-stop-manual-intervention-required
            recovery_status=1
        fi
        if [ "$MANAGEMENT_RECONCILIATION_REQUIRED" = "true" ]; then
            record_state compose.management reconciliation-required
            recovery_status=1
        fi
        if [ "$recovery_status" -eq 0 ] && [ "$PIPELINE_WRITER_GATED" = "true" ]; then
            verify_pipeline_writer_gate && release_pipeline_writers \
                || recovery_status=1
        fi
        if [ "$recovery_status" -ne 0 ]; then
            printf '%s\n' "Recovery is incomplete. Preserve $ACTIVE_JOURNAL and $RUN_DIR." >&2
        fi
        set -e
    fi
    if [ "$PIPELINE_RUNTIME_LOCK_HELD" = "true" ]; then
        if ! verify_pipeline_runtime_identity_unchanged; then
            printf '%s\n' "Pipeline virtual-environment identity changed while the shared lock was held." >&2
            recovery_status=1
        fi
        if ! release_pipeline_runtime_lock; then
            printf '%s\n' "Pipeline virtual-environment shared lock could not be released." >&2
            recovery_status=1
        fi
    fi
    if [ "$LOCK_HELD" = "true" ]; then
        if [ "$recovery_status" -eq 0 ]; then
            if ! release_stateful_lock_exact; then
                printf '%s\n' \
                    "Stateful interlock could not be released exactly at $LOCK_DIR." >&2
                recovery_status=1
            fi
        else
            printf '%s\n' "Stateful interlock retained at $LOCK_DIR." >&2
        fi
    fi
    if [ "$ACTIVE_JOURNAL_CREATED" = "true" ]; then
        if [ "$recovery_status" -eq 0 ]; then
            if ! release_active_journal_exact; then
                printf '%s\n' \
                    "Stateful active journal could not be released exactly at $ACTIVE_JOURNAL." >&2
                recovery_status=1
            fi
        else
            printf '%s\n' "Stateful active journal retained at $ACTIVE_JOURNAL." >&2
        fi
    fi
    if [ "$recovery_status" -ne 0 ] || [ "$private_cleanup_status" -ne 0 ]; then exit 2; fi
    exit "$original_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for positive_setting in "$HEALTH_ATTEMPTS" "$WAIT_SECONDS" "$READ_TIMEOUT_SECONDS" \
    "$FINGERPRINT_TIMEOUT_SECONDS" "$MUTATION_TIMEOUT_SECONDS" \
    "$QDRANT_UPGRADE_TIMEOUT_SECONDS" \
    "$DATA_MUTATION_TIMEOUT_SECONDS" "$BUILD_TIMEOUT_SECONDS" \
    "$DAEMON_SETTLE_ATTEMPTS" "$DAEMON_STABLE_SAMPLES" "$WRITER_SETTLE_SECONDS"; do
    case "$positive_setting" in
        ''|*[!0-9]*|0) fail "stateful retry/timeout settings must be positive integers"; exit 1 ;;
    esac
done
[ "$HEALTH_ATTEMPTS" -ge 2 ] \
    || { fail "health attempts must allow two stable identity samples"; exit 1; }
[ "$DAEMON_SETTLE_ATTEMPTS" -ge "$DAEMON_STABLE_SAMPLES" ] \
    || { fail "daemon settle attempts must cover all stable samples"; exit 1; }
for required in "$DOCKER_COMMAND" "$CURL_COMMAND" "$PYTHON_COMMAND" "$SLEEP_COMMAND" \
    "$TIMEOUT_COMMAND" sha256sum cmp sync stat awk grep cp cat env git hostname; do
    command -v "$required" >/dev/null 2>&1 || { fail "required command is unavailable: $required"; exit 1; }
done
[ -f "$QDRANT_DOCKERFILE" ] && [ ! -L "$QDRANT_DOCKERFILE" ] || { fail "Qdrant Dockerfile is unsafe"; exit 1; }
[ -f "$QDRANT_AUDIT_CONTRACT_HELPER" ] && [ ! -L "$QDRANT_AUDIT_CONTRACT_HELPER" ] \
    || { fail "Qdrant audit contract helper is unsafe"; exit 1; }
[ -f "$BACKUP_ATTESTER" ] && [ ! -L "$BACKUP_ATTESTER" ] || { fail "backup attester is unsafe"; exit 1; }
[ -f "$QDRANT_UPGRADE_CONTROLLER" ] && [ ! -L "$QDRANT_UPGRADE_CONTROLLER" ] \
    || { fail "Qdrant storage-upgrade controller is unsafe"; exit 1; }
[ -f "$POSTGRES_DOCKERFILE" ] && [ ! -L "$POSTGRES_DOCKERFILE" ] \
    || { fail "PostgreSQL Dockerfile is unsafe"; exit 1; }
[ -f "$POSTGRES_MIGRATE_DOCKERFILE" ] && [ ! -L "$POSTGRES_MIGRATE_DOCKERFILE" ] \
    || { fail "PostgreSQL migrate Dockerfile is unsafe"; exit 1; }
[ -f "$IMAGE_SCAN_VALIDATOR" ] && [ ! -L "$IMAGE_SCAN_VALIDATOR" ] \
    || { fail "image scan validator is unsafe"; exit 1; }
[ "$(sha256sum "$IMAGE_SCAN_VALIDATOR" | awk '{print $1}')" \
    = f130fd9559791e907f724e334263a42cec3e6565e62e5d347afc03a9dd7e5b4a ] \
    || { fail "image scan validator digest is not the frozen reviewed contract"; exit 1; }
[ -f "$ROOT_DIR/scripts/wsl-dr-api-bridge-receipt.py" ] \
    && [ ! -L "$ROOT_DIR/scripts/wsl-dr-api-bridge-receipt.py" ] \
    || { fail "API bridge receipt verifier is unsafe"; exit 1; }
[ -f "$API_BRIDGE_CONSUMPTION_HELPER" ] \
    && [ ! -L "$API_BRIDGE_CONSUMPTION_HELPER" ] \
    || { fail "API bridge receipt consumption helper is unsafe"; exit 1; }
acquire_pipeline_runtime_lock \
    || { fail "pipeline virtual-environment shared lock could not be acquired"; exit 1; }
verify_pipeline_venv_provenance \
    || { fail "pipeline qdrant-client 1.19 virtual-environment provenance is unsafe"; exit 1; }
[ -d "$ROOT_DIR" ] && [ ! -L "$ROOT_DIR" ] \
    || { fail "player repository root is unsafe"; exit 1; }
backend_repo_owner=$(stat -c '%u:%g' "$ROOT_DIR") \
    || { fail "player repository ownership is unavailable"; exit 1; }
case "$backend_repo_owner" in
    *[!0-9:]*|:|*:|*::* ) fail "player repository ownership is invalid"; exit 1 ;;
esac
[ "$backend_repo_owner" = "$PIPELINE_RUNTIME_UID:$PIPELINE_RUNTIME_GID" ] \
    || { fail "player and pipeline repositories must share the validated non-root runtime owner"; exit 1; }
BACKEND_ENV_OWNER_UID=${backend_repo_owner%%:*}
BACKEND_ENV_OWNER_GID=${backend_repo_owner#*:}
[ -f "$BACKEND_ENV_FILE" ] && [ ! -L "$BACKEND_ENV_FILE" ] \
    || { fail "backend/.env is missing or unsafe"; exit 1; }
verify_backend_env_metadata \
    || { fail "backend/.env must be a single-link mode-600 file owned by the player repository owner"; exit 1; }
[ "$(trusted_git -C "$ROOT_DIR" rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] \
    || { fail "player Git worktree is unavailable"; exit 1; }
[ "$(trusted_git -C "$PIPELINE_ROOT" rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] \
    || { fail "pipeline Git worktree is unavailable"; exit 1; }
PLAYER_RELEASE_COMMIT=$(trusted_git -C "$ROOT_DIR" rev-parse HEAD) \
    || { fail "player release commit is unavailable"; exit 1; }
PIPELINE_RELEASE_COMMIT=$(trusted_git -C "$PIPELINE_ROOT" rev-parse HEAD) \
    || { fail "pipeline release commit is unavailable"; exit 1; }
case "$PLAYER_RELEASE_COMMIT:$PIPELINE_RELEASE_COMMIT" in
    *[!0-9a-f:]*|:|*:|*::* ) fail "release commit identities are invalid"; exit 1 ;;
esac
[ "${#PLAYER_RELEASE_COMMIT}" -eq 40 ] && [ "${#PIPELINE_RELEASE_COMMIT}" -eq 40 ] \
    || { fail "release commit identities are not full SHA-1 values"; exit 1; }
validate_pipeline_github_ssh_identity \
    || { fail "pipeline GitHub SSH user, home, identity, or ancestry is unsafe"; exit 1; }
prepare_github_host_key_file \
    || { fail "run-specific GitHub Ed25519 host-key trust could not be prepared"; exit 1; }
verify_release_repository_provenance "$ROOT_DIR" "$PLAYER_OFFICIAL_ORIGIN" \
    "$PLAYER_RELEASE_COMMIT" \
    || { fail "player release must be the live official origin/main commit"; exit 1; }
verify_release_repository_provenance "$PIPELINE_ROOT" "$PIPELINE_OFFICIAL_ORIGIN" \
    "$PIPELINE_RELEASE_COMMIT" \
    || { fail "pipeline release must be the live official origin/main commit"; exit 1; }
release_github_host_key_file \
    || { fail "run-specific GitHub host-key trust could not be removed exactly"; exit 1; }
verify_release_sources_unchanged \
    || { fail "stateful runtime sources differ from their captured release commits"; exit 1; }

POSTGRES_BACKUP_RUN=${DIVA_VERIFIED_POSTGRES_BACKUP_RUN_ID:-}
QDRANT_BACKUP_RUN=${DIVA_VERIFIED_QDRANT_BACKUP_RUN_ID:-}
BACKUP_SOURCE_HOST=${DIVA_EXPECTED_BACKUP_SOURCE_HOST:-$(hostname)}
[ -n "$BACKUP_SOURCE_HOST" ] \
    || { fail "expected backup source host is required"; exit 1; }
for backup_execution_id in "$POSTGRES_BACKUP_RUN" "$QDRANT_BACKUP_RUN"; do
    case "$backup_execution_id" in
        ''|*[!0-9a-f]*) fail "verified off-host backup execution IDs are required"; exit 1 ;;
    esac
    [ "${#backup_execution_id}" -eq 32 ] \
        || { fail "verified off-host backup execution IDs must be 32 lowercase hex characters"; exit 1; }
done

POSTGRES_BACKUP_STATUS_FILE=${DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_FILE:-}
POSTGRES_BACKUP_STATUS_SHA=${DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_SHA256:-}
POSTGRES_BACKUP_MANIFEST_FILE=${DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_FILE:-}
POSTGRES_BACKUP_MANIFEST_SHA=${DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_SHA256:-}
QDRANT_BACKUP_STATUS_FILE=${DIVA_VERIFIED_QDRANT_BACKUP_STATUS_FILE:-}
QDRANT_BACKUP_STATUS_SHA=${DIVA_VERIFIED_QDRANT_BACKUP_STATUS_SHA256:-}
QDRANT_BACKUP_MANIFEST_FILE=${DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_FILE:-}
QDRANT_BACKUP_MANIFEST_SHA=${DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_SHA256:-}
BACKUP_ATTESTATION_FILE=${DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_FILE:-}
BACKUP_ATTESTATION_SHA=${DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_SHA256:-}
BACKUP_ATTESTATION_CHALLENGE=${DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_CHALLENGE:-}
BACKUP_VERIFIER_HOST=${DIVA_EXPECTED_BACKUP_VERIFIER_HOST:-}
[ -n "$BACKUP_VERIFIER_HOST" ] \
    || { fail "expected off-host backup verifier host is required"; exit 1; }
POSTGRES_BACKUP_PUBLICATION=$(validate_backup_evidence postgres_disaster_backup "$POSTGRES_BACKUP_RUN" \
    "$POSTGRES_BACKUP_STATUS_FILE" "$POSTGRES_BACKUP_STATUS_SHA" \
    "$POSTGRES_BACKUP_MANIFEST_FILE" "$POSTGRES_BACKUP_MANIFEST_SHA" 48 \
    "$BACKUP_SOURCE_HOST") \
    || { fail "PostgreSQL off-host backup evidence is invalid"; exit 1; }
QDRANT_BACKUP_PUBLICATION=$(validate_backup_evidence qdrant_disaster_backup "$QDRANT_BACKUP_RUN" \
    "$QDRANT_BACKUP_STATUS_FILE" "$QDRANT_BACKUP_STATUS_SHA" \
    "$QDRANT_BACKUP_MANIFEST_FILE" "$QDRANT_BACKUP_MANIFEST_SHA" 192 \
    "$BACKUP_SOURCE_HOST") \
    || { fail "Qdrant off-host backup evidence is invalid"; exit 1; }
case "$POSTGRES_BACKUP_PUBLICATION:$QDRANT_BACKUP_PUBLICATION" in
    *[!0-9a-f:]*|:|*:|*::* ) fail "backup publication fingerprints are invalid"; exit 1 ;;
esac
[ "${#POSTGRES_BACKUP_PUBLICATION}" -eq 64 ] \
    && [ "${#QDRANT_BACKUP_PUBLICATION}" -eq 64 ] \
    && [ "$POSTGRES_BACKUP_PUBLICATION" = "$QDRANT_BACKUP_PUBLICATION" ] \
    || { fail "PostgreSQL and Qdrant backups do not represent one publication"; exit 1; }
prepare_state_root \
    || { fail "stateful state root is not the fixed trusted directory: $STATE_ROOT"; exit 1; }
if [ -e "$RUNTIME_CONTRACT" ] || [ -L "$RUNTIME_CONTRACT" ]; then
    [ -f "$RUNTIME_CONTRACT" ] && [ ! -L "$RUNTIME_CONTRACT" ] \
        || { fail "existing stateful runtime contract is unsafe"; exit 1; }
    [ "$(stat -c '%a' "$RUNTIME_CONTRACT")" = "600" ] \
        && [ "$(stat -c '%u:%g' "$RUNTIME_CONTRACT")" = "$(stat -c '%u:%g' "$STATE_ROOT")" ] \
        || { fail "existing stateful runtime contract ownership is unsafe"; exit 1; }
fi
if [ -e "$API_BRIDGE_CONSUME_INTENT" ] \
    || [ -L "$API_BRIDGE_CONSUME_INTENT" ] \
    || [ -e "$API_BRIDGE_CONSUME_INTENT.prepared" ] \
    || [ -L "$API_BRIDGE_CONSUME_INTENT.prepared" ] \
    || [ -e "$ACTIVE_JOURNAL" ] || [ -L "$ACTIVE_JOURNAL" ] \
    || [ -e "$LOCK_DIR" ] || [ -L "$LOCK_DIR" ]; then
    API_BRIDGE_RECONCILIATION=$("$PYTHON_COMMAND" -I -B \
        "$API_BRIDGE_CONSUMPTION_HELPER" startup-reconcile \
        --canonical "$API_BRIDGE_RECEIPT" \
        --intent "$API_BRIDGE_CONSUME_INTENT" \
        --state-root "$STATE_ROOT" \
        --active-journal "$ACTIVE_JOURNAL" \
        --lock-dir "$LOCK_DIR" \
        --runtime-contract "$RUNTIME_CONTRACT") \
        || { fail "stale API bridge receipt consumption could not be reconciled"; exit 1; }
    case "$API_BRIDGE_RECONCILIATION" in
        none) ;;
        calibration|completed|pre-mutation-failed)
            printf '%s\n' \
                "Recovered stale $API_BRIDGE_RECONCILIATION API bridge receipt consumption." >&2
            ;;
        *) fail "API bridge receipt reconciliation returned an invalid result"; exit 1 ;;
    esac
fi
if [ -e "$ACTIVE_JOURNAL" ] || [ -L "$ACTIVE_JOURNAL" ]; then
    fail "unfinished stateful hardening journal exists: $ACTIVE_JOURNAL"
    exit 1
fi
if [ -e "$ROLLING_ACTIVE_JOURNAL" ] || [ -L "$ROLLING_ACTIVE_JOURNAL" ]; then
    fail "unfinished rolling deployment journal exists: $ROLLING_ACTIVE_JOURNAL"
    exit 75
fi
if [ "$TEST_MODE" = "1" ]; then
    LOCK_OWNER_BOOT_ID=00000000-0000-4000-8000-000000000000
    LOCK_OWNER_START_TICKS=$$
else
    [ -f /proc/sys/kernel/random/boot_id ] \
        && [ ! -L /proc/sys/kernel/random/boot_id ] \
        || { fail "kernel boot identity is unavailable"; exit 1; }
    LOCK_OWNER_BOOT_ID=$(cat /proc/sys/kernel/random/boot_id) \
        || { fail "kernel boot identity could not be read"; exit 1; }
    LOCK_OWNER_START_TICKS=$(read_process_start_ticks "$$") \
        || { fail "hardening process start identity could not be read"; exit 1; }
fi
validate_lock_boot_id "$LOCK_OWNER_BOOT_ID" \
    || { fail "hardening lock boot identity is invalid"; exit 1; }
case "$LOCK_OWNER_START_TICKS" in ''|*[!0-9]*|0)
    fail "hardening lock process start identity is invalid"; exit 1 ;;
esac
LOCK_OWNER_TOKEN="pid=$$ run=$RUN_ID boot=$LOCK_OWNER_BOOT_ID start=$LOCK_OWNER_START_TICKS"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail "another stateful hardening run holds $LOCK_DIR"
    exit 75
fi
LOCK_HELD=true
chmod 700 "$LOCK_DIR" \
    || { fail "stateful hardening lock mode could not be fixed"; exit 1; }
if ! (set -C; printf '%s\n' "$LOCK_OWNER_TOKEN" > "$LOCK_DIR/owner") 2>/dev/null; then
    fail "stateful hardening lock owner could not be published exactly"
    exit 1
fi
durable_sync_path "$LOCK_DIR/owner" \
    && durable_sync_path "$LOCK_DIR" \
    && durable_sync_path "$STATE_ROOT" \
    || { fail "stateful hardening lock owner could not be made durable"; exit 1; }
if [ -e "$API_BRIDGE_CONSUME_INTENT" ] \
    || [ -L "$API_BRIDGE_CONSUME_INTENT" ] \
    || [ -e "$API_BRIDGE_CONSUME_INTENT.prepared" ] \
    || [ -L "$API_BRIDGE_CONSUME_INTENT.prepared" ]; then
    fail "API bridge receipt consumption appeared while acquiring the stateful hardening lock"
    exit 75
fi
[ -f "$API_BRIDGE_RECEIPT" ] && [ ! -L "$API_BRIDGE_RECEIPT" ] \
    || { fail "canonical API bridge receipt disappeared while acquiring the stateful hardening lock"; exit 75; }
if [ -e "$DEPLOY_LOCK_DIR" ]; then
    fail "rolling deployment lock appeared during stateful hardening preflight"
    exit 75
fi
if [ -e "$ROLLING_ACTIVE_JOURNAL" ] || [ -L "$ROLLING_ACTIVE_JOURNAL" ]; then
    fail "rolling deployment journal appeared during stateful hardening preflight"
    exit 75
fi
if [ -e "$PRIVATE_BACKEND_ENV_FILE" ] || [ -L "$PRIVATE_BACKEND_ENV_FILE" ]; then
    durable_unlink_exact "$PRIVATE_BACKEND_ENV_FILE" \
        || { fail "orphaned sensitive rolling deployment environment could not be removed"; exit 1; }
fi
if ! mkdir "$RUN_DIR" 2>/dev/null; then
    fail "stateful run directory already exists: $RUN_DIR"
    exit 1
fi
chmod 700 "$RUN_DIR"
mkdir "$RUN_DIR/evidence"
chmod 700 "$RUN_DIR/evidence"
write_pipeline_runtime_attestation \
    || { fail "pipeline virtual-environment attestation could not be durably captured"; exit 1; }
EXPECTED_ATTESTER_BLOB="$RUN_DIR/evidence/attester-head.expected"
if ! (set -C; trusted_git -C "$ROOT_DIR" cat-file blob \
    "${PLAYER_RELEASE_COMMIT}:scripts/attest-disaster-backup-payloads.py" \
    > "$EXPECTED_ATTESTER_BLOB") 2>/dev/null; then
    fail "tracked backup attester blob could not be materialized"
    exit 1
fi
chmod 600 "$EXPECTED_ATTESTER_BLOB"
EXPECTED_BACKUP_ATTESTER_SHA=$(sha256sum "$EXPECTED_ATTESTER_BLOB" | awk '{print $1}') \
    || { fail "tracked backup attester digest could not be computed"; exit 1; }
case "$EXPECTED_BACKUP_ATTESTER_SHA" in
    ''|*[!0-9a-f]*) fail "tracked backup attester digest is invalid"; exit 1 ;;
esac
[ "${#EXPECTED_BACKUP_ATTESTER_SHA}" -eq 64 ] \
    || { fail "tracked backup attester digest is not SHA-256"; exit 1; }
rm -f -- "$EXPECTED_ATTESTER_BLOB"
[ ! -e "$EXPECTED_ATTESTER_BLOB" ] && [ ! -L "$EXPECTED_ATTESTER_BLOB" ] \
    || { fail "tracked backup attester staging file could not be removed"; exit 1; }
verify_release_sources_unchanged \
    || { fail "stateful runtime sources changed during evidence setup"; exit 1; }
QDRANT_RELEASE_BUILD_CONTEXT="$RUN_DIR/qdrant-build-context"
mkdir "$QDRANT_RELEASE_BUILD_CONTEXT"
chmod 700 "$QDRANT_RELEASE_BUILD_CONTEXT"
POSTGRES_RELEASE_BUILD_CONTEXT="$RUN_DIR/postgres-build-context"
mkdir "$POSTGRES_RELEASE_BUILD_CONTEXT"
chmod 700 "$POSTGRES_RELEASE_BUILD_CONTEXT"
RELEASE_COMPOSE_FILE="$RUN_DIR/docker-compose.release.yml"
QDRANT_RELEASE_CONTROLLER="$RUN_DIR/sbc-qdrant-storage-upgrade.py"
BRIDGE_RECEIPT_HELPER="$RUN_DIR/wsl-dr-api-bridge-receipt.py"
API_BRIDGE_CONSUMPTION_HELPER_RELEASE="$RUN_DIR/sbc-api-bridge-consumption.py"
IMAGE_SCAN_VALIDATOR_RELEASE="$RUN_DIR/validate-container-image-scan.py"
QDRANT_RELEASE_AUDIT_CONTRACT_HELPER="$QDRANT_RELEASE_BUILD_CONTEXT/audit-contract.sh"
for tracked_pair in \
    "backend/qdrant/.dockerignore:$QDRANT_RELEASE_BUILD_CONTEXT/.dockerignore" \
    "backend/qdrant/Dockerfile:$QDRANT_RELEASE_BUILD_CONTEXT/Dockerfile" \
    "backend/qdrant/audit-contract.sh:$QDRANT_RELEASE_AUDIT_CONTRACT_HELPER" \
    "backend/database/.dockerignore:$POSTGRES_RELEASE_BUILD_CONTEXT/.dockerignore" \
    "backend/database/Dockerfile.pgvector:$POSTGRES_RELEASE_BUILD_CONTEXT/Dockerfile.pgvector" \
    "backend/database/Dockerfile.migrate:$POSTGRES_RELEASE_BUILD_CONTEXT/Dockerfile.migrate" \
    "backend/database/schema.sql:$POSTGRES_RELEASE_BUILD_CONTEXT/schema.sql" \
    "backend/docker-compose.yml:$RELEASE_COMPOSE_FILE" \
    "scripts/sbc-qdrant-storage-upgrade.py:$QDRANT_RELEASE_CONTROLLER" \
    "scripts/wsl-dr-api-bridge-receipt.py:$BRIDGE_RECEIPT_HELPER" \
    "scripts/sbc-api-bridge-consumption.py:$API_BRIDGE_CONSUMPTION_HELPER_RELEASE" \
    "scripts/validate-container-image-scan.py:$IMAGE_SCAN_VALIDATOR_RELEASE"; do
    tracked_relative=${tracked_pair%%:*}
    tracked_target=${tracked_pair#*:}
    [ ! -e "$tracked_target" ] && [ ! -L "$tracked_target" ] \
        || { fail "release snapshot target already exists: $tracked_target"; exit 1; }
    if ! (set -C; trusted_git -C "$ROOT_DIR" cat-file blob \
        "${PLAYER_RELEASE_COMMIT}:$tracked_relative" > "$tracked_target") 2>/dev/null; then
        fail "tracked release source could not be materialized: $tracked_relative"
        exit 1
    fi
    chmod 600 "$tracked_target"
done
durable_sync_path "$QDRANT_RELEASE_BUILD_CONTEXT/.dockerignore"
durable_sync_path "$QDRANT_RELEASE_BUILD_CONTEXT/Dockerfile"
durable_sync_path "$QDRANT_RELEASE_AUDIT_CONTRACT_HELPER"
durable_sync_path "$QDRANT_RELEASE_BUILD_CONTEXT"
durable_sync_path "$POSTGRES_RELEASE_BUILD_CONTEXT/.dockerignore"
durable_sync_path "$POSTGRES_RELEASE_BUILD_CONTEXT/Dockerfile.pgvector"
durable_sync_path "$POSTGRES_RELEASE_BUILD_CONTEXT/Dockerfile.migrate"
durable_sync_path "$POSTGRES_RELEASE_BUILD_CONTEXT/schema.sql"
durable_sync_path "$POSTGRES_RELEASE_BUILD_CONTEXT"
durable_sync_path "$RELEASE_COMPOSE_FILE"
durable_sync_path "$QDRANT_RELEASE_CONTROLLER"
durable_sync_path "$BRIDGE_RECEIPT_HELPER"
durable_sync_path "$API_BRIDGE_CONSUMPTION_HELPER_RELEASE"
durable_sync_path "$IMAGE_SCAN_VALIDATOR_RELEASE"
durable_sync_path "$RUN_DIR"
COMPOSE_FILE=$RELEASE_COMPOSE_FILE
verify_release_sources_unchanged \
    || { fail "stateful runtime sources changed during release snapshotting"; exit 1; }
if [ -e "$ACTIVE_JOURNAL.tmp" ] || [ -L "$ACTIVE_JOURNAL.tmp" ]; then
    fail "stateful journal staging path already exists: $ACTIVE_JOURNAL.tmp"
    exit 1
fi
if ! (set -C; printf '%s\n' "$RUN_DIR" > "$ACTIVE_JOURNAL.tmp") 2>/dev/null; then
    fail "stateful journal staging path appeared concurrently"
    exit 1
fi
sync -f "$ACTIVE_JOURNAL.tmp" 2>/dev/null || sync
mv "$ACTIVE_JOURNAL.tmp" "$ACTIVE_JOURNAL"
ACTIVE_JOURNAL_CREATED=true
sync -f "$STATE_ROOT" 2>/dev/null || sync
record_state run.id "$RUN_ID"
record_state deployment.status preflight

cp "$POSTGRES_BACKUP_STATUS_FILE" "$RUN_DIR/evidence/postgres-status.json"
cp "$POSTGRES_BACKUP_MANIFEST_FILE" "$RUN_DIR/evidence/postgres-manifest.json"
cp "$QDRANT_BACKUP_STATUS_FILE" "$RUN_DIR/evidence/qdrant-status.json"
cp "$QDRANT_BACKUP_MANIFEST_FILE" "$RUN_DIR/evidence/qdrant-manifest.json"
cp "$BACKUP_ATTESTATION_FILE" "$RUN_DIR/evidence/backup-payload-attestation.json"
chmod 600 "$RUN_DIR/evidence/"*.json
COPIED_POSTGRES_PUBLICATION=$(validate_backup_evidence postgres_disaster_backup "$POSTGRES_BACKUP_RUN" \
    "$RUN_DIR/evidence/postgres-status.json" "$POSTGRES_BACKUP_STATUS_SHA" \
    "$RUN_DIR/evidence/postgres-manifest.json" "$POSTGRES_BACKUP_MANIFEST_SHA" 48 \
    "$BACKUP_SOURCE_HOST") \
    || { fail "copied PostgreSQL backup evidence changed during preflight"; exit 1; }
COPIED_QDRANT_PUBLICATION=$(validate_backup_evidence qdrant_disaster_backup "$QDRANT_BACKUP_RUN" \
    "$RUN_DIR/evidence/qdrant-status.json" "$QDRANT_BACKUP_STATUS_SHA" \
    "$RUN_DIR/evidence/qdrant-manifest.json" "$QDRANT_BACKUP_MANIFEST_SHA" 192 \
    "$BACKUP_SOURCE_HOST") \
    || { fail "copied Qdrant backup evidence changed during preflight"; exit 1; }
[ "$COPIED_POSTGRES_PUBLICATION" = "$POSTGRES_BACKUP_PUBLICATION" ] \
    && [ "$COPIED_QDRANT_PUBLICATION" = "$QDRANT_BACKUP_PUBLICATION" ] \
    && [ "$COPIED_POSTGRES_PUBLICATION" = "$COPIED_QDRANT_PUBLICATION" ] \
    || { fail "copied backup publication binding changed during preflight"; exit 1; }
capture_fresh_api_bridge_attestation_anchor \
    || { fail "fresh exact API bridge receipt attestation anchor is required"; exit 1; }
validate_backup_payload_attestation "$RUN_DIR/evidence/backup-payload-attestation.json" \
    "$BACKUP_ATTESTATION_SHA" "$BACKUP_ATTESTATION_CHALLENGE" "$BACKUP_VERIFIER_HOST" \
    "$RUN_DIR/evidence/postgres-status.json" "$RUN_DIR/evidence/postgres-manifest.json" \
    "$RUN_DIR/evidence/qdrant-status.json" "$RUN_DIR/evidence/qdrant-manifest.json" \
    "$POSTGRES_BACKUP_STATUS_SHA" "$POSTGRES_BACKUP_MANIFEST_SHA" \
    "$QDRANT_BACKUP_STATUS_SHA" "$QDRANT_BACKUP_MANIFEST_SHA" \
    "$POSTGRES_BACKUP_RUN" "$QDRANT_BACKUP_RUN" \
    "$API_BRIDGE_RECEIPT_CREATED_AT" \
    || { fail "copied backup payload attestation changed during preflight"; exit 1; }
validate_backup_source_ancestry "$RUN_DIR/evidence/postgres-status.json" \
    || { fail "PostgreSQL backup source commits are not ancestors of deployed code"; exit 1; }
validate_backup_source_ancestry "$RUN_DIR/evidence/qdrant-status.json" \
    || { fail "Qdrant backup source commits are not ancestors of deployed code"; exit 1; }
record_state postgres.backup_run "$POSTGRES_BACKUP_RUN"
record_state qdrant.backup_run "$QDRANT_BACKUP_RUN"
record_state postgres.backup_status_sha256 "$POSTGRES_BACKUP_STATUS_SHA"
record_state postgres.backup_manifest_sha256 "$POSTGRES_BACKUP_MANIFEST_SHA"
record_state qdrant.backup_status_sha256 "$QDRANT_BACKUP_STATUS_SHA"
record_state qdrant.backup_manifest_sha256 "$QDRANT_BACKUP_MANIFEST_SHA"
record_state backup.payload_attestation_sha256 "$BACKUP_ATTESTATION_SHA"
qdrant_backup_binding_sha=$(printf '%s\n' \
    'schema=1' \
    "qdrant_backup_run_id=$QDRANT_BACKUP_RUN" \
    "qdrant_status_sha256=$QDRANT_BACKUP_STATUS_SHA" \
    "qdrant_manifest_sha256=$QDRANT_BACKUP_MANIFEST_SHA" \
    "backup_attestation_sha256=$BACKUP_ATTESTATION_SHA" \
    "publication_sha256=$QDRANT_BACKUP_PUBLICATION" \
    | sha256sum | awk '{print $1}') \
    || { fail "Qdrant off-host backup binding could not be computed"; exit 1; }
case "$qdrant_backup_binding_sha" in ''|*[!0-9a-f]*)
    fail "Qdrant off-host backup binding is invalid"; exit 1 ;;
esac
[ "${#qdrant_backup_binding_sha}" -eq 64 ] \
    || { fail "Qdrant off-host backup binding is not SHA-256"; exit 1; }
QDRANT_BACKUP_BINDING="off-host-evidence-sha256-$qdrant_backup_binding_sha"
record_state api_bridge.qdrant_backup_binding "$QDRANT_BACKUP_BINDING"

if ! OLD_QDRANT_ID=$(query_container_id "$QDRANT_CONTAINER") || [ -z "$OLD_QDRANT_ID" ]; then
    fail "exact current Qdrant container could not be identified"
    exit 1
fi
if ! OLD_POSTGRES_ID=$(query_container_id "$POSTGRES_CONTAINER") || [ -z "$OLD_POSTGRES_ID" ]; then
    fail "exact current PostgreSQL container could not be identified"
    exit 1
fi
record_state qdrant.old_container_id "$OLD_QDRANT_ID"
record_state postgres.old_container_id "$OLD_POSTGRES_ID"

qdrant_project=$(container_compose_label "$OLD_QDRANT_ID" com.docker.compose.project) \
    || { fail "current Qdrant Compose project identity is unavailable"; exit 1; }
postgres_project=$(container_compose_label "$OLD_POSTGRES_ID" com.docker.compose.project) \
    || { fail "current PostgreSQL Compose project identity is unavailable"; exit 1; }
[ "$qdrant_project" = "$postgres_project" ] \
    || { fail "stateful services do not share one Compose project"; exit 1; }
ORIGINAL_PROJECT="$qdrant_project"
case "$ORIGINAL_PROJECT" in
    ''|*[!a-z0-9_-]*|[!a-z0-9]*) fail "original Compose project name is unsafe"; exit 1 ;;
esac
[ "$ORIGINAL_PROJECT" = backend ] \
    || { fail "stateful services are not owned by the canonical backend Compose project"; exit 1; }
[ "$(container_compose_label "$OLD_QDRANT_ID" com.docker.compose.service)" = qdrant ] \
    || { fail "current Qdrant Compose service identity is invalid"; exit 1; }
[ "$(container_compose_label "$OLD_POSTGRES_ID" com.docker.compose.service)" = postgres ] \
    || { fail "current PostgreSQL Compose service identity is invalid"; exit 1; }
OLD_QDRANT_CONFIG_HASH=$(container_compose_label "$OLD_QDRANT_ID" \
    com.docker.compose.config-hash) \
    || { fail "current Qdrant Compose config identity is unavailable"; exit 1; }
case "$OLD_QDRANT_CONFIG_HASH" in ''|*[!0-9a-f]*)
    fail "current Qdrant Compose config identity is invalid"; exit 1 ;;
esac
[ "${#OLD_QDRANT_CONFIG_HASH}" -eq 64 ] \
    || { fail "current Qdrant Compose config identity has an invalid length"; exit 1; }
QDRANT_VOLUME=$(container_named_volume "$OLD_QDRANT_ID" /qdrant/storage) \
    || { fail "current Qdrant volume identity is unavailable"; exit 1; }
OLD_QDRANT_VOLUME="$QDRANT_VOLUME"
POSTGRES_VOLUME=$(container_named_volume "$OLD_POSTGRES_ID" /var/lib/postgresql/data) \
    || { fail "current PostgreSQL volume identity is unavailable"; exit 1; }
qdrant_network=$(container_single_network "$OLD_QDRANT_ID") \
    || { fail "current Qdrant network identity is unavailable"; exit 1; }
postgres_network=$(container_single_network "$OLD_POSTGRES_ID") \
    || { fail "current PostgreSQL network identity is unavailable"; exit 1; }
[ "$qdrant_network" = "$postgres_network" ] \
    || { fail "stateful services do not share one primary network"; exit 1; }
STATEFUL_NETWORK="$qdrant_network"
STATEFUL_NETWORK_ID=$(query_network_id "$STATEFUL_NETWORK") \
    || { fail "stateful network ID is unavailable"; exit 1; }
[ "$QDRANT_VOLUME" = "${ORIGINAL_PROJECT}_qdrant_data" ] \
    || { fail "current Qdrant volume does not match future base Compose identity"; exit 1; }
[ "$POSTGRES_VOLUME" = "${ORIGINAL_PROJECT}_postgres_data" ] \
    || { fail "current PostgreSQL volume does not match future base Compose identity"; exit 1; }
[ "$STATEFUL_NETWORK" = "${ORIGINAL_PROJECT}_default" ] \
    || { fail "current stateful network does not match future base Compose identity"; exit 1; }
verify_named_volume "$QDRANT_VOLUME" \
    || { fail "Qdrant named volume is unavailable"; exit 1; }
verify_named_volume "$POSTGRES_VOLUME" \
    || { fail "PostgreSQL named volume is unavailable"; exit 1; }
verify_compose_resource_identity "$OLD_QDRANT_ID" "$ORIGINAL_PROJECT" qdrant \
    "$QDRANT_VOLUME" /qdrant/storage "$STATEFUL_NETWORK" \
    || { fail "current Qdrant Compose resource contract is invalid"; exit 1; }
OLD_QDRANT_IMAGE_ID=$(container_image_id "$OLD_QDRANT_ID") \
    || { fail "current Qdrant image identity is unavailable"; exit 1; }
case "$OLD_QDRANT_IMAGE_ID" in sha256:*) ;;
    *) fail "current Qdrant image identity is invalid"; exit 1 ;;
esac
old_qdrant_image_digest=${OLD_QDRANT_IMAGE_ID#sha256:}
case "$old_qdrant_image_digest" in ''|*[!0-9a-f]*)
    fail "current Qdrant image digest is invalid"; exit 1 ;;
esac
[ "${#old_qdrant_image_digest}" -eq 64 ] \
    || { fail "current Qdrant image digest has an invalid length"; exit 1; }
verify_image_linux_native "$OLD_QDRANT_IMAGE_ID" \
    || { fail "current Qdrant image is not linux/arm64"; exit 1; }
OLD_POSTGRES_IMAGE_ID=$(container_image_id "$OLD_POSTGRES_ID") \
    || { fail "current PostgreSQL image identity is unavailable"; exit 1; }
case "$OLD_POSTGRES_IMAGE_ID" in sha256:*) ;;
    *) fail "current PostgreSQL image identity is invalid"; exit 1 ;;
esac
old_postgres_image_digest=${OLD_POSTGRES_IMAGE_ID#sha256:}
case "$old_postgres_image_digest" in ''|*[!0-9a-f]*)
    fail "current PostgreSQL image digest is invalid"; exit 1 ;;
esac
[ "${#old_postgres_image_digest}" -eq 64 ] \
    || { fail "current PostgreSQL image digest has an invalid length"; exit 1; }
verify_image_linux_native "$OLD_POSTGRES_IMAGE_ID" \
    || { fail "current PostgreSQL image is not linux/arm64"; exit 1; }
OLD_QDRANT_VOLUME_IDENTITY=$(qdrant_volume_identity_json "$OLD_QDRANT_VOLUME") \
    || { fail "current Qdrant volume identity cannot be frozen"; exit 1; }
OLD_QDRANT_VOLUME_IDENTITY_SHA=$(printf '%s\n' "$OLD_QDRANT_VOLUME_IDENTITY" \
    | sha256sum | awk '{print $1}') \
    || { fail "current Qdrant volume identity cannot be hashed"; exit 1; }
record_state qdrant.rollback_image_id "$OLD_QDRANT_IMAGE_ID"
record_state postgres.rollback_image_id "$OLD_POSTGRES_IMAGE_ID"
record_state qdrant.rollback_compose_config_hash "$OLD_QDRANT_CONFIG_HASH"
record_state qdrant.rollback_volume_identity_sha256 "$OLD_QDRANT_VOLUME_IDENTITY_SHA"
old_qdrant_user=$(run_bounded_docker_read inspect --format '{{.Config.User}}' "$OLD_QDRANT_ID") \
    || { fail "current Qdrant user contract is unavailable"; exit 1; }
case "$old_qdrant_user" in
    ''|0|0:0) ;;
    *) fail "current Qdrant is not a root-owned rollback baseline"; exit 1 ;;
esac
verify_compose_resource_identity "$OLD_POSTGRES_ID" "$ORIGINAL_PROJECT" postgres \
    "$POSTGRES_VOLUME" /var/lib/postgresql/data "$STATEFUL_NETWORK" \
    || { fail "current PostgreSQL Compose resource contract is invalid"; exit 1; }
verify_api_bridge_receipt \
    || { fail "fresh exact API bridge receipt is required before stateful preparation"; exit 1; }
candidate_inventory=$(run_bounded_docker_read container ls -a --no-trunc \
    --filter "label=com.docker.compose.project=$CANDIDATE_PROJECT" --format '{{.ID}}') \
    || { fail "candidate Compose project inventory failed"; exit 1; }
[ -z "$candidate_inventory" ] \
    || { fail "candidate Compose project already owns containers"; exit 1; }
for reserved_name in "$QDRANT_PREVIOUS_CONTAINER" "$POSTGRES_PREVIOUS_CONTAINER" \
    "$QDRANT_FALLBACK_CONTAINER" "$POSTGRES_FALLBACK_CONTAINER" \
    "$QDRANT_AUDIT_CONTAINER" "$QDRANT_OWNER_AUDIT_CONTAINER" \
    "$ALPINE_ATTEST_CONTAINER"; do
    reserved_id=$(query_container_id "$reserved_name") \
        || { fail "reserved container inventory is ambiguous: $reserved_name"; exit 1; }
    [ -z "$reserved_id" ] \
        || { fail "reserved container name already exists: $reserved_name"; exit 1; }
done
candidate_image_before=$(query_optional_image_id "$QDRANT_CANDIDATE_IMAGE") \
    || { fail "deployment-unique Qdrant candidate image inventory is ambiguous"; exit 1; }
[ "$candidate_image_before" = "absent" ] \
    || { fail "deployment-unique Qdrant candidate image tag already exists"; exit 1; }
candidate_image_before=$(query_optional_image_id "$POSTGRES_CANDIDATE_IMAGE") \
    || { fail "deployment-unique PostgreSQL candidate image inventory is ambiguous"; exit 1; }
[ "$candidate_image_before" = "absent" ] \
    || { fail "deployment-unique PostgreSQL candidate image tag already exists"; exit 1; }
candidate_image_before=$(query_optional_image_id "$POSTGRES_MIGRATE_CANDIDATE_IMAGE") \
    || { fail "deployment-unique PostgreSQL migrate image inventory is ambiguous"; exit 1; }
[ "$candidate_image_before" = "absent" ] \
    || { fail "deployment-unique PostgreSQL migrate image tag already exists"; exit 1; }
rollback_image_before=$(query_optional_image_id "$QDRANT_ROLLBACK_IMAGE") \
    || { fail "deployment-unique Qdrant rollback image inventory is ambiguous"; exit 1; }
[ "$rollback_image_before" = "absent" ] \
    || { fail "deployment-unique Qdrant rollback image tag already exists"; exit 1; }
rollback_image_before=$(query_optional_image_id "$POSTGRES_ROLLBACK_IMAGE") \
    || { fail "deployment-unique PostgreSQL rollback image inventory is ambiguous"; exit 1; }
[ "$rollback_image_before" = "absent" ] \
    || { fail "deployment-unique PostgreSQL rollback image tag already exists"; exit 1; }

{
    printf '%s\n' 'services:' '  qdrant:'
    printf '    image: "%s"\n' "$QDRANT_CANDIDATE_IMAGE"
    printf '%s\n' '    restart: "no"' '  postgres:'
    printf '    image: "%s"\n' "$POSTGRES_CANDIDATE_IMAGE"
    printf '%s\n' '    restart: "no"' '  migrate:'
    printf '    image: "%s"\n' "$POSTGRES_MIGRATE_CANDIDATE_IMAGE"
    printf '%s\n' '    restart: "no"'
    printf '%s\n' 'volumes:'
    printf '  qdrant_data:\n    external: true\n    name: "%s"\n' "$QDRANT_CANDIDATE_VOLUME"
    printf '  postgres_data:\n    external: true\n    name: "%s"\n' "$POSTGRES_VOLUME"
    printf '%s\n' 'networks:' '  default:' '    external: true'
    printf '    name: "%s"\n' "$STATEFUL_NETWORK"
} > "$CANDIDATE_OVERRIDE"
chmod 600 "$CANDIDATE_OVERRIDE"
sync -f "$CANDIDATE_OVERRIDE" 2>/dev/null || sync
if ! run_bounded_docker_read compose --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
    --project-name "$CANDIDATE_PROJECT" \
    -f "$COMPOSE_FILE" \
    -f "$CANDIDATE_OVERRIDE" config --quiet >/dev/null; then
    fail "candidate Compose configuration could not be rendered"
    exit 1
fi
record_state compose.original_project "$ORIGINAL_PROJECT"
record_state compose.candidate_project "$CANDIDATE_PROJECT"
record_state compose.source_sha256 "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
record_state compose.override_sha256 "$(sha256sum "$CANDIDATE_OVERRIDE" | awk '{print $1}')"
record_state qdrant.rollback_volume "$OLD_QDRANT_VOLUME"
record_state qdrant.candidate_volume "$QDRANT_CANDIDATE_VOLUME"
record_state postgres.volume "$POSTGRES_VOLUME"
record_state stateful.network "$STATEFUL_NETWORK"
record_state stateful.network_id "$STATEFUL_NETWORK_ID"
wait_qdrant || { fail "current Qdrant is not ready"; exit 1; }
wait_postgres || { fail "current PostgreSQL is not ready"; exit 1; }

record_state deployment.status building-qdrant
record_state qdrant.audit_base_pull.intent "$AUDIT_BASE_REFERENCE"
run_bounded_docker_with_timeout "$BUILD_TIMEOUT_SECONDS" pull "$AUDIT_BASE_REFERENCE" \
    || { fail "pinned Alpine audit base could not be pulled"; exit 1; }
AUDIT_BASE_IMAGE_ID=$(query_image_id "$AUDIT_BASE_REFERENCE") \
    || { fail "pinned Alpine audit base identity is unavailable"; exit 1; }
audit_docker_arch=$(run_bounded_docker_read image inspect --format '{{.Architecture}}' \
    "$AUDIT_BASE_IMAGE_ID") \
    || { fail "pinned Alpine audit base architecture is unavailable"; exit 1; }
case "$audit_docker_arch" in
    amd64)
        [ "$TEST_MODE" = "1" ] \
            || { fail "production Alpine audit base is not arm64"; exit 1; }
        AUDIT_APK_ARCH=x86_64
        expected_audit_busybox=f3547b3d78d08a028a4833ddb83b77cf012838c078bfd2b76355f53d1d8bba62
        expected_audit_contract=ecf630ad651e1e3b53d257b0d19e1aa2e2f28e543442218f4c3992b073425a61
        ;;
    arm64)
        AUDIT_APK_ARCH=aarch64
        expected_audit_busybox=dd10691d81c84f0182f5af5f1583d566ddc0b9d0d9fc46b41b99b83c398306dd
        expected_audit_contract=7c9d227469c7c5ffe8e1b407619bc4f132bdd68ca8d254a2be28ee458bfcc3aa
        ;;
    *) fail "pinned Alpine audit base architecture is unsupported"; exit 1 ;;
esac
audit_base_repo_digests=$(run_bounded_docker_read image inspect --format \
    '{{json .RepoDigests}}' "$AUDIT_BASE_IMAGE_ID") \
    || { fail "pinned Alpine audit base RepoDigests are unavailable"; exit 1; }
printf '%s' "$audit_base_repo_digests" | grep -F \
    "alpine@$AUDIT_BASE_DIGEST" >/dev/null \
    || { fail "pinned Alpine audit base digest is not locally attested"; exit 1; }
record_state qdrant.audit_base_image_id "$AUDIT_BASE_IMAGE_ID"
record_state qdrant.audit_base_run.intent "$ALPINE_ATTEST_CONTAINER"
if ! run_bounded_docker_mutation run --name "$ALPINE_ATTEST_CONTAINER" \
    --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 0:0 \
    --entrypoint /bin/sh "$AUDIT_BASE_IMAGE_ID" -ec \
    'printf "banner=%s\n" "$(busybox 2>&1 | sed -n "1p")"; printf "sha256=%s\n" "$(sha256sum /bin/busybox | awk "{print \$1}")"' \
    > "$RUN_DIR/evidence/alpine-busybox-attestation.txt"; then
    fail "pinned Alpine BusyBox attestation failed"
    exit 1
fi
alpine_attest_id=$(query_container_id "$ALPINE_ATTEST_CONTAINER") \
    || { fail "pinned Alpine attestation container identity is ambiguous"; exit 1; }
[ -n "$alpine_attest_id" ] \
    && [ "$(container_image_id "$alpine_attest_id")" = "$AUDIT_BASE_IMAGE_ID" ] \
    || { fail "pinned Alpine attestation container identity is invalid"; exit 1; }
grep -Fx 'banner=BusyBox v1.37.0 (2025-12-16 14:19:28 UTC) multi-call binary.' \
    "$RUN_DIR/evidence/alpine-busybox-attestation.txt" >/dev/null \
    || { fail "pinned Alpine BusyBox banner is invalid"; exit 1; }
AUDIT_BUSYBOX_SHA256=$(awk -F= '$1 == "sha256" { print $2 }' \
    "$RUN_DIR/evidence/alpine-busybox-attestation.txt")
case "$AUDIT_BUSYBOX_SHA256" in
    *[!0-9a-f]*|'') fail "pinned Alpine BusyBox digest is invalid"; exit 1 ;;
esac
[ "${#AUDIT_BUSYBOX_SHA256}" -eq 64 ] \
    || { fail "pinned Alpine BusyBox digest is not SHA-256"; exit 1; }
[ "$AUDIT_BUSYBOX_SHA256" = "$expected_audit_busybox" ] \
    || { fail "pinned Alpine BusyBox digest does not match the architecture map"; exit 1; }
chmod 600 "$RUN_DIR/evidence/alpine-busybox-attestation.txt"
durable_sync_path "$RUN_DIR/evidence/alpine-busybox-attestation.txt"
record_state qdrant.audit_busybox_sha256 "$AUDIT_BUSYBOX_SHA256"
run_bounded_docker_mutation rm "$alpine_attest_id" >/dev/null \
    || { fail "pinned Alpine attestation container could not be removed"; exit 1; }
wait_container_mapping "$ALPINE_ATTEST_CONTAINER" "" \
    || { fail "pinned Alpine attestation container removal did not stabilize"; exit 1; }
AUDIT_CONTRACT_FILE="$RUN_DIR/evidence/audit-contract.expected"
AUDIT_CONTRACT_HELPER_SHA256=$(sha256sum "$QDRANT_RELEASE_AUDIT_CONTRACT_HELPER" \
    | awk '{print $1}')
[ "$AUDIT_CONTRACT_HELPER_SHA256" = 05da48154d8001f2f97d707b98f4c5870c66a0909ad204adc3c6a34f7de4b6d8 ] \
    || { fail "Alpine audit contract helper provenance is invalid"; exit 1; }
/bin/sh "$QDRANT_RELEASE_AUDIT_CONTRACT_HELPER" \
    "$AUDIT_APK_ARCH" "$AUDIT_BUSYBOX_SHA256" > "$AUDIT_CONTRACT_FILE" \
    || { fail "Alpine audit contract helper failed"; exit 1; }
chmod 600 "$AUDIT_CONTRACT_FILE"
durable_sync_path "$AUDIT_CONTRACT_FILE"
AUDIT_CONTRACT_SHA256=$(sha256sum "$AUDIT_CONTRACT_FILE" | awk '{print $1}')
[ "$AUDIT_CONTRACT_SHA256" = "$expected_audit_contract" ] \
    || { fail "Alpine audit contract does not match the architecture map"; exit 1; }
record_state qdrant.audit_contract_sha256 "$AUDIT_CONTRACT_SHA256"
dockerfile_sha=$(sha256sum "$QDRANT_RELEASE_BUILD_CONTEXT/Dockerfile" | awk '{print $1}')
build_timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
run_bounded_docker_with_timeout "$BUILD_TIMEOUT_SECONDS" build --pull --no-cache \
    --target audit-tools \
    --build-arg "DIVA_QDRANT_DOCKERFILE_SHA256=$dockerfile_sha" \
    --build-arg "DIVA_QDRANT_BUILD_TIMESTAMP=$build_timestamp" \
    --build-arg "DIVA_BUSYBOX_BINARY_SHA256=$AUDIT_BUSYBOX_SHA256" \
    --build-arg "DIVA_AUDIT_CONTRACT_SHA256=$AUDIT_CONTRACT_SHA256" \
    --build-arg "DIVA_AUDIT_CONTRACT_HELPER_SHA256=$AUDIT_CONTRACT_HELPER_SHA256" \
    --build-arg "DIVA_AUDIT_ARCH=$AUDIT_APK_ARCH" \
    --tag "$QDRANT_AUDIT_TOOL_IMAGE" "$QDRANT_RELEASE_BUILD_CONTEXT"
NEW_QDRANT_AUDIT_ID=$(query_image_id "$QDRANT_AUDIT_TOOL_IMAGE") \
    || { fail "built Qdrant audit image identity is unavailable"; exit 1; }
verify_image_linux_native "$NEW_QDRANT_AUDIT_ID" \
    || { fail "built Qdrant audit image is not linux/arm64"; exit 1; }
record_state qdrant.audit_image_id "$NEW_QDRANT_AUDIT_ID"
[ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.base-digest"}}' "$NEW_QDRANT_AUDIT_ID")" = "$AUDIT_BASE_DIGEST" ] \
    || { fail "Qdrant audit image base digest label is invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.base-reference"}}' "$NEW_QDRANT_AUDIT_ID")" = "$AUDIT_BASE_REFERENCE" ] \
    || { fail "Qdrant audit image base reference label is invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.audit-contract"}}' "$NEW_QDRANT_AUDIT_ID")" = "offline-storage-audit-v3-alpine" ] \
    || { fail "Qdrant audit image runtime label is invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.audit-contract-sha256"}}' "$NEW_QDRANT_AUDIT_ID")" = "$AUDIT_CONTRACT_SHA256" ] \
    && [ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.audit-contract-helper-sha256"}}' "$NEW_QDRANT_AUDIT_ID")" = "$AUDIT_CONTRACT_HELPER_SHA256" ] \
    && [ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.alpine-inventory-sha256"}}' "$NEW_QDRANT_AUDIT_ID")" = "$AUDIT_INVENTORY_SHA256" ] \
    && [ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.busybox-version"}}' "$NEW_QDRANT_AUDIT_ID")" = "1.37.0-r30" ] \
    && [ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.busybox-binary-sha256"}}' "$NEW_QDRANT_AUDIT_ID")" = "$AUDIT_BUSYBOX_SHA256" ] \
    && [ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.audit-architecture"}}' "$NEW_QDRANT_AUDIT_ID")" = "$AUDIT_APK_ARCH" ] \
    || { fail "Qdrant audit image Alpine/BusyBox evidence labels are invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.dockerfile-sha256"}}' "$NEW_QDRANT_AUDIT_ID")" = "$dockerfile_sha" ] \
    || { fail "Qdrant audit image Dockerfile provenance label is invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{.Config.User}}' "$NEW_QDRANT_AUDIT_ID")" = "65534:65534" ] \
    && [ "$(run_bounded_docker_read image inspect --format '{{json .Config.Entrypoint}}' "$NEW_QDRANT_AUDIT_ID")" = '["/bin/sh"]' ] \
    && [ "$(run_bounded_docker_read image inspect --format '{{json .Config.Cmd}}' "$NEW_QDRANT_AUDIT_ID")" = 'null' ] \
    && [ "$(run_bounded_docker_read image inspect --format '{{json .Config.Volumes}}' "$NEW_QDRANT_AUDIT_ID")" = 'null' ] \
    || { fail "Qdrant audit image default runtime contract is invalid"; exit 1; }
run_bounded_docker_with_timeout "$BUILD_TIMEOUT_SECONDS" build --pull \
    --target runtime \
    --build-arg "DIVA_QDRANT_DOCKERFILE_SHA256=$dockerfile_sha" \
    --build-arg "DIVA_QDRANT_BUILD_TIMESTAMP=$build_timestamp" \
    --build-arg "DIVA_BUSYBOX_BINARY_SHA256=$AUDIT_BUSYBOX_SHA256" \
    --build-arg "DIVA_AUDIT_CONTRACT_SHA256=$AUDIT_CONTRACT_SHA256" \
    --build-arg "DIVA_AUDIT_CONTRACT_HELPER_SHA256=$AUDIT_CONTRACT_HELPER_SHA256" \
    --build-arg "DIVA_AUDIT_ARCH=$AUDIT_APK_ARCH" \
    --tag "$QDRANT_CANDIDATE_IMAGE" "$QDRANT_RELEASE_BUILD_CONTEXT"
NEW_QDRANT_ID=$(query_image_id "$QDRANT_CANDIDATE_IMAGE") \
    || { fail "built Qdrant candidate image identity is unavailable"; exit 1; }
verify_image_linux_native "$NEW_QDRANT_ID" \
    || { fail "built Qdrant candidate image is not linux/arm64"; exit 1; }
record_state qdrant.new_image_id "$NEW_QDRANT_ID"
[ "$(run_bounded_docker_read image inspect --format '{{.Config.User}}' "$NEW_QDRANT_ID")" = "1000:1000" ] \
    || { fail "hardened Qdrant image is not rootless"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.base-digest"}}' "$NEW_QDRANT_ID")" = "$QDRANT_BASE_DIGEST" ] \
    || { fail "hardened Qdrant base digest label is invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.base-reference"}}' "$NEW_QDRANT_ID")" = "qdrant/qdrant:v1.19.0-unprivileged@$QDRANT_BASE_DIGEST" ] \
    || { fail "hardened Qdrant base reference label is invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.runtime-contract"}}' "$NEW_QDRANT_ID")" = "$QDRANT_RUNTIME_CONTRACT" ] \
    || { fail "hardened Qdrant runtime label is invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{index .Config.Labels "com.diva.qdrant.dockerfile-sha256"}}' "$NEW_QDRANT_ID")" = "$dockerfile_sha" ] \
    || { fail "hardened Qdrant Dockerfile provenance label is invalid"; exit 1; }
[ "$(query_image_id "$QDRANT_CANDIDATE_IMAGE")" = "$NEW_QDRANT_ID" ] \
    || { fail "Qdrant candidate tag changed during validation"; exit 1; }
entrypoint_json=$(run_bounded_docker_read image inspect --format '{{json .Config.Entrypoint}}' "$NEW_QDRANT_ID") \
    || { fail "Qdrant runtime entrypoint is unavailable"; exit 1; }
[ "$entrypoint_json" = '["/qdrant/qdrant"]' ] \
    || { fail "Qdrant scratch runtime entrypoint is invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{json .Config.Cmd}}' "$NEW_QDRANT_ID")" = '["--config-path","/qdrant/config/production.yaml"]' ] \
    || { fail "Qdrant scratch runtime production config command is invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{json .Config.Env}}' "$NEW_QDRANT_ID")" = '["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","QDRANT__STORAGE__SNAPSHOTS_PATH=/qdrant/storage/snapshots","QDRANT__TELEMETRY_DISABLED=true"]' ] \
    || { fail "Qdrant scratch runtime environment defaults are invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{.Config.WorkingDir}}' "$NEW_QDRANT_ID")" = /qdrant ] \
    || { fail "Qdrant scratch runtime working directory is invalid"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{json .Config.Shell}}' "$NEW_QDRANT_ID")" = null ] \
    || { fail "Qdrant scratch runtime must not contain a shell contract"; exit 1; }
[ "$(run_bounded_docker_read image inspect --format '{{json .Config.Volumes}}' "$NEW_QDRANT_ID")" = null ] \
    || { fail "Qdrant scratch runtime must not declare implicit volumes"; exit 1; }
record_state qdrant.image_contracts verified-before-shared-scan
if ! run_bounded_docker_mutation run --name "$QDRANT_AUDIT_CONTAINER" \
    --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 1000:1000 \
    "$NEW_QDRANT_ID" --version > "$RUN_DIR/qdrant-runtime-version.txt"; then
    fail "hardened scratch Qdrant runtime could not execute directly"
    exit 1
fi
qdrant_audit_id=$(query_container_id "$QDRANT_AUDIT_CONTAINER") \
    || { fail "Qdrant audit container identity is ambiguous"; exit 1; }
[ -n "$qdrant_audit_id" ] || { fail "Qdrant audit container is missing"; exit 1; }
for runtime_evidence in \
    qdrant-binary.sha256 \
    qdrant-config-tree.sha256 \
    qdrant-config-files.sha256 \
    ca-certificates-bundle.sha256 \
    application-files.sha256 \
    runtime-links.txt \
    runtime-packages.tsv; do
    runtime_evidence_target="$RUN_DIR/evidence/$runtime_evidence"
    [ ! -e "$runtime_evidence_target" ] && [ ! -L "$runtime_evidence_target" ] \
        || { fail "runtime evidence target already exists: $runtime_evidence_target"; exit 1; }
    run_bounded_docker_read cp \
        "$qdrant_audit_id:/usr/share/diva-qdrant/$runtime_evidence" \
        "$runtime_evidence_target" \
        || { fail "Qdrant runtime evidence could not be extracted: $runtime_evidence"; exit 1; }
    chmod 600 "$runtime_evidence_target"
    durable_sync_path "$runtime_evidence_target"
    record_state "qdrant.runtime_evidence.$runtime_evidence.sha256" \
        "$(sha256sum "$runtime_evidence_target" | awk '{print $1}')"
done
qdrant_binary_sha=$(cat "$RUN_DIR/evidence/qdrant-binary.sha256")
qdrant_config_sha=$(cat "$RUN_DIR/evidence/qdrant-config-tree.sha256")
qdrant_runtime_links_sha=$(sha256sum "$RUN_DIR/evidence/runtime-links.txt" | awk '{print $1}')
case "$qdrant_binary_sha:$qdrant_config_sha" in
    *[!0-9a-f:]*|:|*:|*::* ) fail "Qdrant runtime content hashes are invalid"; exit 1 ;;
esac
[ "${#qdrant_binary_sha}" -eq 64 ] && [ "${#qdrant_config_sha}" -eq 64 ] \
    || { fail "Qdrant runtime content hashes are not SHA-256"; exit 1; }
case "$AUDIT_APK_ARCH" in
    x86_64)
        expected_runtime_links=$(printf '%s\n' \
            '/lib=usr/lib' '/lib64=usr/lib64' \
            'interpreter=/lib64/ld-linux-x86-64.so.2' \
            'resolved_interpreter=/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2')
        ;;
    aarch64)
        expected_runtime_links=$(printf '%s\n' \
            '/lib=usr/lib' '/lib64=absent' \
            'interpreter=/lib/ld-linux-aarch64.so.1' \
            'resolved_interpreter=/usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1')
        ;;
    *) fail "Qdrant runtime link architecture is unsupported"; exit 1 ;;
esac
[ "$(cat "$RUN_DIR/evidence/runtime-links.txt")" = "$expected_runtime_links" ] \
    || { fail "Qdrant runtime usrmerge/interpreter evidence is invalid"; exit 1; }
run_bounded_docker_mutation rm "$qdrant_audit_id" >/dev/null \
    || { fail "Qdrant audit container could not be removed"; exit 1; }
wait_container_mapping "$QDRANT_AUDIT_CONTAINER" "" \
    || { fail "Qdrant audit container removal did not stabilize"; exit 1; }
[ -s "$RUN_DIR/qdrant-runtime-version.txt" ] \
    || { fail "hardened scratch Qdrant runtime version is empty"; exit 1; }
if ! run_bounded_docker_mutation run --name "$QDRANT_OWNER_AUDIT_CONTAINER" \
    --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 0:0 \
    --volume "$QDRANT_VOLUME:/qdrant/storage:ro" --entrypoint /bin/sh \
    "$NEW_QDRANT_AUDIT_ID" -ec \
    'find /qdrant/storage -xdev -print0 | while IFS= read -r -d "" path; do stat -c "%u:%g" "$path"; done | sort -u' \
    > "$RUN_DIR/qdrant-owner-audit.txt"; then
    fail "Qdrant ownership audit could not be completed"
    exit 1
fi
qdrant_owner_audit_id=$(query_container_id "$QDRANT_OWNER_AUDIT_CONTAINER") \
    || { fail "Qdrant ownership audit container identity is ambiguous"; exit 1; }
[ -n "$qdrant_owner_audit_id" ] \
    || { fail "Qdrant ownership audit container is missing"; exit 1; }
for audit_evidence in \
    audit-applets.txt \
    audit-links.txt \
    audit-contract.txt \
    audit-contract.sha256 \
    audit-files.sha256 \
    audit-packages.txt \
    busybox-binary.sha256 \
    busybox-version.txt; do
    audit_evidence_target="$RUN_DIR/evidence/$audit_evidence"
    [ ! -e "$audit_evidence_target" ] && [ ! -L "$audit_evidence_target" ] \
        || { fail "audit evidence target already exists: $audit_evidence_target"; exit 1; }
    run_bounded_docker_read cp \
        "$qdrant_owner_audit_id:/usr/share/diva-qdrant/$audit_evidence" \
        "$audit_evidence_target" \
        || { fail "Qdrant audit evidence could not be extracted: $audit_evidence"; exit 1; }
    chmod 600 "$audit_evidence_target"
    durable_sync_path "$audit_evidence_target"
    record_state "qdrant.audit_evidence.$audit_evidence.sha256" \
        "$(sha256sum "$audit_evidence_target" | awk '{print $1}')"
done
cmp -s "$AUDIT_CONTRACT_FILE" "$RUN_DIR/evidence/audit-contract.txt" \
    && [ "$(cat "$RUN_DIR/evidence/audit-contract.sha256")" = "$AUDIT_CONTRACT_SHA256" ] \
    && [ "$(sha256sum "$RUN_DIR/evidence/audit-contract.txt" | awk '{print $1}')" = "$AUDIT_CONTRACT_SHA256" ] \
    && [ "$(sha256sum "$RUN_DIR/evidence/audit-packages.txt" | awk '{print $1}')" = "$AUDIT_INVENTORY_SHA256" ] \
    && [ "$(cat "$RUN_DIR/evidence/busybox-binary.sha256")" = "$AUDIT_BUSYBOX_SHA256" ] \
    && [ "$(cat "$RUN_DIR/evidence/busybox-version.txt")" = 'BusyBox v1.37.0 (2025-12-16 14:19:28 UTC) multi-call binary.' ] \
    || { fail "Qdrant audit image evidence does not match its pinned contract"; exit 1; }
[ -s "$RUN_DIR/evidence/audit-files.sha256" ] \
    || { fail "Qdrant audit image file manifest is empty"; exit 1; }
run_bounded_docker_mutation rm "$qdrant_owner_audit_id" >/dev/null \
    || { fail "Qdrant ownership audit container could not be removed"; exit 1; }
wait_container_mapping "$QDRANT_OWNER_AUDIT_CONTAINER" "" \
    || { fail "Qdrant ownership audit container removal did not stabilize"; exit 1; }
[ "$(cat "$RUN_DIR/qdrant-owner-audit.txt")" = "0:0" ] \
    || { fail "Qdrant volume ownership is not uniformly reversible from root"; exit 1; }
record_state qdrant.original_ownership uniform-0:0

record_state deployment.status preparing-postgres
verify_release_sources_unchanged \
    || { fail "release sources changed before PostgreSQL image builds"; exit 1; }
postgres_dockerfile_sha=$(sha256sum \
    "$POSTGRES_RELEASE_BUILD_CONTEXT/Dockerfile.pgvector" | awk '{print $1}')
postgres_migrate_dockerfile_sha=$(sha256sum \
    "$POSTGRES_RELEASE_BUILD_CONTEXT/Dockerfile.migrate" | awk '{print $1}')
postgres_schema_sha=$(sha256sum \
    "$POSTGRES_RELEASE_BUILD_CONTEXT/schema.sql" | awk '{print $1}')
postgres_source_bundle_sha=$(printf '%s\n' \
    "dockerfile.sha256=$postgres_dockerfile_sha" \
    'pgvector.archive.sha256=d076a3098010905fd60256649327809651f6288327db6413f0938305f62ea299' \
    'pgvector.commit=8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c' \
    "schema.sha256=$postgres_schema_sha" | sha256sum | awk '{print $1}')
postgres_build_timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
run_bounded_docker_with_timeout "$BUILD_TIMEOUT_SECONDS" build --pull --no-cache \
    -f "$POSTGRES_RELEASE_BUILD_CONTEXT/Dockerfile.pgvector" \
    --build-arg "DIVA_POSTGRES_DOCKERFILE_SHA256=$postgres_dockerfile_sha" \
    --build-arg "DIVA_POSTGRES_BUILD_TIMESTAMP=$postgres_build_timestamp" \
    --build-arg "DIVA_POSTGRES_SCHEMA_SHA256=$postgres_schema_sha" \
    --build-arg "DIVA_POSTGRES_SOURCE_BUNDLE_SHA256=$postgres_source_bundle_sha" \
    --tag "$POSTGRES_CANDIDATE_IMAGE" "$POSTGRES_RELEASE_BUILD_CONTEXT" \
    || { fail "hardened PostgreSQL candidate image build failed"; exit 1; }
NEW_POSTGRES_ID=$(query_image_id "$POSTGRES_CANDIDATE_IMAGE") \
    || { fail "built PostgreSQL image identity is unavailable"; exit 1; }
verify_image_linux_native "$NEW_POSTGRES_ID" \
    || { fail "built PostgreSQL image is not linux/arm64"; exit 1; }
verify_postgres_candidate_image "$NEW_POSTGRES_ID" "$postgres_dockerfile_sha" \
    "$postgres_schema_sha" "$postgres_source_bundle_sha" "$postgres_build_timestamp" \
    || { fail "built PostgreSQL image contract is invalid"; exit 1; }
record_state postgres.new_image_id "$NEW_POSTGRES_ID"
record_state postgres.dockerfile_sha256 "$postgres_dockerfile_sha"
record_state postgres.schema_sha256 "$postgres_schema_sha"
record_state postgres.source_bundle_sha256 "$postgres_source_bundle_sha"
run_bounded_docker_with_timeout "$BUILD_TIMEOUT_SECONDS" build --pull --no-cache \
    -f "$POSTGRES_RELEASE_BUILD_CONTEXT/Dockerfile.migrate" \
    --build-arg "DIVA_POSTGRES_MIGRATE_DOCKERFILE_SHA256=$postgres_migrate_dockerfile_sha" \
    --build-arg "DIVA_POSTGRES_MIGRATE_BUILD_TIMESTAMP=$postgres_build_timestamp" \
    --tag "$POSTGRES_MIGRATE_CANDIDATE_IMAGE" "$POSTGRES_RELEASE_BUILD_CONTEXT" \
    || { fail "hardened PostgreSQL migrate image build failed"; exit 1; }
NEW_POSTGRES_MIGRATE_ID=$(query_image_id "$POSTGRES_MIGRATE_CANDIDATE_IMAGE") \
    || { fail "built PostgreSQL migrate image identity is unavailable"; exit 1; }
verify_image_linux_native "$NEW_POSTGRES_MIGRATE_ID" \
    || { fail "built PostgreSQL migrate image is not linux/arm64"; exit 1; }
verify_postgres_migrate_candidate_image "$NEW_POSTGRES_MIGRATE_ID" \
    "$postgres_migrate_dockerfile_sha" "$postgres_build_timestamp" \
    || { fail "built PostgreSQL migrate image contract is invalid"; exit 1; }
record_state postgres_migrate.new_image_id "$NEW_POSTGRES_MIGRATE_ID"
record_state postgres_migrate.dockerfile_sha256 "$postgres_migrate_dockerfile_sha"
[ "$(query_image_id "$POSTGRES_CANDIDATE_IMAGE")" = "$NEW_POSTGRES_ID" ] \
    && [ "$(query_image_id "$POSTGRES_MIGRATE_CANDIDATE_IMAGE")" \
        = "$NEW_POSTGRES_MIGRATE_ID" ] \
    || { fail "PostgreSQL candidate tags changed after immutable builds"; exit 1; }
verify_release_sources_unchanged \
    || { fail "release sources changed during PostgreSQL image builds"; exit 1; }

record_state deployment.status scanning-all-runtime-images
old_qdrant_scan_image_id=$(container_image_id "$OLD_QDRANT_ID") \
    || { fail "current Qdrant image ID is unavailable for scanning"; exit 1; }
[ "$old_qdrant_scan_image_id" = "$OLD_QDRANT_IMAGE_ID" ] \
    || { fail "current Qdrant image changed before rollback scanning"; exit 1; }
old_postgres_scan_image_id=$(container_image_id "$OLD_POSTGRES_ID") \
    || { fail "current PostgreSQL image ID is unavailable for scanning"; exit 1; }
[ "$old_postgres_scan_image_id" = "$OLD_POSTGRES_IMAGE_ID" ] \
    || { fail "current PostgreSQL image changed before rollback scanning"; exit 1; }
api_gateway_container_id=$(query_container_id vocadb_api_gateway) \
    || { fail "API gateway container inventory is ambiguous"; exit 1; }
[ -n "$api_gateway_container_id" ] \
    || { fail "API gateway container is unavailable for exact image scanning"; exit 1; }
api_gateway_image_id=$(container_image_id "$api_gateway_container_id") \
    || { fail "API gateway image ID is unavailable for scanning"; exit 1; }
web_container_id=$(query_container_id vocadb_web) \
    || { fail "Web container inventory is ambiguous"; exit 1; }
[ -n "$web_container_id" ] \
    || { fail "Web container is unavailable for exact image scanning"; exit 1; }
web_image_id=$(container_image_id "$web_container_id") \
    || { fail "Web image ID is unavailable for scanning"; exit 1; }
for native_image_id in "$old_qdrant_scan_image_id" "$old_postgres_scan_image_id" \
    "$API_A_BRIDGE_IMAGE_ID" "$API_B_BRIDGE_IMAGE_ID" \
    "$api_gateway_image_id" "$web_image_id"; do
    verify_image_linux_native "$native_image_id" \
        || { fail "an existing production or rollback image is not linux/arm64: $native_image_id"; exit 1; }
done
prepare_image_scan_database \
    || { fail "isolated Trivy database preparation failed"; exit 1; }
scan_exact_image qdrant-runtime "$QDRANT_CANDIDATE_IMAGE" "$NEW_QDRANT_ID" debian \
    || { fail "exact Qdrant runtime image scan failed"; exit 1; }
scan_exact_image qdrant-audit "$QDRANT_AUDIT_TOOL_IMAGE" "$NEW_QDRANT_AUDIT_ID" alpine \
    || { fail "exact Qdrant audit image scan failed"; exit 1; }
scan_exact_image postgres-runtime "$POSTGRES_CANDIDATE_IMAGE" "$NEW_POSTGRES_ID" alpine \
    || { fail "exact PostgreSQL runtime image scan failed"; exit 1; }
scan_exact_image postgres-migrate "$POSTGRES_MIGRATE_CANDIDATE_IMAGE" \
    "$NEW_POSTGRES_MIGRATE_ID" alpine \
    || { fail "exact PostgreSQL migrate image scan failed"; exit 1; }
scan_exact_image qdrant-rollback "$old_qdrant_scan_image_id" \
    "$old_qdrant_scan_image_id" auto \
    || { fail "exact retained Qdrant image scan failed"; exit 1; }
scan_exact_image postgres-rollback "$old_postgres_scan_image_id" \
    "$old_postgres_scan_image_id" auto \
    || { fail "exact retained PostgreSQL image scan failed"; exit 1; }
scan_exact_image api-a "$API_A_BRIDGE_IMAGE_ID" "$API_A_BRIDGE_IMAGE_ID" alpine \
    || { fail "exact API A image scan failed"; exit 1; }
scan_exact_image api-b "$API_B_BRIDGE_IMAGE_ID" "$API_B_BRIDGE_IMAGE_ID" alpine \
    || { fail "exact API B image scan failed"; exit 1; }
scan_exact_image api-gateway "$api_gateway_image_id" "$api_gateway_image_id" alpine \
    || { fail "exact API gateway image scan failed"; exit 1; }
scan_exact_image web "$web_image_id" "$web_image_id" alpine \
    || { fail "exact Web image scan failed"; exit 1; }
[ "$(query_image_id "$QDRANT_CANDIDATE_IMAGE")" = "$NEW_QDRANT_ID" ] \
    && [ "$(query_image_id "$QDRANT_AUDIT_TOOL_IMAGE")" = "$NEW_QDRANT_AUDIT_ID" ] \
    && [ "$(query_image_id "$POSTGRES_CANDIDATE_IMAGE")" = "$NEW_POSTGRES_ID" ] \
    && [ "$(query_image_id "$POSTGRES_MIGRATE_CANDIDATE_IMAGE")" \
        = "$NEW_POSTGRES_MIGRATE_ID" ] \
    || { fail "candidate image tags changed during exact image scanning"; exit 1; }
if [ "$SCAN_CALIBRATION_REQUIRED" = "true" ]; then
    record_state image_scan.status requires-reviewed-exact-inventory-and-finding-contracts
    consume_verified_api_bridge_receipt calibration \
        || {
            MANAGEMENT_RECONCILIATION_REQUIRED=true
            fail "calibration receipt could not be durably archived; migration remains forbidden"
            exit 1
        }
    fail "image inventory/finding calibration is required before any writer or container switch; review $RUN_DIR/evidence/image-scan-*.calibration.json"
    exit 1
fi
QDRANT_ROLLBACK_SCAN_RECEIPT_SHA=$(sha256sum \
    "$RUN_DIR/evidence/image-scan-qdrant-rollback.receipt.json" | awk '{print $1}') \
    || { fail "Qdrant rollback scan receipt cannot be frozen"; exit 1; }
case "$QDRANT_ROLLBACK_SCAN_RECEIPT_SHA" in ''|*[!0-9a-f]*)
    fail "Qdrant rollback scan receipt digest is invalid"; exit 1 ;;
esac
[ "${#QDRANT_ROLLBACK_SCAN_RECEIPT_SHA}" -eq 64 ] \
    || { fail "Qdrant rollback scan receipt digest has an invalid length"; exit 1; }
record_state qdrant.rollback_scan_receipt_sha256 "$QDRANT_ROLLBACK_SCAN_RECEIPT_SHA"
POSTGRES_ROLLBACK_SCAN_RECEIPT_SHA=$(sha256sum \
    "$RUN_DIR/evidence/image-scan-postgres-rollback.receipt.json" | awk '{print $1}') \
    || { fail "PostgreSQL rollback scan receipt cannot be frozen"; exit 1; }
case "$POSTGRES_ROLLBACK_SCAN_RECEIPT_SHA" in ''|*[!0-9a-f]*)
    fail "PostgreSQL rollback scan receipt digest is invalid"; exit 1 ;;
esac
[ "${#POSTGRES_ROLLBACK_SCAN_RECEIPT_SHA}" -eq 64 ] \
    || { fail "PostgreSQL rollback scan receipt digest has an invalid length"; exit 1; }
record_state postgres.rollback_scan_receipt_sha256 "$POSTGRES_ROLLBACK_SCAN_RECEIPT_SHA"
record_state image_scan.status all-exact-receipts-verified

record_state deployment.status quiescing-pipeline-writers
FINAL_POSTGRES_BACKUP_PUBLICATION=$(validate_backup_evidence postgres_disaster_backup \
    "$POSTGRES_BACKUP_RUN" "$RUN_DIR/evidence/postgres-status.json" \
    "$POSTGRES_BACKUP_STATUS_SHA" "$RUN_DIR/evidence/postgres-manifest.json" \
    "$POSTGRES_BACKUP_MANIFEST_SHA" 48 "$BACKUP_SOURCE_HOST") \
    || { fail "PostgreSQL backup evidence expired before writer quiescence"; exit 1; }
FINAL_QDRANT_BACKUP_PUBLICATION=$(validate_backup_evidence qdrant_disaster_backup \
    "$QDRANT_BACKUP_RUN" "$RUN_DIR/evidence/qdrant-status.json" \
    "$QDRANT_BACKUP_STATUS_SHA" "$RUN_DIR/evidence/qdrant-manifest.json" \
    "$QDRANT_BACKUP_MANIFEST_SHA" 192 "$BACKUP_SOURCE_HOST") \
    || { fail "Qdrant backup evidence expired before writer quiescence"; exit 1; }
[ "$FINAL_POSTGRES_BACKUP_PUBLICATION" = "$COPIED_POSTGRES_PUBLICATION" ] \
    && [ "$FINAL_QDRANT_BACKUP_PUBLICATION" = "$COPIED_QDRANT_PUBLICATION" ] \
    && [ "$FINAL_POSTGRES_BACKUP_PUBLICATION" = "$FINAL_QDRANT_BACKUP_PUBLICATION" ] \
    || { fail "backup publication binding changed before writer quiescence"; exit 1; }
record_state backup.freshness revalidated-before-writer-quiescence
validate_backup_payload_attestation "$RUN_DIR/evidence/backup-payload-attestation.json" \
    "$BACKUP_ATTESTATION_SHA" "$BACKUP_ATTESTATION_CHALLENGE" "$BACKUP_VERIFIER_HOST" \
    "$RUN_DIR/evidence/postgres-status.json" "$RUN_DIR/evidence/postgres-manifest.json" \
    "$RUN_DIR/evidence/qdrant-status.json" "$RUN_DIR/evidence/qdrant-manifest.json" \
    "$POSTGRES_BACKUP_STATUS_SHA" "$POSTGRES_BACKUP_MANIFEST_SHA" \
    "$QDRANT_BACKUP_STATUS_SHA" "$QDRANT_BACKUP_MANIFEST_SHA" \
    "$POSTGRES_BACKUP_RUN" "$QDRANT_BACKUP_RUN" \
    "$API_BRIDGE_RECEIPT_CREATED_AT" \
    || { fail "backup payload attestation or its bridge anchor changed before writer quiescence"; exit 1; }
verify_release_sources_unchanged \
    || { fail "release sources changed before writer quiescence"; exit 1; }
gate_pipeline_writers \
    || { fail "pipeline writer gate could not be established; preserving the interlock"; exit 1; }
for publication_journal in "$FULL_PUBLICATION_JOURNAL" "$INCREMENTAL_PUBLICATION_JOURNAL"; do
    if [ -e "$publication_journal" ] || [ -L "$publication_journal" ]; then
        fail "unfinished recommendation publication journal exists: $publication_journal"
        exit 1
    fi
done
qdrant_fingerprint "$RUN_DIR/qdrant-quiesce-first.json"
"$SLEEP_COMMAND" "$WRITER_SETTLE_SECONDS"
verify_pipeline_writer_gate \
    || { fail "pipeline writer gate did not remain active"; exit 1; }
qdrant_fingerprint "$RUN_DIR/qdrant-before.json"
cmp -s "$RUN_DIR/qdrant-quiesce-first.json" "$RUN_DIR/qdrant-before.json" \
    || { fail "Qdrant changed after pipeline writers were gated"; exit 1; }

record_state deployment.status switching-qdrant
current_qdrant_id=$(query_container_id "$QDRANT_CONTAINER") \
    || { fail "current Qdrant identity became ambiguous"; exit 1; }
[ "$current_qdrant_id" = "$OLD_QDRANT_ID" ] \
    || { fail "current Qdrant changed during image preparation"; exit 1; }
wait_qdrant || { fail "current Qdrant stopped being ready before switch"; exit 1; }
verify_api_bridge_receipt \
    || { fail "fresh API bridge receipt changed before the first Qdrant mutation"; exit 1; }
old_qdrant_image_id=$(container_image_id "$OLD_QDRANT_ID") \
    || { fail "old Qdrant image identity is unavailable"; exit 1; }
old_qdrant_volume_identity=$(qdrant_volume_identity_json "$OLD_QDRANT_VOLUME") \
    || { fail "old Qdrant volume identity is unavailable"; exit 1; }
publication_generation=$(run_bounded_docker_read exec -i "$POSTGRES_CONTAINER" sh -ec \
    'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAtc "SELECT value FROM sync_state WHERE key = '\''recommendation_publication_generation'\''"') \
    || { fail "publication generation is unavailable before Qdrant upgrade"; exit 1; }
[ -n "$publication_generation" ] \
    || { fail "publication generation is empty before Qdrant upgrade"; exit 1; }
probe_slots=$(printf '{"api_a":"%s","api_b":"%s"}' \
    "$API_A_BRIDGE_IMAGE_ID" "$API_B_BRIDGE_IMAGE_ID")
QDRANT_MUTATED=true
record_state qdrant.storage_upgrade intent-before-controller
controller_status=0
run_qdrant_controller_supervised "$PYTHON_COMMAND" -I -B \
    "$QDRANT_RELEASE_CONTROLLER" \
    --journal "$QDRANT_UPGRADE_JOURNAL" \
    --output "$QDRANT_UPGRADE_RESULT" \
    --run-id "$RUN_ID" \
    --old-container-id "$OLD_QDRANT_ID" \
    --old-container-name "$QDRANT_CONTAINER" \
    --old-image-id "$old_qdrant_image_id" \
    --old-volume "$OLD_QDRANT_VOLUME" \
    --old-volume-identity "$old_qdrant_volume_identity" \
    --candidate-volume "$QDRANT_CANDIDATE_VOLUME" \
    --upgrade-network "$QDRANT_UPGRADE_NETWORK" \
    --expected-fingerprint "$RUN_DIR/qdrant-before.json" \
    --publication-generation "$publication_generation" \
    --probe-slots "$probe_slots" \
    --seed-song-id "$API_BRIDGE_SEED_SONG_ID" \
    --runtime-attestation "$PIPELINE_RUNTIME_ATTESTATION_FILE" \
    --final-image-id "$NEW_QDRANT_ID" \
    --audit-image-id "$NEW_QDRANT_AUDIT_ID" \
    --audit-architecture "$AUDIT_APK_ARCH" \
    --audit-inventory-sha256 "$AUDIT_INVENTORY_SHA256" \
    --audit-busybox-sha256 "$AUDIT_BUSYBOX_SHA256" \
    --audit-contract-sha256 "$AUDIT_CONTRACT_SHA256" \
    --audit-contract-helper-sha256 "$AUDIT_CONTRACT_HELPER_SHA256" \
    --runtime-binary-sha256 "$qdrant_binary_sha" \
    --runtime-config-sha256 "$qdrant_config_sha" \
    --runtime-links-sha256 "$qdrant_runtime_links_sha" \
    --dockerfile-sha256 "$dockerfile_sha" \
    --docker "$DOCKER_COMMAND" \
    --read-timeout "$READ_TIMEOUT_SECONDS" \
    --mutation-timeout "$DATA_MUTATION_TIMEOUT_SECONDS" \
    --health-timeout "$FINGERPRINT_TIMEOUT_SECONDS" \
    || controller_status=$?
if [ "$controller_status" -ne 0 ]; then
    DAEMON_MUTATION_UNRESOLVED=true
    record_state qdrant.controller_exit "$controller_status"
    if controller_settlement_sha=$(verify_qdrant_controller_settlement failure 2>/dev/null); then
        record_state qdrant.controller_process_settlement_sha256 "$controller_settlement_sha"
    else
        record_state qdrant.controller_process_settlement invalid-or-missing
    fi
    if wait_qdrant_controller_daemon_stable; then
        record_state qdrant.controller_daemon_reconciliation observed-stable-but-unresolved
    else
        record_state qdrant.controller_daemon_reconciliation read-or-runtime-unresolved
    fi
    fail "offline Qdrant sequential storage upgrade did not settle successfully; preserving the writer gate, journal, controller settlement, and daemon state without rollback"
    exit 1
fi
controller_settlement_sha=$(verify_qdrant_controller_settlement success) \
    || {
        DAEMON_MUTATION_UNRESOLVED=true
        fail "Qdrant controller process/journal/result settlement does not match"
        exit 1
    }
record_state qdrant.controller_process_settlement_sha256 "$controller_settlement_sha"
wait_qdrant_controller_daemon_stable \
    || {
        DAEMON_MUTATION_UNRESOLVED=true
        fail "Docker daemon did not settle after the Qdrant controller exited"
        exit 1
    }
write_qdrant_controller_daemon_settlement \
    || {
        DAEMON_MUTATION_UNRESOLVED=true
        fail "Qdrant controller Docker state could not be reconciled to a durable settlement"
        exit 1
    }
[ -f "$QDRANT_UPGRADE_RESULT" ] && [ ! -L "$QDRANT_UPGRADE_RESULT" ] \
    || { fail "Qdrant upgrade result is missing"; exit 1; }
final_upgrade_id=$(query_container_id "$QDRANT_FINAL_UPGRADE_CONTAINER") \
    || { fail "hardened final upgrade container inventory is ambiguous"; exit 1; }
[ -n "$final_upgrade_id" ] \
    || { fail "hardened final upgrade container is missing"; exit 1; }
record_state qdrant.final_upgrade_container_id "$final_upgrade_id"
record_state qdrant.final_upgrade_stop intent
run_bounded_docker_mutation stop --time 120 "$final_upgrade_id" >/dev/null
wait_container_running_id "$final_upgrade_id" false \
    || { fail "hardened final upgrade container did not stop exactly"; exit 1; }
record_state qdrant.final_upgrade_remove intent
run_bounded_docker_mutation rm "$final_upgrade_id" >/dev/null
wait_container_mapping "$QDRANT_FINAL_UPGRADE_CONTAINER" "" \
    || { fail "hardened final upgrade container removal did not stabilize"; exit 1; }
wait_container_running_id "$OLD_QDRANT_ID" false \
    || { fail "old Qdrant did not remain stopped after clone upgrade"; exit 1; }
run_bounded_docker_mutation rename "$OLD_QDRANT_ID" "$QDRANT_PREVIOUS_CONTAINER"
QDRANT_PREVIOUS_PRESERVED=true
wait_container_mapping "$QDRANT_CONTAINER" "" \
    || { fail "canonical Qdrant name was not released"; exit 1; }
wait_container_mapping "$QDRANT_PREVIOUS_CONTAINER" "$OLD_QDRANT_ID" \
    || { fail "preserved Qdrant container identity changed"; exit 1; }
verify_compose_resource_identity "$OLD_QDRANT_ID" "$ORIGINAL_PROJECT" qdrant \
    "$OLD_QDRANT_VOLUME" /qdrant/storage "$STATEFUL_NETWORK" \
    || { fail "preserved Qdrant resource identity changed"; exit 1; }
[ "$(query_network_id "$STATEFUL_NETWORK")" = "$STATEFUL_NETWORK_ID" ] \
    || { fail "stateful network identity changed before Qdrant switch"; exit 1; }
QDRANT_VOLUME="$QDRANT_CANDIDATE_VOLUME"
run_bounded_candidate_compose_mutation up -d --no-deps --no-build --force-recreate qdrant \
    || { fail "Qdrant candidate Compose mutation failed or timed out; preserving the journal without rollback"; exit 1; }
wait_stateful_daemon_stable \
    || { fail "Docker daemon did not stabilize after Qdrant compose mutation"; exit 1; }
NEW_QDRANT_CONTAINER_ID=$(query_container_id "$QDRANT_CONTAINER") \
    || { fail "new Qdrant container identity is ambiguous"; exit 1; }
[ -n "$NEW_QDRANT_CONTAINER_ID" ] && [ "$NEW_QDRANT_CONTAINER_ID" != "$OLD_QDRANT_ID" ] \
    || { fail "new Qdrant container identity is invalid"; exit 1; }
record_state qdrant.candidate_container_id "$NEW_QDRANT_CONTAINER_ID"
wait_container_mapping "$QDRANT_CONTAINER" "$NEW_QDRANT_CONTAINER_ID" \
    || { fail "new Qdrant canonical mapping did not stabilize"; exit 1; }
wait_qdrant || { fail "hardened Qdrant did not become ready"; exit 1; }
wait_container_mapping "$QDRANT_CONTAINER" "$NEW_QDRANT_CONTAINER_ID" \
    || { fail "new Qdrant mapping changed during readiness"; exit 1; }
verify_qdrant_runtime "$NEW_QDRANT_ID" "$NEW_QDRANT_CONTAINER_ID" \
    || { fail "hardened Qdrant runtime contract failed"; exit 1; }
verify_container_restart_policy "$NEW_QDRANT_CONTAINER_ID" no \
    || { fail "Qdrant candidate restart policy is not disabled"; exit 1; }
verify_compose_resource_identity "$NEW_QDRANT_CONTAINER_ID" "$CANDIDATE_PROJECT" qdrant \
    "$QDRANT_VOLUME" /qdrant/storage "$STATEFUL_NETWORK" \
    || { fail "Qdrant candidate Compose resource contract failed"; exit 1; }
wait_container_mapping "$QDRANT_PREVIOUS_CONTAINER" "$OLD_QDRANT_ID" \
    || { fail "Qdrant candidate creation removed the exact rollback container"; exit 1; }
wait_container_running_id "$OLD_QDRANT_ID" false \
    || { fail "preserved Qdrant did not remain stopped"; exit 1; }
qdrant_fingerprint "$RUN_DIR/qdrant-after.json"
qdrant_fingerprints_equivalent "$RUN_DIR/qdrant-before.json" "$RUN_DIR/qdrant-after.json" \
    || { fail "Qdrant structural fingerprint changed during sequential upgrade"; exit 1; }
record_state qdrant.candidate verified

record_state deployment.status switching-postgres
current_postgres_id=$(query_container_id "$POSTGRES_CONTAINER") \
    || { fail "current PostgreSQL identity became ambiguous"; exit 1; }
[ "$current_postgres_id" = "$OLD_POSTGRES_ID" ] \
    || { fail "current PostgreSQL changed during image preparation"; exit 1; }
wait_postgres "$OLD_POSTGRES_ID" \
    || { fail "current PostgreSQL stopped being ready before switch"; exit 1; }
postgres_fingerprint "$RUN_DIR/postgres-before.json" "$OLD_POSTGRES_ID"
POSTGRES_MUTATED=true
run_bounded_docker_mutation stop --time 60 "$OLD_POSTGRES_ID" >/dev/null
wait_container_running_id "$OLD_POSTGRES_ID" false \
    || { fail "old PostgreSQL did not reach a stable stopped state"; exit 1; }
run_bounded_docker_mutation rename "$OLD_POSTGRES_ID" "$POSTGRES_PREVIOUS_CONTAINER"
POSTGRES_PREVIOUS_PRESERVED=true
wait_container_mapping "$POSTGRES_CONTAINER" "" \
    || { fail "canonical PostgreSQL name was not released"; exit 1; }
wait_container_mapping "$POSTGRES_PREVIOUS_CONTAINER" "$OLD_POSTGRES_ID" \
    || { fail "preserved PostgreSQL container identity changed"; exit 1; }
verify_compose_resource_identity "$OLD_POSTGRES_ID" "$ORIGINAL_PROJECT" postgres \
    "$POSTGRES_VOLUME" /var/lib/postgresql/data "$STATEFUL_NETWORK" \
    || { fail "preserved PostgreSQL resource identity changed"; exit 1; }
[ "$(query_network_id "$STATEFUL_NETWORK")" = "$STATEFUL_NETWORK_ID" ] \
    || { fail "stateful network identity changed before PostgreSQL switch"; exit 1; }
run_bounded_candidate_compose_mutation up -d --no-deps --no-build --force-recreate postgres \
    || { fail "PostgreSQL candidate Compose mutation failed or timed out; preserving the journal without rollback"; exit 1; }
wait_stateful_daemon_stable \
    || { fail "Docker daemon did not stabilize after PostgreSQL compose mutation"; exit 1; }
NEW_POSTGRES_CONTAINER_ID=$(query_container_id "$POSTGRES_CONTAINER") \
    || { fail "new PostgreSQL container identity is ambiguous"; exit 1; }
[ -n "$NEW_POSTGRES_CONTAINER_ID" ] && [ "$NEW_POSTGRES_CONTAINER_ID" != "$OLD_POSTGRES_ID" ] \
    || { fail "new PostgreSQL container identity is invalid"; exit 1; }
record_state postgres.candidate_container_id "$NEW_POSTGRES_CONTAINER_ID"
wait_container_mapping "$POSTGRES_CONTAINER" "$NEW_POSTGRES_CONTAINER_ID" \
    || { fail "new PostgreSQL canonical mapping did not stabilize"; exit 1; }
wait_postgres "$NEW_POSTGRES_CONTAINER_ID" || { fail "pinned PostgreSQL did not become ready"; exit 1; }
wait_container_mapping "$POSTGRES_CONTAINER" "$NEW_POSTGRES_CONTAINER_ID" \
    || { fail "new PostgreSQL mapping changed during readiness"; exit 1; }
verify_postgres_runtime "$NEW_POSTGRES_ID" "$NEW_POSTGRES_CONTAINER_ID" \
    || { fail "pinned PostgreSQL runtime contract failed"; exit 1; }
verify_container_restart_policy "$NEW_POSTGRES_CONTAINER_ID" no \
    || { fail "PostgreSQL candidate restart policy is not disabled"; exit 1; }
verify_compose_resource_identity "$NEW_POSTGRES_CONTAINER_ID" "$CANDIDATE_PROJECT" postgres \
    "$POSTGRES_VOLUME" /var/lib/postgresql/data "$STATEFUL_NETWORK" \
    || { fail "PostgreSQL candidate Compose resource contract failed"; exit 1; }
wait_container_mapping "$POSTGRES_PREVIOUS_CONTAINER" "$OLD_POSTGRES_ID" \
    || { fail "PostgreSQL candidate creation removed the exact rollback container"; exit 1; }
wait_container_running_id "$OLD_POSTGRES_ID" false \
    || { fail "preserved PostgreSQL did not remain stopped"; exit 1; }
postgres_fingerprint "$RUN_DIR/postgres-after.json" "$NEW_POSTGRES_CONTAINER_ID"
cmp -s "$RUN_DIR/postgres-before.json" "$RUN_DIR/postgres-after.json" \
    || { fail "PostgreSQL logical fingerprint changed during minor update"; exit 1; }
record_state postgres.candidate verified

record_state deployment.status validating-candidate-topology
wait_http http://127.0.0.1:5000/api/ready 10 \
    || { fail "local API readiness did not recover after stateful switch"; exit 1; }
wait_http http://127.0.0.1:5000/api/health 30 \
    || { fail "local API health did not recover after stateful switch"; exit 1; }
wait_http http://127.0.0.1:8080/backend-api/api/ready 15 \
    || { fail "Web gateway readiness did not recover after stateful switch"; exit 1; }

wait_container_mapping "$QDRANT_CONTAINER" "$NEW_QDRANT_CONTAINER_ID" \
    || { fail "new Qdrant mapping changed before finalization"; exit 1; }
wait_container_mapping "$POSTGRES_CONTAINER" "$NEW_POSTGRES_CONTAINER_ID" \
    || { fail "new PostgreSQL mapping changed during candidate validation"; exit 1; }
verify_compose_resource_identity "$NEW_QDRANT_CONTAINER_ID" "$CANDIDATE_PROJECT" qdrant \
    "$QDRANT_VOLUME" /qdrant/storage "$STATEFUL_NETWORK" \
    || { fail "validated Qdrant candidate ownership changed"; exit 1; }
verify_container_restart_policy "$NEW_QDRANT_CONTAINER_ID" no \
    || { fail "validated Qdrant candidate acquired a restart policy"; exit 1; }
verify_compose_resource_identity "$NEW_POSTGRES_CONTAINER_ID" "$CANDIDATE_PROJECT" postgres \
    "$POSTGRES_VOLUME" /var/lib/postgresql/data "$STATEFUL_NETWORK" \
    || { fail "validated PostgreSQL candidate ownership changed"; exit 1; }
verify_container_restart_policy "$NEW_POSTGRES_CONTAINER_ID" no \
    || { fail "validated PostgreSQL candidate acquired a restart policy"; exit 1; }
[ "$(query_network_id "$STATEFUL_NETWORK")" = "$STATEFUL_NETWORK_ID" ] \
    || { fail "stateful network identity changed during candidate validation"; exit 1; }
wait_container_mapping "$QDRANT_PREVIOUS_CONTAINER" "$OLD_QDRANT_ID" \
    || { fail "exact legacy Qdrant was not retained through candidate validation"; exit 1; }
wait_container_mapping "$POSTGRES_PREVIOUS_CONTAINER" "$OLD_POSTGRES_ID" \
    || { fail "exact legacy PostgreSQL was not retained through candidate validation"; exit 1; }
verify_qdrant_previous_container_contract \
    || { fail "legacy Qdrant rollback container contract changed before promotion"; exit 1; }

verify_candidate_api_semantics candidate \
    || { fail "exact API A/B Retrieve-to-Query semantics failed against candidate Qdrant"; exit 1; }
verify_candidate_python_semantics candidate \
    || { fail "qdrant-client 1.19 candidate read/write/alias/snapshot semantics failed"; exit 1; }
qdrant_fingerprint "$RUN_DIR/qdrant-after-candidate-semantics.json"
qdrant_fingerprints_equivalent \
    "$RUN_DIR/qdrant-after.json" "$RUN_DIR/qdrant-after-candidate-semantics.json" \
    || { fail "candidate semantic probes left Qdrant state residue"; exit 1; }

QDRANT_FALLBACK_ID="$NEW_QDRANT_CONTAINER_ID"
POSTGRES_FALLBACK_ID="$NEW_POSTGRES_CONTAINER_ID"
verify_all_exact_image_scan_receipts \
    || { fail "exact image scan receipts changed before promotion"; exit 1; }
record_state image_scan.status all-exact-receipts-reverified-before-promotion
OLD_STABLE_QDRANT_IMAGE_ID=$(query_optional_image_id "$QDRANT_IMAGE") \
    || { fail "stable Qdrant image-tag inventory is ambiguous"; exit 1; }
OLD_STABLE_POSTGRES_IMAGE_ID=$(query_optional_image_id "$POSTGRES_IMAGE") \
    || { fail "stable PostgreSQL image-tag inventory is ambiguous"; exit 1; }
OLD_STABLE_POSTGRES_MIGRATE_IMAGE_ID=$(query_optional_image_id \
    "$POSTGRES_MIGRATE_IMAGE") \
    || { fail "stable PostgreSQL migrate image-tag inventory is ambiguous"; exit 1; }
PROMOTION_ARMED=true
record_state promotion.status armed-in-memory-forward-only
write_promotion_manifest \
    || { fail "promotion transaction manifest could not be committed"; exit 1; }
record_state promotion.status durable-forward-only
rollback_image_before=$(query_optional_image_id "$QDRANT_ROLLBACK_IMAGE") \
    || { fail "Qdrant rollback image tag inventory became ambiguous"; exit 1; }
[ "$rollback_image_before" = absent ] \
    || { fail "Qdrant rollback image tag appeared before its immutable bind"; exit 1; }
run_bounded_docker_mutation image tag "$OLD_QDRANT_IMAGE_ID" "$QDRANT_ROLLBACK_IMAGE" \
    || { fail "exact Qdrant rollback image tag bind failed or timed out"; exit 1; }
verify_qdrant_rollback_assets \
    || { fail "exact Qdrant rollback image/volume/scan contract did not bind"; exit 1; }
record_state qdrant.rollback_tag "$QDRANT_ROLLBACK_IMAGE"
record_state qdrant.rollback_tag_image_id "$OLD_QDRANT_IMAGE_ID"
rollback_image_before=$(query_optional_image_id "$POSTGRES_ROLLBACK_IMAGE") \
    || { fail "PostgreSQL rollback image tag inventory became ambiguous"; exit 1; }
[ "$rollback_image_before" = absent ] \
    || { fail "PostgreSQL rollback image tag appeared before its immutable bind"; exit 1; }
run_bounded_docker_mutation image tag "$OLD_POSTGRES_IMAGE_ID" \
    "$POSTGRES_ROLLBACK_IMAGE" \
    || { fail "exact PostgreSQL rollback image tag bind failed or timed out"; exit 1; }
verify_postgres_rollback_assets \
    || { fail "exact PostgreSQL rollback image/scan contract did not bind"; exit 1; }
record_state postgres.rollback_tag "$POSTGRES_ROLLBACK_IMAGE"
record_state postgres.rollback_tag_image_id "$OLD_POSTGRES_IMAGE_ID"
record_state postgres.rollback_scope image-only-no-data-rollback
STABLE_QDRANT_TAG_MUTATED=true
record_state qdrant.stable_tag_recovery armed-before-tag-mutation
run_bounded_docker_mutation image tag "$NEW_QDRANT_ID" "$QDRANT_IMAGE" \
    || { fail "stable Qdrant tag promotion failed or timed out; preserving the interlock"; exit 1; }
[ "$(query_optional_image_id "$QDRANT_IMAGE")" = "$NEW_QDRANT_ID" ] \
    || { fail "stable Qdrant tag did not bind the promoted image"; exit 1; }
record_state qdrant.stable_image_id "$NEW_QDRANT_ID"
STABLE_POSTGRES_TAG_MUTATED=true
record_state postgres.stable_tag_recovery armed-before-tag-mutation
run_bounded_docker_mutation image tag "$NEW_POSTGRES_ID" "$POSTGRES_IMAGE" \
    || { fail "stable PostgreSQL tag promotion failed or timed out; preserving the interlock"; exit 1; }
[ "$(query_optional_image_id "$POSTGRES_IMAGE")" = "$NEW_POSTGRES_ID" ] \
    || { fail "stable PostgreSQL tag did not bind the promoted image"; exit 1; }
record_state postgres.stable_image_id "$NEW_POSTGRES_ID"
STABLE_POSTGRES_MIGRATE_TAG_MUTATED=true
record_state postgres_migrate.stable_tag_recovery armed-before-tag-mutation
run_bounded_docker_mutation image tag "$NEW_POSTGRES_MIGRATE_ID" \
    "$POSTGRES_MIGRATE_IMAGE" \
    || { fail "stable PostgreSQL migrate tag promotion failed or timed out; preserving the interlock"; exit 1; }
[ "$(query_optional_image_id "$POSTGRES_MIGRATE_IMAGE")" \
    = "$NEW_POSTGRES_MIGRATE_ID" ] \
    || { fail "stable PostgreSQL migrate tag did not bind the promoted image"; exit 1; }
record_state postgres_migrate.stable_image_id "$NEW_POSTGRES_MIGRATE_ID"

record_state deployment.status promoting-qdrant
verify_qdrant_previous_container_contract \
    || { fail "legacy Qdrant rollback container contract changed before forward-only promotion"; exit 1; }
verify_qdrant_rollback_assets \
    || { fail "Qdrant rollback image/volume/scan contract changed before promotion"; exit 1; }
verify_postgres_rollback_assets \
    || { fail "PostgreSQL rollback image/scan contract changed before promotion"; exit 1; }
run_bounded_docker_mutation stop --time 120 "$QDRANT_FALLBACK_ID" >/dev/null
wait_container_running_id "$QDRANT_FALLBACK_ID" false \
    || { fail "verified Qdrant candidate did not stop for promotion"; exit 1; }
run_bounded_docker_mutation rename "$QDRANT_FALLBACK_ID" "$QDRANT_FALLBACK_CONTAINER"
QDRANT_FALLBACK_PRESERVED=true
wait_container_mapping "$QDRANT_CONTAINER" "" \
    || { fail "canonical Qdrant name was not released for promotion"; exit 1; }
wait_container_mapping "$QDRANT_FALLBACK_CONTAINER" "$QDRANT_FALLBACK_ID" \
    || { fail "verified Qdrant fallback identity changed"; exit 1; }
verify_compose_resource_identity "$QDRANT_FALLBACK_ID" "$CANDIDATE_PROJECT" qdrant \
    "$QDRANT_VOLUME" /qdrant/storage "$STATEFUL_NETWORK" \
    || { fail "verified Qdrant fallback resource contract changed"; exit 1; }
run_bounded_original_candidate_qdrant_compose_mutation \
    up -d --no-deps --no-build --force-recreate qdrant \
    || { fail "Qdrant original-project promotion failed or timed out; preserving the interlock"; exit 1; }
wait_stateful_daemon_stable \
    || { fail "Docker daemon did not stabilize after Qdrant promotion"; exit 1; }
NEW_QDRANT_CONTAINER_ID=$(query_container_id "$QDRANT_CONTAINER") \
    || { fail "promoted Qdrant container identity is ambiguous"; exit 1; }
[ -n "$NEW_QDRANT_CONTAINER_ID" ] \
    && [ "$NEW_QDRANT_CONTAINER_ID" != "$OLD_QDRANT_ID" ] \
    && [ "$NEW_QDRANT_CONTAINER_ID" != "$QDRANT_FALLBACK_ID" ] \
    || { fail "promoted Qdrant container identity is invalid"; exit 1; }
wait_qdrant || { fail "promoted Qdrant did not become ready"; exit 1; }
verify_qdrant_runtime "$NEW_QDRANT_ID" "$NEW_QDRANT_CONTAINER_ID" \
    || { fail "promoted Qdrant runtime contract failed"; exit 1; }
verify_container_restart_policy "$NEW_QDRANT_CONTAINER_ID" unless-stopped \
    || { fail "promoted Qdrant restart policy is not unless-stopped"; exit 1; }
verify_compose_resource_identity "$NEW_QDRANT_CONTAINER_ID" "$ORIGINAL_PROJECT" qdrant \
    "$QDRANT_VOLUME" /qdrant/storage "$STATEFUL_NETWORK" \
    || { fail "promoted Qdrant Compose ownership contract failed"; exit 1; }
verify_qdrant_rollback_assets \
    || { fail "Qdrant rollback image/volume/scan contract changed during promotion"; exit 1; }
verify_postgres_rollback_assets \
    || { fail "PostgreSQL rollback image/scan contract changed during promotion"; exit 1; }
qdrant_fingerprint "$RUN_DIR/qdrant-promoted.json"
cmp -s "$RUN_DIR/qdrant-after.json" "$RUN_DIR/qdrant-promoted.json" \
    || { fail "Qdrant structural fingerprint changed during promotion"; exit 1; }
record_state qdrant.promoted_container_id "$NEW_QDRANT_CONTAINER_ID"

record_state deployment.status promoting-postgres
run_bounded_docker_mutation stop --time 60 "$POSTGRES_FALLBACK_ID" >/dev/null
wait_container_running_id "$POSTGRES_FALLBACK_ID" false \
    || { fail "verified PostgreSQL candidate did not stop for promotion"; exit 1; }
run_bounded_docker_mutation rename "$POSTGRES_FALLBACK_ID" "$POSTGRES_FALLBACK_CONTAINER"
POSTGRES_FALLBACK_PRESERVED=true
wait_container_mapping "$POSTGRES_CONTAINER" "" \
    || { fail "canonical PostgreSQL name was not released for promotion"; exit 1; }
wait_container_mapping "$POSTGRES_FALLBACK_CONTAINER" "$POSTGRES_FALLBACK_ID" \
    || { fail "verified PostgreSQL fallback identity changed"; exit 1; }
verify_compose_resource_identity "$POSTGRES_FALLBACK_ID" "$CANDIDATE_PROJECT" postgres \
    "$POSTGRES_VOLUME" /var/lib/postgresql/data "$STATEFUL_NETWORK" \
    || { fail "verified PostgreSQL fallback resource contract changed"; exit 1; }
run_bounded_original_compose_mutation up -d --no-deps --no-build --force-recreate postgres \
    || { fail "PostgreSQL original-project promotion failed or timed out; preserving the interlock"; exit 1; }
wait_stateful_daemon_stable \
    || { fail "Docker daemon did not stabilize after PostgreSQL promotion"; exit 1; }
NEW_POSTGRES_CONTAINER_ID=$(query_container_id "$POSTGRES_CONTAINER") \
    || { fail "promoted PostgreSQL container identity is ambiguous"; exit 1; }
[ -n "$NEW_POSTGRES_CONTAINER_ID" ] \
    && [ "$NEW_POSTGRES_CONTAINER_ID" != "$OLD_POSTGRES_ID" ] \
    && [ "$NEW_POSTGRES_CONTAINER_ID" != "$POSTGRES_FALLBACK_ID" ] \
    || { fail "promoted PostgreSQL container identity is invalid"; exit 1; }
wait_postgres "$NEW_POSTGRES_CONTAINER_ID" \
    || { fail "promoted PostgreSQL did not become ready"; exit 1; }
verify_postgres_runtime "$NEW_POSTGRES_ID" "$NEW_POSTGRES_CONTAINER_ID" \
    || { fail "promoted PostgreSQL runtime contract failed"; exit 1; }
verify_container_restart_policy "$NEW_POSTGRES_CONTAINER_ID" unless-stopped \
    || { fail "promoted PostgreSQL restart policy is not unless-stopped"; exit 1; }
verify_compose_resource_identity "$NEW_POSTGRES_CONTAINER_ID" "$ORIGINAL_PROJECT" postgres \
    "$POSTGRES_VOLUME" /var/lib/postgresql/data "$STATEFUL_NETWORK" \
    || { fail "promoted PostgreSQL Compose ownership contract failed"; exit 1; }
postgres_fingerprint "$RUN_DIR/postgres-promoted.json" "$NEW_POSTGRES_CONTAINER_ID"
cmp -s "$RUN_DIR/postgres-after.json" "$RUN_DIR/postgres-promoted.json" \
    || { fail "PostgreSQL logical fingerprint changed during promotion"; exit 1; }
record_state postgres.promoted_container_id "$NEW_POSTGRES_CONTAINER_ID"

record_state deployment.status verifying-promoted-topology
wait_http http://127.0.0.1:5000/api/ready 10 \
    || { fail "local API readiness failed after promotion"; exit 1; }
wait_http http://127.0.0.1:5000/api/health 30 \
    || { fail "local API health failed after promotion"; exit 1; }
wait_http http://127.0.0.1:8080/backend-api/api/ready 15 \
    || { fail "Web gateway readiness failed after promotion"; exit 1; }
wait_container_mapping "$QDRANT_CONTAINER" "$NEW_QDRANT_CONTAINER_ID" \
    || { fail "promoted Qdrant mapping changed before commit"; exit 1; }
wait_container_mapping "$POSTGRES_CONTAINER" "$NEW_POSTGRES_CONTAINER_ID" \
    || { fail "promoted PostgreSQL mapping changed before commit"; exit 1; }
verify_compose_resource_identity "$NEW_QDRANT_CONTAINER_ID" "$ORIGINAL_PROJECT" qdrant \
    "$QDRANT_VOLUME" /qdrant/storage "$STATEFUL_NETWORK" \
    || { fail "final Qdrant Compose ownership changed"; exit 1; }
verify_compose_resource_identity "$NEW_POSTGRES_CONTAINER_ID" "$ORIGINAL_PROJECT" postgres \
    "$POSTGRES_VOLUME" /var/lib/postgresql/data "$STATEFUL_NETWORK" \
    || { fail "final PostgreSQL Compose ownership changed"; exit 1; }
[ "$(query_network_id "$STATEFUL_NETWORK")" = "$STATEFUL_NETWORK_ID" ] \
    || { fail "stateful network identity changed before commit"; exit 1; }
verify_candidate_api_semantics promoted \
    || { fail "exact API A/B Retrieve-to-Query semantics failed after Qdrant promotion"; exit 1; }
verify_candidate_python_semantics promoted \
    || { fail "qdrant-client 1.19 promoted read/write/alias/snapshot semantics failed"; exit 1; }
qdrant_fingerprint "$RUN_DIR/qdrant-after-promoted-semantics.json"
qdrant_fingerprints_equivalent \
    "$RUN_DIR/qdrant-promoted.json" "$RUN_DIR/qdrant-after-promoted-semantics.json" \
    || { fail "promoted semantic probes left Qdrant state residue"; exit 1; }
write_backend_qdrant_volume_binding "$OLD_QDRANT_VOLUME" "$QDRANT_CANDIDATE_VOLUME" \
    || { fail "owner-only persistent Qdrant volume binding could not be committed"; exit 1; }
verify_backend_qdrant_volume_binding "$QDRANT_CANDIDATE_VOLUME" \
    || { fail "persistent Qdrant volume binding changed before Compose convergence"; exit 1; }
run_bounded_original_compose_mutation up -d --no-deps --no-build qdrant postgres \
    || { fail "original Compose ownership convergence check failed"; exit 1; }
wait_container_mapping "$QDRANT_CONTAINER" "$NEW_QDRANT_CONTAINER_ID" \
    || { fail "original Compose ownership check replaced Qdrant"; exit 1; }
wait_container_mapping "$POSTGRES_CONTAINER" "$NEW_POSTGRES_CONTAINER_ID" \
    || { fail "original Compose ownership check replaced PostgreSQL"; exit 1; }
verify_qdrant_rollback_assets \
    || { fail "Qdrant rollback image/volume/scan contract changed before commit"; exit 1; }
verify_postgres_rollback_assets \
    || { fail "PostgreSQL rollback image/scan contract changed before commit"; exit 1; }
PROMOTION_COMMITTED=true
write_promoted_marker \
    || { fail "durable promoted marker could not be committed"; exit 1; }
record_state promotion.status durable-promoted
discard_backend_env_backup \
    || { fail "sensitive Qdrant volume-binding backup could not be durably removed"; exit 1; }

remove_verified_qdrant_previous_container_if_present \
    || { fail "legacy Qdrant cleanup or exact rollback asset verification failed"; exit 1; }
verify_qdrant_rollback_assets \
    || { fail "exact Qdrant rollback assets changed after legacy cleanup"; exit 1; }
record_state qdrant.rollback_retained \
    "$QDRANT_ROLLBACK_IMAGE:$OLD_QDRANT_IMAGE_ID:$OLD_QDRANT_VOLUME"

legacy_postgres=$(query_container_id "$POSTGRES_PREVIOUS_CONTAINER") \
    || { fail "legacy PostgreSQL inventory became ambiguous"; exit 1; }
if [ -n "$legacy_postgres" ]; then
    [ "$legacy_postgres" = "$OLD_POSTGRES_ID" ] \
        || { fail "legacy PostgreSQL identity changed during cleanup"; exit 1; }
    run_bounded_docker_mutation rm "$OLD_POSTGRES_ID" >/dev/null
fi
wait_container_mapping "$POSTGRES_PREVIOUS_CONTAINER" "" \
    || { fail "legacy PostgreSQL cleanup did not stabilize"; exit 1; }
POSTGRES_PREVIOUS_PRESERVED=false
verify_qdrant_rollback_assets \
    || { fail "Qdrant rollback assets changed after all legacy container cleanup"; exit 1; }
verify_postgres_rollback_assets \
    || { fail "PostgreSQL rollback image/scan contract changed after legacy cleanup"; exit 1; }
verify_retained_image_offline "$OLD_QDRANT_IMAGE_ID" \
    || { fail "retained Qdrant rollback image is still referenced by a container"; exit 1; }
verify_retained_image_offline "$OLD_POSTGRES_IMAGE_ID" \
    || { fail "retained PostgreSQL rollback image is still referenced by a container"; exit 1; }
record_state postgres.rollback_retained \
    "$POSTGRES_ROLLBACK_IMAGE:$OLD_POSTGRES_IMAGE_ID:image-only-no-data-rollback"

run_bounded_docker_mutation rm "$QDRANT_FALLBACK_ID" >/dev/null
wait_container_mapping "$QDRANT_FALLBACK_CONTAINER" "" \
    || { fail "verified Qdrant fallback cleanup did not stabilize"; exit 1; }
QDRANT_FALLBACK_PRESERVED=false
run_bounded_docker_mutation rm "$POSTGRES_FALLBACK_ID" >/dev/null
wait_container_mapping "$POSTGRES_FALLBACK_CONTAINER" "" \
    || { fail "verified PostgreSQL fallback cleanup did not stabilize"; exit 1; }
POSTGRES_FALLBACK_PRESERVED=false

wait_container_mapping "$QDRANT_CONTAINER" "$NEW_QDRANT_CONTAINER_ID" \
    || { fail "promoted Qdrant changed during cleanup"; exit 1; }
wait_container_mapping "$POSTGRES_CONTAINER" "$NEW_POSTGRES_CONTAINER_ID" \
    || { fail "promoted PostgreSQL changed during cleanup"; exit 1; }
QDRANT_MUTATED=false
POSTGRES_MUTATED=false
record_state deployment.status verified
prepare_runtime_contract \
    || { fail "stateful runtime contract could not be prepared"; exit 1; }

trap '' HUP INT TERM
verify_pipeline_writer_gate \
    || { fail "pipeline writer gate changed before release"; exit 1; }
release_pipeline_writers \
    || { fail "pipeline writer gate could not be released exactly"; exit 1; }
verify_pipeline_runtime_identity_unchanged \
    || { fail "pipeline virtual-environment identity changed during the semantic-probe interval"; exit 1; }
release_pipeline_runtime_lock \
    || { fail "pipeline virtual-environment shared lock could not be released"; exit 1; }
[ "$DAEMON_READ_UNRESOLVED" = "false" ] \
    && [ ! -f "$DAEMON_READ_UNRESOLVED_FILE" ] \
    || { fail "daemon read state became unresolved before completion"; exit 1; }
write_completed_marker || { fail "durable completed marker could not be committed"; exit 1; }
publish_runtime_contract \
    || {
        MANAGEMENT_RECONCILIATION_REQUIRED=true
        fail "stateful runtime contract could not be published"
        exit 1
    }
consume_verified_api_bridge_receipt completed \
    || {
        MANAGEMENT_RECONCILIATION_REQUIRED=true
        fail "completed API bridge receipt could not be durably consumed"
        exit 1
    }
record_state deployment.status completed
release_stateful_lock_exact \
    || {
        MANAGEMENT_RECONCILIATION_REQUIRED=true
        fail "stateful interlock could not be released exactly after completion"
        exit 1
    }
release_active_journal_exact \
    || {
        MANAGEMENT_RECONCILIATION_REQUIRED=true
        fail "stateful active journal could not be released exactly after completion"
        exit 1
    }
SUCCEEDED=true
printf '%s\n' "Stateful service hardening completed: $STATE_FILE"
