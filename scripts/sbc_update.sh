#!/bin/sh
set -eu
umask 0022

if [ "$#" -ne 0 ]; then
    printf '%s\n' 'usage: sbc_update.sh' >&2
    exit 64
fi

cat >&2 <<'EOF'
ERROR: sbc_update.sh is retired and intentionally performs no update.

The former all-in-one path pulled repositories in the wrong provenance order
and replaced stateful/API containers with an unguarded `docker compose up`.
Use the reviewed pipeline-first pull, ML runtime update when required, and
root rolling deployment in:

  /home/orangepi/diva-data-pipeline/docs/diva-player/ACTIVE/OPERATIONS.md

This refusal is fail-closed; no repository or container was changed.
EOF
exit 78
