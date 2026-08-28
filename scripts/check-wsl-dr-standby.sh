#!/bin/sh
set -eu

COMMAND_TIMEOUT_SECONDS=${DIVA_DR_COMMAND_TIMEOUT_SECONDS:-15}
REPAIR_TIMEOUT_SECONDS=${DIVA_DR_REPAIR_TIMEOUT_SECONDS:-45}
SYNC_MAX_AGE_SECONDS=${DIVA_DR_SYNC_MAX_AGE_SECONDS:-900}

for timeout_value in \
  "$COMMAND_TIMEOUT_SECONDS" \
  "$REPAIR_TIMEOUT_SECONDS" \
  "$SYNC_MAX_AGE_SECONDS"; do
  case "$timeout_value" in
    ''|0|0*|*[!0-9]*)
      echo 'DR watchdog timeout and age settings must be positive integers.' >&2
      exit 1
      ;;
    *) ;;
  esac
done

for required_command in curl docker flock pg_isready python3 systemctl timeout; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "DR watchdog dependency is missing: $required_command" >&2
    exit 1
  fi
done

exec 9>/run/lock/diva-wsl-dr-maintenance.lock
if ! flock -n 9; then
  echo 'DR watchdog skipped: standby maintenance is in progress'
  exit 75
fi

TUNNEL_SERVICE=diva-wsl-dr-quick-tunnel.service
SYNC_SERVICE=diva-wsl-dr-quick-tunnel-sync.service
SYNC_TIMER=diva-wsl-dr-quick-tunnel-sync.timer

run_bounded() {
  timeout --foreground --kill-after=5s "$COMMAND_TIMEOUT_SECONDS" "$@"
}

run_repair_bounded() {
  timeout --foreground --kill-after=5s "$REPAIR_TIMEOUT_SECONDS" "$@"
}

probe_http_200() {
  probe_url=$1
  expected_status=${2:-}
  response_file=$(mktemp)

  if ! http_code=$(run_bounded curl -sS \
      --connect-timeout 3 \
      --max-time 10 \
      --max-filesize 1048576 \
      --max-redirs 0 \
      --output "$response_file" \
      --write-out '%{http_code}' \
      "$probe_url"); then
    rm -f -- "$response_file"
    return 1
  fi
  if [ "$http_code" != 200 ]; then
    rm -f -- "$response_file"
    return 1
  fi
  if [ -n "$expected_status" ] && ! run_bounded python3 -c \
      'import json, sys; payload = json.load(open(sys.argv[1], encoding="utf-8")); raise SystemExit(0 if isinstance(payload, dict) and payload.get("status") == sys.argv[2] else 1)' \
      "$response_file" "$expected_status" 2>/dev/null; then
    rm -f -- "$response_file"
    return 1
  fi

  rm -f -- "$response_file"
  return 0
}

systemctl_value() {
  property=$1
  unit=$2
  run_bounded systemctl show --property="$property" --value "$unit"
}

if ! run_bounded pg_isready -q -t 5 -h 127.0.0.1 -p 5432 -d diva_standby; then
  echo 'DR repair skipped: PostgreSQL is not ready' >&2
  exit 1
fi
if ! probe_http_200 http://127.0.0.1:16333/healthz; then
  echo 'DR repair skipped: Qdrant is not ready' >&2
  exit 1
fi

containers_starting=0
for container in diva_dr_api_a diva_dr_api_b diva_dr_api_gateway diva_dr_web; do
  container_state=$(run_bounded docker inspect \
    -f '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
    "$container" 2>/dev/null || true)
  running=${container_state%% *}
  if [ "$running" != true ]; then
    echo "Starting stopped DR container: $container"
    run_repair_bounded docker start "$container" >/dev/null
    exit 75
  fi

  health=${container_state#* }
  case "$health" in
    healthy) ;;
    starting) containers_starting=1 ;;
    unhealthy)
      # Repair one slot per run. This preserves the other A/B slot and avoids
      # turning a shared dependency incident into simultaneous API restarts.
      echo "Restarting one unhealthy DR container: $container"
      run_repair_bounded docker restart "$container" >/dev/null
      exit 75
      ;;
    *)
      echo "DR container has no health contract: $container" >&2
      exit 1
      ;;
  esac
done

probe_loopback() {
  probe_url=$1
  expected_status=${2:-}
  if probe_http_200 "$probe_url" "$expected_status"; then
    return 0
  fi
  sleep 2
  probe_http_200 "$probe_url" "$expected_status"
}

if ! probe_loopback http://127.0.0.1:18080/backend-api/api/ready ready; then
  if [ "$containers_starting" -eq 1 ]; then
    echo 'DR repair deferred: an application container is still starting' >&2
    exit 75
  fi
  echo 'Restarting DR Web after the loopback API route failed'
  run_repair_bounded docker restart diva_dr_web >/dev/null
  exit 75
fi
if ! probe_loopback http://127.0.0.1:18080/diva-player/; then
  if [ "$containers_starting" -eq 1 ]; then
    echo 'DR repair deferred: an application container is still starting' >&2
    exit 75
  fi
  echo 'Restarting DR Web after the static Web route failed'
  run_repair_bounded docker restart diva_dr_web >/dev/null
  exit 75
fi

if [ "$containers_starting" -eq 1 ]; then
  echo 'DR validation deferred: an application container is still starting'
  exit 75
fi

for unit in "$TUNNEL_SERVICE" "$SYNC_SERVICE" "$SYNC_TIMER"; do
  load_state=$(systemctl_value LoadState "$unit" 2>/dev/null || true)
  if [ "$load_state" != loaded ]; then
    echo "DR systemd unit is not installed: $unit" >&2
    exit 1
  fi
done

tunnel_state=$(systemctl_value ActiveState "$TUNNEL_SERVICE")
case "$tunnel_state" in
  active) ;;
  activating|reloading)
    echo "DR validation deferred: $TUNNEL_SERVICE is $tunnel_state"
    exit 75
    ;;
  *)
    echo "Restarting stopped DR Quick Tunnel service: $TUNNEL_SERVICE"
    run_repair_bounded systemctl restart "$TUNNEL_SERVICE"
    exit 75
    ;;
esac
tunnel_started_usec=$(systemctl_value ActiveEnterTimestampMonotonic "$TUNNEL_SERVICE")
case "$tunnel_started_usec" in
  ''|*[!0-9]*|0)
    echo 'DR Quick Tunnel activation timestamp is unavailable.' >&2
    exit 1
    ;;
esac
if ! run_bounded systemctl is-enabled --quiet "$TUNNEL_SERVICE"; then
  echo "Enabling DR Quick Tunnel service: $TUNNEL_SERVICE"
  run_repair_bounded systemctl enable "$TUNNEL_SERVICE" >/dev/null
  exit 75
fi

timer_state=$(systemctl_value ActiveState "$SYNC_TIMER")
case "$timer_state" in
  active) ;;
  activating|reloading)
    echo "DR validation deferred: $SYNC_TIMER is $timer_state"
    exit 75
    ;;
  *)
    echo "Restarting stopped DR origin sync timer: $SYNC_TIMER"
    run_repair_bounded systemctl restart "$SYNC_TIMER"
    exit 75
    ;;
esac
if ! run_bounded systemctl is-enabled --quiet "$SYNC_TIMER"; then
  echo "Enabling DR origin sync timer: $SYNC_TIMER"
  run_repair_bounded systemctl enable "$SYNC_TIMER" >/dev/null
  exit 75
fi

sync_state=$(systemctl_value ActiveState "$SYNC_SERVICE")
case "$sync_state" in
  active|activating|reloading)
    # The oneshot is currently refreshing the registration. Do not overlap it.
    echo "DR validation deferred: $SYNC_SERVICE is $sync_state"
    exit 75
    ;;
  *)
    sync_result=$(systemctl_value Result "$SYNC_SERVICE")
    sync_status=$(systemctl_value ExecMainStatus "$SYNC_SERVICE")
    sync_finished_usec=$(systemctl_value ExecMainExitTimestampMonotonic "$SYNC_SERVICE")
    uptime_value=$(cut -d ' ' -f 1 /proc/uptime)
    uptime_seconds=${uptime_value%%.*}

    sync_needs_refresh=0
    if [ "$sync_result" != success ] || [ "$sync_status" != 0 ]; then
      sync_needs_refresh=1
    fi
    case "$sync_finished_usec" in
      ''|*[!0-9]*|0) sync_needs_refresh=1 ;;
      *)
        sync_finished_seconds=$((sync_finished_usec / 1000000))
        if [ "$sync_finished_usec" -lt "$tunnel_started_usec" ]; then
          sync_needs_refresh=1
        fi
        if [ "$sync_finished_seconds" -gt "$uptime_seconds" ]; then
          sync_needs_refresh=1
        else
          sync_age_seconds=$((uptime_seconds - sync_finished_seconds))
          if [ "$sync_age_seconds" -gt "$SYNC_MAX_AGE_SECONDS" ]; then
            sync_needs_refresh=1
          fi
        fi
        ;;
    esac

    if [ "$sync_needs_refresh" -eq 1 ]; then
      echo "Re-running failed or stale DR origin sync: $SYNC_SERVICE"
      run_repair_bounded systemctl restart "$SYNC_SERVICE"
      exit 75
    fi
    ;;
esac

echo 'PASS WSL DR standby health watchdog'
