#!/bin/sh
set -eu

ENV_FILE="${DIVA_CLOUDFLARE_ENV:-$HOME/.config/diva-player/cloudflare.env}"
LOG_FILE="${DIVA_CLOUDFLARED_LOG:-$HOME/cloudflared-8080.log}"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

: "${PAGES_SYNC_TOKEN:?PAGES_SYNC_TOKEN is required}"
PAGES_SYNC_URL="${PAGES_SYNC_URL:-https://diva-player.pages.dev/tunnel-admin/update}"

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

response=$(curl -fsS -X POST "$PAGES_SYNC_URL" \
  -H "Authorization: Bearer $PAGES_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "{\"tunnelUrl\":\"$tunnel_url\"}")

case "$response" in
  *'"success":true'*) ;;
  *)
    echo "Cloudflare KV update failed: $response" >&2
    exit 1
    ;;
esac

echo "Cloudflare Pages origin updated: $tunnel_url"
