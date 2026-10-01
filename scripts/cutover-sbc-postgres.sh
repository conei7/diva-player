#!/usr/bin/env bash
set +x
set -Eeuo pipefail
umask 077
exec python3 "$(dirname -- "$0")/sbc-postgres-cutover.py" "$@"
