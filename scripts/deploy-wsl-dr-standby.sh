#!/usr/bin/env bash
set +x
set -Eeuo pipefail

[[ "$(id -u)" == "0" ]] || {
    echo 'Run as root inside the isolated WSL distribution.' >&2
    exit 1
}

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${DIVA_DR_BACKEND_ENV:-/etc/diva-player-standby/backend.env}"
COMPOSE_FILE="$ROOT_DIR/backend/docker-compose.dr-standby.yml"

"$ROOT_DIR/scripts/provision-wsl-dr-api-role.sh" \
    --database diva_standby \
    --env-file "$ENV_FILE"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build

deadline=$((SECONDS + 300))
while (( SECONDS < deadline )); do
    if curl -fsS --max-time 10 \
        http://127.0.0.1:18080/backend-api/api/ready >/dev/null; then
        docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
        echo 'PASS WSL DR API A/B, gateway, and Web are ready on loopback.'
        exit 0
    fi
    sleep 5
done

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps >&2
echo 'DR topology did not become ready within 300 seconds.' >&2
exit 1
