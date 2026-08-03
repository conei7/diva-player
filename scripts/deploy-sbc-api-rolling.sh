#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/backend/docker-compose.yml"
GATEWAY_CONTAINER="vocadb_api_gateway"

compose() {
    docker compose -f "$COMPOSE_FILE" "$@"
}

wait_healthy() {
    container="$1"
    attempts=0
    while [ "$attempts" -lt 90 ]; do
        status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)
        if [ "$status" = "healthy" ]; then
            return 0
        fi
        if [ "$status" = "unhealthy" ] || [ "$status" = "exited" ] || [ "$status" = "dead" ]; then
            docker logs --tail 100 "$container" || true
            return 1
        fi
        attempts=$((attempts + 1))
        sleep 1
    done
    docker logs --tail 100 "$container" || true
    return 1
}

gateway_running() {
    [ "$(docker inspect --format '{{.State.Running}}' "$GATEWAY_CONTAINER" 2>/dev/null || true)" = "true" ]
}

gateway_command() {
    command="$1"
    printf '%s\n' "$command" | docker exec -i "$GATEWAY_CONTAINER" socat - UNIX-CONNECT:/tmp/haproxy-admin.sock
}

wait_slot_sessions() {
    slot="$1"
    attempts=0
    while [ "$attempts" -lt 30 ]; do
        sessions=$(gateway_command "show stat" | awk -F, -v slot="$slot" '$1 == "api_nodes" && $2 == slot { print $5 }')
        if [ -z "$sessions" ] || [ "$sessions" = "0" ]; then
            return 0
        fi
        attempts=$((attempts + 1))
        sleep 1
    done
    return 1
}

wait_slot_up() {
    slot="$1"
    attempts=0
    while [ "$attempts" -lt 30 ]; do
        status=$(gateway_command "show stat" | awk -F, -v slot="$slot" '$1 == "api_nodes" && $2 == slot { print $18 }')
        case "$status" in
            UP*) return 0 ;;
        esac
        attempts=$((attempts + 1))
        sleep 1
    done
    return 1
}

update_slot() {
    slot="$1"
    container="vocadb_${slot}"
    if gateway_running; then
        gateway_command "disable server api_nodes/$slot" >/dev/null
        wait_slot_sessions "$slot"
    fi

    compose up -d --no-deps --force-recreate "$slot"
    wait_healthy "$container"

    if gateway_running; then
        gateway_command "enable server api_nodes/$slot" >/dev/null
        wait_slot_up "$slot"
    fi
}

compose build api_a api_gateway
compose run --rm --no-deps api_gateway haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
compose run --rm migrate

if gateway_running; then
    update_slot api_a
    update_slot api_b
else
    compose up -d --no-deps api_a api_b
    wait_healthy vocadb_api_a
    wait_healthy vocadb_api_b

    legacy_was_running=false
    if [ "$(docker inspect --format '{{.State.Running}}' vocadb_api 2>/dev/null || true)" = "true" ]; then
        legacy_was_running=true
        docker stop --time 30 vocadb_api
    fi

    if ! compose up -d --no-deps api_gateway; then
        if [ "$legacy_was_running" = "true" ]; then docker start vocadb_api; fi
        exit 1
    fi

    if ! wait_healthy "$GATEWAY_CONTAINER"; then
        compose stop api_gateway || true
        if [ "$legacy_was_running" = "true" ]; then docker start vocadb_api; fi
        exit 1
    fi

    compose build web
    compose up -d --no-deps web
fi

curl -fsS --max-time 10 http://127.0.0.1:5000/api/ready >/dev/null
curl -fsS --max-time 30 http://127.0.0.1:5000/api/health >/dev/null
printf '%s\n' "Rolling API deployment completed with both slots healthy."
