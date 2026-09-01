import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(scriptsDirectory, '..');
const fixtureParent = resolve(process.env.DIVA_STATEFUL_TEST_ROOT || (
  process.platform === 'win32' && process.env.USERPROFILE
    ? process.env.USERPROFILE
    : tmpdir()
));
let fixtureBase;
let fixtureBaseIdentity;
let fixtureBaseOriginalAclSddl;
let fixtureParentRealPath;
const hardeningScript = join(scriptsDirectory, 'harden-sbc-stateful-services.sh');
const rollingDeploymentScript = join(scriptsDirectory, 'deploy-sbc-api-rolling.sh');
const backupAttester = join(scriptsDirectory, 'attest-disaster-backup-payloads.py');
const qdrantUpgradeController = join(scriptsDirectory, 'sbc-qdrant-storage-upgrade.py');
const apiBridgeReceiptHelper = join(scriptsDirectory, 'wsl-dr-api-bridge-receipt.py');
const apiBridgeConsumptionHelper = join(scriptsDirectory, 'sbc-api-bridge-consumption.py');
const qdrantDockerfile = join(projectDirectory, 'backend', 'qdrant', 'Dockerfile');
const qdrantDockerignore = join(projectDirectory, 'backend', 'qdrant', '.dockerignore');
const qdrantAuditContractHelper = join(projectDirectory, 'backend', 'qdrant', 'audit-contract.sh');
const postgresDockerfile = join(projectDirectory, 'backend', 'database', 'Dockerfile.pgvector');
const postgresMigrateDockerfile = join(projectDirectory, 'backend', 'database', 'Dockerfile.migrate');
const postgresDockerignore = join(projectDirectory, 'backend', 'database', '.dockerignore');
const postgresSchema = join(projectDirectory, 'backend', 'database', 'schema.sql');
const imageScanValidator = join(scriptsDirectory, 'validate-container-image-scan.py');
const playerOfficialOrigin = 'https://github.com/conei7/diva-player.git';
const pipelineOfficialOrigin = 'git@github.com:conei7/diva-data-pipeline.git';
const githubEd25519HostKey = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const bashCommand = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';

function resolveRealPython() {
  const candidates = [
    ...(process.platform === 'win32' && process.env.USERPROFILE
      ? [[join(
          process.env.USERPROFILE,
          '.cache',
          'codex-runtimes',
          'codex-primary-runtime',
          'dependencies',
          'python',
          'python.exe',
        ), []]]
      : []),
    ['python3', []],
    ['python', []],
    ...(process.platform === 'win32' ? [['py', ['-3']]] : []),
  ];
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error('A real Python 3 interpreter is required for the production evidence validator');
}

const realPythonExecutable = resolveRealPython();
const fixtureRoots = [];
let fixtureBasePromise;
let windowsSid;
let attesterNegativeChecked = false;
const delayedMutationScenarios = new Set([
  'qdrant-compose-timeout',
  'postgres-compose-timeout',
  'image-tag-timeout',
  'promotion-qdrant-compose-timeout',
  'promotion-postgres-compose-timeout',
  'delayed-old-rm',
]);
const timeoutFaultScenarios = new Set([
  ...delayedMutationScenarios,
  'gate-acquire-timeout',
  'gate-release-timeout',
  'qdrant-compose-unresolved',
  'daemon-read-timeout-after-gate',
  'daemon-read-timeout-once-after-gate',
  'projection-config-timeout',
]);
// These fixtures are rejected by production checks that precede creation of
// RUN_DIR. Keep them in production control-flow order: tracked-source index
// validation, PostgreSQL backup evidence validation, then Qdrant backup
// evidence validation. Every other scenario must publish exactly one RUN_DIR.
const preRunRejectionScenarios = new Set([
  'assume-unchanged-pipeline-source',
  'skip-worktree-pipeline-source',
  'pipeline-origin-alias',
  'github-host-key-drift',
  'github-identity-drift',
  'forged-origin-main',
  'status-swap-after-shell-hash',
  'invalid-evidence-existing-journal',
  'zero-point-backup-evidence',
]);

const ids = Object.freeze({
  oldQdrant: 'a'.repeat(64),
  oldPostgres: 'b'.repeat(64),
  qdrantImage: `sha256:${'c'.repeat(64)}`,
  oldStableQdrantImage: `sha256:${'4'.repeat(64)}`,
  postgresImage: `sha256:${'d'.repeat(64)}`,
  postgresMigrateImage: `sha256:${'9'.repeat(64)}`,
  newQdrant: 'e'.repeat(64),
  newPostgres: 'f'.repeat(64),
  promotedQdrant: '1'.repeat(64),
  promotedPostgres: '2'.repeat(64),
  auditContainer: '7'.repeat(64),
  ownerAuditContainer: '6'.repeat(64),
});

if (process.platform === 'win32' && !existsSync(bashCommand)) {
  throw new Error(`Git Bash is required for this contract: ${bashCommand}`);
}

const [
  hardeningSource,
  rollingDeploymentSource,
  backupAttesterSource,
  qdrantUpgradeControllerSource,
  apiBridgeReceiptHelperSource,
  apiBridgeConsumptionHelperSource,
  qdrantDockerfileSource,
  qdrantDockerignoreSource,
  qdrantAuditContractHelperSource,
  postgresDockerfileSource,
  postgresMigrateDockerfileSource,
  postgresDockerignoreSource,
  postgresSchemaSource,
  imageScanValidatorSource,
] = await Promise.all([
  readFile(hardeningScript, 'utf8'),
  readFile(rollingDeploymentScript, 'utf8'),
  readFile(backupAttester, 'utf8'),
  readFile(qdrantUpgradeController, 'utf8'),
  readFile(apiBridgeReceiptHelper, 'utf8'),
  readFile(apiBridgeConsumptionHelper, 'utf8'),
  readFile(qdrantDockerfile, 'utf8'),
  readFile(qdrantDockerignore, 'utf8'),
  readFile(qdrantAuditContractHelper, 'utf8'),
  readFile(postgresDockerfile, 'utf8'),
  readFile(postgresMigrateDockerfile, 'utf8'),
  readFile(postgresDockerignore, 'utf8'),
  readFile(postgresSchema, 'utf8'),
  readFile(imageScanValidator, 'utf8'),
]);

const imageScanValidatorSha256 = sha256(Buffer.from(imageScanValidatorSource, 'utf8'));
assert.ok(
  hardeningSource.includes(`= ${imageScanValidatorSha256} ]`),
  'stateful hardener must freeze the exact image-scan validator SHA-256',
);

const productionPathContract = hardeningSource.slice(
  hardeningSource.indexOf('else\n    if [ "${DIVA_DOCKER_COMMAND+x}"'),
  hardeningSource.indexOf('    validate_trusted_system_directory()'),
);
assert.match(
  productionPathContract,
  /PIPELINE_ROOT=\$\(CDPATH= cd -- "\$ROOT_DIR\/\.\.\/diva-data-pipeline" && pwd -P\) \|\| \{/,
  'production must resolve the pipeline repository to its physical canonical path',
);
assert.doesNotMatch(
  productionPathContract,
  /PIPELINE_ROOT="\$ROOT_DIR\/\.\.\/diva-data-pipeline"/,
  'production must not pass a lexical parent-directory path to Git safe.directory',
);
assert.match(
  productionPathContract,
  /production pipeline repository path could not be canonicalized/,
  'production must fail closed when the canonical pipeline repository is unavailable',
);

const trustedGitContract = hardeningSource.slice(
  hardeningSource.indexOf('trusted_git()'),
  hardeningSource.indexOf('verify_tracked_runtime_source()'),
);
assert.match(trustedGitContract, /GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=\/dev\/null/);
assert.equal(
  trustedGitContract.split('/usr/bin/env -i').length - 1,
  4,
  'local test/production and remote test/production Git must start from an empty environment',
);
assert.match(
  trustedGitContract,
  /else[\s\S]*\/usr\/bin\/env -i[\s\S]*HOME=\/var\/empty PATH=\/usr\/bin:\/bin[\s\S]*\/usr\/bin\/git/,
  'production local/HTTPS Git must receive only fixed environment values and an absolute binary',
);
assert.equal(
  trustedGitContract.split('-c "safe.directory=$ROOT_DIR"').length - 1,
  4,
  'local and test/production remote Git must allow only the fixed player root',
);
assert.equal(
  trustedGitContract.split('-c "safe.directory=$PIPELINE_ROOT"').length - 1,
  4,
  'local and test/production remote Git must allow only the fixed pipeline root',
);
assert.doesNotMatch(
  trustedGitContract,
  /safe\.directory=["']?\*/,
  'trusted Git must never allow a wildcard safe.directory',
);
assert.match(hardeningSource, /PIPELINE_OFFICIAL_ORIGIN=git@github\.com:conei7\/diva-data-pipeline\.git/);
assert.match(hardeningSource, new RegExp(githubEd25519HostKey.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
assert.doesNotMatch(
  trustedGitContract,
  /SSH_AUTH_SOCK|SSH_AGENT_PID/,
  'empty-environment Git launches must not forward an ambient SSH agent',
);
assert.match(trustedGitContract, /-F \/dev\/null/);
assert.match(trustedGitContract, /IdentityAgent=none/);
assert.match(trustedGitContract, /GlobalKnownHostsFile=\/dev\/null/);
assert.match(trustedGitContract, /HostKeyAlgorithms=ssh-ed25519/);
assert.match(trustedGitContract, /run_bounded_command 30/);
assert.match(trustedGitContract, /\/usr\/bin\/setpriv[\s\S]*--reuid="\$PIPELINE_RUNTIME_UID"/);
assert.match(hardeningSource, /os\.fchown\(descriptor, expected_uid, expected_gid\)/);
assert.match(
  hardeningSource,
  /stat -c '%u:%g:%a:%h'[\s\S]*BACKEND_ENV_OWNER_UID:[^\n]*BACKEND_ENV_OWNER_GID:600:1/,
);

const unexpectedArgument = spawnSync(
  bashCommand,
  [shellPath(hardeningScript), '--dry-run'],
  {
    env: { ...process.env, DIVA_STATEFUL_TEST_MODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
  },
);
assert.equal(unexpectedArgument.status, 64, unexpectedArgument.stderr);
assert.equal(unexpectedArgument.stdout, '');
assert.match(unexpectedArgument.stderr, /^Usage: .*harden-sbc-stateful-services\.sh\r?\n$/);

const pipelineRuntimeContract = hardeningSource.slice(
  hardeningSource.indexOf('validate_pipeline_runtime_structure()'),
  hardeningSource.indexOf('validate_trivy_db_metadata()'),
);
assert.match(pipelineRuntimeContract, /acquire_pipeline_runtime_lock\(\)/);
assert.match(pipelineRuntimeContract, /release_pipeline_runtime_lock\(\)/);
assert.match(pipelineRuntimeContract, /--shared --timeout 900/);
assert.match(pipelineRuntimeContract, /python-link=/);
assert.match(hardeningSource, /\.ml-runtime-use\.lock/);
assert.match(hardeningSource, /\.diva-runtime-receipt\.json/);
assert.match(pipelineRuntimeContract, /--clear-groups --no-new-privs/);
assert.match(pipelineRuntimeContract, /--inh-caps=-all --ambient-caps=-all --bounding-set=-all/);
assert.match(pipelineRuntimeContract, /env -i[\s\S]*PYTHONNOUSERSITE=1[\s\S]*-I -B/);
assert.match(pipelineRuntimeContract, /write_pipeline_runtime_attestation\(\)/);
assert.doesNotMatch(
  hardeningSource,
  /run_qdrant_controller_supervised "\$PIPELINE_PYTHON"/,
  'root controller must not execute the pipeline venv',
);
assert.match(hardeningSource, /run_qdrant_controller_supervised "\$PYTHON_COMMAND" -I -B/);
assert.match(hardeningSource, /--runtime-attestation "\$PIPELINE_RUNTIME_ATTESTATION_FILE"/);
assert.doesNotMatch(qdrantUpgradeControllerSource, /qdrant_client/);

const backupAttestationContract = hardeningSource.slice(
  hardeningSource.indexOf('validate_backup_payload_attestation()'),
  hardeningSource.indexOf('validate_backup_source_ancestry()'),
);
const hardenerBridgeLifetime = hardeningSource.match(
  /^BRIDGE_BACKUP_MAX_ELAPSED_SECONDS=([0-9]+)$/mu,
);
const rollingBridgeLifetime = rollingDeploymentSource.match(
  /^BRIDGE_BACKUP_MAX_ELAPSED_SECONDS=([0-9]+)$/mu,
);
assert.ok(hardenerBridgeLifetime, 'stateful hardener must fix the bridge backup lifetime');
assert.ok(rollingBridgeLifetime, 'rolling deploy must fix the bridge backup lifetime');
assert.equal(
  hardenerBridgeLifetime[1],
  rollingBridgeLifetime[1],
  'rolling deploy and stateful hardener bridge backup lifetimes must not drift',
);
assert.equal(hardenerBridgeLifetime[1], '14400');
assert.doesNotMatch(
  hardeningSource,
  /BRIDGE_BACKUP_MAX_ELAPSED_SECONDS=\$\{DIVA_/,
  'the four-hour bridge lifetime must remain a fixed production bound',
);
assert.match(backupAttestationContract, /bridge_receipt_created_at="\$\{15\}"/);
assert.match(
  backupAttestationContract,
  /"\$bridge_receipt_created_at" "\$BRIDGE_BACKUP_MAX_ELAPSED_SECONDS"/,
);
assert.match(
  backupAttestationContract,
  /receipt_created_at\.astimezone\(dt\.timezone\.utc\)[\s\S]*verified_at\.astimezone\(dt\.timezone\.utc\)/,
);
assert.match(
  backupAttestationContract,
  /-300 <= attestation_offset < maximum_attestation_offset/,
);
assert.doesNotMatch(backupAttestationContract, /datetime\.now|dt\.datetime\.now/);
assert.match(
  backupAttestationContract,
  /--require-fresh --field createdAt/,
);
assert.match(
  backupAttestationContract,
  /\[ "\$after_sha" = "\$before_sha" \]/,
);
assert.match(
  hardeningSource,
  /verify_api_bridge_receipt[\s\S]*fresh API bridge receipt changed before the first Qdrant mutation/,
);

for (const [architecture, busyboxSha256, contractSha256] of [
  [
    'x86_64',
    'f3547b3d78d08a028a4833ddb83b77cf012838c078bfd2b76355f53d1d8bba62',
    'ecf630ad651e1e3b53d257b0d19e1aa2e2f28e543442218f4c3992b073425a61',
  ],
  [
    'aarch64',
    'dd10691d81c84f0182f5af5f1583d566ddc0b9d0d9fc46b41b99b83c398306dd',
    '7c9d227469c7c5ffe8e1b407619bc4f132bdd68ca8d254a2be28ee458bfcc3aa',
  ],
]) {
  const rendered = spawnSync(bashCommand, [
    shellPath(qdrantAuditContractHelper), architecture, busyboxSha256,
  ], { encoding: null, windowsHide: true });
  assert.equal(rendered.status, 0, `audit contract helper failed for ${architecture}`);
  assert.equal(sha256(rendered.stdout), contractSha256);
}
assert.match(qdrantDockerfileSource, /ln -snf \/bin\/busybox "\$audit\/bin\/sh"/);
assert.match(
  qdrantDockerfileSource,
  /\[ "\$\(readlink "\$audit\/bin\/sh"\)" = \/bin\/busybox \]/,
);
assert.match(qdrantDockerfileSource, /install_usrmerge_link \/lib usr\/lib/);
assert.match(qdrantDockerfileSource, /install_usrmerge_link \/lib64 usr\/lib64/);
assert.doesNotMatch(qdrantDockerfileSource, /record_package "\$source_target"/);
assert.match(
  qdrantDockerfileSource,
  /apt-get install --yes --no-install-recommends --only-upgrade[\s\S]*libssl3t64=3\.5\.7-1~deb13u2[\s\S]*openssl-provider-legacy=3\.5\.7-1~deb13u2/u,
);
assert.match(qdrantDockerfileSource, /resolved_interpreter/);
assert.match(
  qdrantDockerfileSource,
  /case "\$binary_package" in ''\|\*\[!a-z0-9\+\.\-\]\*\) exit 1/,
);
assert.match(
  qdrantDockerfileSource,
  /owner_field !~ \/\^\[a-z0-9\]\[a-z0-9\+\.\-\]\*\(\:\[a-z0-9\]\[a-z0-9-\]\*\)\?\(, /,
);
assert.match(qdrantDockerfileSource, /split\(owner_field, package_names, ", "\)/);
assert.match(
  qdrantDockerfileSource,
  /sub\(\/\:\[a-z0-9\]\[a-z0-9-\]\*\$\/, "", package_names\[package_index\]\)/,
);
assert.match(qdrantDockerfileSource, /package_names\[package_index\] in seen_packages/);
assert.match(qdrantDockerfileSource, /\[ "\$package_count" = "\$unique_package_count" \]/);
assert.match(qdrantDockerfileSource, /for binary_package in \$binary_packages; do/);

const ownerParserMatch = qdrantDockerfileSource.match(
  /\| awk -F ': ' -v expected_path="\$queried_path" ' \\\r?\n([\s\S]*?)'\); \\/,
);
assert.ok(ownerParserMatch, 'Qdrant dpkg owner parser was not found');
const ownerParserProgram = ownerParserMatch[1].replace(/ \\\r?\n/g, '\n');

function parseDpkgPathOwners(ownership, expectedPath = '/usr/lib') {
  return spawnSync(bashCommand, [
    '-c',
    'exec awk -F ": " -v expected_path="$1" "$2"',
    'qdrant-dpkg-owner-parser',
    expectedPath,
    ownerParserProgram,
  ], {
    input: ownership,
    encoding: 'utf8',
    windowsHide: true,
  });
}

for (const [ownership, expectedPackages] of [
  ['openssl: /usr/lib\n', ['openssl']],
  ['openssl, libunwind8: /usr/lib\n', ['openssl', 'libunwind8']],
  ['openssl:amd64, libunwind8:amd64: /usr/lib\n', ['openssl', 'libunwind8']],
]) {
  const parsed = parseDpkgPathOwners(ownership);
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(parsed.stdout.trim().split('\n'), expectedPackages);
}

for (const malformedOwnership of [
  'openssl: /usr/share/not-lib\n',
  'openssl,libunwind8: /usr/lib\n',
  'openssl, : /usr/lib\n',
  'openssl, openssl: /usr/lib\n',
  ', openssl: /usr/lib\n',
  'OpenSSL: /usr/lib\n',
]) {
  const parsed = parseDpkgPathOwners(malformedOwnership);
  assert.notEqual(parsed.status, 0, `accepted malformed ownership: ${malformedOwnership}`);
}
if (process.env.DIVA_STATEFUL_TEST_PARSER_ONLY === '1') {
  console.log('PASS Qdrant dpkg owner parser contract');
  process.exit(0);
}

const gateVerifyContract = hardeningSource.slice(
  hardeningSource.indexOf('verify_pipeline_writer_gate()'),
  hardeningSource.indexOf('gate_pipeline_writers()'),
);
const gateAcquireContract = hardeningSource.slice(
  hardeningSource.indexOf('gate_pipeline_writers()'),
  hardeningSource.indexOf('release_pipeline_writers()'),
);
const gateReleaseContract = hardeningSource.slice(
  hardeningSource.indexOf('release_pipeline_writers()'),
  hardeningSource.indexOf('qdrant_fingerprint()'),
);
for (const [label, contract, expectedActivityChecks] of [
  ['verify', gateVerifyContract, 1],
  ['acquire', gateAcquireContract, 2],
  ['release', gateReleaseContract, 2],
]) {
  assert.match(
    contract,
    /pg_has_role\([^)]*'diva_pipeline_runtime', 'MEMBER'/,
    `${label} gate SQL does not validate effective runtime-role membership`,
  );
  const activityChecks = [...contract.matchAll(/FROM pg_stat_activity AS activity/g)].length;
  assert.equal(
    activityChecks,
    expectedActivityChecks,
    `${label} gate SQL must retain every client-session check`,
  );
  assert.equal(
    [...contract.matchAll(/activity\.backend_type = 'client backend'/g)].length,
    activityChecks,
    `${label} gate SQL must exclude PostgreSQL auxiliary processes`,
  );
  assert.equal(
    [...contract.matchAll(
      /JOIN pg_roles AS parent_role ON parent_role\.oid = membership\.roleid/g,
    )].length,
    activityChecks,
    `${label} gate SQL must identify sessions by direct pipeline-role membership`,
  );
}
assert.match(gateAcquireContract, /count\(\*\) = \(\s*SELECT count\(\*\)[\s\S]*pg_has_role/);
assert.match(gateReleaseContract, /released_roles_ok/);
for (const contract of [gateAcquireContract, gateReleaseContract]) {
  assert.match(contract, /LOCK TABLE pg_catalog\.pg_auth_members IN SHARE MODE/);
  assert.match(contract, /LOCK TABLE pg_catalog\.pg_authid IN SHARE MODE/);
}

function shellPath(path) {
  const normalized = path.replaceAll('\\', '/');
  return process.platform === 'win32'
    ? normalized.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`)
    : normalized;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value) {
  const normalize = item => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item).sort().map(key => [key, normalize(item[key])]),
      );
    }
    return item;
  };
  return `${JSON.stringify(normalize(value))}\n`;
}

function canonicalDigest(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function canonicalFindingDigest(value) {
  const payload = canonicalJson(value);
  return sha256(Buffer.from(payload.slice(0, -1), 'utf8'));
}

const legacyFindingDigests = Object.freeze({
  qdrant: canonicalFindingDigest({
    Class: 'os-pkgs',
    Type: 'debian',
    Target: 'fixture',
    VulnerabilityID: 'CVE-OLD-QDRANT',
    PkgID: 'openssl@1',
    PkgName: 'openssl',
    PkgPath: '/usr/lib/libssl.so',
    InstalledVersion: '1',
    FixedVersion: '2',
    Severity: 'HIGH',
    Status: 'fixed',
  }),
  postgres: canonicalFindingDigest({
    Class: 'os-pkgs',
    Type: 'alpine',
    Target: 'fixture',
    VulnerabilityID: 'CVE-OLD-POSTGRES',
    PkgID: 'libcrypto@1',
    PkgName: 'libcrypto',
    PkgPath: '/lib/libcrypto.so',
    InstalledVersion: '1',
    FixedVersion: '2',
    Severity: 'CRITICAL',
    Status: 'fixed',
  }),
});

function runFixtureGit(directory, arguments_) {
  const result = spawnSync('git', arguments_, {
    cwd: directory,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `fixture git ${arguments_.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function initializeFixtureRepository(directory, message, origin) {
  runFixtureGit(directory, ['init', '--quiet']);
  runFixtureGit(directory, ['config', 'user.name', 'DIVA Contract Test']);
  runFixtureGit(directory, ['config', 'user.email', 'diva-contract@example.invalid']);
  runFixtureGit(directory, ['add', '--all']);
  runFixtureGit(directory, ['commit', '--quiet', '-m', message]);
  runFixtureGit(directory, ['branch', '-M', 'main']);
  const head = runFixtureGit(directory, ['rev-parse', 'HEAD']);
  runFixtureGit(directory, ['remote', 'add', 'origin', origin]);
  runFixtureGit(directory, ['update-ref', 'refs/remotes/origin/main', head]);
  return head;
}

async function createBridgeEvidence(fixtureProject, stateRoot, playerCommit, evidence) {
  const deploymentId = 'bridge-deployment-20260831';
  const deploymentDirectory = join(stateRoot, deploymentId);
  const sourceRoot = join(deploymentDirectory, 'source-root');
  const imageScanRoot = join(deploymentDirectory, 'image-scan');
  const entriesPath = join(deploymentDirectory, 'source-tree.entries');
  await Promise.all([
    mkdir(sourceRoot, { recursive: true, mode: 0o700 }),
    mkdir(imageScanRoot, { recursive: true, mode: 0o700 }),
  ]);
  const tree = spawnSync('git', ['ls-tree', '-rz', '--full-tree', playerCommit], {
    cwd: fixtureProject,
    encoding: null,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(tree.status, 0, `fixture ls-tree failed: ${tree.stderr?.toString('utf8')}`);
  await writeFile(entriesPath, tree.stdout);
  await chmod(entriesPath, 0o600);
  for (const entry of tree.stdout.subarray(0, -1).toString('utf8').split('\0')) {
    const [metadata, relativePath] = entry.split('\t');
    const [mode, kind] = metadata.split(' ');
    assert.equal(kind, 'blob');
    const destination = join(sourceRoot, ...relativePath.split('/'));
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, await readFile(join(fixtureProject, ...relativePath.split('/'))));
    await chmod(destination, mode === '100755' ? 0o755 : 0o644);
  }
  const tarResult = spawnSync(bashCommand, [
    '-c',
    'umask 077; exec /usr/bin/tar --sort=name --format=gnu --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$1" -cf - .',
    'bridge-source-digest',
    shellPath(sourceRoot),
  ], {
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(
    tarResult.status,
    0,
    `fixture deterministic tar failed: ${tarResult.stderr?.toString('utf8')}`,
  );
  const sourceSnapshotSha256 = sha256(tarResult.stdout);
  const sourceManifestSha256 = sha256(tree.stdout);
  const helperSha256 = sha256(await readFile(join(sourceRoot, 'scripts', 'wsl-dr-api-bridge-receipt.py')));
  const qdrantManifest = JSON.parse(await readFile(evidence.qdrant.manifestPath, 'utf8'));
  const publicationGeneration = qdrantManifest.publication.generation;
  const publicationProjection = {
    generation: publicationGeneration,
    aliases: Object.fromEntries(Object.entries(qdrantManifest.publication.aliases).sort()),
    collections: [
      'song_audio', ...Object.values(qdrantManifest.publication.aliases),
    ].sort(),
  };
  const publicationSha256 = sha256(Buffer.from(
    canonicalJson(publicationProjection).slice(0, -1),
    'utf8',
  ));
  const backupBindingSha256 = createHash('sha256').update([
    'schema=1',
    `qdrant_backup_run_id=${evidence.qdrant.runId}`,
    `qdrant_status_sha256=${evidence.qdrant.statusSha}`,
    `qdrant_manifest_sha256=${evidence.qdrant.manifestSha}`,
    `backup_attestation_sha256=${evidence.attestation.sha}`,
    `publication_sha256=${publicationSha256}`,
    '',
  ].join('\n')).digest('hex');
  const emptyMapSha = sha256(Buffer.from('{}\n', 'utf8'));
  const receiptPath = join(stateRoot, 'api-bridge-receipt.json');
  const wrapperPath = join(stateRoot, 'api-bridge-wrapper.json');
  const scanReceipts = {};
  for (const [service, imageId] of [
    ['api', `sha256:${'1'.repeat(64)}`],
    ['gateway', `sha256:${'3'.repeat(64)}`],
    ['web', `sha256:${'5'.repeat(64)}`],
  ]) {
    const payload = Buffer.from(`${JSON.stringify({ imageId, service, status: 'passed' })}\n`, 'utf8');
    await writeFile(join(imageScanRoot, `${service}.receipt.json`), payload, { mode: 0o600 });
    await chmod(join(imageScanRoot, `${service}.receipt.json`), 0o600);
    scanReceipts[service] = { imageId, sha256: sha256(payload) };
  }
  const seedSongId = 42;
  const readMatrix = {
    aliases: [
      { alias: 'song_hybrid_active', collection: 'song_hybrid_generation_42' },
      { alias: 'song_metadata_active', collection: 'song_metadata_generation_42' },
      { alias: 'songs_v2_active', collection: 'songs_v2_generation_42' },
    ],
    collectionInfo: [
      'song_audio', 'song_hybrid_active', 'song_metadata_active', 'songs_v2_active',
    ].map(collection => ({
      collection, indexedVectorsCount: 100, pointsCount: 120, segmentsCount: 2, status: 'Green',
    })),
    collections: [
      'song_audio', 'song_hybrid_generation_42', 'song_metadata_generation_42',
      'songs_v2_generation_42',
    ],
    operations: [
      ['named-audio', 'songs_v2_active', 'audio', 512],
      ['named-meta', 'songs_v2_active', 'meta', 384],
      ['hybrid-default', 'song_hybrid_active', 'default', 896],
      ['metadata-default', 'song_metadata_active', 'default', 384],
      ['audio-default', 'song_audio', 'default', 512],
    ].map(([operation, collection, vectorName, vectorDimensions]) => ({
      collection,
      hits: [{ score: 0.875, songId: 3100 }],
      operation,
      payloadKeys: ['artist', 'name'],
      queryPath: 'legacy-search-fallback',
      vectorDimensions,
      vectorName,
      withoutPayloadFieldCount: 0,
    })),
    schemaVersion: 1,
    seedSongId,
  };
  const endpoints = Object.fromEntries(
    ['audio', 'dig', 'metadata', 'multi', 'recommend', 'similar'].map(name => {
      const response = { items: [{ songId: 3100 }, { songId: 3101 }] };
      if (name === 'dig') response.totalCount = 2;
      const summary = {
        itemCount: 2,
        responseKeys: Object.keys(response).sort(),
        responseSha256: canonicalDigest(response),
        songIds: [3100, 3101],
      };
      if (name === 'dig') summary.totalCount = 2;
      return [name, summary];
    }),
  );
  const readMatrixSha256 = canonicalDigest(readMatrix);
  const endpointResponsesSha256 = canonicalDigest(endpoints);
  const semanticSha256 = canonicalDigest({
    endpoints, readMatrix, schemaVersion: 1, seedSongId,
  });
  const compatibilityMatrix = {
    endpoints,
    endpointResponsesSha256,
    readMatrix,
    readMatrixSha256,
    requiredQueryPath: 'legacy-search-fallback',
    schemaVersion: 1,
    seedSelection: {
      collectionNames: [
        'song_audio', 'song_hybrid_active', 'song_metadata_active', 'songs_v2_active',
      ],
      scanLimit: 64,
      sha256: '5'.repeat(64),
    },
    seedSongId,
    semanticSha256,
    slots: Object.fromEntries(['api_a', 'api_b'].map(service => [service, {
      endpointResponsesSha256, readMatrixSha256, semanticSha256,
    }])),
  };
  const createdAt = evidence.bridgeCreatedAt
    ? new Date(evidence.bridgeCreatedAt)
    : new Date();
  const validUntil = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
  const receipt = {
    schemaVersion: 3,
    hostScope: 'sbc-primary',
    mode: 'qdrant-legacy-api-bridge',
    deploymentId,
    createdAt: createdAt.toISOString().replace('.000Z', 'Z'),
    validUntil: validUntil.toISOString().replace('.000Z', 'Z'),
    validOnlyWhileOldQExact: true,
    playerCommit,
    helperSha256,
    sourceManifestSha256,
    sourceSnapshotSha256,
    clientPackageVersion: '1.19.0',
    oldQdrant: {
      containerName: 'vocadb_qdrant',
      containerId: ids.oldQdrant,
      imageId: `sha256:${'7'.repeat(64)}`,
      imageReference: 'qdrant/qdrant:v1.9.4',
      imageRepoDigest: `sha256:${'6'.repeat(64)}`,
      imageIndexDigest: 'sha256:8f9011596cb03595a340cf2388083e36e38421eb49cb3fdc0ab7666cf14a90c1',
      version: '1.9.4',
      backup: `off-host-evidence-sha256-${backupBindingSha256}`,
      publicationGeneration,
      volume: {
        createdAt: '2026-08-30T00:00:00Z',
        driver: 'local',
        labelsSha256: emptyMapSha,
        mountpoint: '/var/lib/docker/volumes/backend_qdrant_data/_data',
        mountpointDeviceInode: '2049:42',
        name: 'backend_qdrant_data',
        optionsSha256: emptyMapSha,
        scope: 'local',
      },
    },
    apiSlots: {
      api_a: {
        containerName: 'vocadb_api_a', containerId: '3'.repeat(64),
        imageId: `sha256:${'1'.repeat(64)}`, configHash: '4'.repeat(64),
        sourceCommit: playerCommit, clientPackageVersion: '1.19.0',
      },
      api_b: {
        containerName: 'vocadb_api_b', containerId: '5'.repeat(64),
        imageId: `sha256:${'1'.repeat(64)}`, configHash: '6'.repeat(64),
        sourceCommit: playerCommit, clientPackageVersion: '1.19.0',
      },
    },
    previousApiRollback: {
      path: '/var/lib/diva-player-deploy/api-bridge-previous-api-rollback.receipt',
      provenance: 'legacy-pre-contract-unattested',
      sha256: '7'.repeat(64),
    },
    smoke: {
      seedSongId,
      retrieveVectorDimensions: { audio: 128, meta: 64 },
      api_a: { path: 'retrieve-query-legacy-search-passed', resultCount: 5 },
      api_b: { path: 'retrieve-query-legacy-search-passed', resultCount: 5 },
    },
    compatibilityMatrix,
    compatibilityMatrixSha256: canonicalDigest(compatibilityMatrix),
  };
  receipt.payloadSha256 = canonicalDigest(receipt);
  await writeFile(receiptPath, canonicalJson(receipt), 'utf8');
  await chmod(receiptPath, 0o600);
  await writeFile(wrapperPath, `${JSON.stringify({
    previousApiRollback: {
      apiSlots: {},
      provenance: 'legacy-pre-contract-unattested',
      scanReceipts,
      schemaVersion: 2,
      statelessServices: {
        api_gateway: {
          canonicalName: 'vocadb_api_gateway',
          configHash: '7'.repeat(64),
          containerId: 'c0'.repeat(32),
          imageId: `sha256:${'3'.repeat(64)}`,
          imageReference: 'diva-player-api-gateway:local',
        },
        web: {
          canonicalName: 'vocadb_web',
          configHash: '8'.repeat(64),
          containerId: 'd0'.repeat(32),
          imageId: `sha256:${'5'.repeat(64)}`,
          imageReference: 'diva-player-web:local',
        },
      },
    },
    receipt,
  })}\n`, 'utf8');
  await chmod(wrapperPath, 0o600);
  return { imageScanRoot, receiptPath, wrapperPath };
}

function currentWindowsSid() {
  if (windowsSid) return windowsSid;
  const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(identity.status, 0, `whoami failed: ${identity.stderr}`);
  windowsSid = identity.stdout.match(/S-1-[0-9-]+/u)?.[0];
  assert.ok(windowsSid, `current Windows SID is unavailable: ${identity.stdout}`);
  return windowsSid;
}

function assertFixtureContainment(path) {
  assert.ok(fixtureBase, 'fixture base is not initialized');
  const child = relative(fixtureBase, resolve(path));
  assert.ok(
    child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)),
    `refusing to modify a path outside the fresh fixture base: ${path}`,
  );
}

function assertWindowsTreeOwnedAndNotReparse(path) {
  assertFixtureContainment(path);
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$root = Get-Item -LiteralPath $env:DIVA_TEST_ACL_PATH -Force
$expectedSid = $env:DIVA_TEST_ACL_SID
$items = @($root) + @(Get-ChildItem -LiteralPath $root.FullName -Recurse -Force)
foreach ($item in $items) {
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 12 }
  $security = if ($item.PSIsContainer) {
    [System.IO.Directory]::GetAccessControl($item.FullName)
  } else {
    [System.IO.File]::GetAccessControl($item.FullName)
  }
  $ownerSid = $security.GetOwner(
    [System.Security.Principal.SecurityIdentifier]
  ).Value
  if ($ownerSid -ne $expectedSid) { exit 13 }
}
`;
  const checked = spawnSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command', script,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DIVA_TEST_ACL_PATH: path,
      DIVA_TEST_ACL_SID: currentWindowsSid(),
    },
    windowsHide: true,
  });
  assert.equal(
    checked.status,
    0,
    `fixture tree is not a current-user-owned non-reparse tree (${checked.status}): `
      + `${path}\n${checked.stdout}\n${checked.stderr}`,
  );
}

function runWindowsAclScript(script, variables, label) {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const fullScript = String.raw`
$ErrorActionPreference = 'Stop'
` + script;
  const result = spawnSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    fullScript,
  ], {
    encoding: 'utf8',
    env: { ...process.env, ...variables },
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `${label} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function windowsAclSddl(path) {
  return runWindowsAclScript(
    String.raw`[System.IO.Directory]::GetAccessControl(
  $env:DIVA_TEST_ACL_PATH
).GetSecurityDescriptorSddlForm(
  [System.Security.AccessControl.AccessControlSections]::Access
)`,
    { DIVA_TEST_ACL_PATH: path },
    'reading the fixture ACL',
  );
}

function restoreWindowsAclSddl(path, sddl) {
  runWindowsAclScript(String.raw`
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetSecurityDescriptorSddlForm(
  $env:DIVA_TEST_ACL_SDDL,
  [System.Security.AccessControl.AccessControlSections]::Access
)
[System.IO.Directory]::SetAccessControl($env:DIVA_TEST_ACL_PATH, $acl)
`, {
    DIVA_TEST_ACL_PATH: path,
    DIVA_TEST_ACL_SDDL: sddl,
  }, 'restoring the fixture ACL');
}

function addWindowsUnknownSidRule(path, rightsMask) {
  runWindowsAclScript(String.raw`
$acl = [System.IO.Directory]::GetAccessControl($env:DIVA_TEST_ACL_PATH)
$sid = [System.Security.Principal.SecurityIdentifier]::new(
  'S-1-5-21-4242424242-4242424242-4242424242-4242'
)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights][int]$env:DIVA_TEST_ACL_RIGHTS,
  [System.Security.AccessControl.InheritanceFlags]::None,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($env:DIVA_TEST_ACL_PATH, $acl)
`, {
    DIVA_TEST_ACL_PATH: path,
    DIVA_TEST_ACL_RIGHTS: String(rightsMask),
  }, 'adding the isolated fixture ACL rule');
}

async function hardenEvidenceTree(directory) {
  assertFixtureContainment(directory);
  if (process.platform === 'win32') {
    assertWindowsTreeOwnedAndNotReparse(directory);
    const sid = currentWindowsSid();
    const commands = [
      [directory, '/grant:r', `*${sid}:F`, '/T', '/Q'],
      [directory, '/inheritance:r', '/T', '/Q'],
      [directory, '/grant:r', `*${sid}:(OI)(CI)F`, '/Q'],
    ];
    for (const arguments_ of commands) {
      const secured = spawnSync('icacls.exe', arguments_, {
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(
        secured.status,
        0,
        `fixture evidence ACL hardening failed:\n${secured.stdout}\n${secured.stderr}`,
      );
    }
    assertWindowsTreeOwnedAndNotReparse(directory);
    return;
  }
  const rootStatus = await lstat(directory);
  assert.ok(rootStatus.isDirectory() && !rootStatus.isSymbolicLink(), 'unsafe fixture directory');
  const entries = await readdir(directory, { withFileTypes: true });
  await chmod(directory, 0o700);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const status = await lstat(path);
    assert.equal(status.isSymbolicLink(), false, `fixture contains a symbolic link: ${path}`);
    if (entry.isDirectory()) await hardenEvidenceTree(path);
    else await chmod(path, 0o600);
  }
}

async function prepareFixtureBase() {
  if (!fixtureBasePromise) {
    fixtureBasePromise = (async () => {
      const parentStatus = await lstat(fixtureParent);
      assert.ok(
        parentStatus.isDirectory() && !parentStatus.isSymbolicLink(),
        `fixture parent is not a plain directory: ${fixtureParent}`,
      );
      fixtureParentRealPath = resolve(await realpath(fixtureParent));
      assert.equal(
        fixtureParentRealPath.toLocaleLowerCase('en-US'),
        resolve(fixtureParent).toLocaleLowerCase('en-US'),
        `fixture parent resolves through a link or junction: ${fixtureParent}`,
      );
      fixtureBase = await mkdtemp(join(fixtureParent, '.diva-player-contract-tests-'));
      const baseStatus = await lstat(fixtureBase, { bigint: true });
      assert.ok(
        baseStatus.isDirectory() && !baseStatus.isSymbolicLink(),
        `fresh fixture base is not a plain directory: ${fixtureBase}`,
      );
      fixtureBaseIdentity = `${baseStatus.dev}:${baseStatus.ino}`;
      if (process.platform === 'win32') {
        fixtureBaseOriginalAclSddl = windowsAclSddl(fixtureBase);
        assertWindowsTreeOwnedAndNotReparse(fixtureBase);
        const sid = currentWindowsSid();
        for (const arguments_ of [
          [fixtureBase, '/grant:r', `*${sid}:F`, '/Q'],
          [fixtureBase, '/inheritance:r', '/Q'],
          [fixtureBase, '/grant:r', `*${sid}:(OI)(CI)F`, '/Q'],
        ]) {
          const secured = spawnSync('icacls.exe', arguments_, {
            encoding: 'utf8',
            windowsHide: true,
          });
          assert.equal(
            secured.status,
            0,
            `fixture root ACL hardening failed:\n${secured.stdout}\n${secured.stderr}`,
          );
        }
        assertWindowsTreeOwnedAndNotReparse(fixtureBase);
      } else {
        await chmod(fixtureBase, 0o700);
      }
    })();
  }
  await fixtureBasePromise;
}

async function hardenVerifierPath(path) {
  if (process.platform === 'win32') {
    await hardenEvidenceTree(dirname(path));
    return;
  }
  await chmod(dirname(path), 0o755);
  await chmod(path, 0o755);
}

const fakeGit = String.raw`#!/bin/sh
set -eu
root=__D__{FAKE_STATE:?}
player_root=$(cat "$root/trusted-git-player-root")
pipeline_root=$(cat "$root/trusted-git-pipeline-root")
[ "__D__{GIT_CONFIG_NOSYSTEM:-}" = 1 ] || exit 91
[ "__D__{GIT_CONFIG_GLOBAL:-}" = /dev/null ] || exit 92
[ "__D__{GIT_CONFIG_COUNT+x}" != x ] || exit 93
[ "__D__{GIT_CONFIG_PARAMETERS+x}" != x ] || exit 94
[ "__D__{GIT_CONFIG+x}" != x ] || exit 95
[ "__D__{GIT_ASKPASS+x}" != x ] || exit 96
[ "__D__{GIT_TERMINAL_PROMPT:-}" = 0 ] || exit 97
[ "__D__{GIT_SSL_NO_VERIFY+x}" != x ] || exit 120
[ "__D__{GIT_SSL_CAINFO+x}" != x ] || exit 121
[ "__D__{GIT_SSL_CAPATH+x}" != x ] || exit 122
[ "__D__{GIT_PROXY_COMMAND+x}" != x ] || exit 123
[ "__D__{HTTPS_PROXY+x}" != x ] || exit 124
[ "__D__{https_proxy+x}" != x ] || exit 125
[ "__D__{HTTP_PROXY+x}" != x ] || exit 126
[ "__D__{http_proxy+x}" != x ] || exit 127
[ "__D__{ALL_PROXY+x}" != x ] || exit 128
[ "__D__{all_proxy+x}" != x ] || exit 129
[ "__D__{NO_PROXY+x}" != x ] || exit 130
[ "__D__{no_proxy+x}" != x ] || exit 131
player_count=0
pipeline_count=0
previous=""
ls_remote=false
remote_url=""
for argument in "$@"; do
  if [ "$previous" = -c ]; then
    case "$argument" in
      "safe.directory=$player_root") player_count=__D__((player_count + 1)) ;;
      "safe.directory=$pipeline_root") pipeline_count=__D__((pipeline_count + 1)) ;;
      safe.directory=*) exit 98 ;;
    esac
  fi
  if [ "$ls_remote" = true ] && [ -z "$remote_url" ]; then
    case "$argument" in ls-remote|--exit-code) ;; *) remote_url="$argument" ;; esac
  fi
  [ "$argument" != ls-remote ] || ls_remote=true
  previous="$argument"
done
[ "$player_count" -eq 1 ] || exit 99
[ "$pipeline_count" -eq 1 ] || exit 100
printf '%s\n' "$*" >> "$root/trusted-git.log"
if [ "$ls_remote" = true ]; then
  case "$remote_url" in
    https://github.com/conei7/diva-player.git)
      live_head=$(cat "$root/trusted-git-player-head")
      ;;
    git@github.com:conei7/diva-data-pipeline.git)
      [ "__D__{SSH_AUTH_SOCK+x}" != x ] || exit 103
      [ "__D__{SSH_AGENT_PID+x}" != x ] || exit 104
      [ "__D__{SSH_ASKPASS+x}" != x ] || exit 105
      [ "__D__{GIT_SSH_VARIANT:-}" = ssh ] || exit 106
      [ "__D__{HOME:-}" = "__D__{FAKE_PIPELINE_GITHUB_HOME:?}" ] || exit 107
      ssh_command=__D__{GIT_SSH_COMMAND:?}
      case "$ssh_command" in *'/usr/bin/ssh -F /dev/null'*) ;; *) exit 108 ;; esac
      case "$ssh_command" in *'-o HostName=github.com -o User=git -o Port=22'*) ;; *) exit 109 ;; esac
      case "$ssh_command" in *'-o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none'*) ;; *) exit 110 ;; esac
      case "$ssh_command" in *"-o IdentityFile=__D__{FAKE_PIPELINE_GITHUB_IDENTITY:?}"*) ;; *) exit 111 ;; esac
      case "$ssh_command" in *"-o UserKnownHostsFile=__D__{FAKE_GITHUB_HOST_KEY_FILE:?}"*) ;; *) exit 112 ;; esac
      case "$ssh_command" in *'-o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519'*) ;; *) exit 113 ;; esac
      case "$ssh_command" in *'-o ProxyCommand=none -o ProxyJump=none -o PermitLocalCommand=no'*) ;; *) exit 114 ;; esac
      [ "$(cat "__D__{FAKE_GITHUB_HOST_KEY_FILE}")" = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' ] || exit 115
      [ "$(/usr/bin/stat -c '%a:%h' "__D__{FAKE_PIPELINE_GITHUB_IDENTITY}")" = 600:1 ] || exit 116
      printf '%s\n' 'config=isolated agent=none host-key=run-specific identity=dedicated owner-boundary=setpriv' > "$root/pipeline-remote-boundary.log"
      case "__D__{FAKE_SCENARIO:-}" in
        github-host-key-drift)
          chmod 600 "__D__{FAKE_GITHUB_HOST_KEY_FILE}"
          printf '%s\n' '# drift' >> "__D__{FAKE_GITHUB_HOST_KEY_FILE}"
          ;;
        github-identity-drift)
          printf '%s\n' '# drift' >> "__D__{FAKE_PIPELINE_GITHUB_IDENTITY}"
          ;;
      esac
      live_head=$(cat "$root/trusted-git-pipeline-head")
      if [ "__D__{FAKE_SCENARIO:-}" = forged-origin-main ]; then
        live_head=0000000000000000000000000000000000000000
      fi
      ;;
    *) exit 101 ;;
  esac
  printf '%s\trefs/heads/main\n' "$live_head"
  exit 0
fi
[ "__D__{SSH_AUTH_SOCK+x}" != x ] || exit 117
[ "__D__{SSH_AGENT_PID+x}" != x ] || exit 118
[ "__D__{GIT_SSH_COMMAND+x}" != x ] || exit 119
for real_git in /mingw64/bin/git.exe /mingw64/bin/git /usr/bin/git; do
  if [ -x "$real_git" ]; then exec "$real_git" "$@"; fi
done
exit 102
`.replaceAll('__D__', '$');

const fakeDocker = String.raw`#!/bin/sh
set -eu

root=__D__{FAKE_STATE:?}
containers="$root/containers"
scenario=__D__{FAKE_SCENARIO:-success}
printf '%s\n' "$*" >> "$root/docker.log"

old_q=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
old_p=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
new_q=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
new_p=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
promoted_q=1111111111111111111111111111111111111111111111111111111111111111
promoted_p=2222222222222222222222222222222222222222222222222222222222222222
audit=7777777777777777777777777777777777777777777777777777777777777777
owner_audit=6666666666666666666666666666666666666666666666666666666666666666
helper=9999999999999999999999999999999999999999999999999999999999999999
q_image=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
q_audit_image=sha256:abababababababababababababababababababababababababababababababab
audit_base_image=sha256:0000000000000000000000000000000000000000000000000000000000000000
p_image=sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
m_image=sha256:9999999999999999999999999999999999999999999999999999999999999999

read_value() {
  if [ -f "$1" ]; then cat "$1"; else printf '%s\n' "$2"; fi
}

write_value() {
  printf '%s\n' "$2" > "$1"
}

resolve_container() {
  requested="$1"
  if [ -f "$containers/$requested.id" ]; then
    printf '%s\n' "$requested"
    return 0
  fi
  for id_file in "$containers"/*.id; do
    [ -f "$id_file" ] || continue
    if [ "$(cat "$id_file")" = "$requested" ]; then
      resolved=__D__{id_file##*/}
      printf '%s\n' "__D__{resolved%.id}"
      return 0
    fi
  done
  return 1
}

move_container() {
  source="$1"
  destination="$2"
  found=false
  for file in "$containers/$source".*; do
    [ -f "$file" ] || continue
    found=true
    suffix=__D__{file#"$containers/$source"}
    mv "$file" "$containers/$destination$suffix"
  done
  [ "$found" = true ]
}

remove_container() {
  target="$1"
  for file in "$containers/$target".*; do
    [ -f "$file" ] || continue
    rm -f "$file"
  done
}

create_container() {
  name="$1"
  id="$2"
  image="$3"
  write_value "$containers/$name.id" "$id"
  write_value "$containers/$name.image" "$image"
  write_value "$containers/$name.running" true
  write_value "$containers/$name.restart" no
  if [ "$#" -ge 8 ]; then
    write_value "$containers/$name.project" "$4"
    write_value "$containers/$name.service" "$5"
    write_value "$containers/$name.volume" "$6"
    write_value "$containers/$name.destination" "$7"
    write_value "$containers/$name.network" "$8"
    write_value "$containers/$name.aliases" "$5"
    [ "$4" != backend ] || write_value "$containers/$name.restart" unless-stopped
    case "$5" in qdrant) write_value "$containers/$name.user" 1000:1000 ;; postgres) write_value "$containers/$name.user" 999:999 ;; esac
  fi
}

if [ "$1" = container ] && [ "__D__{2:-}" = ls ]; then
  target=""
  project=""
  ancestor=""
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --filter)
        case "$2" in
          name=^/*)
            target=__D__{2#name=^/}
            target=__D__{target%\$}
            ;;
          label=com.docker.compose.project=*)
            project=__D__{2#label=com.docker.compose.project=}
            ;;
          ancestor=*) ancestor=__D__{2#ancestor=} ;;
        esac
        shift 2
        ;;
      *) shift ;;
    esac
  done
  if [ -n "$target" ] && [ -f "$containers/$target.id" ]; then
    cat "$containers/$target.id"
  elif [ -n "$project" ]; then
    for project_file in "$containers"/*.project; do
      [ -f "$project_file" ] || continue
      [ "$(cat "$project_file")" = "$project" ] || continue
      base=__D__{project_file%.project}
      cat "$base.id"
    done
  elif [ -n "$ancestor" ]; then
    for image_file in "$containers"/*.image; do
      [ -f "$image_file" ] || continue
      [ "$(cat "$image_file")" = "$ancestor" ] || continue
      base=__D__{image_file%.image}
      cat "$base.id"
    done
  fi
  exit 0
fi

if [ "$1" = image ]; then
  operation="$2"
  shift 2
  case "$operation" in
    ls)
      reference=""
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --filter)
            case "$2" in reference=*) reference=__D__{2#reference=} ;; esac
            shift 2
            ;;
          *) shift ;;
        esac
      done
      if [ "$reference" = diva-player-qdrant:v1.19.0-hardened-r1 ] \
          && [ -f "$root/stable-image-id" ]; then
        cat "$root/stable-image-id"
      elif [ "$reference" = diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1 ] \
          && [ -f "$root/stable-postgres-image-id" ]; then
        cat "$root/stable-postgres-image-id"
      elif [ "$reference" = diva-player-postgres-migrate:16.15-hardened-r1 ] \
          && [ -f "$root/stable-postgres-migrate-image-id" ]; then
        cat "$root/stable-postgres-migrate-image-id"
      elif [ "__D__{reference#diva-player-qdrant:rollback-}" != "$reference" ] \
          && [ -f "$root/rollback-image-id" ]; then
        cat "$root/rollback-image-id"
      elif [ "__D__{reference#diva-player-postgres:rollback-}" != "$reference" ] \
          && [ -f "$root/rollback-postgres-image-id" ]; then
        cat "$root/rollback-postgres-image-id"
      fi
      exit 0
      ;;
    inspect)
      format=""
      reference=""
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --format) format="$2"; shift 2 ;;
          *) reference="$1"; shift ;;
        esac
      done
      case "$reference" in
        diva-player-qdrant:v1.19.0-hardened-r1)
          [ -f "$root/stable-image-id" ] || exit 1
          image=$(cat "$root/stable-image-id")
          ;;
        diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1)
          [ -f "$root/stable-postgres-image-id" ] || exit 1
          image=$(cat "$root/stable-postgres-image-id")
          ;;
        diva-player-postgres-migrate:16.15-hardened-r1)
          [ -f "$root/stable-postgres-migrate-image-id" ] || exit 1
          image=$(cat "$root/stable-postgres-migrate-image-id")
          ;;
        diva-player-qdrant:rollback-*)
          [ -f "$root/rollback-image-id" ] || exit 1
          image=$(cat "$root/rollback-image-id")
          ;;
        diva-player-postgres:rollback-*)
          [ -f "$root/rollback-postgres-image-id" ] || exit 1
          image=$(cat "$root/rollback-postgres-image-id")
          ;;
        alpine:3.23.3@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659|"$audit_base_image")
          image="$audit_base_image"
          ;;
        diva-player-qdrant:candidate-*)
          [ -f "$root/qdrant-candidate-built" ] || exit 1
          image="$q_image"
          ;;
        diva-player-qdrant-audit:candidate-*)
          [ -f "$root/qdrant-audit-built" ] || exit 1
          image="$q_audit_image"
          ;;
        diva-player-postgres:candidate-*)
          [ -f "$root/postgres-candidate-built" ] || exit 1
          image="$p_image"
          ;;
        diva-player-postgres-migrate:candidate-*)
          [ -f "$root/postgres-migrate-candidate-built" ] || exit 1
          image="$m_image"
          ;;
        sha256:*) image="$reference" ;;
        *) exit 1 ;;
      esac
      case "$format" in
        *'.Id'*) printf '%s\n' "$image" ;;
        *RepoDigests*)
          if [ "$image" = "$audit_base_image" ]; then
            printf '%s\n' '["alpine@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659"]'
          else
            printf '%s\n' '["qdrant/qdrant@sha256:6666666666666666666666666666666666666666666666666666666666666666"]'
          fi
          ;;
        *Architecture*) printf '%s\n' amd64 ;;
        *'.Os'*) printf '%s\n' linux ;;
        *Config.User*)
          case "$image" in
            "$q_audit_image"|"$m_image") printf '%s\n' 65534:65534 ;;
            "$p_image") printf '\n' ;;
            *) printf '%s\n' 1000:1000 ;;
          esac
          ;;
        *'com.diva.postgres-migrate.base-digest'*) printf '%s\n' sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659 ;;
        *'com.diva.postgres.base-digest'*) printf '%s\n' sha256:421b84e07a72bb8f3715f20501a1fdbe1219aad1fa4af7786a49d9a3f2480296 ;;
        *'com.diva.postgres-migrate.pg-major'*) printf '%s\n' 16 ;;
        *'com.diva.postgres.pg-major'*) printf '%s\n' 16 ;;
        *'com.diva.postgres-migrate.pg-version'*) printf '%s\n' 16.15 ;;
        *'com.diva.postgres.pg-version'*) printf '%s\n' 16.15 ;;
        *'com.diva.postgres.pgvector-version'*) printf '%s\n' 0.8.6 ;;
        *'com.diva.postgres.pgvector-commit'*) printf '%s\n' 8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c ;;
        *'com.diva.postgres-migrate.dockerfile-sha256'*) sha256sum "__D__{FAKE_POSTGRES_MIGRATE_DOCKERFILE:?}" | awk '{print __D__1}' ;;
        *'com.diva.postgres.dockerfile-sha256'*) sha256sum "__D__{FAKE_POSTGRES_DOCKERFILE:?}" | awk '{print __D__1}' ;;
        *'com.diva.postgres.schema-sha256'*) sha256sum "__D__{FAKE_POSTGRES_SCHEMA:?}" | awk '{print __D__1}' ;;
        *'com.diva.postgres.source-bundle-sha256'*)
          pg_df=$(sha256sum "__D__{FAKE_POSTGRES_DOCKERFILE:?}" | awk '{print __D__1}')
          pg_schema=$(sha256sum "__D__{FAKE_POSTGRES_SCHEMA:?}" | awk '{print __D__1}')
          printf '%s\n' \
            "dockerfile.sha256=$pg_df" \
            'pgvector.archive.sha256=d076a3098010905fd60256649327809651f6288327db6413f0938305f62ea299' \
            'pgvector.commit=8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c' \
            "schema.sha256=$pg_schema" | sha256sum | awk '{print __D__1}'
          ;;
        *'com.diva.postgres-migrate.build-timestamp'*) cat "$root/postgres-build-timestamp" ;;
        *'com.diva.postgres.build-timestamp'*) cat "$root/postgres-build-timestamp" ;;
        *base-digest*)
          case "$image" in "$q_audit_image") printf '%s\n' sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659 ;; *) printf '%s\n' sha256:a0e04fe623cb064502cd869cefc1dc7ce359d8edd481063b5bd351c0a0a2c91e ;; esac
          ;;
        *base-reference*)
          case "$image" in "$q_audit_image") printf '%s\n' alpine:3.23.3@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659 ;; *) printf '%s\n' qdrant/qdrant:v1.19.0-unprivileged@sha256:a0e04fe623cb064502cd869cefc1dc7ce359d8edd481063b5bd351c0a0a2c91e ;; esac
          ;;
        *audit-contract-sha256*) printf '%s\n' ecf630ad651e1e3b53d257b0d19e1aa2e2f28e543442218f4c3992b073425a61 ;;
        *audit-contract-helper-sha256*) printf '%s\n' 05da48154d8001f2f97d707b98f4c5870c66a0909ad204adc3c6a34f7de4b6d8 ;;
        *alpine-inventory-sha256*) printf '%s\n' 3f18c4f5c16154eeba3ffd4970bf886c1699a3b901a3ddcf7948f99a8d2b8c53 ;;
        *busybox-version*) printf '%s\n' 1.37.0-r30 ;;
        *busybox-binary-sha256*) printf '%s\n' f3547b3d78d08a028a4833ddb83b77cf012838c078bfd2b76355f53d1d8bba62 ;;
        *audit-architecture*) printf '%s\n' x86_64 ;;
        *audit-contract*) printf '%s\n' offline-storage-audit-v3-alpine ;;
        *'com.diva.postgres-migrate.runtime-contract'*) printf '%s\n' rootless-readonly-psql-client-v1 ;;
        *'com.diva.postgres.runtime-contract'*) printf '%s\n' alpine-root-init-su-exec-uid999-v1 ;;
        *runtime-contract*) printf '%s\n' rootless-readonly-scratch-v3 ;;
        *dockerfile-sha256*) sha256sum "__D__{FAKE_QDRANT_DOCKERFILE:?}" | awk '{print __D__1}' ;;
        *Config.Entrypoint*)
          case "$image" in
            "$q_audit_image") printf '%s\n' '["/bin/sh"]' ;;
            "$p_image") printf '%s\n' '["docker-entrypoint.sh"]' ;;
            "$m_image") printf '%s\n' '["psql"]' ;;
            *) printf '%s\n' '["/qdrant/qdrant"]' ;;
          esac
          ;;
        *Config.Cmd*)
          case "$image" in
            "$q_audit_image"|"$m_image") printf '%s\n' null ;;
            "$p_image") printf '%s\n' '["postgres"]' ;;
            *) printf '%s\n' '["--config-path","/qdrant/config/production.yaml"]' ;;
          esac
          ;;
        *Config.Env*) printf '%s\n' '["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","QDRANT__STORAGE__SNAPSHOTS_PATH=/qdrant/storage/snapshots","QDRANT__TELEMETRY_DISABLED=true"]' ;;
        *Config.Volumes*|*Config.Shell*) printf '%s\n' null ;;
        *Config.WorkingDir*) printf '%s\n' /qdrant ;;
        *) exit 1 ;;
      esac
      exit 0
      ;;
    tag)
      source="$1"
      destination="$2"
      case "$source" in diva-player-qdrant:candidate-*) source="$q_image" ;; esac
      case "$source" in diva-player-postgres:candidate-*) source="$p_image" ;; esac
      case "$source" in diva-player-postgres-migrate:candidate-*) source="$m_image" ;; esac
      case "$source" in sha256:*) ;; *) exit 1 ;; esac
      case "$destination" in
        diva-player-qdrant:v1.19.0-hardened-r1)
          write_value "$root/stable-image-id" "$source"
          ;;
        diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1)
          write_value "$root/stable-postgres-image-id" "$source"
          ;;
        diva-player-postgres-migrate:16.15-hardened-r1)
          write_value "$root/stable-postgres-migrate-image-id" "$source"
          ;;
        diva-player-qdrant:rollback-*)
          write_value "$root/rollback-image-id" "$source"
          ;;
        diva-player-postgres:rollback-*)
          write_value "$root/rollback-postgres-image-id" "$source"
          ;;
      esac
      exit 0
      ;;
    rm)
      case "__D__{1:-}" in
        diva-player-qdrant:v1.19.0-hardened-r1) rm -f "$root/stable-image-id" ;;
        diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1) rm -f "$root/stable-postgres-image-id" ;;
        diva-player-postgres-migrate:16.15-hardened-r1) rm -f "$root/stable-postgres-migrate-image-id" ;;
        *) exit 1 ;;
      esac
      exit 0
      ;;
    *) exit 1 ;;
  esac
fi

if [ "$1" = inspect ]; then
  shift
  format=""
  if [ "__D__{1:-}" = --format ]; then
    format="$2"
    shift 2
  fi
  requested="$1"
  name=$(resolve_container "$requested") || exit 1
  id=$(read_value "$containers/$name.id" '')
  image=$(read_value "$containers/$name.image" '')
  running=$(read_value "$containers/$name.running" false)
  case "$format" in
    *RestartCount*)
      sequence=0
      if [ -f "$root/daemon-unstable" ] && [ "$id" = "$new_q" ]; then
        sequence=$(read_value "$root/runtime-sequence" 0)
        sequence=$((sequence + 1))
        write_value "$root/runtime-sequence" "$sequence"
      fi
      status=exited
      [ "$running" = true ] && status=running
      printf '%s|%s|/%s|%s|%s|false|sequence-%s|finished|0|{}|[]\n' \
        "$id" "$image" "$name" "$status" "$running" "$sequence"
      ;;
    *State.Running*) printf '%s\n' "$running" ;;
    *'.Config.Image'*)
      if [ -f "$containers/$name.reference" ]; then
        cat "$containers/$name.reference"
      else
        printf '%s\n' qdrant/qdrant:v1.9.4
      fi
      ;;
    *'.Image'*) printf '%s\n' "$image" ;;
    *Config.User*)
      if [ -f "$containers/$name.user" ]; then
        cat "$containers/$name.user"
      else
        case "$image" in "$q_image") printf '%s\n' 1000:1000 ;; *) printf '%s\n' 999:999 ;; esac
      fi
      ;;
    *'com.docker.compose.project'*) cat "$containers/$name.project" ;;
    *'com.docker.compose.service'*) cat "$containers/$name.service" ;;
    *'com.docker.compose.config-hash'*) cat "$containers/$name.config" ;;
    *'com.diva.disaster-recovery.backup'*) printf '%s\n' fixture-qdrant-backup ;;
    *HostConfig.ReadonlyRootfs*) printf '%s\n' true ;;
    *HostConfig.CapDrop*) printf '%s\n' '["ALL"]' ;;
    *HostConfig.CapAdd*)
      if [ "$(read_value "$containers/$name.service" '')" = qdrant ]; then
        printf '%s\n' null
      else
        printf '%s\n' '["CAP_CHOWN","CAP_DAC_OVERRIDE","CAP_FOWNER","CAP_SETGID","CAP_SETUID"]'
      fi
      ;;
    *HostConfig.SecurityOpt*) printf '%s\n' '["no-new-privileges:true"]' ;;
    *HostConfig.RestartPolicy.Name*) cat "$containers/$name.restart" ;;
    *HostConfig.PortBindings*)
      if [ "$(read_value "$containers/$name.service" '')" = qdrant ]; then
        printf '%s\n' '{"6333/tcp":[{"HostIp":"127.0.0.1","HostPort":"6333"}],"6334/tcp":[{"HostIp":"127.0.0.1","HostPort":"6334"}]}'
      else
        printf '%s\n' '{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"5432"}]}'
      fi
      ;;
    *'.NetworkSettings.Networks'*Aliases*) cat "$containers/$name.aliases" ;;
    *'.NetworkSettings.Networks'*) cat "$containers/$name.network" ;;
    *'/qdrant/storage'*) cat "$containers/$name.volume" ;;
    *'/var/lib/postgresql/data'*) cat "$containers/$name.volume" ;;
    *) exit 1 ;;
  esac
  exit 0
fi

case "$1" in
  pull) exit 0 ;;
  build)
    for argument in "$@"; do
      case "$argument" in
        DIVA_POSTGRES_BUILD_TIMESTAMP=*)
          write_value "$root/postgres-build-timestamp" "__D__{argument#*=}"
          ;;
        DIVA_POSTGRES_MIGRATE_BUILD_TIMESTAMP=*)
          write_value "$root/postgres-build-timestamp" "__D__{argument#*=}"
          ;;
      esac
    done
    case " $* " in
      *' --target audit-tools '*) touch "$root/qdrant-audit-built" ;;
      *' --target runtime '*) touch "$root/qdrant-candidate-built" ;;
      *Dockerfile.pgvector*) touch "$root/postgres-candidate-built" ;;
      *Dockerfile.migrate*) touch "$root/postgres-migrate-candidate-built" ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
  run)
    helper_name=""
    previous=""
    for argument in "$@"; do
      if [ "$previous" = --name ]; then helper_name="$argument"; fi
      previous="$argument"
    done
    if [ -n "$helper_name" ]; then
      case "$helper_name" in
        diva_qdrant_alpine_attest_*)
          create_container "$helper_name" "$helper" "$audit_base_image"
          write_value "$containers/$helper_name.running" false
          printf '%s\n' \
            'banner=BusyBox v1.37.0 (2025-12-16 14:19:28 UTC) multi-call binary.' \
            'sha256=f3547b3d78d08a028a4833ddb83b77cf012838c078bfd2b76355f53d1d8bba62'
          ;;
        diva_qdrant_audit_*)
          create_container "$helper_name" "$audit" "$q_image"
          write_value "$containers/$helper_name.running" false
          printf '%s\n' 'qdrant 1.19.0'
          ;;
        diva_qdrant_owner_audit_*)
          create_container "$helper_name" "$owner_audit" "$q_audit_image"
          write_value "$containers/$helper_name.running" false
          printf '%s\n' 0:0
          ;;
        *)
          create_container "$helper_name" "$helper" "$q_image"
          write_value "$containers/$helper_name.running" false
          ;;
      esac
    fi
    exit 0
    ;;
  stop)
    target=""
    for argument in "$@"; do target="$argument"; done
    name=$(resolve_container "$target") || exit 1
    write_value "$containers/$name.running" false
    exit 0
    ;;
  start)
    name=$(resolve_container "$2") || exit 1
    write_value "$containers/$name.running" true
    exit 0
    ;;
  rename)
    source=$(resolve_container "$2") || exit 1
    source_id=$(read_value "$containers/$source.id" '')
    destination="$3"
    move_container "$source" "$destination"
    if [ "$source_id" = "$old_q" ]; then
      case "$destination" in
        diva_qdrant_previous_*) write_value "$root/qdrant-previous-name" "$destination" ;;
      esac
    fi
    exit 0
    ;;
  rm)
    target=""
    for argument in "$@"; do target="$argument"; done
    name=$(resolve_container "$target") || exit 0
    remove_container "$name"
    exit 0
    ;;
  cp)
    source="$2"
    destination="$3"
    case "$source" in
      *:/usr/share/diva-qdrant/qdrant-binary.sha256)
        printf '%064d\n' 0 | tr 0 a > "$destination"
        ;;
      *:/usr/share/diva-qdrant/qdrant-config-tree.sha256)
        printf '%064d\n' 0 | tr 0 b > "$destination"
        ;;
      *:/usr/share/diva-qdrant/qdrant-config-files.sha256)
        printf '%s\n' 'fixture-config-files' > "$destination"
        ;;
      *:/usr/share/diva-qdrant/ca-certificates-bundle.sha256)
        printf '%064d\n' 0 | tr 0 c > "$destination"
        ;;
      *:/usr/share/diva-qdrant/application-files.sha256)
        printf '%s\n' 'fixture-application-files' > "$destination"
        ;;
      *:/usr/share/diva-qdrant/runtime-packages.tsv)
        printf '%s\n' 'libc6\tglibc\t2.36\t2.36\tamd64' > "$destination"
        ;;
      *:/usr/share/diva-qdrant/runtime-links.txt)
        printf '%s\n' \
          '/lib=usr/lib' '/lib64=usr/lib64' \
          'interpreter=/lib64/ld-linux-x86-64.so.2' \
          'resolved_interpreter=/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2' \
          > "$destination"
        ;;
      *:/usr/share/diva-qdrant/audit-applets.txt)
        printf '%s\n' awk chown cp find readlink sh sha256sum sort stat tr wc xargs > "$destination"
        ;;
      *:/usr/share/diva-qdrant/audit-links.txt)
        printf '%s\n' \
          awk:hardlink chown:hardlink cp:hardlink find:hardlink readlink:hardlink \
          sh:symlink sha256sum:hardlink sort:hardlink stat:hardlink tr:hardlink \
          wc:hardlink xargs:hardlink > "$destination"
        ;;
      *:/usr/share/diva-qdrant/audit-contract.txt)
        printf '%s\n' \
          schema=4 \
          alpine_index_digest=sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659 \
          alpine_release=3.23.3 \
          alpine_inventory_sha256=3f18c4f5c16154eeba3ffd4970bf886c1699a3b901a3ddcf7948f99a8d2b8c53 \
          architecture=x86_64 \
          busybox_binary_sha256=f3547b3d78d08a028a4833ddb83b77cf012838c078bfd2b76355f53d1d8bba62 \
          busybox_package_version=1.37.0-r30 user=65534:65534 \
          busybox_link_count=12 hardlink_owner=0:0 hardlink_mode=755 \
          sh_symlink=/bin/busybox apk_database=/lib/apk/db/installed \
          directory_ancestry=/,/bin,/etc,/lib,/lib/apk,/lib/apk/db,/usr,/usr/share,/usr/share/diva-qdrant \
          directory_owner=0:0 directory_mode=755 \
          applets=awk,chown,cp,find,readlink,sh,sha256sum,sort,stat,tr,wc,xargs \
          links=awk:hardlink,chown:hardlink,cp:hardlink,find:hardlink,readlink:hardlink,sh:symlink,sha256sum:hardlink,sort:hardlink,stat:hardlink,tr:hardlink,wc:hardlink,xargs:hardlink \
          > "$destination"
        ;;
      *:/usr/share/diva-qdrant/audit-contract.sha256)
        printf '%s\n' ecf630ad651e1e3b53d257b0d19e1aa2e2f28e543442218f4c3992b073425a61 > "$destination"
        ;;
      *:/usr/share/diva-qdrant/audit-files.sha256)
        printf '%s\n' 'fixture-audit-files' > "$destination"
        ;;
      *:/usr/share/diva-qdrant/audit-packages.txt)
        printf '%s\n' \
          'busybox-1.37.0-r30 - Size optimized toolbox of many common UNIX utilities' \
          'busybox-binsh-1.37.0-r30 - busybox ash /bin/sh' \
          'musl-1.2.5-r23 - the musl c library (libc) implementation' > "$destination"
        ;;
      *:/usr/share/diva-qdrant/busybox-binary.sha256)
        printf '%s\n' f3547b3d78d08a028a4833ddb83b77cf012838c078bfd2b76355f53d1d8bba62 > "$destination"
        ;;
      *:/usr/share/diva-qdrant/busybox-version.txt)
        printf '%s\n' 'BusyBox v1.37.0 (2025-12-16 14:19:28 UTC) multi-call binary.' > "$destination"
        ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
  exec)
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -*) shift ;;
        *) break ;;
      esac
    done
    target="$1"
    name=$(resolve_container "$target") || exit 1
    id=$(read_value "$containers/$name.id" '')
    shift
    command="$*"
    stdin=$(cat)
    case "$command" in
      *"stat -c %d:%i /qdrant/storage"*) printf '%s\n' 2049:42 ;;
      *pg_isready*) exit 0 ;;
      *'SHOW server_version_num'*) printf '%s\n' 160015 ;;
      *'SELECT extversion'*) printf '%s\n' 0.8.2 ;;
      *'/api/recommend/similar?songId='*)
        printf '%s\n' '{"items":[{"songId":43}]}'
        ;;
      *recommendation_publication_generation*)
        printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        ;;
      *psql*)
        case "$stdin" in
          *diva_postgres_logical_fingerprint*)
            if [ "$id" = "$new_p" ] && [ "$scenario" = postgres-ephemeral-cache-change ]; then
              : > "$root/ephemeral-cache-mutated"
            fi
            if [ "$id" = "$new_p" ] && [ "$scenario" = postgres-fingerprint-failure ]; then
              printf '%s\n' '{"databaseOid":1,"publicationGeneration":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","relations":[{"name":"public.songs","rows":"43","sum0":"100","sum1":"200"}],"sequences":[]}'
            elif [ "$id" = "$new_p" ] && [ "$scenario" = postgres-row-content-failure ]; then
              printf '%s\n' '{"databaseOid":1,"publicationGeneration":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","relations":[{"name":"public.songs","rows":"42","sum0":"101","sum1":"201"}],"sequences":[]}'
            else
              printf '%s\n' '{"databaseOid":1,"publicationGeneration":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","relations":[{"name":"public.songs","rows":"42","sum0":"100","sum1":"200"}],"sequences":[]}'
            fi
            ;;
          *diva-writer-gate-acquire*)
            if [ "$scenario" = writer-active ] \
                || [ "$scenario" = indirect-pipeline-login-role ] \
                || [ "$scenario" = bridge-attestation-prep-over-15m ]; then
              exit 0
            fi
            token=""
            for argument in $command; do token="$argument"; done
            write_value "$root/writer-gate" "$token"
            touch "$root/writer-roles-locked"
            printf '%s\n' "$token"
            ;;
          *diva-writer-gate-verify*)
            [ -f "$root/writer-gate" ] || exit 0
            [ -f "$root/writer-roles-locked" ] || exit 0
            printf '%s|true|true|true|0|0|true\n' "$(cat "$root/writer-gate")"
            ;;
          *diva-writer-gate-release*)
            [ -f "$root/writer-gate" ] || exit 0
            cat "$root/writer-gate"
            rm -f "$root/writer-gate" "$root/writer-roles-locked"
            ;;
          *"SELECT value FROM sync_state WHERE key = 'diva_stateful_maintenance_gate'"*)
            [ ! -f "$root/writer-gate" ] || cat "$root/writer-gate"
            ;;
          *) exit 1 ;;
        esac
        ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
esac

if [ "$1" = network ] && [ "__D__{2:-}" = inspect ]; then
  printf '%s\n' 3333333333333333333333333333333333333333333333333333333333333333
  exit 0
fi

if [ "$1" = volume ] && [ "__D__{2:-}" = inspect ]; then
  shift 2
  format=""
  target=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --format) format="$2"; shift 2 ;;
      *) target="$1"; shift ;;
    esac
  done
  case "$format" in
    *'.Name'*) printf '%s\n' "$target" ;;
    *'.Labels'*) printf '%s\n' '{}' ;;
    *'.Options'*) printf '%s\n' '{}' ;;
    '')
      mountpoint="/var/lib/docker/volumes/$target/_data"
      if [ "$target" = backend_qdrant_data ] \
          && [ -f "$root/rollback-volume-identity-drift" ]; then
        mountpoint="/var/lib/docker/volumes/third-party-qdrant/_data"
      fi
      printf '[{"CreatedAt":"2026-08-30T00:00:00Z","Driver":"local","Labels":{},"Mountpoint":"%s","Name":"%s","Options":{},"Scope":"local"}]\n' "$mountpoint" "$target"
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi

if [ "$1" = compose ]; then
  project=""
  override=""
  operation=""
  service=""
  no_recreate=false
  force_recreate=false
  previous=""
  for argument in "$@"; do
    if [ "$previous" = --project-name ]; then project="$argument"; fi
    if [ "$previous" = -f ]; then override="$argument"; fi
    case "$argument" in
      config|up) operation="$argument" ;;
      qdrant|postgres) service="$argument" ;;
      --no-recreate) no_recreate=true ;;
      --force-recreate) force_recreate=true ;;
    esac
    previous="$argument"
  done
  if [ "$operation" = config ]; then
    case " $* " in
      *' --format json '*)
        if [ "$scenario" = projection-config-failure ]; then
          printf '%s\n' '{"services":{"postgres":{"environment":{"POSTGRES_PASSWORD":"must-not-remain"}'
          exit 17
        fi
        printf '%s\n' '{"services":{"postgres":{"environment":{"POSTGRES_DB":"vocadb_recommender","POSTGRES_PASSWORD":"fixture-secret"},"image":"pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b","networks":{"default":null},"volumes":[{"source":"postgres_data","target":"/var/lib/postgresql/data","type":"volume"}]},"qdrant":{"image":"diva-player-qdrant:v1.19.0-hardened-r1","networks":{"default":null},"volumes":[{"source":"qdrant_data","target":"/qdrant/storage","type":"volume"}]}},"volumes":{"postgres_data":{"name":"backend_postgres_data"},"qdrant_data":{"name":"backend_qdrant_data"}},"networks":{"default":{"name":"backend_default"}}}'
        ;;
      *) printf '%s\n' 'services: {}' ;;
    esac
    exit 0
  fi
  [ "$operation" = up ] || exit 1
  [ -n "$project" ] || exit 1
  if [ "$project" = backend ]; then
    case " $* " in *' candidate-compose.override.yml '*) exit 1 ;; esac
    if [ "$service" = qdrant ]; then
      [ -f "$root/stable-image-id" ] || exit 1
      [ "$(cat "$root/stable-image-id")" = "$q_image" ] || exit 1
    elif [ "$service" = postgres ]; then
      [ -f "$root/stable-postgres-image-id" ] || exit 1
      [ "$(cat "$root/stable-postgres-image-id")" = "$p_image" ] || exit 1
    fi
  fi
  if [ "$project" = backend ] && [ "$force_recreate" = false ]; then
    case " $* " in
      *' qdrant postgres '*)
        case "$scenario" in
          rollback-tag-retag-drift)
            write_value "$root/rollback-image-id" \
              sha256:f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0
            ;;
          rollback-tag-missing)
            rm -f "$root/rollback-image-id"
            ;;
          rollback-volume-identity-drift)
            touch "$root/rollback-volume-identity-drift"
            ;;
          rollback-container-third-party-replacement)
            previous=$(read_value "$root/qdrant-previous-name" '')
            [ -n "$previous" ] || exit 87
            create_container "$previous" \
              f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1 \
              sha256:7777777777777777777777777777777777777777777777777777777777777777 \
              backend qdrant backend_qdrant_data /qdrant/storage backend_default
            write_value "$containers/$previous.running" false
            ;;
        esac
        ;;
    esac
  fi
  [ "$no_recreate" = false ] || exit 0
  [ "$force_recreate" = true ] || exit 0
  for project_file in "$containers"/*.project; do
    [ -f "$project_file" ] || continue
    [ "$(cat "$project_file")" = "$project" ] || continue
    base=__D__{project_file%.project}
    [ "$(cat "$base.service")" = "$service" ] || continue
    if [ "$scenario" = delayed-old-rm ] && [ "$project" = backend ]; then
      continue
    fi
    remove_container "__D__{base##*/}"
  done
    case "$service" in
      qdrant)
        if [ "$project" = backend ]; then id="$promoted_q"; else id="$new_q"; fi
        qdrant_volume=__D__{DIVA_QDRANT_VOLUME:-backend_qdrant_data}
        if [ "$project" != backend ] && [ -f "$override" ]; then
          qdrant_volume=$(awk '
            /^  qdrant_data:__D__/{found=1; next}
            found && /^    name: / {gsub(/"/, "", __D__2); print __D__2; exit}
          ' "$override")
        fi
        [ -n "$qdrant_volume" ] || exit 1
        create_container vocadb_qdrant "$id" "$q_image" "$project" qdrant \
          "$qdrant_volume" /qdrant/storage backend_default
      [ "__D__{FAKE_TIMEOUT_MUTATION:-}" != qdrant-unresolved ] || touch "$root/daemon-unstable"
      ;;
    postgres)
      if [ "$project" = backend ]; then id="$promoted_p"; else id="$new_p"; fi
      create_container vocadb_postgres "$id" "$p_image" "$project" postgres \
        backend_postgres_data /var/lib/postgresql/data backend_default
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi

exit 1
`.replaceAll('__D__', '$');

const fakeCurl = String.raw`#!/bin/sh
set -eu
root=__D__{FAKE_STATE:?}
printf '%s\n' "$*" >> "$root/curl.log"
url=""
for argument in "$@"; do url="$argument"; done
if [ "__D__{FAKE_SCENARIO:-}" = qdrant-health-failure ] \
    && [ "$url" = http://127.0.0.1:6333/readyz ] \
    && [ -f "$root/containers/vocadb_qdrant.id" ] \
    && [ "$(cat "$root/containers/vocadb_qdrant.id")" = eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee ]; then
  exit 22
fi
case "__D__{FAKE_SCENARIO:-}:$url" in
  stable-tag-*-post-bind-failure:http://127.0.0.1:6333/readyz)
    if [ -f "$root/containers/vocadb_qdrant.id" ] \
        && [ "$(cat "$root/containers/vocadb_qdrant.id")" = 1111111111111111111111111111111111111111111111111111111111111111 ]; then
      exit 22
    fi
    ;;
esac
exit 0
`.replaceAll('__D__', '$');

const fakeTrivy = String.raw`#!/bin/sh
set -eu
root=__D__{FAKE_STATE:?}
cache=""
output=""
exit_code=0
previous=""
last=""
download=false
for argument in "$@"; do
  if [ "$previous" = --cache-dir ]; then cache="$argument"; fi
  if [ "$previous" = --output ]; then output="$argument"; fi
  if [ "$previous" = --exit-code ]; then exit_code="$argument"; fi
  [ "$argument" != --download-db-only ] || download=true
  previous="$argument"
  last="$argument"
done
[ -n "$cache" ] || exit 2
if [ "$download" = true ]; then
  mkdir -p "$cache/db"
  updated=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  next=$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)
  printf '{"Version":2,"UpdatedAt":"%s","DownloadedAt":"%s","NextUpdate":"%s"}\n' \
    "$updated" "$updated" "$next" > "$cache/db/metadata.json"
  printf '%s\n' 'fixture-trivy-database' > "$cache/db/trivy.db"
  exit 0
fi
[ -n "$output" ] || exit 3
os_type=debian
case "$last" in
  sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc|\
  sha256:7777777777777777777777777777777777777777777777777777777777777777)
    os_type=debian
    ;;
  *) os_type=alpine ;;
esac
finding=""
case "__D__{FAKE_SCENARIO:-}:$last" in
  legacy-scan-calibration:sha256:7777777777777777777777777777777777777777777777777777777777777777|\
  legacy-scan-reviewed:sha256:7777777777777777777777777777777777777777777777777777777777777777|\
  legacy-scan-unexpected:sha256:7777777777777777777777777777777777777777777777777777777777777777)
    finding='{"VulnerabilityID":"CVE-OLD-QDRANT","PkgID":"openssl@1","PkgName":"openssl","PkgPath":"/usr/lib/libssl.so","InstalledVersion":"1","FixedVersion":"2","Severity":"HIGH","Status":"fixed"}'
    ;;
  legacy-scan-calibration:sha256:8888888888888888888888888888888888888888888888888888888888888888|\
  legacy-scan-reviewed:sha256:8888888888888888888888888888888888888888888888888888888888888888|\
  legacy-scan-unexpected:sha256:8888888888888888888888888888888888888888888888888888888888888888)
    finding='{"VulnerabilityID":"CVE-OLD-POSTGRES","PkgID":"libcrypto@1","PkgName":"libcrypto","PkgPath":"/lib/libcrypto.so","InstalledVersion":"1","FixedVersion":"2","Severity":"CRITICAL","Status":"fixed"}'
    ;;
  candidate-scan-finding:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc)
    finding='{"VulnerabilityID":"CVE-CANDIDATE","PkgID":"candidate@1","PkgName":"candidate","PkgPath":"/candidate","InstalledVersion":"1","FixedVersion":"2","Severity":"HIGH","Status":"fixed"}'
    ;;
esac
if [ -n "$finding" ]; then
  vulnerabilities="[$finding]"
else
  vulnerabilities=null
fi
printf '%s|%s\n' "$last" "$exit_code" >> "$root/trivy-scan.log"
printf '{"SchemaVersion":2,"ArtifactType":"container_image","Metadata":{"ImageID":"%s","ImageConfig":{"architecture":"amd64","os":"linux"},"OS":{"Family":"%s","Name":"fixture"}},"Results":[{"Target":"fixture","Class":"os-pkgs","Type":"%s","Packages":[{"Name":"fixture","Version":"1"}],"Vulnerabilities":%s}]}\n' \
  "$last" "$os_type" "$os_type" "$vulnerabilities" > "$output"
[ "$finding" = "" ] || [ "$exit_code" = 0 ] || exit "$exit_code"
`.replaceAll('__D__', '$');

const fakePython = String.raw`#!/bin/sh
set -eu
root=__D__{FAKE_STATE:?}
printf '%s\n' "$*" >> "$root/python.log"
# The production hardener invokes every standard-library helper with -I -B.
# Normalize that fixture-only extra flag so the legacy command fixtures below
# remain focused on their payload behavior.
if [ "__D__{1:-}" = -I ] && [ "__D__{2:-}" = -B ]; then
  shift 2
  set -- -I "$@"
fi
case "__D__{3:-}" in
  *pipeline-runtime-attestation.json.tmp)
    exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
    ;;
esac
case "__D__{2:-}" in
  *validate-container-image-scan.py)
    if [ "__D__{FAKE_FAST_IMAGE_SCAN:-0}" = 1 ]; then
      mode=__D__{3:?}
      receipt=""
      previous=""
      for argument in "$@"; do
        if [ "$previous" = --receipt ]; then receipt="$argument"; fi
        previous="$argument"
      done
      [ -n "$receipt" ] || exit 91
      case "$mode" in
        validate)
          printf '%s\n' '{"kind":"fast-fault-fixture-scan-receipt","schemaVersion":1}' > "$receipt"
          printf '%s\n' '{"status":"validated-by-fast-fault-fixture"}'
          ;;
        verify)
          [ -f "$receipt" ] || exit 92
          printf '%s\n' '{"status":"verified-by-fast-fault-fixture"}'
          ;;
        *) exit 93 ;;
      esac
      exit 0
    fi
    exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
    ;;
  *wsl-dr-api-bridge-receipt.py)
    field=
    while [ "__D__#" -gt 0 ]; do
      if [ "__D__1" = --field ]; then
        shift
        field=__D__{1:-}
      fi
      shift
    done
    if [ "$field" = createdAt ]; then
      exec "__D__{FAKE_REAL_PYTHON:?}" -I -B -c \
        'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["receipt"]["createdAt"])' \
        "__D__{FAKE_API_BRIDGE_WRAPPER:?}"
    fi
    cat "__D__{FAKE_API_BRIDGE_WRAPPER:?}"
    exit 0
    ;;
  *sbc-api-bridge-consumption.py)
    exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
    ;;
  *sbc-qdrant-storage-upgrade.py)
    exec "__D__{FAKE_REAL_PYTHON:?}" "__D__{FAKE_QDRANT_CONTROLLER_RUNNER:?}" "$root" "$@"
    ;;
  -c)
    exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
    ;;
esac
if [ "__D__{2:-}" = - ]; then
  case "__D__{3:-}:__D__{4:-}" in
    *:*qdrant-storage-upgrade-controller-settlement.json|\
    success:*|failure:*|\
    *qdrant-storage-upgrade-daemon-settlement.json.tmp:*)
      exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
      ;;
  esac
  case "__D__{3:-}" in
    qdrant-rollback|postgres-rollback)
      exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
      ;;
  esac
fi
backup_validation_job=
case "__D__{3:-}:__D__{4:-}" in
  postgres_disaster_backup:*|qdrant_disaster_backup:*)
    backup_validation_job=__D__3
    ;;
  -:postgres_disaster_backup|-:qdrant_disaster_backup)
    backup_validation_job=__D__4
    ;;
esac
if [ -n "$backup_validation_job" ]; then
    backup_validation_count=0
    if [ -f "$root/backup-validation-count" ]; then
      backup_validation_count=$(cat "$root/backup-validation-count")
    fi
    backup_validation_count=__D__((backup_validation_count + 1))
    printf '%s\n' "$backup_validation_count" > "$root/backup-validation-count"
    if [ "__D__{FAKE_SCENARIO:-}" = backup-expires-before-writer-gate ] \
        && [ "$backup_validation_count" -ge 5 ]; then
      DIVA_STATEFUL_TEST_BACKUP_CLOCK_SKEW_HOURS=49
      export DIVA_STATEFUL_TEST_BACKUP_CLOCK_SKEW_HOURS
    fi
    exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
fi
case "__D__{3:-}" in
  *api-bridge-receipt-verified-*.json|*source-tree.entries|'['*)
    "__D__{FAKE_REAL_PYTHON:?}" "$@" || {
      rc=$?
      printf 'embedded-python-failure=%s args=%s\n' "$rc" "$*" >> "$root/python.log"
      exit "$rc"
    }
    exit 0
    ;;
  *qdrant-*-api_*-semantic.json)
    exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
    ;;
  *backend/.env)
    exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
    ;;
esac
case "__D__{3:-}:__D__{4:-}" in
  *.json:*.json)
    exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
    ;;
esac
case "__D__{4:-}" in
  *qdrant-*-python-semantic.json)
    printf '%s\n' '{"aliasList":"passed","clientPackageVersion":"1.19.0","queryResultCount":2,"retrieveVectorDimensions":3,"scratchAliasCleanup":"confirmed","scratchCollectionCleanup":"confirmed","scratchSnapshotCleanup":"confirmed","scratchUpsertDelete":"passed"}' > "__D__4"
    exit 0
    ;;
  *stateful-compose-projection.json)
    exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
    ;;
esac
case "__D__{3:-}" in
  verify-port-bindings|*backup-payload-attestation.json)
    exec "__D__{FAKE_REAL_PYTHON:?}" "$@"
    ;;
esac
output=__D__{3:?}
case "$output" in
  *status.json)
    exec "__D__{FAKE_NODE_COMMAND:?}" "__D__{FAKE_EVIDENCE_VALIDATOR:?}" ancestry "$output"
    ;;
esac
if [ "__D__{FAKE_SCENARIO:-}" = qdrant-fingerprint-failure ]; then
  case "$output" in *qdrant-after.json) printf '%s\n' '{"collections":{"songs":{"payloadSchema":{},"pointsCount":999}}}' > "$output"; exit 0 ;; esac
fi
if [ "__D__{FAKE_SCENARIO:-}" = qdrant-payload-schema-failure ]; then
  case "$output" in *qdrant-after.json) printf '%s\n' '{"collections":{"songs":{"payloadSchema":{"artist":{"data_type":"keyword"}},"pointsCount":42}}}' > "$output"; exit 0 ;; esac
fi
printf '%s\n' '{"collections":{"songs":{"payloadSchema":{},"pointsCount":42}}}' > "$output"
`.replaceAll('__D__', '$');

// Kept separate from fakePython: the hardener's root-side standard-library
// controller must never directly execute this pipeline-runtime stub.
const fakePipelineVenvPython = String.raw`#!/bin/sh
set -eu
[ "__D__{1:-}" = -I ] && [ "__D__{2:-}" = -B ] && [ "__D__{3:-}" = - ] || exit 90
case "__D__{4:-}" in
  runtime-attestation)
    printf '%s\n' '{"baseExecutable":"/usr/bin/python3.10","contract":"linux-aarch64","executable":"/fixture/pipeline/ml_pipeline/.venv/bin/python","gid":1000,"lockSha256":"1111111111111111111111111111111111111111111111111111111111111111","patcherSha256":"2222222222222222222222222222222222222222222222222222222222222222","privilegeBoundary":"uid-gid-no-groups-no-caps-nnp","qdrantClientVersion":"1.19.0","qdrantModule":"/fixture/pipeline/ml_pipeline/.venv/lib/python3.10/site-packages/qdrant_client/__init__.py","runtimeReceiptSha256":"3333333333333333333333333333333333333333333333333333333333333333","schema":"diva.pipeline-qdrant-probe-runtime.v1","uid":1000,"verifierSha256":"4444444444444444444444444444444444444444444444444444444444444444"}'
    ;;
  qdrant-semantic)
    printf '%s\n' '{"aliasList":"passed","clientPackageVersion":"1.19.0","queryResultCount":2,"retrieveVectorDimensions":3,"scratchAliasCleanup":"confirmed","scratchCollectionCleanup":"confirmed","scratchSnapshotCleanup":"confirmed","scratchUpsertDelete":"passed"}'
    ;;
  *) exit 91 ;;
esac
`.replaceAll('__D__', '$');

const fakeSetpriv = String.raw`#!/bin/sh
set -eu
while [ "__D__{1:-}" != -- ]; do
  [ "__D__{1:-}" ] || exit 92
  shift
done
shift
exec "$@"
`.replaceAll('__D__', '$');

const fakeFlock = String.raw`#!/bin/sh
set -eu
case "__D__{1:-}" in
  --shared)
    [ "__D__#" -eq 4 ]
    [ "__D__2" = --timeout ]
    [ "__D__3" = 900 ]
    [ "__D__4" = 9 ]
    ;;
  --unlock)
    [ "__D__#" -eq 2 ]
    [ "__D__2" = 9 ]
    ;;
  *) exit 93 ;;
esac
`.replaceAll('__D__', '$');

const fakeQdrantControllerRunner = String.raw`import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

root = Path(sys.argv[1])
arguments = sys.argv[4:]
values = {}
index = 0
while index < len(arguments):
    key = arguments[index]
    if key.startswith("--") and index + 1 < len(arguments):
        values[key] = arguments[index + 1]
        index += 2
    else:
        index += 1

run_id = values["--run-id"]
journal_path = Path(values["--journal"])
output_path = Path(values["--output"])
containers = root / "containers"
old_id = values["--old-container-id"]
old_name = values["--old-container-name"]
candidate_volume = values["--candidate-volume"]
final_image_id = values["--final-image-id"]
audit_image_id = values["--audit-image-id"]
final_id = "8" * 64
final_name = "diva_qfinal_" + run_id

def write_value(path, value):
    path.write_text(str(value) + "\n", encoding="utf-8")

def canonical(document):
    return (json.dumps(document, ensure_ascii=True, sort_keys=True,
                       separators=(",", ":")) + "\n").encode()

scenario = os.environ.get("FAKE_SCENARIO", "success")
write_value(containers / f"{old_name}.running", "false")
if scenario == "qdrant-controller-timeout":
    if os.name == "posix":
        marker = root / "late-controller-mutation"
        subprocess.Popen([
            sys.executable,
            "-c",
            "import pathlib,sys,time;time.sleep(3);pathlib.Path(sys.argv[1]).write_text('late\\n')",
            str(marker),
        ])
    time.sleep(30)
    raise SystemExit(70)

for suffix, value in {
    "id": final_id,
    "image": final_image_id,
    "running": "true",
    "restart": "no",
}.items():
    write_value(containers / f"{final_name}.{suffix}", value)

result = {
    "schemaVersion": 1,
    "status": "ready-for-coupled-cutover",
    "runId": run_id,
    "oldContainerId": old_id,
    "oldVolume": values["--old-volume"],
    "candidateVolume": candidate_volume,
    "candidateContainerId": final_id,
    "candidateImageId": final_image_id,
    "hardenedFinalImageId": final_image_id,
    "offlineAuditImageId": audit_image_id,
    "completedAt": "2026-08-31T00:00:00Z",
}
journal = {
    "schemaVersion": 1,
    "runId": run_id,
    "phase": "ready-for-coupled-cutover",
    "result": result,
}
journal_payload = canonical(journal)
journal_path.write_bytes(journal_payload)
published = {**result, "journalSha256": hashlib.sha256(journal_payload).hexdigest()}
output_path.write_bytes(canonical(published))
print(json.dumps(published, ensure_ascii=True, sort_keys=True))
`;

const fakeSleep = String.raw`#!/bin/sh
set -eu
root=__D__{FAKE_STATE:?}
if [ -f "$root/pending-rm" ]; then
  target=$(cat "$root/pending-rm")
  rm -f "$root/pending-rm"
  for id_file in "$root/containers"/*.id; do
    [ -f "$id_file" ] || continue
    if [ "$(cat "$id_file")" = "$target" ]; then
      base=__D__{id_file%.id}
      rm -f "$base".*
      printf 'late-rm|%s\n' "$target" >> "$root/sleep.log"
      break
    fi
  done
fi
exit 0
`.replaceAll('__D__', '$');

const fakeTimeout = String.raw`#!/bin/sh
set -eu
root=__D__{FAKE_STATE:?}
scenario=__D__{FAKE_SCENARIO:-success}
while [ "$#" -gt 0 ]; do
  case "$1" in --signal=*|--kill-after=*) shift ;; *) break ;; esac
done
limit=__D__{1:?}
shift
command=__D__{1:?}
shift
# This fixture also runs beneath the hardener's 64 KiB RLIMIT_FSIZE semantic
# probe.  Keep its cumulative diagnostics bounded so the fixture cannot fail
# before the command whose timeout behavior it is meant to model.
printf '%s|%s|argc=%s\n' "$limit" "__D__{command##*/}" "__D__#" >> "$root/timeout.log"
if [ "$scenario" = daemon-read-timeout-after-gate ] \
    && [ -f "$root/writer-gate" ]; then
  case "$*" in
    'container ls -a --no-trunc --filter name=^/vocadb_qdrant$ --format {{.ID}}')
      exit 124
      ;;
  esac
fi
if [ "$scenario" = daemon-read-timeout-once-after-gate ] \
    && [ -f "$root/writer-gate" ]; then
  case "$*" in
    'container ls -a --no-trunc --filter name=^/diva_qdrant_previous_'*'$ --format {{.ID}}')
      if [ ! -f "$root/read-timeout-injected" ]; then
        : > "$root/read-timeout-injected"
        exit 124
      fi
      ;;
  esac
fi
case "$scenario:$*" in
  projection-config-timeout:*'compose '*'config --format json')
    printf '%s\n' '{"services":{"postgres":{"environment":{"POSTGRES_PASSWORD":"must-not-remain"}'
    exit 124
    ;;
  qdrant-compose-timeout:*'compose '*'force-recreate qdrant')
    (
      /usr/bin/sleep 1
      FAKE_TIMEOUT_MUTATION=qdrant-stable "$command" "$@" || true
      printf '%s\n' "$scenario" > "$root/delayed-mutation-done"
    ) </dev/null >> "$root/delayed-mutation.log" 2>&1 &
    exit 124
    ;;
  qdrant-compose-unresolved:*'compose '*'force-recreate qdrant')
    FAKE_TIMEOUT_MUTATION=qdrant-unresolved "$command" "$@" || true
    exit 124
    ;;
  postgres-compose-timeout:*'compose '*'force-recreate postgres')
    (
      /usr/bin/sleep 1
      FAKE_TIMEOUT_MUTATION=postgres-stable "$command" "$@" || true
      printf '%s\n' "$scenario" > "$root/delayed-mutation-done"
    ) </dev/null >> "$root/delayed-mutation.log" 2>&1 &
    exit 124
    ;;
  image-tag-timeout:*'image tag '*)
    (
      /usr/bin/sleep 1
      FAKE_TIMEOUT_MUTATION=image-tag "$command" "$@" || true
      printf '%s\n' "$scenario" > "$root/delayed-mutation-done"
    ) </dev/null >> "$root/delayed-mutation.log" 2>&1 &
    exit 124
    ;;
  promotion-qdrant-compose-timeout:*'compose '*'--project-name backend '*'force-recreate qdrant')
    (
      /usr/bin/sleep 1
      FAKE_TIMEOUT_MUTATION=promotion-qdrant "$command" "$@" || true
      printf '%s\n' "$scenario" > "$root/delayed-mutation-done"
    ) </dev/null >> "$root/delayed-mutation.log" 2>&1 &
    exit 124
    ;;
  promotion-postgres-compose-timeout:*'compose '*'--project-name backend '*'force-recreate postgres')
    (
      /usr/bin/sleep 1
      FAKE_TIMEOUT_MUTATION=promotion-postgres "$command" "$@" || true
      printf '%s\n' "$scenario" > "$root/delayed-mutation-done"
    ) </dev/null >> "$root/delayed-mutation.log" 2>&1 &
    exit 124
    ;;
esac
case "$*" in
  *'exec -i vocadb_postgres '*'psql'*)
    if [ "$scenario" = gate-acquire-timeout ] && [ ! -f "$root/writer-gate" ]; then
      FAKE_TIMEOUT_MUTATION=gate-acquire "$command" "$@" || true
      exit 124
    fi
    if [ "$scenario" = gate-release-timeout ] && [ -f "$root/writer-gate" ]; then
      case "$*" in
        *'-v "token=$1"'*)
          FAKE_TIMEOUT_MUTATION=gate-release "$command" "$@" || true
          exit 124
          ;;
      esac
    fi
    ;;
esac
if [ "$scenario" = delayed-old-rm ]; then
  case "$*" in
    "rm aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"|\
    "rm bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
      target=__D__{2:?}
      (
        /usr/bin/sleep 1
        FAKE_TIMEOUT_MUTATION=late-rm "$command" "$@" || true
        printf 'late-rm|%s\n' "$target" >> "$root/sleep.log"
        printf '%s\n' "$scenario" > "$root/delayed-mutation-done"
      ) </dev/null >> "$root/delayed-mutation.log" 2>&1 &
      exit 124
      ;;
  esac
fi
exec "$command" "$@"
`.replaceAll('__D__', '$');

const fakeStat = String.raw`#!/bin/sh
format=__D__{2:-}
target=__D__{3:-}
owner_uid=$(/usr/bin/id -u)
owner_gid=$(/usr/bin/id -g)
case "$format:$target" in
  %u:%g:*/project) printf '%s:%s\n' "$owner_uid" "$owner_gid" ;;
  %u:%g:%a:%h:*/project/backend/.env*|\
  %u:%g:%a:%h:*/backend.env.before-qdrant-volume)
    printf '%s:%s:600:1\n' "$owner_uid" "$owner_gid"
    ;;
  %a:*/stateful-hardening.lock) printf '%s\n' 700 ;;
  *%u:%g:%a*) printf '%s\n' 0:0:700 ;;
  *%u:%g*) printf '%s\n' 0:0 ;;
  *%a:%h*) printf '%s\n' 600:1 ;;
  *) printf '%s\n' 600 ;;
esac
`.replaceAll('__D__', '$');

const fakeSync = String.raw`#!/bin/sh
set -eu
root=__D__{FAKE_STATE:?}
if [ "__D__{FAKE_SCENARIO:-}" = promotion-marker-sync-failure ]; then
  case "__D__{*:-}" in
    *promoted.tmp*)
      touch "$root/promotion-marker-sync-fallback"
      exit 71
      ;;
  esac
  if [ -f "$root/promotion-marker-sync-fallback" ]; then
    rm -f "$root/promotion-marker-sync-fallback"
    exit 71
  fi
fi
exit 0
`.replaceAll('__D__', '$');

const fakeSha256sum = String.raw`#!/bin/sh
set -eu
root=__D__{FAKE_STATE:?}
scenario=__D__{FAKE_SCENARIO:-success}
output=$(/usr/bin/sha256sum "$@")
target=__D__{1:-}
case "__D__{target##*/}" in
  audit-packages.txt)
    printf '%s  %s\n' 3f18c4f5c16154eeba3ffd4970bf886c1699a3b901a3ddcf7948f99a8d2b8c53 "$target"
    exit 0
    ;;
esac
case "$scenario:$target" in
  status-swap-after-shell-hash:*postgres-status.json)
    if [ ! -f "$root/status-swapped" ]; then
      printf '%s\n' '{"swapped":true}' > "$target"
      touch "$root/status-swapped"
    fi
    ;;
  attestation-swap-after-shell-hash:*backup-payload-attestation.json)
    if [ ! -f "$root/attestation-swapped" ]; then
      printf '%s\n' '{"swapped":true}' > "$target"
      touch "$root/attestation-swapped"
    fi
    ;;
esac
printf '%s\n' "$output"
`.replaceAll('__D__', '$');

const fakeMkdir = String.raw`#!/bin/sh
if [ "__D__{1:-}" = -p ] && [ -d "__D__{2:-}" ]; then exit 0; fi
exec /usr/bin/mkdir "$@"
`.replaceAll('__D__', '$');

const evidenceValidator = String.raw`const fs = require('node:fs');
const [mode, ...args] = process.argv.slice(2);
if (mode === 'ancestry') {
  const status = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  process.stdout.write(status.source.playerCommit + ' ' + status.source.pipelineCommit + '\n');
  process.exit(0);
}
throw new Error('unsupported fake Python mode');
`;

async function writeExecutable(path, content) {
  await writeFile(path, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  await chmod(path, 0o755);
}

async function writeEvidence(root, playerCommit, pipelineCommit, attesterPath, scenario) {
  const evidenceDirectory = join(root, 'evidence');
  await mkdir(evidenceDirectory);
  const source = {
    host: 'test-sbc',
    pipelineCommit,
    playerCommit,
  };
  const basisId = 'a'.repeat(64);
  const buildId = 'b'.repeat(32);
  const suffix = `${basisId.slice(0, 12)}_${buildId.slice(0, 8)}`;
  const generation = `${basisId}:${buildId}`;
  const aliases = {
    song_hybrid_active: `song_hybrid_basis_${suffix}`,
    song_metadata_active: `song_metadata_basis_${suffix}`,
    songs_v2_active: `songs_v2_basis_${suffix}`,
  };
  const collections = ['song_audio', ...Object.values(aliases)].sort();

  async function createEvidence(kind, executionRunId, exportRunId) {
    const exportDirectory = join(root, 'offhost', exportRunId);
    await mkdir(exportDirectory, { recursive: true });
    const job = `${kind}_disaster_backup`;
    const publication = {
      generation,
      aliases,
      collections,
      ...(kind === 'qdrant' ? { qdrantVersion: '1.9.4' } : {}),
    };
    const validation = {
      generationStable: true,
      qdrantReferenceStable: true,
      ...(kind === 'postgres'
        ? { pgRestoreList: 'success' }
        : {
            adoptedExistingExport: false,
            collectionStatesStable: true,
            sourceChecksumsVerified: true,
          }),
    };
    const payloads = kind === 'postgres'
      ? [{ file: 'postgres.dump', bytes: Buffer.alloc(123, 5) }]
      : [
          ['song_audio.snapshot', 456, 6],
          ['song_hybrid.snapshot', 457, 7],
          ['song_metadata.snapshot', 458, 8],
          ['songs_v2.snapshot', 459, 9],
        ].map(([file, size, value]) => ({ file, bytes: Buffer.alloc(size, value) }));
    const payloadRecords = payloads.map(({ file, bytes }) => ({
      file,
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
    }));
    const manifest = {
      schemaVersion: 1,
      runId: exportRunId,
      status: 'complete',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      source,
      publication,
      validation,
      ...(kind === 'postgres'
        ? { database: payloadRecords[0] }
        : {
            collectionStates: {
              song_audio: {
                status: 'green',
                pointsCount: scenario === 'zero-point-backup-evidence' ? 0 : 42,
              },
              [aliases.song_hybrid_active]: { status: 'green', pointsCount: 42 },
              [aliases.song_metadata_active]: { status: 'green', pointsCount: 42 },
              [aliases.songs_v2_active]: { status: 'green', pointsCount: 42 },
            },
            snapshots: Object.entries({
              'song_audio.snapshot': 'song_audio',
              'song_hybrid.snapshot': aliases.song_hybrid_active,
              'song_metadata.snapshot': aliases.song_metadata_active,
              'songs_v2.snapshot': aliases.songs_v2_active,
            }).map(([file, collection]) => ({
              collection,
              file,
              ...payloadRecords.find(item => item.file === file),
            })),
          }),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
    const manifestSha = sha256(manifestBytes);
    const status = {
      schemaVersion: 1,
      job,
      runId: executionRunId,
      status: 'success',
      exitCode: 0,
      remoteCleanup: 'confirmed',
      finishedAt: new Date().toISOString(),
      manifestSha256: manifestSha,
      source,
      publication,
      backupPath: exportDirectory,
      ...(kind === 'postgres'
        ? { dumpSha256: manifest.database.sha256, dumpSizeBytes: manifest.database.sizeBytes }
        : {
            collectionStates: manifest.collectionStates,
            snapshotCount: manifest.snapshots.length,
            totalSizeBytes: manifest.snapshots.reduce((sum, item) => sum + item.sizeBytes, 0),
          }),
    };
    const statusBytes = Buffer.from(`${JSON.stringify(status)}\n`, 'utf8');
    const statusPath = join(evidenceDirectory, `${kind}-status.json`);
    const manifestPath = join(exportDirectory, 'manifest.json');
    await Promise.all([
      writeFile(statusPath, statusBytes),
      writeFile(manifestPath, manifestBytes),
      ...payloads.map(({ file, bytes }) => writeFile(join(exportDirectory, file), bytes)),
    ]);
    return {
      runId: executionRunId,
      statusPath,
      statusSha: sha256(statusBytes),
      manifestPath,
      manifestSha,
    };
  }

  const postgres = await createEvidence(
      'postgres',
      '1'.repeat(32),
      'postgres-20260830T083000Z-1234abcd',
    );
  const qdrant = await createEvidence(
      'qdrant',
      '2'.repeat(32),
      'qdrant-20260830T093000Z-5678abcd',
    );
  const challenge = '9'.repeat(64);
  const attestationPath = join(evidenceDirectory, 'backup-payload-attestation.json');
  const attesterArguments = [
    attesterPath,
    '--postgres-status', postgres.statusPath,
    '--postgres-manifest', postgres.manifestPath,
    '--postgres-root', join(root, 'offhost'),
    '--qdrant-status', qdrant.statusPath,
    '--qdrant-manifest', qdrant.manifestPath,
    '--qdrant-root', join(root, 'offhost'),
    '--challenge', challenge,
  ];
  await Promise.all([
    hardenEvidenceTree(join(root, 'offhost')),
    hardenEvidenceTree(evidenceDirectory),
  ]);
  if (!attesterNegativeChecked) {
    const expectAttesterRejection = (arguments_, output, label) => {
      const rejected = spawnSync(realPythonExecutable, [
        ...arguments_,
        '--output', output,
      ], { encoding: 'utf8', windowsHide: true });
      assert.notEqual(rejected.status, 0, `backup attester accepted ${label}`);
      assert.equal(existsSync(output), false, `backup attester published ${label}`);
      assert.match(
        rejected.stderr,
        /safe directory|unsafe|reparse|trusted path|write access|unexpected principal/i,
        `${label}: ${rejected.stderr}`,
      );
    };
    const snapshot = join(dirname(qdrant.manifestPath), 'song_audio.snapshot');
    const original = await readFile(snapshot);
    try {
      await writeFile(snapshot, Buffer.concat([original, Buffer.from('corrupt')]));
      const corruptOutput = join(evidenceDirectory, 'must-not-attest-corrupt.json');
      const rejected = spawnSync(realPythonExecutable, [
        ...attesterArguments,
        '--output', corruptOutput,
      ], { encoding: 'utf8', windowsHide: true });
      assert.notEqual(rejected.status, 0, 'backup attester accepted a corrupt snapshot');
      assert.equal(existsSync(corruptOutput), false, 'backup attester published a corrupt snapshot');
    } finally {
      await writeFile(snapshot, original);
    }

    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const removeDirectoryLink = target => (
      process.platform === 'win32' ? rmdir(target) : unlink(target)
    );
    const qdrantExport = dirname(qdrant.manifestPath);
    const qdrantRealExport = join(dirname(qdrantExport), 'qdrant-real-export-target');
    await rename(qdrantExport, qdrantRealExport);
    try {
      await symlink(qdrantRealExport, qdrantExport, linkType);
      const exportArguments = [...attesterArguments];
      exportArguments[exportArguments.indexOf('--qdrant-manifest') + 1]
        = join(qdrantRealExport, 'manifest.json');
      expectAttesterRejection(
        exportArguments,
        join(evidenceDirectory, 'must-not-attest-export-junction.json'),
        'a canonical export leaf junction',
      );
    } finally {
      if (existsSync(qdrantExport)) await removeDirectoryLink(qdrantExport);
      await rename(qdrantRealExport, qdrantExport);
    }

    const allowedRoot = join(root, 'offhost');
    const allowedRootJunction = join(root, 'offhost-root-junction');
    try {
      await symlink(allowedRoot, allowedRootJunction, linkType);
      const rootArguments = [...attesterArguments];
      rootArguments[rootArguments.indexOf('--postgres-root') + 1] = allowedRootJunction;
      rootArguments[rootArguments.indexOf('--qdrant-root') + 1] = allowedRootJunction;
      expectAttesterRejection(
        rootArguments,
        join(evidenceDirectory, 'must-not-attest-root-junction.json'),
        'an allowed-root leaf junction',
      );
    } finally {
      if (existsSync(allowedRootJunction)) await removeDirectoryLink(allowedRootJunction);
    }
    if (process.platform === 'win32') {
      const verifierGrandparent = dirname(dirname(attesterPath));
      assertFixtureContainment(verifierGrandparent);
      const originalAcl = windowsAclSddl(verifierGrandparent);
      try {
        addWindowsUnknownSidRule(verifierGrandparent, 0x40);
        expectAttesterRejection(
          attesterArguments,
          join(evidenceDirectory, 'must-not-attest-unsafe-grandparent.json'),
          'a verifier with an ancestor replaceable through DELETE_CHILD',
        );
      } finally {
        restoreWindowsAclSddl(verifierGrandparent, originalAcl);
      }

      const safeAncestorOutput = join(evidenceDirectory, 'safe-create-sibling-ancestor.json');
      try {
        addWindowsUnknownSidRule(verifierGrandparent, 0x04);
        const accepted = spawnSync(realPythonExecutable, [
          ...attesterArguments,
          '--output', safeAncestorOutput,
        ], { encoding: 'utf8', windowsHide: true });
        assert.equal(
          accepted.status,
          0,
          `backup attester rejected a create-sibling-only ancestor:\n`
            + `${accepted.stdout}\n${accepted.stderr}`,
        );
        assert.equal(existsSync(safeAncestorOutput), true);
      } finally {
        if (existsSync(safeAncestorOutput)) await unlink(safeAncestorOutput);
        restoreWindowsAclSddl(verifierGrandparent, originalAcl);
      }
      assertWindowsTreeOwnedAndNotReparse(verifierGrandparent);
    }
    attesterNegativeChecked = true;
  }
  const attestationResult = spawnSync(realPythonExecutable, [
    ...attesterArguments,
    '--output', attestationPath,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(
    attestationResult.status,
    0,
    `backup attester failed:\n${attestationResult.stdout}\n${attestationResult.stderr}`,
  );
  let attestationBytes = await readFile(attestationPath);
  const attestation = JSON.parse(attestationBytes.toString('utf8'));
  // The normal matrix already executes the complete build/scan path for
  // writer-active. Reuse it for the >15-minute liveness regression instead of
  // duplicating that expensive path in every full test run.
  if (scenario === 'bridge-attestation-prep-over-15m' || scenario === 'writer-active') {
    attestation.verifiedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    attestationBytes = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`, 'utf8');
    await writeFile(attestationPath, attestationBytes);
  } else if (scenario === 'bridge-attestation-at-4h') {
    attestation.verifiedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    attestationBytes = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`, 'utf8');
    await writeFile(attestationPath, attestationBytes);
  }
  const bridgeCreatedAt = scenario === 'bridge-attestation-prep-over-15m'
      || scenario === 'writer-active'
    ? new Date(Date.parse(attestation.verifiedAt) + 20 * 60 * 1000).toISOString()
    : scenario === 'bridge-attestation-at-4h'
      ? new Date(Date.parse(attestation.verifiedAt) + 4 * 60 * 60 * 1000).toISOString()
    : scenario === 'bridge-attestation-new-mismatch'
      ? new Date(Date.parse(attestation.verifiedAt) - 20 * 60 * 1000).toISOString()
      : undefined;
  return {
    postgres,
    qdrant,
    attestation: {
      path: attestationPath,
      sha: sha256(attestationBytes),
      challenge,
      verifierHost: attestation.verifierHost,
    },
    bridgeCreatedAt,
  };
}

async function createScenario(name) {
  await prepareFixtureBase();
  const root = await mkdtemp(join(fixtureBase, `.stateful-hardening-test-${name}-`));
  fixtureRoots.push(root);
  const fixtureProject = join(root, 'project');
  const fixturePipeline = join(root, 'pipeline');
  const fixtureScripts = join(fixtureProject, 'scripts');
  const fixtureQdrant = join(fixtureProject, 'backend', 'qdrant');
  const fixtureDatabase = join(fixtureProject, 'backend', 'database');
  const fixturePipelineUtils = join(fixturePipeline, 'ml_pipeline', 'utils');
  const fixturePipelineVenvBin = join(fixturePipeline, 'ml_pipeline', '.venv', 'bin');
  const fixtureGithubHome = join(root, 'github-home');
  const fixtureGithubSsh = join(fixtureGithubHome, '.ssh');
  const fixtureGithubIdentity = join(
    fixtureGithubSsh,
    'id_ed25519_diva_data_pipeline_github',
  );
  const fixtureHardeningScript = join(fixtureScripts, 'harden-sbc-stateful-services.sh');
  const fixtureBackupAttester = join(fixtureScripts, 'attest-disaster-backup-payloads.py');
  const fixtureQdrantUpgradeController = join(fixtureScripts, 'sbc-qdrant-storage-upgrade.py');
  const fixtureApiBridgeReceiptHelper = join(fixtureScripts, 'wsl-dr-api-bridge-receipt.py');
  const fixtureApiBridgeConsumptionHelper = join(fixtureScripts, 'sbc-api-bridge-consumption.py');
  const fixtureQdrantDockerfile = join(fixtureQdrant, 'Dockerfile');
  const fixtureQdrantAuditContractHelper = join(fixtureQdrant, 'audit-contract.sh');
  const fixturePostgresDockerfile = join(fixtureDatabase, 'Dockerfile.pgvector');
  const fixturePostgresMigrateDockerfile = join(fixtureDatabase, 'Dockerfile.migrate');
  const fixturePostgresSchema = join(fixtureDatabase, 'schema.sql');
  const fixtureImageScanValidator = join(fixtureScripts, 'validate-container-image-scan.py');
  const bin = join(root, 'bin');
  const fakeState = join(root, 'fake-state');
  const containers = join(fakeState, 'containers');
  const stateRoot = join(root, 'deploy-state');
  await Promise.all([
    mkdir(bin),
    mkdir(containers, { recursive: true }),
    mkdir(stateRoot),
    mkdir(fixtureScripts, { recursive: true }),
    mkdir(fixtureQdrant, { recursive: true }),
    mkdir(fixtureDatabase, { recursive: true }),
    mkdir(fixturePipeline, { recursive: true }),
    mkdir(fixturePipelineUtils, { recursive: true }),
    mkdir(fixturePipelineVenvBin, { recursive: true }),
    mkdir(fixtureGithubSsh, { recursive: true }),
  ]);
  await Promise.all([
    writeExecutable(fixtureHardeningScript, hardeningSource),
    writeExecutable(fixtureBackupAttester, backupAttesterSource),
    writeExecutable(fixtureQdrantUpgradeController, qdrantUpgradeControllerSource),
    writeExecutable(fixtureApiBridgeReceiptHelper, apiBridgeReceiptHelperSource),
    writeExecutable(fixtureApiBridgeConsumptionHelper, apiBridgeConsumptionHelperSource),
    writeFile(fixtureQdrantDockerfile, qdrantDockerfileSource, 'utf8'),
    writeFile(join(fixtureQdrant, '.dockerignore'), qdrantDockerignoreSource, 'utf8'),
    writeFile(fixtureQdrantAuditContractHelper, qdrantAuditContractHelperSource, 'utf8'),
    writeFile(fixturePostgresDockerfile, postgresDockerfileSource, 'utf8'),
    writeFile(fixturePostgresMigrateDockerfile, postgresMigrateDockerfileSource, 'utf8'),
    writeFile(join(fixtureDatabase, '.dockerignore'), postgresDockerignoreSource, 'utf8'),
    writeFile(fixturePostgresSchema, postgresSchemaSource.replaceAll('\r\n', '\n'), 'utf8'),
    writeFile(fixtureImageScanValidator, imageScanValidatorSource, 'utf8'),
    writeFile(join(fixtureProject, '.gitignore'), 'backend/.env\n', 'utf8'),
    writeFile(join(fixtureProject, 'backend', 'docker-compose.yml'), 'services: {}\n', 'utf8'),
    writeFile(join(fixtureProject, 'backend', '.env'), 'TEST_ONLY=true\n', 'utf8'),
    writeFile(join(stateRoot, 'backend.env.private'), 'FIXTURE_SECRET=must-be-unlinked\n', 'utf8'),
    writeFile(join(fixturePipeline, 'fixture.txt'), 'pipeline fixture\n', 'utf8'),
    writeFile(join(fixturePipeline, '.gitignore'), 'ml_pipeline/logs/\n', 'utf8'),
    writeFile(join(fixturePipelineUtils, 'pipeline_lock.py'), '# pipeline lock fixture\n', 'utf8'),
    writeFile(join(fixturePipelineUtils, 'runtime_contracts.py'), '# runtime contract fixture\n', 'utf8'),
    writeFile(join(fixturePipelineUtils, 'qdrant_cleanup.py'), '# cleanup fixture\n', 'utf8'),
    writeFile(join(fixturePipeline, 'ml_pipeline', '.ml-runtime-use.lock'), 'fixture runtime lock\n', 'utf8'),
    writeFile(join(fixturePipeline, 'ml_pipeline', '.venv', '.diva-runtime-receipt.json'), '{}\n', 'utf8'),
    writeFile(join(fixturePipeline, 'ml_pipeline', 'requirements.linux-aarch64-cp310.lock.txt'), 'fixture lock\n', 'utf8'),
    writeFile(join(fixturePipeline, 'ml_pipeline', 'verify_production_ml_runtime.py'), '# verifier fixture\n', 'utf8'),
    writeFile(join(fixturePipeline, 'ml_pipeline', 'patch_tensorflow_hub_compat.py'), '# patcher fixture\n', 'utf8'),
    writeFile(join(fakeState, 'trusted-git-player-root'), `${shellPath(fixtureProject)}\n`, 'utf8'),
    writeFile(join(fakeState, 'trusted-git-pipeline-root'), `${shellPath(fixturePipeline)}\n`, 'utf8'),
    writeFile(fixtureGithubIdentity, 'fixture-private-identity-material\n', 'utf8'),
    writeFile(
      join(fixtureGithubSsh, 'config'),
      'Host github.com\n  ProxyCommand must-not-run-user-ssh-config\n',
      'utf8',
    ),
    writeFile(join(fixtureGithubSsh, 'known_hosts'), 'must-not-use-user-known-hosts\n', 'utf8'),
    writeFile(
      join(fakeState, 'hostile-global-gitconfig'),
      '[safe]\n\tdirectory = *\n[core]\n\tfsmonitor = true\n',
      'utf8',
    ),
  ]);
  // Production only accepts an owner-only persistent Compose binding.  Keep
  // the nominal fixture on that exact POSIX contract so the success case does
  // not rely on the test runner's default umask.
  await chmod(join(fixtureProject, 'backend', '.env'), 0o600);
  await chmod(fixtureGithubHome, 0o700);
  await chmod(fixtureGithubSsh, 0o700);
  await Promise.all([
    chmod(fixtureGithubIdentity, 0o600),
    chmod(join(fixtureGithubSsh, 'config'), 0o600),
    chmod(join(fixtureGithubSsh, 'known_hosts'), 0o600),
  ]);

  const commands = {
    git: fakeGit,
    docker: fakeDocker,
    curl: fakeCurl,
    python: fakePython,
    sleep: fakeSleep,
    timeout: fakeTimeout,
    trivy: fakeTrivy,
    mkdir: fakeMkdir,
    stat: fakeStat,
    sync: fakeSync,
    sha256sum: fakeSha256sum,
    flock: fakeFlock,
    setpriv: fakeSetpriv,
  };
  await Promise.all(Object.entries(commands).map(([command, content]) => (
    writeExecutable(join(bin, command), content)
  )));
  await writeExecutable(join(fixturePipelineVenvBin, 'python'), fakePipelineVenvPython);
  const validatorPath = join(root, 'validate-evidence.cjs');
  const qdrantControllerRunnerPath = join(root, 'fake-qdrant-controller.py');
  await writeFile(validatorPath, evidenceValidator, 'utf8');
  await writeFile(qdrantControllerRunnerPath, fakeQdrantControllerRunner, 'utf8');

  const playerCommit = initializeFixtureRepository(
    fixtureProject,
    'player fixture',
    playerOfficialOrigin,
  );
  const pipelineCommit = initializeFixtureRepository(
    fixturePipeline,
    'pipeline fixture',
    pipelineOfficialOrigin,
  );
  await Promise.all([
    writeFile(join(fakeState, 'trusted-git-player-head'), `${playerCommit}\n`, 'utf8'),
    writeFile(join(fakeState, 'trusted-git-pipeline-head'), `${pipelineCommit}\n`, 'utf8'),
  ]);
  await hardenVerifierPath(fixtureBackupAttester);

  const initialContainers = {
    'vocadb_qdrant.id': ids.oldQdrant,
    'vocadb_qdrant.image': `sha256:${'7'.repeat(64)}`,
    'vocadb_qdrant.running': 'true',
    'vocadb_qdrant.project': 'backend',
    'vocadb_qdrant.service': 'qdrant',
    'vocadb_qdrant.volume': 'backend_qdrant_data',
    'vocadb_qdrant.destination': '/qdrant/storage',
    'vocadb_qdrant.network': 'backend_default',
    'vocadb_qdrant.aliases': 'qdrant',
    'vocadb_qdrant.user': '0:0',
    'vocadb_qdrant.restart': 'unless-stopped',
    'vocadb_qdrant.config': '9'.repeat(64),
    'vocadb_postgres.id': ids.oldPostgres,
    'vocadb_postgres.image': `sha256:${'8'.repeat(64)}`,
    'vocadb_postgres.running': 'true',
    'vocadb_postgres.project': 'backend',
    'vocadb_postgres.service': 'postgres',
    'vocadb_postgres.volume': 'backend_postgres_data',
    'vocadb_postgres.destination': '/var/lib/postgresql/data',
    'vocadb_postgres.network': 'backend_default',
    'vocadb_postgres.aliases': 'postgres',
    'vocadb_postgres.user': '999:999',
    'vocadb_postgres.restart': 'unless-stopped',
    'vocadb_api_a.id': '3'.repeat(64),
    'vocadb_api_a.image': `sha256:${'1'.repeat(64)}`,
    'vocadb_api_a.running': 'true',
    'vocadb_api_a.config': '4'.repeat(64),
    'vocadb_api_b.id': '5'.repeat(64),
    'vocadb_api_b.image': `sha256:${'1'.repeat(64)}`,
    'vocadb_api_b.running': 'true',
    'vocadb_api_b.config': '6'.repeat(64),
    'vocadb_api_gateway.id': 'c0'.repeat(32),
    'vocadb_api_gateway.image': `sha256:${'3'.repeat(64)}`,
    'vocadb_api_gateway.running': 'true',
    'vocadb_api_gateway.config': '7'.repeat(64),
    'vocadb_api_gateway.reference': 'diva-player-api-gateway:local',
    'vocadb_web.id': 'd0'.repeat(32),
    'vocadb_web.image': `sha256:${'5'.repeat(64)}`,
    'vocadb_web.running': 'true',
    'vocadb_web.config': '8'.repeat(64),
    'vocadb_web.reference': 'diva-player-web:local',
  };
  await Promise.all(Object.entries(initialContainers).map(([file, value]) => (
    writeFile(join(containers, file), `${value}\n`, 'utf8')
  )));
  if (!name.startsWith('stable-tag-absent')) {
    await writeFile(join(fakeState, 'stable-image-id'), `${ids.oldStableQdrantImage}\n`, 'utf8');
  }
  const evidence = await writeEvidence(
    root,
    playerCommit,
    pipelineCommit,
    fixtureBackupAttester,
    name,
  );
  const bridge = await createBridgeEvidence(
    fixtureProject,
    stateRoot,
    playerCommit,
    evidence,
  );
  return {
    root,
    bin,
    fakeState,
    containers,
    stateRoot,
    fixtureProject,
    fixturePipeline,
    fixtureGithubHome,
    fixtureGithubIdentity,
    fixturePipelinePython: join(fixturePipelineVenvBin, 'python'),
    validatorPath,
    qdrantControllerRunnerPath,
    evidence,
    bridge,
    hardeningScript: fixtureHardeningScript,
    qdrantDockerfile: fixtureQdrantDockerfile,
    postgresDockerfile: fixturePostgresDockerfile,
    postgresMigrateDockerfile: fixturePostgresMigrateDockerfile,
    postgresSchema: fixturePostgresSchema,
  };
}

async function findRunDirectory(stateRoot) {
  const entries = await readdir(stateRoot, { withFileTypes: true });
  const runs = entries.filter(entry => (
    entry.isDirectory() && /^stateful-[0-9]{8}T[0-9]{6}Z-[0-9]+$/u.test(entry.name)
  ));
  assert.ok(runs.length <= 1, 'expected at most one stateful run directory');
  return runs.length === 1 ? join(stateRoot, runs[0].name) : null;
}

async function readRunState(runDirectory) {
  return runDirectory ? readFile(join(runDirectory, 'state'), 'utf8') : '';
}

function runArtifactRemains(runDirectory, name) {
  return runDirectory ? existsSync(join(runDirectory, name)) : false;
}

async function readRunArtifact(runDirectory, name) {
  return runDirectory ? readFile(join(runDirectory, name), 'utf8') : '';
}

function sensitiveComposeArtifactsRemain(runDirectory) {
  return runArtifactRemains(runDirectory, 'resolved-compose.private.json');
}

async function readContainers(directory) {
  const entries = await readdir(directory).catch(() => []);
  const result = {};
  for (const entry of entries.filter(item => item.endsWith('.id'))) {
    result[entry.slice(0, -3)] = (await readFile(join(directory, entry), 'utf8')).trim();
  }
  return result;
}

async function waitForDelayedMutation(fakeState, scenario) {
  if (!delayedMutationScenarios.has(scenario)) return;
  const marker = join(fakeState, 'delayed-mutation-done');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(marker)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`delayed Docker mutation did not complete for ${scenario}`);
}

async function runScenario(name) {
  console.log(`CASE ${name}`);
  const scenario = await createScenario(name);
  try {
    const existingJournal = name === 'invalid-evidence-existing-journal'
      ? 'existing-stateful-run-owned-by-another-process\n'
      : '';
    if (existingJournal) {
      await writeFile(join(scenario.stateRoot, 'stateful-hardening-active'), existingJournal, 'utf8');
    }
    if (name === 'orphan-publication-journal') {
      const journalDirectory = join(scenario.fixturePipeline, 'ml_pipeline', 'logs');
      await mkdir(journalDirectory, { recursive: true });
      await writeFile(join(journalDirectory, 'recommendation_publication_journal.json'), '{}\n');
    }
    if (name === 'invalid-payload-attestation') {
      await writeFile(scenario.evidence.attestation.path, '{"tampered":true}\n', 'utf8');
    }
    if (name === 'attester-verifier-head-mismatch') {
      const attestation = JSON.parse(await readFile(scenario.evidence.attestation.path, 'utf8'));
      attestation.verifierSha256 = '0'.repeat(64);
      const bytes = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`, 'utf8');
      await writeFile(scenario.evidence.attestation.path, bytes);
      scenario.evidence.attestation.sha = sha256(bytes);
    }
    if (name === 'bridge-scan-receipt-missing') {
      await rm(join(scenario.bridge.imageScanRoot, 'gateway.receipt.json'));
    }
    if (name === 'bridge-scan-receipt-tampered') {
      await writeFile(
        join(scenario.bridge.imageScanRoot, 'web.receipt.json'),
        '{"imageId":"sha256:tampered","service":"web","status":"passed"}\n',
        'utf8',
      );
    }
    if (name === 'bridge-stateless-identity-mismatch') {
      await writeFile(
        join(scenario.containers, 'vocadb_api_gateway.id'),
        `${'c1'.repeat(32)}\n`,
        'utf8',
      );
    }
    if (name === 'assume-unchanged-pipeline-source') {
      runFixtureGit(scenario.fixturePipeline, [
        'update-index',
        '--assume-unchanged',
        'ml_pipeline/utils/pipeline_lock.py',
      ]);
    }
    if (name === 'skip-worktree-pipeline-source') {
      runFixtureGit(scenario.fixturePipeline, [
        'update-index',
        '--skip-worktree',
        'ml_pipeline/utils/pipeline_lock.py',
      ]);
    }
    if (name === 'pipeline-origin-alias') {
      runFixtureGit(scenario.fixturePipeline, [
        'remote',
        'set-url',
        'origin',
        'git@github-diva-data-pipeline:conei7/diva-data-pipeline.git',
      ]);
    }
    const env = {
      ...process.env,
      HOME: shellPath(join(scenario.root, 'hostile-home')),
      SSH_AUTH_SOCK: shellPath(join(scenario.root, 'hostile-agent.sock')),
      SSH_AGENT_PID: '999999',
      GIT_SSH_COMMAND: 'must-not-run-hostile-git-ssh-command',
      GIT_SSH_VARIANT: 'plink',
      GIT_CONFIG_GLOBAL: shellPath(join(scenario.fakeState, 'hostile-global-gitconfig')),
      GIT_CONFIG: shellPath(join(scenario.fakeState, 'hostile-global-gitconfig')),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
      GIT_CONFIG_PARAMETERS: "'safe.directory'='*'",
      GIT_ASKPASS: shellPath(join(scenario.fakeState, 'must-not-run-askpass')),
      GIT_TERMINAL_PROMPT: '1',
      GIT_SSL_NO_VERIFY: 'true',
      GIT_SSL_CAINFO: shellPath(join(scenario.fakeState, 'hostile-ca.pem')),
      GIT_SSL_CAPATH: shellPath(join(scenario.fakeState, 'hostile-ca-directory')),
      GIT_PROXY_COMMAND: shellPath(join(scenario.fakeState, 'hostile-git-proxy')),
      HTTPS_PROXY: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      http_proxy: 'http://127.0.0.1:9',
      ALL_PROXY: 'socks5://127.0.0.1:9',
      all_proxy: 'socks5://127.0.0.1:9',
      NO_PROXY: 'github.com',
      no_proxy: 'github.com',
      DIVA_STATEFUL_TEST_MODE: '1',
      DIVA_DOCKER_COMMAND: shellPath(join(scenario.bin, 'docker')),
      DIVA_CURL_COMMAND: shellPath(join(scenario.bin, 'curl')),
      DIVA_PYTHON_COMMAND: shellPath(join(scenario.bin, 'python')),
      DIVA_SLEEP_COMMAND: shellPath(join(scenario.bin, 'sleep')),
      DIVA_TIMEOUT_COMMAND: timeoutFaultScenarios.has(name)
        ? shellPath(join(scenario.bin, 'timeout'))
        : '/usr/bin/timeout',
      DIVA_TRIVY_COMMAND: shellPath(join(scenario.bin, 'trivy')),
      DIVA_TRIVY_CACHE_DIR: shellPath(join(scenario.stateRoot, 'trivy-cache')),
      DIVA_STATEFUL_STATE_DIR: shellPath(scenario.stateRoot),
      DIVA_STATEFUL_HEALTH_ATTEMPTS: '3',
      DIVA_STATEFUL_WAIT_SECONDS: '1',
      DIVA_STATEFUL_READ_TIMEOUT_SECONDS: '10',
      DIVA_STATEFUL_FINGERPRINT_TIMEOUT_SECONDS: '10',
      DIVA_STATEFUL_MUTATION_TIMEOUT_SECONDS: '10',
      DIVA_QDRANT_UPGRADE_TIMEOUT_SECONDS: name === 'qdrant-controller-timeout'
        ? '2'
        : '21600',
      DIVA_STATEFUL_DATA_MUTATION_TIMEOUT_SECONDS: '10',
      DIVA_STATEFUL_BUILD_TIMEOUT_SECONDS: '10',
      DIVA_STATEFUL_DAEMON_SETTLE_ATTEMPTS: '3',
      DIVA_STATEFUL_DAEMON_STABLE_SAMPLES: '2',
      DIVA_STATEFUL_WRITER_SETTLE_SECONDS: '1',
      DIVA_STATEFUL_TEST_CONTROLLER_PYTHON: realPythonExecutable,
      DIVA_STATEFUL_TEST_CONTROLLER_RUNNER: shellPath(scenario.qdrantControllerRunnerPath),
      DIVA_STATEFUL_TEST_CONTROLLER_STATE: shellPath(scenario.fakeState),
      DIVA_PIPELINE_ROOT: shellPath(scenario.fixturePipeline),
      DIVA_PIPELINE_PYTHON: shellPath(scenario.fixturePipelinePython),
      DIVA_PIPELINE_VENV: shellPath(join(scenario.fixturePipeline, 'ml_pipeline', '.venv')),
      DIVA_STATEFUL_TEST_GITHUB_USER: 'fixture-owner',
      DIVA_STATEFUL_TEST_GITHUB_HOME: shellPath(scenario.fixtureGithubHome),
      DIVA_STATEFUL_TEST_GITHUB_IDENTITY: shellPath(scenario.fixtureGithubIdentity),
      DIVA_FLOCK_COMMAND: shellPath(join(scenario.bin, 'flock')),
      DIVA_SETPRIV_COMMAND: shellPath(join(scenario.bin, 'setpriv')),
      DIVA_API_BRIDGE_RECEIPT: shellPath(scenario.bridge.receiptPath),
      DIVA_EXPECTED_BACKUP_SOURCE_HOST: 'test-sbc',
      DIVA_VERIFIED_POSTGRES_BACKUP_RUN_ID: scenario.evidence.postgres.runId,
      DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_FILE: shellPath(scenario.evidence.postgres.statusPath),
      DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_SHA256: existingJournal
        ? '0'.repeat(64)
        : scenario.evidence.postgres.statusSha,
      DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_FILE: shellPath(scenario.evidence.postgres.manifestPath),
      DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_SHA256: scenario.evidence.postgres.manifestSha,
      DIVA_VERIFIED_QDRANT_BACKUP_RUN_ID: scenario.evidence.qdrant.runId,
      DIVA_VERIFIED_QDRANT_BACKUP_STATUS_FILE: shellPath(scenario.evidence.qdrant.statusPath),
      DIVA_VERIFIED_QDRANT_BACKUP_STATUS_SHA256: scenario.evidence.qdrant.statusSha,
      DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_FILE: shellPath(scenario.evidence.qdrant.manifestPath),
      DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_SHA256: scenario.evidence.qdrant.manifestSha,
      DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_FILE: shellPath(scenario.evidence.attestation.path),
      DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_SHA256: scenario.evidence.attestation.sha,
      DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_CHALLENGE: scenario.evidence.attestation.challenge,
      DIVA_EXPECTED_BACKUP_VERIFIER_HOST: scenario.evidence.attestation.verifierHost,
      FAKE_STATE: shellPath(scenario.fakeState),
      FAKE_SCENARIO: name,
      FAKE_NODE_COMMAND: shellPath(process.execPath),
      FAKE_EVIDENCE_VALIDATOR: shellPath(scenario.validatorPath),
      FAKE_REAL_PYTHON: shellPath(realPythonExecutable),
      DIVA_STATEFUL_TEST_LEGACY_SCAN_CONTRACT: name === 'legacy-scan-calibration'
        ? 'unreviewed'
        : 'reviewed',
      DIVA_STATEFUL_TEST_QDRANT_FINDING_SHA256: name === 'legacy-scan-reviewed'
        ? legacyFindingDigests.qdrant
        : name === 'legacy-scan-unexpected'
          ? '0'.repeat(64)
          : '',
      DIVA_STATEFUL_TEST_POSTGRES_FINDING_SHA256: name === 'legacy-scan-reviewed'
        ? legacyFindingDigests.postgres
        : name === 'legacy-scan-unexpected'
          ? '0'.repeat(64)
          : '',
      // A focused success run verifies the end-to-end control flow, not the
      // validator's already-separate exact-report contract. Keep the full
      // matrix on the exact path unless its caller explicitly opts into fast
      // validation, while making the Windows-focused smoke bounded by default.
      FAKE_FAST_IMAGE_SCAN: name !== 'success'
        && name !== 'legacy-scan-reviewed'
        && name !== 'legacy-scan-unexpected'
        || process.env.DIVA_STATEFUL_TEST_FAST_SUCCESS === '1'
        || (
          process.env.DIVA_STATEFUL_TEST_CASE === 'success'
          && process.env.DIVA_STATEFUL_TEST_FAST_SUCCESS !== '0'
        )
        ? '1'
        : '0',
      FAKE_QDRANT_CONTROLLER_RUNNER: shellPath(scenario.qdrantControllerRunnerPath),
      FAKE_QDRANT_DOCKERFILE: shellPath(scenario.qdrantDockerfile),
      FAKE_POSTGRES_DOCKERFILE: shellPath(scenario.postgresDockerfile),
      FAKE_POSTGRES_MIGRATE_DOCKERFILE: shellPath(scenario.postgresMigrateDockerfile),
      FAKE_POSTGRES_SCHEMA: shellPath(scenario.postgresSchema),
      FAKE_API_BRIDGE_WRAPPER: shellPath(scenario.bridge.wrapperPath),
    };
    const result = spawnSync(bashCommand, [
      '-c',
      'PATH="$1:/mingw64/bin:/usr/bin:/bin"; export PATH; exec "$2"',
      'stateful-hardening-test',
      shellPath(scenario.bin),
      shellPath(scenario.hardeningScript),
    ], {
      cwd: projectDirectory,
      env,
      encoding: 'utf8',
      // Focused smoke tests must never monopolize a developer workstation.
      // The full fault matrix retains its larger exact-scan allowance.
      // Fixture construction and ACL restoration also consume wall time, so
      // leave headroom under the two-minute focused-test budget.
      timeout: process.env.DIVA_STATEFUL_TEST_CASE === 'qdrant-controller-timeout'
        ? 120_000
        : new Set(['success', 'legacy-scan-reviewed', 'gate-release-timeout']).has(
          process.env.DIVA_STATEFUL_TEST_CASE,
        )
          ? 600_000
        : new Set([
          'backup-expires-before-writer-gate',
        ]).has(
          process.env.DIVA_STATEFUL_TEST_CASE,
        )
          ? 600_000
        : new Set([
          'bridge-attestation-prep-over-15m',
          'legacy-scan-calibration',
          'legacy-scan-unexpected',
          'candidate-scan-finding',
        ]).has(
          process.env.DIVA_STATEFUL_TEST_CASE,
        )
          ? 240_000
          : process.env.DIVA_STATEFUL_TEST_CASE
            ? 90_000
            : 600_000,
      windowsHide: true,
    });
    await waitForDelayedMutation(scenario.fakeState, name);
    if (name === 'qdrant-controller-timeout' && process.platform !== 'win32') {
      await new Promise(resolve => setTimeout(resolve, 4_000));
    }
    const runDirectory = await findRunDirectory(scenario.stateRoot);
    const [
      state,
      dockerLog,
      timeoutLog,
      sleepLog,
      pythonLog,
      containers,
      stableImageId,
      rollbackImageId,
      rollbackPostgresImageId,
      qdrantScanCalibration,
      postgresScanCalibration,
      trivyScanLog,
      promotionManifest,
      trustedGitLog,
      pipelineRemoteBoundary,
      runtimeContract,
      sensitiveComposeArtifactRemains,
      backendEnvBackupRemains,
      controllerSettlement,
    ] = await Promise.all([
      readRunState(runDirectory).catch(() => ''),
      readFile(join(scenario.fakeState, 'docker.log'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'timeout.log'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'sleep.log'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'python.log'), 'utf8').catch(() => ''),
      readContainers(scenario.containers),
      readFile(join(scenario.fakeState, 'stable-image-id'), 'utf8').then(value => value.trim()).catch(() => 'absent'),
      readFile(join(scenario.fakeState, 'rollback-image-id'), 'utf8').then(value => value.trim()).catch(() => 'absent'),
      readFile(join(scenario.fakeState, 'rollback-postgres-image-id'), 'utf8').then(value => value.trim()).catch(() => 'absent'),
      readRunArtifact(runDirectory, join('evidence', 'image-scan-qdrant-rollback.calibration.json')).catch(() => ''),
      readRunArtifact(runDirectory, join('evidence', 'image-scan-postgres-rollback.calibration.json')).catch(() => ''),
      readFile(join(scenario.fakeState, 'trivy-scan.log'), 'utf8').catch(() => ''),
      readRunArtifact(runDirectory, 'promotion-transaction').catch(() => ''),
      readFile(join(scenario.fakeState, 'trusted-git.log'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'pipeline-remote-boundary.log'), 'utf8').catch(() => ''),
      readFile(join(scenario.stateRoot, 'stateful-runtime-contract'), 'utf8').catch(() => ''),
      sensitiveComposeArtifactsRemain(runDirectory),
      runArtifactRemains(
        runDirectory,
        'backend.env.before-qdrant-volume',
      ),
      readRunArtifact(
        runDirectory,
        'qdrant-storage-upgrade-controller-settlement.json',
      ).catch(() => ''),
    ]);
    const [backendEnvStatus, projectStatus, backendEnvContent] = await Promise.all([
      lstat(join(scenario.fixtureProject, 'backend', '.env')),
      lstat(scenario.fixtureProject),
      readFile(join(scenario.fixtureProject, 'backend', '.env'), 'utf8'),
    ]);
    const journalPath = join(scenario.stateRoot, 'stateful-hardening-active');
    const journalExists = existsSync(journalPath);
    const journalContent = journalExists ? await readFile(journalPath, 'utf8') : '';
    const interlockExists = existsSync(join(scenario.stateRoot, 'stateful-hardening.lock'));
    const writerGateExists = existsSync(join(scenario.fakeState, 'writer-gate'));
    const writerRolesLocked = existsSync(join(scenario.fakeState, 'writer-roles-locked'));
    const githubTrustRemains = (await readdir(scenario.stateRoot))
      .some(entry => entry.startsWith('github-known-hosts-'));
    const run = {
      result,
      runDirectoryExists: runDirectory !== null,
      state,
      dockerLog,
      timeoutLog,
      sleepLog,
      pythonLog,
      containers,
      stableImageId,
      rollbackImageId,
      rollbackPostgresImageId,
      qdrantScanCalibration,
      postgresScanCalibration,
      trivyScanLog,
      promotionManifest,
      trustedGitLog,
      pipelineRemoteBoundary,
      runtimeContract,
      backendEnvContent,
      backendEnvMetadata: {
        uid: backendEnvStatus.uid,
        gid: backendEnvStatus.gid,
        mode: backendEnvStatus.mode & 0o777,
        nlink: backendEnvStatus.nlink,
        repositoryUid: projectStatus.uid,
        repositoryGid: projectStatus.gid,
      },
      journalExists,
      journalContent,
      interlockExists,
      writerGateExists,
      writerRolesLocked,
      githubTrustRemains,
      ephemeralCacheMutated: existsSync(join(scenario.fakeState, 'ephemeral-cache-mutated')),
      sensitiveComposeArtifactRemains,
      privateBackendEnvRemains: existsSync(join(scenario.stateRoot, 'backend.env.private')),
      backendEnvBackupRemains,
      controllerSettlement,
      lateControllerMutation: existsSync(join(scenario.fakeState, 'late-controller-mutation')),
    };
    assert.equal(
      run.runDirectoryExists,
      !preRunRejectionScenarios.has(name),
      `unexpected RUN_DIR presence for ${name}:\n${diagnostic(run)}`,
    );
    return run;
  } finally {
    // Git Bash can retain transient Windows handles briefly.  The pre-push
    // harness removes these isolated, uniquely named fixtures after Node exits.
  }
}

function diagnostic(run) {
  return JSON.stringify({
    status: run.result.status,
    signal: run.result.signal,
    error: run.result.error?.message,
    stdout: run.result.stdout,
    stderr: run.result.stderr,
    runDirectoryExists: run.runDirectoryExists,
    state: run.state,
    dockerLog: run.dockerLog,
    pythonLog: run.pythonLog,
    timeoutLog: run.timeoutLog,
    sleepLog: run.sleepLog,
    containers: run.containers,
    stableImageId: run.stableImageId,
    rollbackImageId: run.rollbackImageId,
    rollbackPostgresImageId: run.rollbackPostgresImageId,
    qdrantScanCalibration: run.qdrantScanCalibration,
    postgresScanCalibration: run.postgresScanCalibration,
    trivyScanLog: run.trivyScanLog,
    promotionManifest: run.promotionManifest,
    trustedGitLog: run.trustedGitLog,
    pipelineRemoteBoundary: run.pipelineRemoteBoundary,
    runtimeContract: run.runtimeContract,
    backendEnvContent: run.backendEnvContent,
    backendEnvMetadata: run.backendEnvMetadata,
    journalExists: run.journalExists,
    journalContent: run.journalContent,
    interlockExists: run.interlockExists,
    writerGateExists: run.writerGateExists,
    writerRolesLocked: run.writerRolesLocked,
    githubTrustRemains: run.githubTrustRemains,
    ephemeralCacheMutated: run.ephemeralCacheMutated,
    privateBackendEnvRemains: run.privateBackendEnvRemains,
    backendEnvBackupRemains: run.backendEnvBackupRemains,
    controllerSettlement: run.controllerSettlement,
    lateControllerMutation: run.lateControllerMutation,
  }, null, 2);
}

function assertExactOldTopology(run, { postgres = true } = {}) {
  assert.equal(run.containers.vocadb_qdrant, ids.oldQdrant, diagnostic(run));
  if (postgres) assert.equal(run.containers.vocadb_postgres, ids.oldPostgres, diagnostic(run));
  assert.ok(!Object.values(run.containers).includes(ids.newQdrant), diagnostic(run));
  if (postgres) assert.ok(!Object.values(run.containers).includes(ids.newPostgres), diagnostic(run));
}

function assertRollbackImagesRetainedOffline(run) {
  const qdrantImageId = `sha256:${'7'.repeat(64)}`;
  const postgresImageId = `sha256:${'8'.repeat(64)}`;
  assert.equal(run.rollbackImageId, qdrantImageId, diagnostic(run));
  assert.equal(run.rollbackPostgresImageId, postgresImageId, diagnostic(run));
  assert.ok(!Object.values(run.containers).includes(ids.oldQdrant), diagnostic(run));
  assert.ok(!Object.values(run.containers).includes(ids.oldPostgres), diagnostic(run));
  assert.match(
    run.state,
    new RegExp(`qdrant\\.rollback_retained=diva-player-qdrant:rollback-[^:]+:${qdrantImageId}:backend_qdrant_data`),
  );
  assert.match(
    run.state,
    new RegExp(`postgres\\.rollback_retained=diva-player-postgres:rollback-[^:]+:${postgresImageId}:image-only-no-data-rollback`),
  );
  assert.match(run.state, /postgres\.rollback_scan_receipt_sha256=[0-9a-f]{64}/);
  assert.match(
    run.promotionManifest,
    new RegExp(`postgres_rollback_tag=diva-player-postgres:rollback-[^\\n]+\\npostgres_rollback_image_id=${postgresImageId}\\n`),
  );
  assert.match(
    run.promotionManifest,
    /postgres_rollback_scan_receipt_sha256=[0-9a-f]{64}\npostgres_rollback_scope=image-only-no-data-rollback\n/,
  );
  assert.equal(
    run.backendEnvMetadata.uid,
    run.backendEnvMetadata.repositoryUid,
    diagnostic(run),
  );
  assert.equal(
    run.backendEnvMetadata.gid,
    run.backendEnvMetadata.repositoryGid,
    diagnostic(run),
  );
  assert.equal(run.backendEnvMetadata.nlink, 1, diagnostic(run));
  if (process.platform !== 'win32') {
    assert.equal(run.backendEnvMetadata.mode, 0o600, diagnostic(run));
    assert.notEqual(run.backendEnvMetadata.uid, 0, diagnostic(run));
  }
  assert.match(run.backendEnvContent, /DIVA_QDRANT_VOLUME=diva_qdrant_v119_/);
}

function assertPreWriterScanStop(run) {
  assert.notEqual(run.result.status, 0, diagnostic(run));
  assert.equal(run.journalExists, false, diagnostic(run));
  assert.equal(run.interlockExists, false, diagnostic(run));
  assert.equal(run.writerGateExists, false, diagnostic(run));
  assert.equal(run.writerRolesLocked, false, diagnostic(run));
  assertExactOldTopology(run);
  assert.equal(run.rollbackImageId, 'absent', diagnostic(run));
  assert.equal(run.rollbackPostgresImageId, 'absent', diagnostic(run));
}

function assertPersistentFailStop(run) {
  assert.equal(run.result.status, 2, diagnostic(run));
  assert.equal(run.journalExists, true, diagnostic(run));
  assert.equal(run.interlockExists, true, diagnostic(run));
  assert.match(run.state, /daemon\.reconciliation=fail-stop-manual-intervention-required/);
  assert.doesNotMatch(run.state, /rollback=completed/);
  assert.equal(run.privateBackendEnvRemains, false, diagnostic(run));
}

function assertGateReleaseTimeout(run) {
  assertPersistentFailStop(run);
  assert.equal(run.writerGateExists, false, diagnostic(run));
  assert.equal(run.writerRolesLocked, false, diagnostic(run));
  assert.equal(run.containers.vocadb_qdrant, ids.promotedQdrant, diagnostic(run));
  assert.equal(run.containers.vocadb_postgres, ids.promotedPostgres, diagnostic(run));
  assert.match(run.state, /qdrant\.candidate_python_semantic=verified/);
  assert.match(run.state, /qdrant\.promoted_python_semantic=verified/);
  assert.match(run.state, /deployment\.status=verified/);
  assert.match(run.state, /daemon\.mutation_uncertain_exit=124/);
  assert.doesNotMatch(run.state, /compose\.management=/);
  assert.match(run.result.stderr, /pipeline writer gate could not be released exactly/);
  assert.ok(Buffer.byteLength(run.timeoutLog, 'utf8') < 32768, diagnostic(run));
}

function assertQdrantControllerTimeout(run) {
  assertPersistentFailStop(run);
  assertExactOldTopology(run);
  assert.equal(run.writerGateExists, true, diagnostic(run));
  assert.equal(run.writerRolesLocked, true, diagnostic(run));
  assert.match(run.state, /qdrant\.controller_exit=124/);
  assert.match(
    run.state,
    /qdrant\.controller_process_settlement_sha256=[0-9a-f]{64}/,
  );
  assert.match(
    run.state,
    /qdrant\.controller_daemon_reconciliation=observed-stable-but-unresolved/,
  );
  const settlement = JSON.parse(run.controllerSettlement);
  assert.equal(settlement.status, 'timed-out-drained', diagnostic(run));
  assert.equal(settlement.timedOut, true, diagnostic(run));
  assert.equal(settlement.processGroupDrained, true, diagnostic(run));
  assert.equal(settlement.log.status, 'captured', diagnostic(run));
  assert.equal(run.lateControllerMutation, false, diagnostic(run));
  assert.equal(run.backendEnvBackupRemains, false, diagnostic(run));
}

function assertManagementReconciliationInterlock(run) {
  assert.notEqual(run.result.status, 0, diagnostic(run));
  assert.equal(run.journalExists, true, diagnostic(run));
  assert.equal(run.interlockExists, true, diagnostic(run));
  assert.equal(run.writerGateExists, true, diagnostic(run));
  assert.equal(run.writerRolesLocked, true, diagnostic(run));
  assert.match(run.state, /compose\.management=reconciliation-required/);
  assert.equal(run.privateBackendEnvRemains, false, diagnostic(run));
}

function fixtureIdentity(status) {
  return `${status.dev}:${status.ino}`;
}

async function assertExactFixtureBaseForCleanup() {
  assert.ok(fixtureBase, 'fixture base is not initialized');
  assert.match(
    basename(fixtureBase),
    /^\.diva-player-contract-tests-[A-Za-z0-9_-]{6,}$/u,
    `refusing to clean an unexpected fixture basename: ${fixtureBase}`,
  );
  assert.equal(
    dirname(resolve(fixtureBase)).toLocaleLowerCase('en-US'),
    fixtureParent.toLocaleLowerCase('en-US'),
    `refusing to clean a fixture outside its exact parent: ${fixtureBase}`,
  );
  assert.equal(
    resolve(await realpath(fixtureParent)).toLocaleLowerCase('en-US'),
    fixtureParentRealPath.toLocaleLowerCase('en-US'),
    `fixture parent changed before cleanup: ${fixtureParent}`,
  );
  const status = await lstat(fixtureBase, { bigint: true });
  assert.ok(
    status.isDirectory() && !status.isSymbolicLink(),
    `refusing to clean a replaced fixture root: ${fixtureBase}`,
  );
  assert.equal(
    fixtureIdentity(status),
    fixtureBaseIdentity,
    `fixture root identity changed before cleanup: ${fixtureBase}`,
  );
  assert.equal(
    resolve(await realpath(fixtureBase)).toLocaleLowerCase('en-US'),
    resolve(fixtureBase).toLocaleLowerCase('en-US'),
    `fixture root resolves through a link or junction: ${fixtureBase}`,
  );
  if (process.platform === 'win32') assertWindowsTreeOwnedAndNotReparse(fixtureBase);
}

async function restoreFixturePermissionsForCleanup() {
  await assertExactFixtureBaseForCleanup();
  if (process.platform === 'win32') {
    const reset = spawnSync('icacls.exe', [fixtureBase, '/reset', '/T', '/Q'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(
      reset.status,
      0,
      `fixture ACL reset failed:\n${reset.stdout}\n${reset.stderr}`,
    );
    restoreWindowsAclSddl(fixtureBase, fixtureBaseOriginalAclSddl);
    return;
  }
  await chmod(fixtureBase, 0o700);
}

async function cleanupFixtureRoots() {
  if (!fixtureBase) return;
  await restoreFixturePermissionsForCleanup();
  await rm(fixtureBase, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
  assert.equal(existsSync(fixtureBase), false, `fixture cleanup left its exact root: ${fixtureBase}`);
}

const focusedCase = process.env.DIVA_STATEFUL_TEST_CASE;
try {
  if (focusedCase) {
    assert.match(focusedCase, /^[a-z0-9-]{1,80}$/);
    const run = await runScenario(focusedCase);
    if (focusedCase === 'success') {
      assert.equal(run.result.status, 0, diagnostic(run));
      assert.equal(run.runDirectoryExists, true, diagnostic(run));
      assert.match(run.trustedGitLog, /safe\.directory=.*project/);
      assert.match(run.trustedGitLog, /safe\.directory=.*pipeline/);
      assert.equal(
        run.pipelineRemoteBoundary.trim(),
        'config=isolated agent=none host-key=run-specific identity=dedicated owner-boundary=setpriv',
        diagnostic(run),
      );
      assert.equal(run.githubTrustRemains, false, diagnostic(run));
      assertRollbackImagesRetainedOffline(run);
    } else if (focusedCase === 'legacy-scan-calibration') {
      assertPreWriterScanStop(run);
      const qdrantCalibration = JSON.parse(run.qdrantScanCalibration);
      const postgresCalibration = JSON.parse(run.postgresScanCalibration);
      assert.deepEqual(
        [qdrantCalibration.service, postgresCalibration.service],
        ['qdrant-rollback', 'postgres-rollback'],
        diagnostic(run),
      );
      assert.equal(qdrantCalibration.imageId, `sha256:${'7'.repeat(64)}`, diagnostic(run));
      assert.equal(postgresCalibration.imageId, `sha256:${'8'.repeat(64)}`, diagnostic(run));
      assert.equal(qdrantCalibration.osFamily, 'debian', diagnostic(run));
      assert.equal(postgresCalibration.osFamily, 'alpine', diagnostic(run));
      assert.equal(qdrantCalibration.highCriticalCount, 1, diagnostic(run));
      assert.equal(postgresCalibration.highCriticalCount, 1, diagnostic(run));
      assert.equal(qdrantCalibration.findings[0].sha256, legacyFindingDigests.qdrant, diagnostic(run));
      assert.equal(postgresCalibration.findings[0].sha256, legacyFindingDigests.postgres, diagnostic(run));
      assert.match(run.state, /image_scan\.qdrant-rollback\.calibration_sha256=[0-9a-f]{64}/);
      assert.match(run.state, /image_scan\.postgres-rollback\.calibration_sha256=[0-9a-f]{64}/);
      assert.match(
        run.state,
        /image_scan\.status=requires-reviewed-exact-inventory-and-finding-contracts/,
      );
      assert.match(run.trivyScanLog, new RegExp(`sha256:${'c'.repeat(64)}\\|1`));
      assert.match(run.trivyScanLog, new RegExp(`sha256:${'7'.repeat(64)}\\|0`));
      assert.match(run.trivyScanLog, new RegExp(`sha256:${'8'.repeat(64)}\\|0`));
      assert.match(run.result.stderr, /image inventory\/finding calibration is required/);
    } else if (focusedCase === 'legacy-scan-reviewed') {
      assert.equal(run.result.status, 0, diagnostic(run));
      assertRollbackImagesRetainedOffline(run);
      assert.match(run.trivyScanLog, new RegExp(`sha256:${'7'.repeat(64)}\\|0`));
      assert.match(run.trivyScanLog, new RegExp(`sha256:${'8'.repeat(64)}\\|0`));
      assert.equal(run.qdrantScanCalibration, '', diagnostic(run));
      assert.equal(run.postgresScanCalibration, '', diagnostic(run));
    } else if (focusedCase === 'legacy-scan-unexpected') {
      assertPreWriterScanStop(run);
      assert.equal(run.qdrantScanCalibration, '', diagnostic(run));
      assert.equal(run.postgresScanCalibration, '', diagnostic(run));
      assert.match(run.trivyScanLog, new RegExp(`sha256:${'7'.repeat(64)}\\|0`));
      assert.doesNotMatch(run.trivyScanLog, new RegExp(`sha256:${'8'.repeat(64)}\\|0`));
      assert.match(run.result.stderr, /exact retained Qdrant image scan failed/);
    } else if (focusedCase === 'candidate-scan-finding') {
      assertPreWriterScanStop(run);
      assert.equal(run.qdrantScanCalibration, '', diagnostic(run));
      assert.equal(run.postgresScanCalibration, '', diagnostic(run));
      assert.match(run.trivyScanLog, new RegExp(`sha256:${'c'.repeat(64)}\\|1`));
      assert.doesNotMatch(run.trivyScanLog, new RegExp(`sha256:${'7'.repeat(64)}\\|0`));
      assert.doesNotMatch(run.trivyScanLog, new RegExp(`sha256:${'8'.repeat(64)}\\|0`));
      assert.match(run.result.stderr, /exact Qdrant runtime image scan failed/);
    } else if (focusedCase === 'backup-expires-before-writer-gate') {
      assertPreWriterScanStop(run);
      assert.match(run.state, /image_scan\.status=all-exact-receipts-verified/);
      assert.doesNotMatch(run.state, /pipeline_writer\.status=gating/);
      assert.doesNotMatch(run.state, /backup\.freshness=revalidated-before-writer-quiescence/);
      assert.match(
        run.result.stderr,
        /PostgreSQL backup evidence expired before writer quiescence/,
      );
    } else if (focusedCase === 'bridge-attestation-prep-over-15m') {
      assert.notEqual(run.result.status, 0, diagnostic(run));
      assert.equal(run.journalExists, false, diagnostic(run));
      assert.equal(run.interlockExists, false, diagnostic(run));
      assert.equal(run.writerGateExists, false, diagnostic(run));
      assert.equal(run.writerRolesLocked, false, diagnostic(run));
      assert.equal(run.githubTrustRemains, false, diagnostic(run));
      assertExactOldTopology(run);
      assert.match(run.state, /api_bridge\.attestation_anchor_created_at=/);
      assert.match(run.state, /image_scan\.status=all-exact-receipts-verified/);
      assert.match(run.state, /pipeline_writer\.status=refused-busy/);
    } else if (new Set([
      'bridge-attestation-at-4h',
      'bridge-attestation-new-mismatch',
    ]).has(focusedCase)) {
      assert.notEqual(run.result.status, 0, diagnostic(run));
      assert.equal(run.journalExists, false, diagnostic(run));
      assert.equal(run.interlockExists, false, diagnostic(run));
      assert.equal(run.writerGateExists, false, diagnostic(run));
      assert.equal(run.writerRolesLocked, false, diagnostic(run));
      assertExactOldTopology(run);
      assert.match(
        run.result.stderr,
        /not anchored to the API bridge receipt|copied backup payload attestation changed during preflight/,
      );
    } else if (new Set([
      'bridge-scan-receipt-missing',
      'bridge-scan-receipt-tampered',
      'bridge-stateless-identity-mismatch',
    ]).has(focusedCase)) {
      assert.notEqual(run.result.status, 0, diagnostic(run));
      assert.equal(run.journalExists, false, diagnostic(run));
      assert.equal(run.interlockExists, false, diagnostic(run));
      assert.equal(run.writerGateExists, false, diagnostic(run));
      assert.equal(run.writerRolesLocked, false, diagnostic(run));
      assertExactOldTopology(run);
      assert.match(
        run.result.stderr,
        /exact legacy-Qdrant API bridge receipt is invalid|fresh exact API bridge receipt (?:attestation anchor )?is required/,
      );
    } else if (preRunRejectionScenarios.has(focusedCase)) {
      assert.notEqual(run.result.status, 0, diagnostic(run));
      assert.equal(run.runDirectoryExists, false, diagnostic(run));
      assert.equal(run.dockerLog, '', diagnostic(run));
      assert.equal(run.state, '', diagnostic(run));
      if (focusedCase === 'invalid-evidence-existing-journal') {
        assert.equal(run.journalExists, true, diagnostic(run));
        assert.equal(
          run.journalContent,
          'existing-stateful-run-owned-by-another-process\n',
          diagnostic(run),
        );
      } else {
        assert.equal(run.journalExists, false, diagnostic(run));
      }
      assert.equal(run.interlockExists, false, diagnostic(run));
      assert.equal(run.writerGateExists, false, diagnostic(run));
      assert.equal(run.writerRolesLocked, false, diagnostic(run));
      assert.equal(run.sensitiveComposeArtifactRemains, false, diagnostic(run));
      assert.equal(run.backendEnvBackupRemains, false, diagnostic(run));
      assert.equal(run.controllerSettlement, '', diagnostic(run));
      assertExactOldTopology(run);
      if (focusedCase === 'forged-origin-main') {
        assert.match(run.result.stderr, /pipeline release must be the live official origin\/main commit/);
        assert.match(run.trustedGitLog, /ls-remote --exit-code https:\/\/github\.com\/conei7\/diva-player\.git refs\/heads\/main/);
        assert.match(run.trustedGitLog, /ls-remote --exit-code git@github\.com:conei7\/diva-data-pipeline\.git refs\/heads\/main/);
      } else if (focusedCase === 'pipeline-origin-alias') {
        assert.match(run.result.stderr, /pipeline release must be the live official origin\/main commit/);
        assert.doesNotMatch(
          run.trustedGitLog,
          /ls-remote --exit-code git@github\.com:conei7\/diva-data-pipeline\.git/,
        );
      } else if (focusedCase === 'github-host-key-drift') {
        assert.match(run.result.stderr, /pipeline release must be the live official origin\/main commit/);
        assert.match(run.pipelineRemoteBoundary, /host-key=run-specific/);
      } else if (focusedCase === 'github-identity-drift') {
        assert.match(run.result.stderr, /pipeline release must be the live official origin\/main commit/);
        assert.match(run.pipelineRemoteBoundary, /identity=dedicated/);
      }
    } else if (focusedCase === 'qdrant-controller-timeout') {
      assertQdrantControllerTimeout(run);
    } else if (focusedCase === 'gate-release-timeout') {
      assertGateReleaseTimeout(run);
    } else if (new Set([
      'rollback-tag-retag-drift',
      'rollback-tag-missing',
      'rollback-volume-identity-drift',
      'rollback-container-third-party-replacement',
    ]).has(focusedCase)) {
      assert.notEqual(run.result.status, 0, diagnostic(run));
      assert.equal(run.journalExists, true, diagnostic(run));
      assert.equal(run.interlockExists, true, diagnostic(run));
      assert.equal(run.writerGateExists, true, diagnostic(run));
      assert.equal(run.writerRolesLocked, true, diagnostic(run));
      assert.equal(run.privateBackendEnvRemains, false, diagnostic(run));
      assert.match(run.state, /promotion\.status=durable-forward-only/);
      assert.doesNotMatch(run.state, /rollback=completed/);
      assert.match(run.result.stderr, /rollback image\/volume\/scan contract changed before commit|legacy Qdrant cleanup or exact rollback asset verification failed/);
      if (focusedCase === 'rollback-tag-retag-drift') {
        assert.equal(run.rollbackImageId, `sha256:${'f0'.repeat(32)}`, diagnostic(run));
      } else if (focusedCase === 'rollback-tag-missing') {
        assert.equal(run.rollbackImageId, 'absent', diagnostic(run));
      } else if (focusedCase === 'rollback-container-third-party-replacement') {
        const thirdParty = 'f1'.repeat(32);
        assert.ok(Object.values(run.containers).includes(thirdParty), diagnostic(run));
        assert.doesNotMatch(run.dockerLog, new RegExp(`rm(?: -f)? ${thirdParty}`));
      }
    } else {
      throw new Error(`unsupported focused stateful case: ${focusedCase}`);
    }
    console.log(`PASS focused stateful hardening case ${focusedCase}`);
  } else {
const success = await runScenario('success');
assert.equal(success.result.status, 0, diagnostic(success));
assert.match(success.trustedGitLog, /safe\.directory=.*project/);
assert.match(success.trustedGitLog, /safe\.directory=.*pipeline/);
assert.match(success.trustedGitLog, /ls-remote --exit-code git@github\.com:conei7\/diva-data-pipeline\.git refs\/heads\/main/);
assert.match(success.pipelineRemoteBoundary, /config=isolated agent=none/);
assert.equal(success.githubTrustRemains, false, diagnostic(success));
assert.equal(success.runDirectoryExists, true, diagnostic(success));
assert.equal(success.journalExists, false, diagnostic(success));
assert.equal(success.writerGateExists, false, diagnostic(success));
assert.equal(success.writerRolesLocked, false, diagnostic(success));
assert.equal(success.privateBackendEnvRemains, false, diagnostic(success));
assert.equal(success.backendEnvBackupRemains, false, diagnostic(success));
assertRollbackImagesRetainedOffline(success);
assert.equal(success.containers.vocadb_qdrant, ids.promotedQdrant, diagnostic(success));
assert.equal(success.containers.vocadb_postgres, ids.promotedPostgres, diagnostic(success));
assert.match(success.state, /deployment\.status=completed/);
assert.match(success.state, /promotion\.status=durable-forward-only/);
assert.match(success.state, /promotion\.status=durable-promoted/);
assert.match(success.state, /qdrant\.candidate=verified/);
assert.match(success.state, /postgres\.candidate=verified/);
const runtimeContractLines = success.runtimeContract.trim().split('\n');
const runtimeContractEntries = runtimeContractLines.map((line) => {
  const separator = line.indexOf('=');
  assert.ok(separator > 0, diagnostic(success));
  return [line.slice(0, separator), line.slice(separator + 1)];
});
const runtimeContract = Object.fromEntries(runtimeContractEntries);
assert.equal(runtimeContractLines.length, 21, diagnostic(success));
assert.equal(Object.keys(runtimeContract).length, runtimeContractLines.length, diagnostic(success));
assert.match(success.runtimeContract, /^schema=1\nstatus=completed\nrun=[^\n]+\n/);
assert.equal(runtimeContract.qdrant_stable_tag, 'diva-player-qdrant:v1.19.0-hardened-r1');
assert.equal(runtimeContract.qdrant_image_id, ids.qdrantImage);
assert.equal(
  runtimeContract.postgres_image_reference,
  'diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1',
);
assert.equal(runtimeContract.postgres_image_id, ids.postgresImage);
assert.equal(
  runtimeContract.postgres_migrate_image_reference,
  'diva-player-postgres-migrate:16.15-hardened-r1',
);
assert.equal(runtimeContract.postgres_migrate_image_id, ids.postgresMigrateImage);
for (const digestField of [
  'qdrant_image_scan_receipt_sha256',
  'qdrant_audit_image_scan_receipt_sha256',
  'postgres_image_scan_receipt_sha256',
  'postgres_migrate_image_scan_receipt_sha256',
  'postgres_dockerfile_sha256',
  'postgres_schema_sha256',
  'postgres_source_bundle_sha256',
  'postgres_migrate_dockerfile_sha256',
  'stateful_compose_projection_sha256',
  'promotion_manifest_sha256',
]) {
  assert.match(runtimeContract[digestField] ?? '', /^[0-9a-f]{64}$/, diagnostic(success));
}
assert.match(success.runtimeContract, /stateful_compose_projection_sha256=[0-9a-f]{64}\n/);
assert.match(success.runtimeContract, /promotion_manifest_sha256=[0-9a-f]{64}\n/);
assert.match(success.runtimeContract, /player_commit=[0-9a-f]{40}\npipeline_commit=[0-9a-f]{40}\n$/);
assert.doesNotMatch(success.dockerLog, new RegExp(`rm(?: -f)? ${ids.promotedQdrant}`));
assert.doesNotMatch(success.dockerLog, new RegExp(`rm(?: -f)? ${ids.promotedPostgres}`));

const ephemeralCacheChange = await runScenario('postgres-ephemeral-cache-change');
assert.equal(ephemeralCacheChange.result.status, 0, diagnostic(ephemeralCacheChange));
assert.equal(ephemeralCacheChange.ephemeralCacheMutated, true, diagnostic(ephemeralCacheChange));
assert.equal(ephemeralCacheChange.journalExists, false, diagnostic(ephemeralCacheChange));
assert.equal(ephemeralCacheChange.writerGateExists, false, diagnostic(ephemeralCacheChange));
assert.equal(ephemeralCacheChange.writerRolesLocked, false, diagnostic(ephemeralCacheChange));
assert.equal(ephemeralCacheChange.containers.vocadb_qdrant, ids.promotedQdrant, diagnostic(ephemeralCacheChange));
assert.equal(ephemeralCacheChange.containers.vocadb_postgres, ids.promotedPostgres, diagnostic(ephemeralCacheChange));
assert.match(ephemeralCacheChange.state, /deployment\.status=completed/);
assert.match(ephemeralCacheChange.runtimeContract, /stateful_compose_projection_sha256=[0-9a-f]{64}\n/);

const writerActive = await runScenario('writer-active');
assert.notEqual(writerActive.result.status, 0, diagnostic(writerActive));
assert.equal(writerActive.journalExists, false, diagnostic(writerActive));
assert.equal(writerActive.interlockExists, false, diagnostic(writerActive));
assert.equal(writerActive.writerGateExists, false, diagnostic(writerActive));
assert.equal(writerActive.writerRolesLocked, false, diagnostic(writerActive));
assertExactOldTopology(writerActive);
assert.match(writerActive.state, /api_bridge\.attestation_anchor_created_at=/);
assert.match(writerActive.state, /image_scan\.status=all-exact-receipts-verified/);
assert.match(writerActive.state, /pipeline_writer\.status=refused-busy/);
assert.doesNotMatch(writerActive.dockerLog, / stop | rename | compose /);

const indirectPipelineLogin = await runScenario('indirect-pipeline-login-role');
assert.notEqual(indirectPipelineLogin.result.status, 0, diagnostic(indirectPipelineLogin));
assert.equal(indirectPipelineLogin.journalExists, false, diagnostic(indirectPipelineLogin));
assert.equal(indirectPipelineLogin.interlockExists, false, diagnostic(indirectPipelineLogin));
assert.equal(indirectPipelineLogin.writerGateExists, false, diagnostic(indirectPipelineLogin));
assert.equal(indirectPipelineLogin.writerRolesLocked, false, diagnostic(indirectPipelineLogin));
assertExactOldTopology(indirectPipelineLogin);
assert.match(indirectPipelineLogin.state, /pipeline_writer\.status=refused-busy/);
assert.doesNotMatch(indirectPipelineLogin.dockerLog, / stop | rename | compose /);

const orphanPublication = await runScenario('orphan-publication-journal');
assert.notEqual(orphanPublication.result.status, 0, diagnostic(orphanPublication));
assert.equal(orphanPublication.journalExists, false, diagnostic(orphanPublication));
assert.equal(orphanPublication.writerGateExists, false, diagnostic(orphanPublication));
assert.equal(orphanPublication.writerRolesLocked, false, diagnostic(orphanPublication));
assertExactOldTopology(orphanPublication);
assert.match(orphanPublication.result.stderr, /unfinished recommendation publication journal/);

const invalidAttestation = await runScenario('invalid-payload-attestation');
assert.notEqual(invalidAttestation.result.status, 0, diagnostic(invalidAttestation));
assert.equal(invalidAttestation.dockerLog, '', diagnostic(invalidAttestation));
assert.equal(invalidAttestation.journalExists, false, diagnostic(invalidAttestation));
assert.equal(invalidAttestation.privateBackendEnvRemains, false, diagnostic(invalidAttestation));

const verifierHeadMismatch = await runScenario('attester-verifier-head-mismatch');
assert.notEqual(verifierHeadMismatch.result.status, 0, diagnostic(verifierHeadMismatch));
assert.equal(verifierHeadMismatch.dockerLog, '', diagnostic(verifierHeadMismatch));
assert.equal(verifierHeadMismatch.journalExists, false, diagnostic(verifierHeadMismatch));
assert.equal(verifierHeadMismatch.interlockExists, false, diagnostic(verifierHeadMismatch));
assert.equal(verifierHeadMismatch.writerGateExists, false, diagnostic(verifierHeadMismatch));
assert.equal(verifierHeadMismatch.writerRolesLocked, false, diagnostic(verifierHeadMismatch));
assertExactOldTopology(verifierHeadMismatch);

const mismatchedNewAttestation = await runScenario('bridge-attestation-new-mismatch');
assert.notEqual(mismatchedNewAttestation.result.status, 0, diagnostic(mismatchedNewAttestation));
assert.equal(mismatchedNewAttestation.journalExists, false, diagnostic(mismatchedNewAttestation));
assert.equal(mismatchedNewAttestation.interlockExists, false, diagnostic(mismatchedNewAttestation));
assert.equal(mismatchedNewAttestation.writerGateExists, false, diagnostic(mismatchedNewAttestation));
assert.equal(mismatchedNewAttestation.writerRolesLocked, false, diagnostic(mismatchedNewAttestation));
assertExactOldTopology(mismatchedNewAttestation);

const expiredBridgeAttestation = await runScenario('bridge-attestation-at-4h');
assert.notEqual(expiredBridgeAttestation.result.status, 0, diagnostic(expiredBridgeAttestation));
assert.equal(expiredBridgeAttestation.journalExists, false, diagnostic(expiredBridgeAttestation));
assert.equal(expiredBridgeAttestation.interlockExists, false, diagnostic(expiredBridgeAttestation));
assert.equal(expiredBridgeAttestation.writerGateExists, false, diagnostic(expiredBridgeAttestation));
assert.equal(expiredBridgeAttestation.writerRolesLocked, false, diagnostic(expiredBridgeAttestation));
assert.match(
  expiredBridgeAttestation.result.stderr,
  /not anchored to the API bridge receipt|copied backup payload attestation changed during preflight/,
);
assertExactOldTopology(expiredBridgeAttestation);

for (const nonordinaryIndex of [
  'assume-unchanged-pipeline-source',
  'skip-worktree-pipeline-source',
]) {
  const run = await runScenario(nonordinaryIndex);
  assert.notEqual(run.result.status, 0, diagnostic(run));
  assert.equal(run.runDirectoryExists, false, diagnostic(run));
  assert.equal(run.dockerLog, '', diagnostic(run));
  assert.equal(run.journalExists, false, diagnostic(run));
  assert.equal(run.interlockExists, false, diagnostic(run));
  assertExactOldTopology(run);
}

const zeroPointBackup = await runScenario('zero-point-backup-evidence');
assert.notEqual(zeroPointBackup.result.status, 0, diagnostic(zeroPointBackup));
assert.equal(zeroPointBackup.runDirectoryExists, false, diagnostic(zeroPointBackup));
assert.equal(zeroPointBackup.dockerLog, '', diagnostic(zeroPointBackup));
assert.equal(zeroPointBackup.journalExists, false, diagnostic(zeroPointBackup));
assert.match(zeroPointBackup.result.stderr, /Qdrant off-host backup evidence is invalid/);

const swappedStatus = await runScenario('status-swap-after-shell-hash');
assert.notEqual(swappedStatus.result.status, 0, diagnostic(swappedStatus));
assert.equal(swappedStatus.runDirectoryExists, false, diagnostic(swappedStatus));
assert.equal(swappedStatus.dockerLog, '', diagnostic(swappedStatus));
assert.equal(swappedStatus.journalExists, false, diagnostic(swappedStatus));
assert.match(swappedStatus.result.stderr, /evidence is invalid/);

const swappedAttestation = await runScenario('attestation-swap-after-shell-hash');
assert.notEqual(swappedAttestation.result.status, 0, diagnostic(swappedAttestation));
assert.equal(swappedAttestation.runDirectoryExists, true, diagnostic(swappedAttestation));
assert.equal(swappedAttestation.dockerLog, '', diagnostic(swappedAttestation));
assert.equal(swappedAttestation.journalExists, false, diagnostic(swappedAttestation));
assert.match(
  swappedAttestation.result.stderr,
  /payload attestation (?:is invalid|changed during preflight)/,
);

const gateAcquireTimeout = await runScenario('gate-acquire-timeout');
assertPersistentFailStop(gateAcquireTimeout);
assert.equal(gateAcquireTimeout.writerGateExists, true, diagnostic(gateAcquireTimeout));
assert.equal(gateAcquireTimeout.writerRolesLocked, true, diagnostic(gateAcquireTimeout));
assertExactOldTopology(gateAcquireTimeout);

const gateReleaseTimeout = await runScenario('gate-release-timeout');
assertGateReleaseTimeout(gateReleaseTimeout);

const daemonReadTimeout = await runScenario('daemon-read-timeout-after-gate');
assert.notEqual(daemonReadTimeout.result.status, 0, diagnostic(daemonReadTimeout));
assert.equal(daemonReadTimeout.journalExists, true, diagnostic(daemonReadTimeout));
assert.equal(daemonReadTimeout.interlockExists, true, diagnostic(daemonReadTimeout));
assert.equal(daemonReadTimeout.writerGateExists, true, diagnostic(daemonReadTimeout));
assert.equal(daemonReadTimeout.writerRolesLocked, true, diagnostic(daemonReadTimeout));
assert.match(daemonReadTimeout.state, /daemon\.read_uncertain_exit=124/);
assert.match(daemonReadTimeout.state, /daemon\.reconciliation=fail-stop-manual-intervention-required/);
assertExactOldTopology(daemonReadTimeout);
assert.doesNotMatch(daemonReadTimeout.dockerLog, / stop |rename .*diva_.*_previous_/);

const daemonReadTimeoutOnce = await runScenario('daemon-read-timeout-once-after-gate');
assert.notEqual(daemonReadTimeoutOnce.result.status, 0, diagnostic(daemonReadTimeoutOnce));
assert.equal(daemonReadTimeoutOnce.journalExists, true, diagnostic(daemonReadTimeoutOnce));
assert.equal(daemonReadTimeoutOnce.interlockExists, true, diagnostic(daemonReadTimeoutOnce));
assert.equal(daemonReadTimeoutOnce.writerGateExists, true, diagnostic(daemonReadTimeoutOnce));
assert.equal(daemonReadTimeoutOnce.writerRolesLocked, true, diagnostic(daemonReadTimeoutOnce));
assert.match(daemonReadTimeoutOnce.state, /daemon\.read_uncertain_exit=124/);
assert.match(daemonReadTimeoutOnce.state, /daemon\.mutation_blocked=prior-read-unresolved/);
assert.match(daemonReadTimeoutOnce.state, /daemon\.reconciliation=fail-stop-manual-intervention-required/);
assert.equal(daemonReadTimeoutOnce.containers.vocadb_qdrant, undefined, diagnostic(daemonReadTimeoutOnce));
assert.ok(
  Object.values(daemonReadTimeoutOnce.containers).includes(ids.oldQdrant),
  diagnostic(daemonReadTimeoutOnce),
);
assert.equal(daemonReadTimeoutOnce.containers.vocadb_postgres, ids.oldPostgres, diagnostic(daemonReadTimeoutOnce));

const controllerTimeout = await runScenario('qdrant-controller-timeout');
assertQdrantControllerTimeout(controllerTimeout);

const qdrantComposeTimeout = await runScenario('qdrant-compose-timeout');
assertPersistentFailStop(qdrantComposeTimeout);
assert.equal(qdrantComposeTimeout.containers.vocadb_qdrant, ids.newQdrant, diagnostic(qdrantComposeTimeout));
assert.equal(qdrantComposeTimeout.containers.vocadb_postgres, ids.oldPostgres, diagnostic(qdrantComposeTimeout));
assert.ok(Object.values(qdrantComposeTimeout.containers).includes(ids.oldQdrant), diagnostic(qdrantComposeTimeout));

const postgresComposeTimeout = await runScenario('postgres-compose-timeout');
assertPersistentFailStop(postgresComposeTimeout);
assert.equal(postgresComposeTimeout.containers.vocadb_qdrant, ids.newQdrant, diagnostic(postgresComposeTimeout));
assert.equal(postgresComposeTimeout.containers.vocadb_postgres, ids.newPostgres, diagnostic(postgresComposeTimeout));
assert.ok(Object.values(postgresComposeTimeout.containers).includes(ids.oldQdrant), diagnostic(postgresComposeTimeout));
assert.ok(Object.values(postgresComposeTimeout.containers).includes(ids.oldPostgres), diagnostic(postgresComposeTimeout));

const imageTagTimeout = await runScenario('image-tag-timeout');
assertPersistentFailStop(imageTagTimeout);
assert.equal(imageTagTimeout.stableImageId, ids.oldStableQdrantImage, diagnostic(imageTagTimeout));
assert.equal(imageTagTimeout.writerGateExists, true, diagnostic(imageTagTimeout));
assert.equal(imageTagTimeout.containers.vocadb_qdrant, ids.newQdrant, diagnostic(imageTagTimeout));
assert.equal(imageTagTimeout.containers.vocadb_postgres, ids.newPostgres, diagnostic(imageTagTimeout));
assert.doesNotMatch(imageTagTimeout.dockerLog, new RegExp(`rm(?: -f)? ${ids.newQdrant}`));
assert.doesNotMatch(imageTagTimeout.dockerLog, new RegExp(`rm(?: -f)? ${ids.newPostgres}`));

const promotionQdrantTimeout = await runScenario('promotion-qdrant-compose-timeout');
assertPersistentFailStop(promotionQdrantTimeout);
assert.equal(promotionQdrantTimeout.containers.vocadb_qdrant, ids.promotedQdrant, diagnostic(promotionQdrantTimeout));
assert.equal(promotionQdrantTimeout.containers.vocadb_postgres, ids.newPostgres, diagnostic(promotionQdrantTimeout));
assert.doesNotMatch(promotionQdrantTimeout.dockerLog, new RegExp(`rm(?: -f)? ${ids.promotedQdrant}`));

const promotionPostgresTimeout = await runScenario('promotion-postgres-compose-timeout');
assertPersistentFailStop(promotionPostgresTimeout);
assert.equal(promotionPostgresTimeout.containers.vocadb_qdrant, ids.promotedQdrant, diagnostic(promotionPostgresTimeout));
assert.equal(promotionPostgresTimeout.containers.vocadb_postgres, ids.promotedPostgres, diagnostic(promotionPostgresTimeout));
assert.doesNotMatch(promotionPostgresTimeout.dockerLog, new RegExp(`rm(?: -f)? ${ids.promotedQdrant}`));
assert.doesNotMatch(promotionPostgresTimeout.dockerLog, new RegExp(`rm(?: -f)? ${ids.promotedPostgres}`));

const qdrantHealthFailure = await runScenario('qdrant-health-failure');
assertManagementReconciliationInterlock(qdrantHealthFailure);
assertExactOldTopology(qdrantHealthFailure);
assert.match(qdrantHealthFailure.state, /qdrant\.rollback=completed/);

const qdrantFingerprintFailure = await runScenario('qdrant-fingerprint-failure');
assertManagementReconciliationInterlock(qdrantFingerprintFailure);
assertExactOldTopology(qdrantFingerprintFailure);
assert.match(qdrantFingerprintFailure.state, /qdrant\.rollback=completed/);

const qdrantPayloadSchemaFailure = await runScenario('qdrant-payload-schema-failure');
assertManagementReconciliationInterlock(qdrantPayloadSchemaFailure);
assertExactOldTopology(qdrantPayloadSchemaFailure);
assert.match(qdrantPayloadSchemaFailure.state, /qdrant\.rollback=completed/);

const postgresFingerprintFailure = await runScenario('postgres-fingerprint-failure');
assertManagementReconciliationInterlock(postgresFingerprintFailure);
assertExactOldTopology(postgresFingerprintFailure);
assert.match(postgresFingerprintFailure.state, /postgres\.rollback=completed/);
assert.match(postgresFingerprintFailure.state, /qdrant\.rollback=completed/);

const postgresRowContentFailure = await runScenario('postgres-row-content-failure');
assertManagementReconciliationInterlock(postgresRowContentFailure);
assertExactOldTopology(postgresRowContentFailure);
assert.match(postgresRowContentFailure.state, /postgres\.rollback=completed/);
assert.match(postgresRowContentFailure.state, /qdrant\.rollback=completed/);

const unresolved = await runScenario('qdrant-compose-unresolved');
assertPersistentFailStop(unresolved);
assert.equal(unresolved.containers.vocadb_qdrant, ids.newQdrant, diagnostic(unresolved));
assert.ok(Object.values(unresolved.containers).includes(ids.oldQdrant), diagnostic(unresolved));

for (const projectionFailure of ['projection-config-failure', 'projection-config-timeout']) {
  const run = await runScenario(projectionFailure);
  assert.notEqual(run.result.status, 0, diagnostic(run));
  assert.equal(run.journalExists, true, diagnostic(run));
  assert.equal(run.interlockExists, true, diagnostic(run));
  assert.equal(run.writerGateExists, true, diagnostic(run));
  assert.equal(run.writerRolesLocked, true, diagnostic(run));
  assert.equal(run.sensitiveComposeArtifactRemains, false, diagnostic(run));
  assert.equal(run.privateBackendEnvRemains, false, diagnostic(run));
  assert.equal(run.backendEnvBackupRemains, false, diagnostic(run));
  assert.doesNotMatch(run.state, /deployment\.status=completed/);
}

const existingJournal = await runScenario('invalid-evidence-existing-journal');
assert.notEqual(existingJournal.result.status, 0, diagnostic(existingJournal));
assert.equal(existingJournal.runDirectoryExists, false, diagnostic(existingJournal));
assert.equal(existingJournal.journalExists, true, diagnostic(existingJournal));
assert.equal(
  existingJournal.journalContent,
  'existing-stateful-run-owned-by-another-process\n',
  diagnostic(existingJournal),
);
assert.match(existingJournal.result.stderr, /PostgreSQL off-host backup evidence is invalid/);
assert.equal(existingJournal.dockerLog, '', diagnostic(existingJournal));

const delayedOldRemoval = await runScenario('delayed-old-rm');
assertPersistentFailStop(delayedOldRemoval);
assert.equal(delayedOldRemoval.containers.vocadb_qdrant, ids.promotedQdrant, diagnostic(delayedOldRemoval));
assert.equal(delayedOldRemoval.containers.vocadb_postgres, ids.promotedPostgres, diagnostic(delayedOldRemoval));
assert.ok(Object.values(delayedOldRemoval.containers).includes(ids.newQdrant), diagnostic(delayedOldRemoval));
assert.ok(Object.values(delayedOldRemoval.containers).includes(ids.newPostgres), diagnostic(delayedOldRemoval));
assert.ok(!Object.values(delayedOldRemoval.containers).includes(ids.oldQdrant), diagnostic(delayedOldRemoval));
assert.ok(Object.values(delayedOldRemoval.containers).includes(ids.oldPostgres), diagnostic(delayedOldRemoval));
assert.match(delayedOldRemoval.state, /promotion\.status=durable-promoted/);
assert.doesNotMatch(delayedOldRemoval.dockerLog, new RegExp(`rm(?: -f)? ${ids.promotedQdrant}`));
assert.doesNotMatch(delayedOldRemoval.dockerLog, new RegExp(`rm(?: -f)? ${ids.promotedPostgres}`));

const promotionMarkerFailure = await runScenario('promotion-marker-sync-failure');
assert.notEqual(promotionMarkerFailure.result.status, 0, diagnostic(promotionMarkerFailure));
assert.equal(promotionMarkerFailure.journalExists, true, diagnostic(promotionMarkerFailure));
assert.equal(promotionMarkerFailure.interlockExists, true, diagnostic(promotionMarkerFailure));
assert.equal(promotionMarkerFailure.writerGateExists, true, diagnostic(promotionMarkerFailure));
assert.equal(promotionMarkerFailure.writerRolesLocked, true, diagnostic(promotionMarkerFailure));
assert.equal(promotionMarkerFailure.privateBackendEnvRemains, false, diagnostic(promotionMarkerFailure));
assert.equal(promotionMarkerFailure.backendEnvBackupRemains, true, diagnostic(promotionMarkerFailure));
assert.equal(
  promotionMarkerFailure.containers.vocadb_qdrant,
  ids.promotedQdrant,
  diagnostic(promotionMarkerFailure),
);
assert.equal(
  promotionMarkerFailure.containers.vocadb_postgres,
  ids.promotedPostgres,
  diagnostic(promotionMarkerFailure),
);
assert.match(
  promotionMarkerFailure.state,
  /promotion\.reconciliation=post-commit-manual-intervention-required/,
);
assert.doesNotMatch(promotionMarkerFailure.state, /rollback=completed/);

const stableAbsentRecovery = await runScenario('stable-tag-absent-post-bind-failure');
assert.notEqual(stableAbsentRecovery.result.status, 0, diagnostic(stableAbsentRecovery));
assert.equal(stableAbsentRecovery.stableImageId, 'absent', diagnostic(stableAbsentRecovery));
assert.equal(stableAbsentRecovery.journalExists, true, diagnostic(stableAbsentRecovery));
assert.equal(stableAbsentRecovery.writerGateExists, true, diagnostic(stableAbsentRecovery));
assert.equal(stableAbsentRecovery.containers.vocadb_qdrant, ids.newQdrant, diagnostic(stableAbsentRecovery));
assert.match(stableAbsentRecovery.state, /qdrant\.stable_tag_recovery=restored-previous-mapping/);

const stableOldRecovery = await runScenario('stable-tag-old-post-bind-failure');
assert.notEqual(stableOldRecovery.result.status, 0, diagnostic(stableOldRecovery));
assert.equal(stableOldRecovery.stableImageId, ids.oldStableQdrantImage, diagnostic(stableOldRecovery));
assert.equal(stableOldRecovery.journalExists, true, diagnostic(stableOldRecovery));
assert.equal(stableOldRecovery.writerGateExists, true, diagnostic(stableOldRecovery));
assert.equal(stableOldRecovery.containers.vocadb_qdrant, ids.newQdrant, diagnostic(stableOldRecovery));
assert.match(stableOldRecovery.state, /qdrant\.stable_tag_recovery=restored-previous-mapping/);

console.log('PASS deterministic stateful hardening fault matrix');
  }
} finally {
  await cleanupFixtureRoots();
}
