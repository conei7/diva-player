#!/bin/sh
set -eu

LOG_FILE="${DIVA_CLOUDFLARED_LOG:-$HOME/cloudflared-8080.log}"
WEB_PORT="${DIVA_WEB_PORT:-8080}"
# Repeated QUIC idle timeouts on this SBC's UDP path caused public 530s.
# Keep a tested TCP transport by default; retain an explicit rollback override.
TRANSPORT="${DIVA_TUNNEL_TRANSPORT:-http2}"
case "$TRANSPORT" in
  http2|quic|auto) ;;
  *) echo "DIVA_TUNNEL_TRANSPORT must be http2, quic, or auto" >&2; exit 64 ;;
esac

: > "$LOG_FILE"
cloudflared tunnel --protocol "$TRANSPORT" --url "http://127.0.0.1:$WEB_PORT" >> "$LOG_FILE" 2>&1 &
cloudflared_pid=$!

cleanup() {
  kill "$cloudflared_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

while ! "$(dirname "$0")/sync-quick-tunnel-to-cloudflare.sh"; do
  if ! kill -0 "$cloudflared_pid" 2>/dev/null; then
    wait "$cloudflared_pid"
    exit $?
  fi
  echo "Tunnel URL sync failed; retrying in 30 seconds" >&2
  sleep 30
done
wait "$cloudflared_pid"
