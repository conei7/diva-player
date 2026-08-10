#!/bin/sh
set -eu

TOKEN_FILE="${DIVA_CLOUDFLARE_TUNNEL_TOKEN_FILE:-$HOME/.config/diva-player/cloudflare-tunnel.token}"
METRICS_ADDRESS="${DIVA_CLOUDFLARED_METRICS_ADDRESS:-127.0.0.1:20241}"

if [ ! -r "$TOKEN_FILE" ]; then
  echo "Named tunnel token file is not readable: $TOKEN_FILE" >&2
  exit 1
fi

if [ "$(uname -s)" = "Linux" ]; then
  if [ ! -f "$TOKEN_FILE" ] || [ -L "$TOKEN_FILE" ]; then
    echo "Named tunnel token must be a regular, non-symlink file: $TOKEN_FILE" >&2
    exit 1
  fi
  token_owner=$(stat -c '%u' "$TOKEN_FILE")
  token_mode=$(stat -c '%a' "$TOKEN_FILE")
  if [ "$token_owner" != "$(id -u)" ] || [ $((token_mode % 100)) -ne 0 ]; then
    echo "Named tunnel token must be owned by the service user with no group/other permissions" >&2
    exit 1
  fi
fi

# token-file keeps the remotely-managed tunnel credential out of the process
# command line. Cloudflared 2025.4.0 or newer is required for this option.
exec cloudflared tunnel \
  --no-autoupdate \
  --loglevel info \
  --metrics "$METRICS_ADDRESS" \
  run --token-file "$TOKEN_FILE"
