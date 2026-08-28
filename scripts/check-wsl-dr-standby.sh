#!/bin/sh
set -eu

if ! pg_isready -q -h 127.0.0.1 -p 5432 -d diva_standby; then
  echo 'DR repair skipped: PostgreSQL is not ready' >&2
  exit 1
fi
if ! curl -fsS --max-time 5 http://127.0.0.1:16333/healthz >/dev/null; then
  echo 'DR repair skipped: Qdrant is not ready' >&2
  exit 1
fi

for container in diva_dr_api_a diva_dr_api_b diva_dr_api_gateway diva_dr_web; do
  running=$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)
  if [ "$running" != true ]; then
    echo "Starting stopped DR container: $container"
    docker start "$container" >/dev/null
    exit 0
  fi

  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
    "$container")
  case "$health" in
    healthy|starting) ;;
    unhealthy)
      # Repair one slot per run. This preserves the other A/B slot and avoids
      # turning a shared dependency incident into simultaneous API restarts.
      echo "Restarting one unhealthy DR container: $container"
      docker restart "$container" >/dev/null
      exit 0
      ;;
    *)
      echo "DR container has no health contract: $container" >&2
      exit 1
      ;;
  esac
done

curl -fsS --max-time 10 http://127.0.0.1:18080/backend-api/api/ready >/dev/null
echo 'PASS WSL DR standby health watchdog'
