import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const toShellPath = (value) => {
  if (process.platform !== 'win32') return value;
  return value
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
};

const bash = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';

assert(existsSync(bash) || process.platform !== 'win32', `bash not found: ${bash}`);

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = resolve(repositoryRoot, 'scripts/provision-sbc-db-roles.sh');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'diva-db-role-contract-'));
const fakeBin = join(temporaryRoot, 'bin');
const dockerArguments = join(temporaryRoot, 'docker-arguments');
const dockerStdin = join(temporaryRoot, 'docker-stdin');

try {
  const scriptSource = await readFile(scriptPath, 'utf8');
  assert.match(scriptSource, /\[\[ -f "\$secret_file" && ! -L "\$secret_file" \]\]/);
  assert.match(scriptSource, /stat -c '%u' -- "\$secret_file"/);
  assert.match(scriptSource, /file_owner_uid.*current_uid/s);
  assert.match(scriptSource, /8#\$file_mode & 077/);

  await mkdir(fakeBin);
  const fakeDocker = join(fakeBin, 'docker');
  await writeFile(fakeDocker, `#!/usr/bin/env bash
set -euo pipefail
[[ -z "\${DIVA_DB_API_PASSWORD-}" ]]
[[ -z "\${DIVA_DB_PIPELINE_PASSWORD-}" ]]
[[ -z "\${DIVA_DB_ADMIN_PASSWORD-}" ]]
[[ -z "\${DIVA_DB_ADMIN_NEW_PASSWORD-}" ]]
[[ -z "\${PGPASSWORD-}" ]]
[[ -z "\${POSTGRES_PASSWORD-}" ]]
printf '%s\\n' "$@" >> "$DIVA_TEST_DOCKER_ARGUMENTS"
printf '%s\\n' -- '--END-ARGS--' >> "$DIVA_TEST_DOCKER_ARGUMENTS"
payload="$(cat)"
printf '%s\\n' "$payload" >> "$DIVA_TEST_DOCKER_STDIN"
printf '%s\\n' -- '--END-STDIN--' >> "$DIVA_TEST_DOCKER_STDIN"
if [[ " $* " == *' --tuples-only '* ]]; then
  printf '0\\n'
else
  printf 'fake docker completed\\n'
fi
`, { mode: 0o700 });
  await chmod(fakeDocker, 0o700);

  const apiSecret = 'api,Secret"Value$WithSymbols-1234567890';
  const pipelineSecret = 'pipeline-Secret-Value-9876543210!';
  const environment = {
    ...process.env,
    DIVA_DB_CONTAINER: 'vocadb_postgres_contract',
    DIVA_DB_API_LOGIN_ROLE: 'diva_api_login_20260810a',
    DIVA_DB_PIPELINE_LOGIN_ROLE: 'diva_pipeline_login_20260810a',
    DIVA_DB_API_PASSWORD: apiSecret,
    DIVA_DB_PIPELINE_PASSWORD: pipelineSecret,
    DIVA_TEST_DOCKER_ARGUMENTS: toShellPath(dockerArguments),
    DIVA_TEST_DOCKER_STDIN: toShellPath(dockerStdin),
  };

  const result = spawnSync(
    bash,
    [
      '-c',
      'PATH="$1:$PATH"; export PATH; exec "$2" "$3"',
      'diva-db-role-test',
      toShellPath(fakeBin),
      toShellPath(scriptPath),
      'create',
    ],
    { env: environment, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, `provision script failed:\n${result.stderr}`);

  const argumentsText = await readFile(dockerArguments, 'utf8');
  const stdinText = await readFile(dockerStdin, 'utf8');
  const observableText = `${result.stdout}\n${result.stderr}\n${argumentsText}`;

  assert(!observableText.includes(apiSecret), 'API password leaked to argv/output');
  assert(!observableText.includes(pipelineSecret), 'pipeline password leaked to argv/output');
  assert(
    stdinText.includes(apiSecret.replaceAll('"', '""')),
    'CSV-escaped API password was not transported over stdin',
  );
  assert(stdinText.includes(pipelineSecret), 'pipeline password was not transported over stdin');
  assert.match(stdinText, /SET LOCAL password_encryption = 'scram-sha-256'/);
  assert.match(stdinText, /SET LOCAL log_statement = 'none'/);
  assert.match(stdinText, /GRANT %I TO %I/);
  assert.match(stdinText, /in-place password rotation is forbidden/);
  assert.match(stdinText, /CREATE ROLE %I WITH LOGIN/);
  assert.doesNotMatch(stdinText, /ALTER ROLE %I WITH LOGIN[^\n]*PASSWORD/);
  assert.match(stdinText, /diva_api_login_20260810a/);
  assert.match(stdinText, /diva_pipeline_login_20260810a/);
  assert.match(argumentsText, /^exec\n-i\nvocadb_postgres_contract\npsql\n/m);
  assert.doesNotMatch(argumentsText, /password/i);

  const invalidResult = spawnSync(
    bash,
    [
      '-c',
      'PATH="$1:$PATH"; export PATH; exec "$2" "$3"',
      'diva-db-role-test',
      toShellPath(fakeBin),
      toShellPath(scriptPath),
      'create',
    ],
    {
      env: {
        ...environment,
        DIVA_DB_API_PASSWORD: 'too-short',
      },
      encoding: 'utf8',
    },
  );

  assert.notEqual(invalidResult.status, 0, 'short password was accepted');
  assert(!`${invalidResult.stdout}\n${invalidResult.stderr}`.includes('too-short'));

  const fixedNameResult = spawnSync(
    bash,
    [
      '-c',
      'PATH="$1:$PATH"; export PATH; exec "$2" "$3"',
      'diva-db-role-test',
      toShellPath(fakeBin),
      toShellPath(scriptPath),
      'create',
    ],
    {
      env: {
        ...environment,
        DIVA_DB_API_LOGIN_ROLE: 'diva_api_login',
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(fixedNameResult.status, 0, 'unversioned LOGIN role name was accepted');

  const oldRole = 'diva_api_login_20260701a';
  const decommissionResult = spawnSync(
    bash,
    [
      '-c',
      'PATH="$1:$PATH"; export PATH; exec "$2" "$3" "$4" "$5"',
      'diva-db-role-test',
      toShellPath(fakeBin),
      toShellPath(scriptPath),
      'decommission',
      'api',
      oldRole,
    ],
    {
      env: {
        ...environment,
        DIVA_DB_REPLACEMENT_LOGIN_ROLE: 'diva_api_login_20260810a',
        DIVA_DB_DECOMMISSION_CONFIRM: oldRole,
        DIVA_DB_DECOMMISSION_WAIT_SECONDS: '0',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(
    decommissionResult.status,
    0,
    `decommission script failed:\n${decommissionResult.stderr}`,
  );
  const contractionStdin = await readFile(dockerStdin, 'utf8');
  assert.match(contractionStdin, /ALTER ROLE %I NOLOGIN/);
  assert.match(contractionStdin, /verified replacement role/);
  assert.match(contractionStdin, /pg_stat_activity/);
  assert.match(contractionStdin, /DROP ROLE %I/);
  assert.match(decommissionResult.stdout, new RegExp(oldRole));

  const missingConfirmation = spawnSync(
    bash,
    [
      '-c',
      'PATH="$1:$PATH"; export PATH; exec "$2" "$3" "$4" "$5"',
      'diva-db-role-test',
      toShellPath(fakeBin),
      toShellPath(scriptPath),
      'decommission',
      'api',
      oldRole,
    ],
    {
      env: {
        ...environment,
        DIVA_DB_REPLACEMENT_LOGIN_ROLE: 'diva_api_login_20260810a',
        DIVA_DB_DECOMMISSION_CONFIRM: 'wrong-role',
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(missingConfirmation.status, 0, 'unsafe decommission was accepted');

  await writeFile(dockerArguments, '');
  await writeFile(dockerStdin, '');
  const adminSecret = 'admin:Secret\\Value$WithSymbols-2468135790';
  const rotateAdminResult = spawnSync(
    bash,
    [
      '-c',
      'PATH="$1:$PATH"; export PATH; exec "$2" "$3"',
      'diva-db-role-test',
      toShellPath(fakeBin),
      toShellPath(scriptPath),
      'rotate-admin',
    ],
    {
      env: {
        ...environment,
        DIVA_DB_ADMIN_USER: 'vocadb',
        DIVA_DB_ADMIN_PASSWORD: 'old-admin-password-must-not-be-inherited',
        DIVA_DB_ADMIN_NEW_PASSWORD: adminSecret,
        DIVA_DB_ADMIN_ROTATE_CONFIRM: 'vocadb',
        PGPASSWORD: 'ambient-pg-password-must-not-be-inherited',
        POSTGRES_PASSWORD: 'ambient-postgres-password-must-not-be-inherited',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(
    rotateAdminResult.status,
    0,
    `admin rotation failed:\n${rotateAdminResult.stderr}`,
  );

  const rotationArguments = await readFile(dockerArguments, 'utf8');
  const rotationStdin = await readFile(dockerStdin, 'utf8');
  const rotationObservable = [
    rotateAdminResult.stdout,
    rotateAdminResult.stderr,
    rotationArguments,
  ].join('\n');
  assert(!rotationObservable.includes(adminSecret), 'admin password leaked to argv/output');
  assert(
    !rotationObservable.includes('old-admin-password-must-not-be-inherited'),
    'old admin password leaked to argv/output',
  );
  assert.equal(
    rotationStdin.split(adminSecret.replaceAll('"', '""')).length - 1,
    2,
    'admin password was not sent exactly once to ALTER and once to TCP verification',
  );
  assert.match(rotationStdin, /COPY _diva_admin_rotation \(admin_role, password\)/);
  assert.match(rotationStdin, /rolcanlogin/);
  assert.match(rotationStdin, /rolsuper/);
  assert.match(rotationStdin, /current_user <> rotation\.admin_role/);
  assert.match(rotationStdin, /datdba = \(SELECT oid FROM pg_roles/);
  assert.match(rotationStdin, /FROM pg_stat_activity/);
  assert.match(rotationStdin, /backend_type = 'client backend'/);
  assert.match(rotationStdin, /pid <> pg_backend_pid\(\)/);
  assert.match(rotationStdin, /migrate and drain runtime pools before rotation/);
  assert.match(rotationStdin, /ALTER ROLE %I WITH LOGIN PASSWORD %L/);
  assert.match(rotationStdin, /COMMIT;/);
  assert.match(rotationStdin, /SET LOCAL log_statement = 'none'/);
  assert.match(rotationStdin, /SET LOCAL log_min_error_statement = 'panic'/);
  assert.match(rotationArguments, /sh\n-ceu\n/);
  assert.match(rotationArguments, /umask 077/);
  assert.match(rotationArguments, /mktemp/);
  assert.match(rotationArguments, /chmod 600/);
  assert.match(rotationArguments, /stat -c "%a"/);
  assert.match(rotationArguments, /trap cleanup EXIT/);
  assert.match(rotationArguments, /trap "exit 143" TERM/);
  assert.match(rotationArguments, /rm -f -- "\$passfile"/);
  assert.match(rotationArguments, /unset PGPASSWORD POSTGRES_PASSWORD/);
  assert.match(rotationArguments, /PGPASSFILE="\$passfile" PGCONNECT_TIMEOUT=5/);
  assert.match(rotationArguments, /--host=127\.0\.0\.1 --port=5432/);
  assert.doesNotMatch(rotationArguments, /admin:Secret/);

  const wrongAdminConfirmation = spawnSync(
    bash,
    [
      '-c',
      'PATH="$1:$PATH"; export PATH; exec "$2" "$3"',
      'diva-db-role-test',
      toShellPath(fakeBin),
      toShellPath(scriptPath),
      'rotate-admin',
    ],
    {
      env: {
        ...environment,
        DIVA_DB_ADMIN_NEW_PASSWORD: adminSecret,
        DIVA_DB_ADMIN_ROTATE_CONFIRM: 'different-admin',
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(wrongAdminConfirmation.status, 0, 'unsafe admin rotation was accepted');
  assert(!`${wrongAdminConfirmation.stdout}\n${wrongAdminConfirmation.stderr}`.includes(adminSecret));

  const shortAdminSecret = spawnSync(
    bash,
    [
      '-c',
      'PATH="$1:$PATH"; export PATH; exec "$2" "$3"',
      'diva-db-role-test',
      toShellPath(fakeBin),
      toShellPath(scriptPath),
      'rotate-admin',
    ],
    {
      env: {
        ...environment,
        DIVA_DB_ADMIN_NEW_PASSWORD: 'too-short-admin',
        DIVA_DB_ADMIN_ROTATE_CONFIRM: 'vocadb',
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(shortAdminSecret.status, 0, 'short admin password was accepted');
  assert(!`${shortAdminSecret.stdout}\n${shortAdminSecret.stderr}`.includes('too-short-admin'));

  console.log('PASS database role expand/contract/admin-rotation secret contract');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
