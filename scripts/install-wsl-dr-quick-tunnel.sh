#!/usr/bin/env bash
set +x
set -Eeuo pipefail

[[ "$(id -u)" == "0" ]] || {
    echo 'Run as root inside the isolated WSL distribution.' >&2
    exit 1
}

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${DIVA_CLOUDFLARE_ENV:-/etc/diva-player-standby/cloudflare.env}"
INSTALL_DIR="/usr/local/lib/diva-player-standby"
SERVICE_USER="diva-dr-tunnel"
SERVICE_FILE="/etc/systemd/system/diva-wsl-dr-quick-tunnel.service"
SYNC_SERVICE_FILE="/etc/systemd/system/diva-wsl-dr-quick-tunnel-sync.service"
SYNC_TIMER_FILE="/etc/systemd/system/diva-wsl-dr-quick-tunnel-sync.timer"

exec 9>/run/lock/diva-wsl-dr-maintenance.lock
flock 9

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

[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || {
    echo 'Cloudflare environment must be a regular non-symlink file.' >&2
    exit 1
}
[[ "$(stat -c '%U:%G' -- "$ENV_FILE")" == 'root:root' ]] || {
    echo 'Cloudflare environment must be owned by root:root.' >&2
    exit 1
}
env_mode="$(stat -c '%a' -- "$ENV_FILE")"
(( (8#$env_mode & 077) == 0 )) || {
    echo 'Cloudflare environment must not be accessible by group/other.' >&2
    exit 1
}
unset env_mode

command -v cloudflared >/dev/null || {
    echo 'cloudflared is not installed.' >&2
    exit 1
}
ready_response="$(mktemp)"
if ! ready_code="$(curl -sS \
        --connect-timeout 3 \
        --max-time 10 \
        --max-filesize 1048576 \
        --max-redirs 0 \
        --output "$ready_response" \
        --write-out '%{http_code}' \
        http://127.0.0.1:18080/backend-api/api/ready)" \
        || [[ "$ready_code" != 200 ]] \
        || ! python3 -c \
            'import json, sys; payload = json.load(open(sys.argv[1], encoding="utf-8")); raise SystemExit(0 if isinstance(payload, dict) and payload.get("status") == "ready" else 1)' \
            "$ready_response" 2>/dev/null; then
    rm -f -- "$ready_response"
    echo 'WSL DR API readiness check failed.' >&2
    exit 1
fi
rm -f -- "$ready_response"

if ! getent passwd "$SERVICE_USER" >/dev/null; then
    useradd --system --user-group --home-dir /nonexistent \
        --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -o root -g root -m 0755 "$INSTALL_DIR"
install -o root -g root -m 0755 \
    "$ROOT_DIR/scripts/run-wsl-dr-quick-tunnel.sh" \
    "$ROOT_DIR/scripts/sync-wsl-dr-origin-to-cloudflare.sh" \
    "$ROOT_DIR/scripts/sync-quick-tunnel-to-cloudflare.sh" \
    "$ROOT_DIR/scripts/sync-quick-tunnel-to-cloudflare.py" \
    "$INSTALL_DIR/"
install -o root -g root -m 0644 \
    "$ROOT_DIR/scripts/diva-wsl-dr-quick-tunnel.service" \
    "$SERVICE_FILE"
install -o root -g root -m 0644 \
    "$ROOT_DIR/scripts/diva-wsl-dr-quick-tunnel-sync.service" \
    "$SYNC_SERVICE_FILE"
install -o root -g root -m 0644 \
    "$ROOT_DIR/scripts/diva-wsl-dr-quick-tunnel-sync.timer" \
    "$SYNC_TIMER_FILE"

systemctl daemon-reload
systemctl enable diva-wsl-dr-quick-tunnel.service
systemctl restart diva-wsl-dr-quick-tunnel.service
systemctl is-active --quiet diva-wsl-dr-quick-tunnel.service

registration_succeeded=0
if systemctl start diva-wsl-dr-quick-tunnel-sync.service; then
    registration_succeeded=1
fi
systemctl enable --now diva-wsl-dr-quick-tunnel-sync.timer

# Let the watchdog run through its normal lock path; otherwise a synchronous
# start here would be an intentional maintenance skip and a false validation.
flock -u 9
exec 9>&-

if ! watchdog_load_state="$(systemctl show --property=LoadState --value diva-wsl-dr-watchdog.service)"; then
    echo 'Unable to inspect the DR watchdog unit.' >&2
    exit 1
fi
case "$watchdog_load_state" in
    loaded)
        systemctl restart diva-wsl-dr-watchdog.timer
        verify_watchdog_full_pass
        registration_succeeded=1
        ;;
    not-found) ;;
    *)
        echo "Unexpected DR watchdog unit state: $watchdog_load_state" >&2
        exit 1
        ;;
esac

service_user="$(systemctl show -p User --value diva-wsl-dr-quick-tunnel.service)"
main_pid="$(systemctl show -p MainPID --value diva-wsl-dr-quick-tunnel.service)"
[[ "$service_user" == "$SERVICE_USER" && "$main_pid" =~ ^[1-9][0-9]*$ ]] || {
    echo 'Quick Tunnel did not start under the dedicated service user.' >&2
    exit 1
}

if (( registration_succeeded != 1 )); then
    echo 'Quick Tunnel is running; origin registration remains pending and will retry automatically.' >&2
    exit 1
fi

echo 'PASS WSL DR Quick Tunnel is enabled, registered, self-retrying, and running as a non-root user.'
