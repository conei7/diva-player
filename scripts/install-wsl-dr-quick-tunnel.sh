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
curl -fsS --max-time 10 \
    http://127.0.0.1:18080/backend-api/api/ready >/dev/null

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
