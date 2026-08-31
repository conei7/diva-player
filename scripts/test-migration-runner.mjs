import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFile,
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(repoRoot, 'backend', 'database', 'migrations');
const manifestPath = path.join(migrationsDir, 'migration-manifest.tsv');
const runnerPath = path.join(repoRoot, 'backend', 'database', 'migrate.sh');

const manifestText = await readFile(manifestPath, 'utf8');
const entries = manifestText.trimEnd().split('\n').map((line, index) => {
  const fields = line.replace(/\r$/, '').split('|');
  assert.equal(fields.length, 3, `manifest line ${index + 1} must have three fields`);
  const [migrationId, executionMode, contentSha256] = fields;
  assert.match(migrationId, /^\d{4}_[a-z0-9][a-z0-9_]*\.sql$/);
  assert.match(executionMode, /^(?:atomic|atomic-boundary|non-transactional)$/);
  assert.match(contentSha256, /^[0-9a-f]{64}$/);
  return { migrationId, executionMode, contentSha256 };
});

assert.equal(entries.length, 24, 'all existing migrations must be pinned in the manifest');
assert.deepEqual(
  entries.map(entry => entry.migrationId),
  [...entries.map(entry => entry.migrationId)].sort(),
  'manifest order must be deterministic',
);
assert.equal(new Set(entries.map(entry => entry.migrationId)).size, entries.length);

const sqlFiles = (await readdir(migrationsDir))
  .filter(name => name.endsWith('.sql'))
  .sort();
assert.deepEqual(
  entries.map(entry => entry.migrationId),
  sqlFiles,
  'every SQL file must have exactly one manifest entry',
);

const transactionIncompatible = /^(?:\s*(?:BEGIN|COMMIT)\s*;|\s*(?:(?:CREATE(?:\s+UNIQUE)?\s+INDEX|DROP\s+INDEX|REINDEX)\s+.*CONCURRENTLY|VACUUM\b|CLUSTER\b|CREATE\s+DATABASE\b|DROP\s+DATABASE\b|ALTER\s+SYSTEM\b|CALL\b)|\s*\\(?:gexec|set\s+AUTOCOMMIT))/im;

for (const entry of entries) {
  const sql = await readFile(path.join(migrationsDir, entry.migrationId), 'utf8');
  const canonicalSql = sql.replaceAll('\r\n', '\n');
  const digest = createHash('sha256').update(canonicalSql).digest('hex');
  assert.equal(digest, entry.contentSha256, `${entry.migrationId} checksum drifted`);

  if (entry.executionMode === 'atomic') {
    assert.doesNotMatch(sql, transactionIncompatible, `${entry.migrationId} is not runner-atomic`);
  }
  if (entry.executionMode === 'atomic-boundary') {
    assert.equal((sql.match(/^BEGIN;\s*$/gm) ?? []).length, 1);
    assert.equal((sql.match(/^COMMIT;\s*$/gm) ?? []).length, 1);
    const withoutBoundaries = sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    assert.doesNotMatch(withoutBoundaries, transactionIncompatible);
  }
}

const runner = await readFile(runnerPath, 'utf8');
assert.match(runner, /pg_try_advisory_lock\([\s\S]*diva-player-schema-migration-runner-v1/);
assert.match(runner, /pg_advisory_unlock\([\s\S]*diva-player-schema-migration-runner-v1/);
assert.match(runner, /ALTER COLUMN content_sha256 SET NOT NULL/);
assert.match(runner, /database contains migrations absent from this checkout/);
assert.match(runner, /applied migration checksum or execution mode differs/);
assert.match(runner, /schema_migration_attempts/);
assert.match(runner, /has incomplete attempt/);
assert.match(runner, /status = 'succeeded'/);
assert.match(runner, /psql -X -v ON_ERROR_STOP=1 -f "\$driver"/);
assert.match(runner, /--reconcile-migration-acl-only/);
assert.match(runner, /reconcile_migration_acl \|\| acl_status=\$\?/);
assert.match(runner, /has_table_privilege\(target_role_name, relation_oid, privilege_name\)/);
assert.match(runner, /has_sequence_privilege\(target_role_name, sequence_oid, 'UPDATE'\)/);
const migrationHistoryNotNull = runner.indexOf('ALTER COLUMN content_sha256 SET NOT NULL');
const preflightPrivilegeRevoke = runner.indexOf(
  'DO $migration_history_privileges$',
  migrationHistoryNotNull,
);
const preflightCommit = runner.indexOf('COMMIT;', migrationHistoryNotNull);
assert.ok(
  migrationHistoryNotNull >= 0
    && preflightPrivilegeRevoke > migrationHistoryNotNull
    && preflightCommit > preflightPrivilegeRevoke,
  'new migration-history objects must lose runtime write privileges before commit',
);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'diva-migration-runner-contract-'));
const fakeBin = path.join(tempRoot, 'bin');
const fakePsql = path.join(fakeBin, 'psql');

const toShellPath = value => {
  if (process.platform !== 'win32') return value;
  return value
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
};

const runWithFakePsql = (sqlDir, extraEnv = {}) => spawnSync(
  'sh',
  [
    '-c',
    'PATH="$1:$PATH"; export PATH; MIGRATIONS_SQL_DIR="$2"; export MIGRATIONS_SQL_DIR; exec sh "$3"',
    'migration-runner-contract',
    toShellPath(fakeBin),
    toShellPath(sqlDir),
    toShellPath(runnerPath),
  ],
  {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  },
);

try {
  await mkdir(fakeBin);
  await writeFile(fakePsql, `#!/bin/sh
if [ -n "\${DIVA_TEST_PSQL_MARKER:-}" ]; then
  printf 'invoked\n' >"$DIVA_TEST_PSQL_MARKER"
fi
driver=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-f' ]; then
    shift
    driver="$1"
  fi
  shift
done
if [ -n "$driver" ]; then
  cat "$driver"
else
  cat >/dev/null
fi
`, 'utf8');
  await chmod(fakePsql, 0o755);

  const generated = runWithFakePsql(migrationsDir);
  assert.equal(generated.status, 0, generated.stderr);
  assert.doesNotMatch(
    generated.stdout,
    /\u001b/,
    'generated psql driver must not contain shell-expanded escape characters',
  );
  assert.equal(
    (generated.stdout.match(/^\\endif\r?$/gm) ?? []).length,
    entries.length,
    'every migration guard must end with a literal psql \\endif command',
  );
  const appliedGuards = [...generated.stdout.matchAll(
    /SELECT EXISTS \(\r?\n {4}SELECT 1 FROM public\.schema_migrations\r?\n {4}WHERE migration_id = '[^']+'\r?\n\) AS ([a-z_]+)\r?\n\\gset ([a-z_]+)\r?\n\\if :([a-z_]+)/g,
  )];
  assert.equal(
    appliedGuards.length,
    entries.length,
    'every migration must have an applied-history guard',
  );
  for (const [, columnName, variablePrefix, conditionalVariable] of appliedGuards) {
    assert.equal(
      `${variablePrefix}${columnName}`,
      conditionalVariable,
      `psql \\if references undefined variable ${conditionalVariable}`,
    );
  }
  assert.match(
    generated.stdout,
    /^\\echo \[migrate\] applying atomic migration: 0002_view_history_recorded_song_idx\.sql\r?$/m,
  );
  assert.match(generated.stdout, /CREATE INDEX IF NOT EXISTS view_history_recorded_song_idx[\s\S]*INSERT INTO public\.schema_migrations[\s\S]*COMMIT;/);

  const boundaryStart = generated.stdout.indexOf(
    'applying atomic migration: 0019_repair_tag_parent_fk.sql',
  );
  const boundaryEnd = generated.stdout.indexOf('\\endif', boundaryStart);
  assert.ok(boundaryStart >= 0 && boundaryEnd > boundaryStart);
  const boundaryBlock = generated.stdout.slice(boundaryStart, boundaryEnd);
  assert.equal((boundaryBlock.match(/^BEGIN;\s*$/gm) ?? []).length, 1);
  assert.equal((boundaryBlock.match(/^COMMIT;\s*$/gm) ?? []).length, 1);
  assert.match(boundaryBlock, /INSERT INTO public\.schema_migrations[\s\S]*COMMIT;/);

  const nonTransactionalStart = generated.stdout.indexOf(
    'applying non-transactional migration: 0023_normalize_song_album_links.sql',
  );
  const nonTransactionalEnd = generated.stdout.indexOf('\\endif', nonTransactionalStart);
  assert.ok(nonTransactionalStart >= 0 && nonTransactionalEnd > nonTransactionalStart);
  const nonTransactionalBlock = generated.stdout.slice(
    nonTransactionalStart,
    nonTransactionalEnd,
  );
  assert.ok(
    nonTransactionalBlock.indexOf("status = 'running'")
      < nonTransactionalBlock.indexOf('CREATE TEMP TABLE song_album_migration_runtime_v1'),
  );
  assert.ok(
    nonTransactionalBlock.indexOf('CREATE TEMP TABLE song_album_migration_runtime_v1')
      < nonTransactionalBlock.indexOf('INSERT INTO public.schema_migrations'),
  );
  assert.ok(
    nonTransactionalBlock.indexOf('INSERT INTO public.schema_migrations')
      < nonTransactionalBlock.indexOf("status = 'succeeded'"),
  );

  const tamperedDir = path.join(tempRoot, 'tampered-migrations');
  await cp(migrationsDir, tamperedDir, { recursive: true });
  await appendFile(path.join(tamperedDir, '0024_view_history_observation_flags.sql'), '\n-- drift\n');
  const tampered = runWithFakePsql(tamperedDir);
  assert.notEqual(tampered.status, 0, 'checksum drift must stop before psql runs');
  assert.match(tampered.stderr, /checksum mismatch for 0024_view_history_observation_flags\.sql/);

  const psqlMarker = path.join(tempRoot, 'psql-invoked');
  const interrupted = runWithFakePsql(migrationsDir, {
    DIVA_MIGRATION_TEST_SIGNAL_BEFORE_PSQL: 'TERM',
    DIVA_TEST_PSQL_MARKER: toShellPath(psqlMarker),
  });
  assert.equal(interrupted.status, 143, interrupted.stderr);
  assert.match(interrupted.stderr, /signal received before database execution/);
  await assert.rejects(
    readFile(psqlMarker, 'utf8'),
    { code: 'ENOENT' },
    'TERM during manifest validation must not invoke psql',
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('PASS migration runner integrity and atomicity contract');
