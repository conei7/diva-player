#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

for file in /migrations/sql/*.sql; do
  [ -f "$file" ] || continue
  migration_id="$(basename "$file")"
  applied="$(psql -v ON_ERROR_STOP=1 -v migration_id="$migration_id" -tAc "SELECT 1 FROM schema_migrations WHERE migration_id = :'migration_id'")"

  if [ "$applied" = "1" ]; then
    echo "[migrate] already applied: $migration_id"
    continue
  fi

  echo "[migrate] applying: $migration_id"
  psql -v ON_ERROR_STOP=1 -f "$file"
  psql -v ON_ERROR_STOP=1 -v migration_id="$migration_id" -c "INSERT INTO schema_migrations (migration_id) VALUES (:'migration_id')"
done
