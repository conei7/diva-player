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
WATCHDOG_INSTALL_DIR="/usr/local/lib/diva-player-standby"
WATCHDOG_SCRIPT_SOURCE="$ROOT_DIR/scripts/check-wsl-dr-standby.sh"
WATCHDOG_SERVICE_SOURCE="$ROOT_DIR/scripts/diva-wsl-dr-watchdog.service"
WATCHDOG_TIMER_SOURCE="$ROOT_DIR/scripts/diva-wsl-dr-watchdog.timer"
WATCHDOG_SCRIPT_FILE="$WATCHDOG_INSTALL_DIR/check-wsl-dr-standby.sh"
WATCHDOG_SERVICE_FILE="/etc/systemd/system/diva-wsl-dr-watchdog.service"
WATCHDOG_TIMER_FILE="/etc/systemd/system/diva-wsl-dr-watchdog.timer"

exec 9>/run/lock/diva-wsl-dr-maintenance.lock
flock 9

for source_file in \
    "$WATCHDOG_SCRIPT_SOURCE" \
    "$WATCHDOG_SERVICE_SOURCE" \
    "$WATCHDOG_TIMER_SOURCE"; do
    [[ -f "$source_file" && ! -L "$source_file" ]] || {
        echo "Watchdog source must be a regular non-symlink file: $source_file" >&2
        exit 1
    }
done

[[ ! -e "$WATCHDOG_INSTALL_DIR" || ( -d "$WATCHDOG_INSTALL_DIR" && ! -L "$WATCHDOG_INSTALL_DIR" ) ]] || {
    echo 'Watchdog install directory must be a non-symlink directory.' >&2
    exit 1
}
for target_file in \
    "$WATCHDOG_SCRIPT_FILE" \
    "$WATCHDOG_SERVICE_FILE" \
    "$WATCHDOG_TIMER_FILE"; do
    if [[ -e "$target_file" || -L "$target_file" ]]; then
        [[ -f "$target_file" && ! -L "$target_file" ]] || {
            echo "Watchdog target must be absent or a regular non-symlink file: $target_file" >&2
            exit 1
        }
    fi
done

probe_ready() {
    local response_file http_code
    response_file="$(mktemp)"
    if ! http_code="$(curl -sS \
        --connect-timeout 3 \
        --max-time 10 \
        --max-filesize 1048576 \
        --max-redirs 0 \
        --output "$response_file" \
        --write-out '%{http_code}' \
        http://127.0.0.1:18080/backend-api/api/ready)"; then
        rm -f -- "$response_file"
        return 1
    fi
    if [[ "$http_code" != 200 ]] || ! python3 -c \
        'import json, sys; payload = json.load(open(sys.argv[1], encoding="utf-8")); raise SystemExit(0 if isinstance(payload, dict) and payload.get("status") == "ready" else 1)' \
        "$response_file" 2>/dev/null; then
        rm -f -- "$response_file"
        return 1
    fi
    rm -f -- "$response_file"
}

verify_watchdog_full_pass() {
    local deadline remaining result status
    command -v timeout >/dev/null || {
        echo 'The timeout command is required for bounded watchdog validation.' >&2
        return 1
    }
    deadline=$((SECONDS + 180))
    while (( SECONDS < deadline )); do
        remaining=$((deadline - SECONDS))
        if ! timeout --foreground --signal=KILL "${remaining}s" \
            systemctl restart diva-wsl-dr-watchdog.service; then
            : # Inspect the authoritative unit result below.
        fi
        remaining=$((deadline - SECONDS))
        (( remaining > 0 )) || break
        if ! result="$(timeout --foreground --signal=KILL "${remaining}s" \
            systemctl show --property=Result --value diva-wsl-dr-watchdog.service)"; then
            echo 'Unable to read the bounded watchdog result.' >&2
            return 1
        fi
        remaining=$((deadline - SECONDS))
        (( remaining > 0 )) || break
        if ! status="$(timeout --foreground --signal=KILL "${remaining}s" \
            systemctl show --property=ExecMainStatus --value diva-wsl-dr-watchdog.service)"; then
            echo 'Unable to read the bounded watchdog exit status.' >&2
            return 1
        fi
        if [[ "$result" == success && "$status" == 0 ]]; then
            return 0
        fi
        if [[ "$result" == success && "$status" == 75 ]]; then
            remaining=$((deadline - SECONDS))
            (( remaining > 0 )) || break
            if (( remaining < 2 )); then sleep "$remaining"; else sleep 2; fi
            continue
        fi
        echo "Watchdog validation failed: result=$result status=$status" >&2
        return 1
    done
    echo 'Watchdog did not reach a complete healthy pass within 180 seconds.' >&2
    return 1
}

"$ROOT_DIR/scripts/provision-wsl-dr-api-role.sh" \
    --database diva_standby \
    --env-file "$ENV_FILE"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build

deadline=$((SECONDS + 300))
ready=0
while (( SECONDS < deadline )); do
    if probe_ready; then
        ready=1
        break
    fi
    sleep 5
done

if (( ready != 1 )); then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps >&2
    echo 'DR topology did not become ready within 300 seconds.' >&2
    exit 1
fi

install -d -o root -g root -m 0755 "$WATCHDOG_INSTALL_DIR"
install -T -o root -g root -m 0755 \
    "$WATCHDOG_SCRIPT_SOURCE" \
    "$WATCHDOG_SCRIPT_FILE"
install -T -o root -g root -m 0644 \
    "$WATCHDOG_SERVICE_SOURCE" \
    "$WATCHDOG_SERVICE_FILE"
install -T -o root -g root -m 0644 \
    "$WATCHDOG_TIMER_SOURCE" \
    "$WATCHDOG_TIMER_FILE"

systemctl daemon-reload
systemctl enable --now diva-wsl-dr-watchdog.timer
systemctl is-enabled --quiet diva-wsl-dr-watchdog.timer
systemctl is-active --quiet diva-wsl-dr-watchdog.timer

# The validation run must acquire the same lock itself. Releasing here proves
# that the real watchdog path executes instead of returning the intentional
# maintenance skip with Result=success.
flock -u 9
exec 9>&-

loaded_tunnel_units=0
missing_tunnel_units=0
for tunnel_unit in \
    diva-wsl-dr-quick-tunnel.service \
    diva-wsl-dr-quick-tunnel-sync.service \
    diva-wsl-dr-quick-tunnel-sync.timer; do
    if ! tunnel_load_state="$(systemctl show --property=LoadState --value "$tunnel_unit")"; then
        echo "Unable to inspect DR tunnel unit: $tunnel_unit" >&2
        exit 1
    fi
    case "$tunnel_load_state" in
        loaded) loaded_tunnel_units=$((loaded_tunnel_units + 1)) ;;
        not-found) missing_tunnel_units=$((missing_tunnel_units + 1)) ;;
        *)
            echo "Unexpected DR tunnel unit state: $tunnel_unit=$tunnel_load_state" >&2
            exit 1
            ;;
    esac
done

if (( loaded_tunnel_units == 3 )); then
    verify_watchdog_full_pass
elif (( missing_tunnel_units == 3 )); then
    echo 'Watchdog installed; full tunnel validation remains pending until the Quick Tunnel units are installed.' >&2
else
    echo 'DR tunnel units are only partially installed; refusing to report deployment success.' >&2
    exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
echo 'PASS WSL DR API A/B, gateway, Web, and watchdog timer are ready on loopback.'
