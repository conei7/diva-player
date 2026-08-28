#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export DIVA_CLOUDFLARE_ENV="${DIVA_CLOUDFLARE_ENV:-/etc/diva-player-standby/cloudflare.env}"
export DIVA_CLOUDFLARED_LOG="${DIVA_CLOUDFLARED_LOG:-/var/log/diva-player-standby/cloudflared.log}"
export DIVA_TUNNEL_ORIGIN_ROLE=standby
exec "$SCRIPT_DIR/sync-quick-tunnel-to-cloudflare.sh"
