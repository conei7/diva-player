import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [migration, normalization, integration, runner, workflow, compose, runtimeRoles] = await Promise.all([
  readFile(
    new URL('../backend/database/migrations/0019_repair_tag_parent_fk.sql', import.meta.url),
    'utf8',
  ),
  readFile(
    new URL('../backend/database/migrations/0020_normalize_annoyloids_category.sql', import.meta.url),
    'utf8',
  ),
  readFile(new URL('./test-tag-parent-fk-migration.sh', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/migrate.sh', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'),
  readFile(new URL('../backend/docker-compose.yml', import.meta.url), 'utf8'),
  readFile(
    new URL('../backend/database/migrations/0018_runtime_database_roles.sql', import.meta.url),
    'utf8',
  ),
]);

assert.match(migration, /^BEGIN;\s*$/m);
assert.match(migration, /COMMIT;\s*$/);
assert.match(migration, /SET LOCAL lock_timeout = '5s'/);
assert.match(migration, /SET LOCAL statement_timeout = '30s'/);
assert.match(migration, /LOCK TABLE public\.tags IN SHARE ROW EXCLUSIVE MODE/);
assert.match(migration, /0019 must run as the tags owner or a superuser/);

for (const expectedShape of [
  /id = 11668[\s\S]*name = 'Nowaru Burakku Hato'[\s\S]*category = 'Derivative'[\s\S]*parent_id = 11669/,
  /id = 11822[\s\S]*name = '猫の日'[\s\S]*category = 'Themes'[\s\S]*parent_id = 11805/,
  /id = 11669[\s\S]*name = 'Annoyloids'[\s\S]*category IS NULL[\s\S]*parent_id = 92/,
  /id = 11805[\s\S]*name = '記念日'[\s\S]*category = 'Themes'[\s\S]*parent_id IS NULL/,
  /id = 92[\s\S]*name = '亜種'[\s\S]*category = 'Derivative'[\s\S]*parent_id IS NULL/,
]) {
  assert.match(migration, expectedShape);
}

assert.match(migration, /lower\(btrim\(name\)\) = lower\('Annoyloids'\)/);
assert.match(migration, /lower\(btrim\(name\)\) = lower\('記念日'\)/);
assert.match(migration, /unreviewed orphan tag parent edges/);
assert.match(migration, /\(child\.id, child\.parent_id\) NOT IN \(\(11668, 11669\), \(11822, 11805\)\)/);
assert.ok(
  (migration.match(/WITH RECURSIVE parent_walk/g) ?? []).length >= 2,
  'migration must check the global parent graph before and after repair',
);
assert.ok(
  (migration.match(/parent_tag\.id = ANY\(walk\.path\)/g) ?? []).length >= 2,
  'recursive cycle checks must use a terminating path guard',
);

assert.match(
  migration,
  /INSERT INTO public\.tags \(id, name, category, parent_id\)[\s\S]*VALUES \(11669, 'Annoyloids', NULL, 92\)/,
);
assert.match(
  migration,
  /INSERT INTO public\.tags \(id, name, category, parent_id\)[\s\S]*VALUES \(11805, '記念日', 'Themes', NULL\)/,
);
assert.doesNotMatch(migration, /\bUPDATE\s+public\.tags\b/i);
assert.doesNotMatch(migration, /\bDELETE\s+FROM\s+public\.tags\b/i);
assert.doesNotMatch(migration, /ON\s+CONFLICT/i);
assert.doesNotMatch(migration, /session_replication_role/i);
assert.doesNotMatch(migration, /\b(?:GRANT|REVOKE|ALTER\s+ROLE)\b/i);

assert.match(migration, /constraint tags_parent_id_fkey exists with unexpected semantics/);
assert.match(migration, /competing foreign keys involve tags\.parent_id/);
assert.match(migration, /FOREIGN KEY \(parent_id\)[\s\S]*REFERENCES public\.tags \(id\)/);
assert.match(migration, /ON UPDATE NO ACTION[\s\S]*ON DELETE NO ACTION/);
assert.match(migration, /NOT DEFERRABLE[\s\S]*NOT VALID/);
assert.match(migration, /VALIDATE CONSTRAINT tags_parent_id_fkey/);
for (const catalogField of [
  'conkey',
  'confrelid',
  'confkey',
  'confmatchtype',
  'confupdtype',
  'confdeltype',
  'condeferrable',
  'condeferred',
  'convalidated',
]) {
  assert.match(migration, new RegExp(`constraint_row\\.${catalogField}`));
}

assert.match(integration, /DIVA_ALLOW_DESTRUCTIVE_DB_MIGRATION_TEST/);
assert.match(integration, /requires empty tags\/songs\/song_tags tables/);
assert.match(integration, /unreviewed orphan tag parent edges/);
assert.match(integration, /tag parent cycle detected before repair/);
assert.match(integration, /late constraint failure did not roll back repairs/);
assert.match(integration, /song_tags references changed during repair/);
assert.match(integration, /SET ROLE diva_pipeline_runtime/);
assert.match(integration, /exact pre-existing FK was not validated/);
assert.match(integration, /competing foreign keys involve tags\.parent_id/);
assert.match(integration, /PASS tag parent FK migration contract/);

const runMigration = runner.indexOf('psql -v ON_ERROR_STOP=1 -f "$file"');
const recordMigration = runner.indexOf('INSERT INTO schema_migrations');
assert.match(
  runner,
  /migrations_sql_dir="\$\{MIGRATIONS_SQL_DIR:-\/migrations\/sql\}"/,
);
assert.match(runner, /for file in "\$migrations_sql_dir"\/\*\.sql/);
assert.ok(runMigration !== -1 && recordMigration > runMigration);
assert.match(compose, /\.\/database\/migrations:\/migrations\/sql:ro/);
assert.match(compose, /PGUSER: "\$\{DIVA_DB_ADMIN_USER:-vocadb\}"/);

assert.match(workflow, /npm run test:tag-parent-fk-migration/);
assert.match(workflow, /bash scripts\/test-tag-parent-fk-migration\.sh/);
assert.match(workflow, /DIVA_ALLOW_DESTRUCTIVE_DB_MIGRATION_TEST: '1'/);

assert.match(runtimeRoles, /GRANT SELECT, INSERT, UPDATE, DELETE[\s\S]*diva_pipeline_runtime/);
assert.doesNotMatch(
  runtimeRoles,
  /GRANT (?:REFERENCES|TRIGGER)[\s\S]*diva_pipeline_runtime/,
);

assert.match(normalization, /^BEGIN;\s*$/m);
assert.match(normalization, /COMMIT;\s*$/);
assert.match(normalization, /SET LOCAL lock_timeout = '5s'/);
assert.match(normalization, /SET LOCAL statement_timeout = '30s'/);
assert.match(normalization, /LOCK TABLE public\.tags IN SHARE ROW EXCLUSIVE MODE/);
assert.match(normalization, /0020 must run as the tags owner or a superuser/);
assert.match(normalization, /0020 requires the validated tags\(parent_id\) self-reference/);
assert.match(
  normalization,
  /id = 11669[\s\S]*name = 'Annoyloids'[\s\S]*parent_id = 92[\s\S]*\(category IS NULL OR category = ''\)/,
);
assert.match(
  normalization,
  /UPDATE public\.tags[\s\S]*SET category = ''[\s\S]*WHERE id = 11669[\s\S]*category IS NULL/,
);
assert.match(normalization, /orphan tag parent edges found during 0020/);
assert.match(normalization, /tag parent cycle found during 0020/);
assert.doesNotMatch(normalization, /\bDELETE\s+FROM\s+public\.tags\b/i);
assert.doesNotMatch(normalization, /session_replication_role/i);
assert.doesNotMatch(normalization, /\b(?:GRANT|REVOKE|ALTER\s+ROLE)\b/i);

console.log('PASS tag parent FK migration static contract');
