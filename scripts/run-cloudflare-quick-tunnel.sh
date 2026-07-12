#!/bin/sh
set -eu

LOG_FILE="${DIVA_CLOUDFLARED_LOG:-$HOME/cloudflared-8080.log}"
WEB_PORT="${DIVA_WEB_PORT:-8080}"

: > "$LOG_FILE"
cloudflared tunnel --url "http://127.0.0.1:$WEB_PORT" >> "$LOG_FILE" 2>&1 &
cloudflared_pid=$!

cleanup() {
  kill "$cloudflared_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

"$(dirname "$0")/sync-quick-tunnel-to-cloudflare.sh"
wait "$cloudflared_pid"
