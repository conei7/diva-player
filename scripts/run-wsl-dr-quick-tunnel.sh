#!/bin/sh
set -eu

LOG_FILE="${DIVA_CLOUDFLARED_LOG:-/var/log/diva-player-standby/cloudflared.log}"
WEB_PORT="${DIVA_WEB_PORT:-18080}"

install -d -m 0700 "$(dirname "$LOG_FILE")"
if ! curl -fsS --max-time 10 "http://127.0.0.1:$WEB_PORT/backend-api/api/ready" >/dev/null; then
  echo "DR Web/API is not ready; refusing to publish a tunnel" >&2
  exit 1
fi

: > "$LOG_FILE"
exec cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$WEB_PORT" \
  >> "$LOG_FILE" 2>&1
