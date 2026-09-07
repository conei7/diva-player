#!/usr/bin/env bash
set -euo pipefail
[[ "${DIVA_ALLOW_DESTRUCTIVE_DB_MIGRATION_TEST:-}" == 1 && "${CI:-}" == true ]] || {
  echo 'This test requires the disposable CI database' >&2; exit 1;
}
psql -X -v ON_ERROR_STOP=1 -f backend/database/tests/youtube_quota_contract.sql
# Preserve the policy and counters in this disposable database only.
psql -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE diva_ci_quota_saved AS SELECT * FROM sync_state
WHERE key = 'youtube_quota_policy_v2' OR key LIKE 'youtube_quota_v2:%';
DELETE FROM sync_state WHERE key LIKE 'youtube_quota_v2:%';
UPDATE sync_state SET value = '{"views":5,"playlists":5,"activeAfter":"2000-01-01T00:00:00Z"}'
WHERE key = 'youtube_quota_policy_v2';
SQL
cleanup() {
  psql -X -v ON_ERROR_STOP=1 <<'SQL'
DELETE FROM sync_state WHERE key = 'youtube_quota_policy_v2' OR key LIKE 'youtube_quota_v2:%';
INSERT INTO sync_state SELECT * FROM diva_ci_quota_saved;
DROP TABLE diva_ci_quota_saved;
SQL
}
trap cleanup EXIT
pids=()
for purpose in views playlists; do
  role=diva_pipeline_runtime
  [[ "$purpose" != playlists ]] || role=diva_api_runtime
  for attempt in {1..12}; do
    psql -X -v ON_ERROR_STOP=1 -qc "SET SESSION AUTHORIZATION $role; SELECT * FROM public.reserve_youtube_quota('$purpose')" >/dev/null &
    pids+=("$!")
  done
done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
[[ "$failed" == 0 ]]
psql -X -v ON_ERROR_STOP=1 -Atc "SELECT count(*) = 2 AND bool_and(value::integer = 5) FROM sync_state WHERE key LIKE 'youtube_quota_v2:%'" | grep -qx t
echo 'Concurrent quota reservations passed'
