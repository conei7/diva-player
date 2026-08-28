#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="${DIVA_CLOUDFLARE_ENV:-$HOME/.config/diva-player/cloudflare.env}"
LOG_FILE="${DIVA_CLOUDFLARED_LOG:-$HOME/cloudflared-8080.log}"
PYTHON_COMMAND="${DIVA_PYTHON_COMMAND:-python3}"
SYNC_HELPER="${DIVA_SYNC_HELPER:-$SCRIPT_DIR/sync-quick-tunnel-to-cloudflare.py}"
origin_role="${DIVA_TUNNEL_ORIGIN_ROLE:-primary}"
case "$origin_role" in
  primary|standby) ;;
  *) echo "DIVA_TUNNEL_ORIGIN_ROLE must be primary or standby" >&2; exit 1 ;;
esac

attempt=0
tunnel_url=""
while [ "$attempt" -lt 30 ]; do
  tunnel_url=$(grep -hEo 'https://[-a-zA-Z0-9.]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1 || true)
  if [ -n "$tunnel_url" ]; then
    break
  fi
  tunnel_url=""
  attempt=$((attempt + 1))
  sleep 2
done

if [ -z "$tunnel_url" ]; then
  echo "No healthy Quick Tunnel URL found in $LOG_FILE" >&2
  exit 1
fi

if [ "${DIVA_SYNC_DRY_RUN:-0}" = 1 ]; then
  exec "$PYTHON_COMMAND" "$SYNC_HELPER" \
    --env-file "$ENV_FILE" \
    --tunnel-url "$tunnel_url" \
    --origin-role "$origin_role" \
    --dry-run
fi

exec "$PYTHON_COMMAND" "$SYNC_HELPER" \
  --env-file "$ENV_FILE" \
  --tunnel-url "$tunnel_url" \
  --origin-role "$origin_role"
