#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/backend/docker-compose.yml"
GATEWAY_CONTAINER="vocadb_api_gateway"
API_IMAGE="diva-player-api:local"
GATEWAY_IMAGE="diva-player-api-gateway:local"
WEB_IMAGE="diva-player-web:local"
API_A_ROLLBACK_IMAGE="diva-player-api:rollback-api-a"
API_B_ROLLBACK_IMAGE="diva-player-api:rollback-api-b"
GATEWAY_ROLLBACK_IMAGE="diva-player-api-gateway:rollback"
WEB_ROLLBACK_IMAGE="diva-player-web:rollback"

# Command overrides make the real deployment state machine executable against
# deterministic fakes. Production uses the defaults.
DOCKER_COMMAND=${DIVA_DOCKER_COMMAND:-docker}
CURL_COMMAND=${DIVA_CURL_COMMAND:-curl}
SLEEP_COMMAND=${DIVA_SLEEP_COMMAND:-sleep}
HOOK_COMMAND=${DIVA_DEPLOY_HOOK_COMMAND:-}
HEALTH_ATTEMPTS=${DIVA_DEPLOY_HEALTH_ATTEMPTS:-180}
DRAIN_ATTEMPTS=${DIVA_DEPLOY_DRAIN_ATTEMPTS:-75}
ROUTE_ATTEMPTS=${DIVA_DEPLOY_ROUTE_ATTEMPTS:-30}
WAIT_SECONDS=${DIVA_DEPLOY_WAIT_SECONDS:-1}

STATE_ROOT=${DIVA_DEPLOY_STATE_DIR:-"$ROOT_DIR/.deploy-state"}
DEPLOY_LOCK_DIR="$STATE_ROOT/deploy.lock"
DEPLOYMENT_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
DEPLOYMENT_DIR="$STATE_ROOT/$DEPLOYMENT_ID"
STATE_FILE="$DEPLOYMENT_DIR/state"
CANDIDATE_CONTAINER="diva_api_gateway_candidate_$DEPLOYMENT_ID"
CANDIDATE_STARTED=false
CANDIDATE_CONFIG_HASH=""
CANDIDATE_API_CONTAINER="diva_api_candidate_$DEPLOYMENT_ID"
CANDIDATE_API_STARTED=false
CANDIDATE_WEB_CONTAINER="diva_web_candidate_$DEPLOYMENT_ID"
CANDIDATE_WEB_STARTED=false
DEPLOYMENT_SUCCEEDED=false
RECOVERY_ARMED=false
RECOVERY_RUNNING=false
ACTIVE_SLOT=""
ACTIVE_SLOT_PREVIOUS_STATE="unknown"
ACTIVE_SLOT_ROUTE_DISABLED=false
ACTIVE_SLOT_CONTAINER_MUTATED=false
API_A_UPDATED=false
API_B_UPDATED=false
GATEWAY_REPLACEMENT_STARTED=false
GATEWAY_UPDATED=false
API_A_STATE="unknown"
API_B_STATE="unknown"
BOOTSTRAP_RECOVERY_ARMED=false
BOOTSTRAP_GATEWAY_MUTATED=false
LEGACY_WAS_RUNNING=false
LEGACY_STOPPED_BY_DEPLOY=false
WEB_WAS_RUNNING=false
WEB_REPLACEMENT_STARTED=false
WEB_UPDATED=false
DEPLOY_LOCK_HELD=false

mkdir -p "$DEPLOYMENT_DIR"

record_state() {
    local key="$1"
    local value="$2"
    printf '%s=%s\n' "$key" "$value" >> "$STATE_FILE"
}

log() {
    printf '%s\n' "$*"
}

fail() {
    record_state "failure" "$1"
    printf '%s\n' "ERROR: $1" >&2
    return 1
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
    if ! env DIVA_DEPLOYMENT_PID="$$" "$HOOK_COMMAND" "$phase"; then
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

cleanup() {
    local original_exit_code="$1"
    local recovery_result=0
    trap - 0
    trap '' HUP INT TERM

    if [ "$CANDIDATE_STARTED" = "true" ]; then
        "$DOCKER_COMMAND" rm -f "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
    fi
    if [ "$CANDIDATE_API_STARTED" = "true" ]; then
        "$DOCKER_COMMAND" rm -f "$CANDIDATE_API_CONTAINER" >/dev/null 2>&1 || true
    fi
    if [ "$CANDIDATE_WEB_STARTED" = "true" ]; then
        "$DOCKER_COMMAND" rm -f "$CANDIDATE_WEB_CONTAINER" >/dev/null 2>&1 || true
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
                compose stop api_gateway >/dev/null 2>&1 || recovery_result=1
            fi
            if [ "$LEGACY_STOPPED_BY_DEPLOY" = "true" ]; then
                "$DOCKER_COMMAND" start vocadb_api >/dev/null 2>&1 || recovery_result=1
            fi
            if [ "$WEB_REPLACEMENT_STARTED" = "true" ]; then
                rollback_web || recovery_result=1
            fi
            if [ "$recovery_result" -eq 0 ]; then
                record_state "bootstrap.recovery" "completed"
            else
                record_state "bootstrap.recovery" "incomplete-manual-intervention-required"
            fi
        fi
        record_state "deployment.status" "failed"
        printf '%s\n' "Deployment failed. State was saved to $STATE_FILE" >&2
    fi
    if [ "$DEPLOY_LOCK_HELD" = "true" ]; then
        rm -f "$DEPLOY_LOCK_DIR/owner" >/dev/null 2>&1 || true
        rmdir "$DEPLOY_LOCK_DIR" >/dev/null 2>&1 || true
        DEPLOY_LOCK_HELD=false
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
        "$DOCKER_COMMAND" compose -f "$COMPOSE_FILE" "$@"
}

compose() {
    compose_with_images "$API_IMAGE" "$GATEWAY_IMAGE" "$WEB_IMAGE" "$@"
}

wait_once() {
    "$SLEEP_COMMAND" "$WAIT_SECONDS"
}

container_running() {
    local container="$1"
    [ "$("$DOCKER_COMMAND" inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" = "true" ]
}

container_health() {
    local container="$1"
    "$DOCKER_COMMAND" inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$container" 2>/dev/null || true
}

container_image() {
    local container="$1"
    "$DOCKER_COMMAND" inspect --format '{{.Image}}' "$container" 2>/dev/null || true
}

container_compose_config_hash() {
    local container="$1"
    "$DOCKER_COMMAND" inspect \
        --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' \
        "$container" 2>/dev/null || true
}

wait_healthy() {
    local container="$1"
    local attempts=0
    local status
    while [ "$attempts" -lt "$HEALTH_ATTEMPTS" ]; do
        status=$(container_health "$container")
        if [ "$status" = "healthy" ]; then
            return 0
        fi
        if [ "$status" = "unhealthy" ] || [ "$status" = "exited" ] || [ "$status" = "dead" ]; then
            "$DOCKER_COMMAND" logs --tail 100 "$container" || true
            return 1
        fi
        attempts=$((attempts + 1))
        wait_once
    done
    "$DOCKER_COMMAND" logs --tail 100 "$container" || true
    return 1
}

gateway_running() {
    container_running "$GATEWAY_CONTAINER"
}

gateway_command() {
    local command="$1"
    printf '%s\n' "$command" | "$DOCKER_COMMAND" exec -i "$GATEWAY_CONTAINER" \
        socat - UNIX-CONNECT:/tmp/haproxy-admin.sock
}

slot_status() {
    local slot="$1"
    gateway_command "show stat" 2>/dev/null \
        | awk -F, -v slot="$slot" '$1 == "api_nodes" && $2 == slot { print $18; exit }'
}

slot_sessions() {
    local slot="$1"
    gateway_command "show stat" 2>/dev/null \
        | awk -F, -v slot="$slot" '$1 == "api_nodes" && $2 == slot { print $5; exit }'
}

slot_enabled_state() {
    local slot="$1"
    local status
    status=$(slot_status "$slot" || true)
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
        sessions=$(slot_sessions "$slot" || true)
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
        status=$(slot_status "$slot" || true)
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

peer_for_slot() {
    case "$1" in
        api_a) printf '%s\n' "api_b" ;;
        api_b) printf '%s\n' "api_a" ;;
        *) return 1 ;;
    esac
}

restore_slot_route() {
    local slot="$1"
    local previous_state="$2"
    local container="vocadb_${slot}"

    if ! gateway_running; then
        return 0
    fi

    if [ "$previous_state" = "disabled" ]; then
        gateway_command "disable server api_nodes/$slot" >/dev/null
        return $?
    fi

    if [ "$previous_state" != "enabled" ]; then
        fail "Cannot restore unknown gateway state for $slot"
        return 1
    fi

    # Never enable a server just because a deploy step finished. Its saved
    # state must have been enabled and the restored/new container must first
    # pass its own readiness check.
    if ! wait_healthy "$container"; then
        fail "Refusing to enable unhealthy $slot"
        return 1
    fi
    if ! gateway_command "enable server api_nodes/$slot" >/dev/null; then
        fail "HAProxy rejected enable for $slot"
        return 1
    fi
    if ! wait_slot_up "$slot"; then
        fail "$slot did not return UP after its readiness-guarded enable"
        return 1
    fi
}

rollback_slot() {
    local slot="$1"
    local previous_state="$2"
    local rollback_image
    local peer
    local container="vocadb_${slot}"
    rollback_image=$(rollback_tag_for_slot "$slot")
    peer=$(peer_for_slot "$slot")

    log "Rolling back $slot to $rollback_image"
    record_state "$slot.rollback" "started"

    if gateway_running; then
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

    if ! compose_with_images "$rollback_image" "$GATEWAY_IMAGE" "$WEB_IMAGE" \
        up -d --no-deps --no-build --force-recreate "$slot"; then
        fail "Compose could not restore the previous image for $slot"
        return 1
    fi
    if ! wait_healthy "$container"; then
        fail "Previous image for $slot did not become healthy"
        return 1
    fi
    if ! restore_slot_route "$slot" "$previous_state"; then
        return 1
    fi

    mark_slot_updated "$slot" false
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
    peer=$(peer_for_slot "$slot")

    log "Updating $slot"
    record_state "$slot.update" "started"
    ACTIVE_SLOT="$slot"
    ACTIVE_SLOT_PREVIOUS_STATE="$previous_state"
    ACTIVE_SLOT_ROUTE_DISABLED=false
    ACTIVE_SLOT_CONTAINER_MUTATED=false

    if gateway_running; then
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

    # Compose may replace/remove the old container before returning an error,
    # so arm image rollback before invoking it.
    ACTIVE_SLOT_CONTAINER_MUTATED=true
    if ! compose up -d --no-deps --no-build --force-recreate "$slot"; then
        fail "Compose failed while replacing $slot"
        return 1
    fi
    run_test_hook "slot-replaced:$slot"
    if ! wait_healthy "$container"; then
        fail "Replacement $slot did not become healthy"
        return 1
    fi
    if ! restore_slot_route "$slot" "$previous_state"; then
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
        "$DOCKER_COMMAND" rm -f "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
        CANDIDATE_STARTED=false
    fi
}

remove_candidate_api() {
    if [ "$CANDIDATE_API_STARTED" = "true" ]; then
        "$DOCKER_COMMAND" rm -f "$CANDIDATE_API_CONTAINER" >/dev/null 2>&1 || true
        CANDIDATE_API_STARTED=false
    fi
}

remove_candidate_web() {
    if [ "$CANDIDATE_WEB_STARTED" = "true" ]; then
        "$DOCKER_COMMAND" rm -f "$CANDIDATE_WEB_CONTAINER" >/dev/null 2>&1 || true
        CANDIDATE_WEB_STARTED=false
    fi
}

validate_candidate_api() {
    log "Starting an unexposed candidate API"
    if ! compose run -d --no-deps --name "$CANDIDATE_API_CONTAINER" api_a >/dev/null; then
        fail "Candidate API could not start with the configured runtime credentials"
        return 1
    fi
    CANDIDATE_API_STARTED=true
    if ! wait_healthy "$CANDIDATE_API_CONTAINER"; then
        "$DOCKER_COMMAND" logs --tail 100 "$CANDIDATE_API_CONTAINER" || true
        remove_candidate_api
        fail "Candidate API could not become ready with the configured database and Qdrant state"
        return 1
    fi
    remove_candidate_api
    record_state "api.candidate" "healthy"
}

validate_candidate_web() {
    log "Starting an unexposed candidate Web proxy"
    if ! compose run -d --no-deps --name "$CANDIDATE_WEB_CONTAINER" web >/dev/null; then
        fail "Candidate Web proxy could not start"
        return 1
    fi
    CANDIDATE_WEB_STARTED=true
    if ! wait_healthy "$CANDIDATE_WEB_CONTAINER"; then
        "$DOCKER_COMMAND" logs --tail 100 "$CANDIDATE_WEB_CONTAINER" || true
        remove_candidate_web
        fail "Candidate Web proxy could not reach the API gateway"
        return 1
    fi
    remove_candidate_web
    record_state "web.candidate" "healthy"
}

rollback_web() {
    record_state "web.rollback" "started"
    if [ "$WEB_WAS_RUNNING" != "true" ]; then
        compose stop web >/dev/null 2>&1 || true
        WEB_REPLACEMENT_STARTED=false
        WEB_UPDATED=false
        record_state "web.rollback" "removed-new-container"
        return 0
    fi

    log "Rolling back the Web proxy to $WEB_ROLLBACK_IMAGE"
    if ! compose_with_images "$API_IMAGE" "$GATEWAY_IMAGE" "$WEB_ROLLBACK_IMAGE" \
        up -d --no-deps --no-build --force-recreate web; then
        fail "Compose could not restore the previous Web proxy image"
        return 1
    fi
    if ! wait_healthy vocadb_web; then
        fail "Previous Web proxy image did not become healthy"
        return 1
    fi
    WEB_REPLACEMENT_STARTED=false
    WEB_UPDATED=false
    record_state "web.rollback" "completed"
}

validate_candidate_gateway() {
    log "Starting an unexposed candidate gateway"
    if ! compose run -d --no-deps --name "$CANDIDATE_CONTAINER" api_gateway >/dev/null; then
        fail "Candidate gateway could not start"
        return 1
    fi
    CANDIDATE_STARTED=true
    if ! wait_healthy "$CANDIDATE_CONTAINER"; then
        "$DOCKER_COMMAND" logs --tail 100 "$CANDIDATE_CONTAINER" || true
        remove_candidate_gateway
        fail "Candidate gateway could not reach both API slots"
        return 1
    fi
    CANDIDATE_CONFIG_HASH=$(container_compose_config_hash "$CANDIDATE_CONTAINER")
    remove_candidate_gateway
    record_state "gateway.candidate" "healthy"
    record_state "gateway.candidate_config_hash" "${CANDIDATE_CONFIG_HASH:-unknown}"
}

rollback_gateway() {
    local api_a_state="$1"
    local api_b_state="$2"
    log "Rolling back the API gateway to $GATEWAY_ROLLBACK_IMAGE"
    record_state "gateway.rollback" "started"

    if ! compose_with_images "$API_IMAGE" "$GATEWAY_ROLLBACK_IMAGE" "$WEB_IMAGE" \
        up -d --no-deps --no-build --force-recreate api_gateway; then
        fail "Compose could not restore the previous gateway image"
        return 1
    fi
    if ! wait_healthy "$GATEWAY_CONTAINER"; then
        fail "Previous gateway image did not become healthy"
        return 1
    fi
    if ! restore_gateway_routes "$api_a_state" "$api_b_state"; then
        fail "Previous gateway routes could not be restored"
        return 1
    fi

    GATEWAY_REPLACEMENT_STARTED=false
    GATEWAY_UPDATED=false
    record_state "gateway.rollback" "completed"
    return 0
}

apply_gateway_image() {
    local old_gateway_image="$1"
    local new_gateway_image="$2"
    local api_a_state="$3"
    local api_b_state="$4"
    local old_config_hash

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
    if ! compose up -d --no-deps --no-build --force-recreate api_gateway; then
        fail "Gateway replacement failed"
        return 1
    fi
    run_test_hook "gateway-replaced"
    if ! wait_healthy "$GATEWAY_CONTAINER"; then
        fail "New gateway did not become healthy"
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

preserve_image() {
    local source_image="$1"
    local rollback_image="$2"
    local description="$3"
    if [ -z "$source_image" ]; then
        fail "Could not identify the current $description image"
        return 1
    fi
    if ! "$DOCKER_COMMAND" image tag "$source_image" "$rollback_image"; then
        fail "Could not preserve $description image $source_image"
        return 1
    fi
}

acquire_deploy_lock() {
    if ! mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null; then
        owner=$(cat "$DEPLOY_LOCK_DIR/owner" 2>/dev/null || printf '%s' unknown)
        fail "Another rolling deployment holds $DEPLOY_LOCK_DIR (owner=$owner)"
        return 1
    fi
    DEPLOY_LOCK_HELD=true
    printf 'pid=%s started=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        > "$DEPLOY_LOCK_DIR/owner"
    record_state "deployment.lock" "acquired"
}

if ! acquire_deploy_lock; then
    exit 75
fi

record_state "deployment.id" "$DEPLOYMENT_ID"
GIT_COMMIT=$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || printf '%s\n' "unknown")
record_state "git.commit" "$GIT_COMMIT"
record_state "deployment.status" "preflight"
record_state "migration.rollback" "not-attempted-forward-only"

GATEWAY_WAS_RUNNING=false
API_A_STATE="not-routed"
API_B_STATE="not-routed"
OLD_API_A_IMAGE=$(container_image vocadb_api_a)
OLD_API_B_IMAGE=$(container_image vocadb_api_b)
OLD_GATEWAY_IMAGE=$(container_image "$GATEWAY_CONTAINER")
OLD_WEB_IMAGE=$(container_image vocadb_web)

if gateway_running; then
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

    preserve_image "$OLD_API_A_IMAGE" "$API_A_ROLLBACK_IMAGE" "api_a"
    preserve_image "$OLD_API_B_IMAGE" "$API_B_ROLLBACK_IMAGE" "api_b"
    preserve_image "$OLD_GATEWAY_IMAGE" "$GATEWAY_ROLLBACK_IMAGE" "gateway"
elif container_running vocadb_web; then
    WEB_WAS_RUNNING=true
    preserve_image "$OLD_WEB_IMAGE" "$WEB_ROLLBACK_IMAGE" "web"
fi

record_state "gateway.was_running" "$GATEWAY_WAS_RUNNING"
record_state "api_a.old_image" "${OLD_API_A_IMAGE:-none}"
record_state "api_b.old_image" "${OLD_API_B_IMAGE:-none}"
record_state "gateway.old_image" "${OLD_GATEWAY_IMAGE:-none}"
record_state "web.was_running" "$WEB_WAS_RUNNING"
record_state "web.old_image" "${OLD_WEB_IMAGE:-none}"
record_state "api_a.route_state" "$API_A_STATE"
record_state "api_b.route_state" "$API_B_STATE"

log "Building immutable deployment candidates"
record_state "deployment.status" "building"
compose build api_a api_gateway
NEW_API_IMAGE=$("$DOCKER_COMMAND" image inspect --format '{{.Id}}' "$API_IMAGE")
NEW_GATEWAY_IMAGE=$("$DOCKER_COMMAND" image inspect --format '{{.Id}}' "$GATEWAY_IMAGE")
record_state "api.new_image" "$NEW_API_IMAGE"
record_state "gateway.new_image" "$NEW_GATEWAY_IMAGE"

log "Validating the built HAProxy configuration"
compose run --rm --no-deps api_gateway \
    haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
record_state "gateway.config_validation" "passed"

# Migrations are deliberately a separate, forward-only phase. Binary rollback
# below never claims to undo schema changes; migrations must remain compatible
# with the prior API image for the duration of a rolling deployment.
log "Applying forward-only database migrations"
record_state "deployment.status" "migrating"
record_state "migration.status" "started"
if ! compose run --rm migrate; then
    record_state "migration.status" "failed"
    fail "Forward-only migration failed before any service was replaced"
    exit 1
fi
record_state "migration.status" "applied"

# Validate the exact runtime credentials/configuration before draining or
# replacing either live slot. A missing versioned login therefore leaves both
# old API containers untouched and serving traffic.
if ! validate_candidate_api; then
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
    compose up -d --no-deps --no-build --force-recreate api_a api_b
    wait_healthy vocadb_api_a
    wait_healthy vocadb_api_b
    validate_candidate_gateway
    compose build web

    if container_running vocadb_api; then
        LEGACY_WAS_RUNNING=true
        BOOTSTRAP_RECOVERY_ARMED=true
        LEGACY_STOPPED_BY_DEPLOY=true
        "$DOCKER_COMMAND" stop --time 30 vocadb_api
    fi
    record_state "legacy.was_running" "$LEGACY_WAS_RUNNING"

    # Once the gateway may own port 5000, any unexpected exit must stop it and
    # restore the legacy port owner when one existed.
    BOOTSTRAP_RECOVERY_ARMED=true
    BOOTSTRAP_GATEWAY_MUTATED=true
    if ! compose up -d --no-deps --no-build --force-recreate api_gateway \
        || ! wait_healthy "$GATEWAY_CONTAINER"; then
        fail "Gateway bootstrap failed; the legacy API was restored when available"
        exit 1
    fi

    if ! validate_candidate_web; then
        exit 1
    fi
    WEB_REPLACEMENT_STARTED=true
    if ! compose up -d --no-deps --no-build --force-recreate web; then
        fail "Web proxy replacement failed"
        exit 1
    fi
    run_test_hook "web-replaced"
    if ! wait_healthy vocadb_web; then
        fail "New Web proxy did not become healthy"
        exit 1
    fi
    WEB_UPDATED=true
    record_state "web.update" "completed"
fi

record_state "deployment.status" "verifying"
"$CURL_COMMAND" -fsS --max-time 10 http://127.0.0.1:5000/api/ready >/dev/null
"$CURL_COMMAND" -fsS --max-time 30 http://127.0.0.1:5000/api/health >/dev/null
if container_running vocadb_web; then
    "$CURL_COMMAND" -fsS --max-time 15 \
        http://127.0.0.1:8080/backend-api/api/ready >/dev/null
fi

DEPLOYMENT_SUCCEEDED=true
RECOVERY_ARMED=false
BOOTSTRAP_RECOVERY_ARMED=false
record_state "deployment.status" "completed"
log "Rolling API deployment completed with both slots healthy."
log "Deployment state: $STATE_FILE"
