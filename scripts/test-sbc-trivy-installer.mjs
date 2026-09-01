import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const installer = join(scriptsDirectory, 'install-sbc-trivy.sh');
const installerSource = await readFile(installer, 'utf8');
const bash = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const fixture = await mkdtemp(join(tmpdir(), 'diva-trivy-elf-'));

const sha256 = value => createHash('sha256').update(value).digest('hex');
const shellPath = value => (
  process.platform === 'win32' && /^[A-Za-z]:[\\/]/u.test(value)
    ? `/${value[0].toLowerCase()}${value.slice(2).replaceAll('\\', '/')}`
    : value
);
const runInstaller = args => spawnSync(
  bash,
  [shellPath(installer), ...args.map(shellPath)],
  {
    encoding: 'utf8',
    env: { ...process.env, DIVA_TRIVY_INSTALL_TEST_MODE: '1' },
    windowsHide: true,
  },
);
const fileMetadata = path => {
  const result = spawnSync(
    bash,
    ['-c', "umask 077; /usr/bin/stat -c '%u:%g:%a' -- \"$1\"", 'diva-stat', shellPath(path)],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const pathExists = async path => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
const elfHeader = machine => Buffer.from([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x02, 0x00, machine & 0xff, machine >> 8,
]);

try {
  const directoryFunctionsStart = installerSource.indexOf('validate_root_directory()');
  const directoryFunctionsEnd = installerSource.indexOf(
    'verify_installed_binary()',
    directoryFunctionsStart,
  );
  assert.ok(directoryFunctionsStart >= 0, 'root directory validator must remain explicit');
  assert.ok(
    directoryFunctionsEnd > directoryFunctionsStart,
    'install directory helper must precede installed binary verification',
  );
  const directoryFunctions = installerSource.slice(
    directoryFunctionsStart,
    directoryFunctionsEnd,
  );
  const directoryScopeHarness = join(fixture, 'directory-scope.sh');
  await writeFile(directoryScopeHarness, `#!/bin/sh
set -eu
${directoryFunctions}
directory=outer-directory
parent=outer-parent
validate_root_directory "$1" || :
[ "$directory" = outer-directory ]
[ "$parent" = outer-parent ]
ensure_install_directory "$1/child" || :
[ "$directory" = outer-directory ]
[ "$parent" = outer-parent ]
`);
  const directoryScope = spawnSync(
    bash,
    [shellPath(directoryScopeHarness), shellPath(join(fixture, 'missing-parent'))],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(
    directoryScope.status,
    0,
    `directory trust helpers must not clobber caller variables\n${directoryScope.stderr}`,
  );

  const existingTargetBranch = installerSource.indexOf('if [ -e "$INSTALL_PATH" ] || [ -L "$INSTALL_PATH" ]; then');
  const downloadStart = installerSource.indexOf('temporary=$(/usr/bin/mktemp');
  assert.ok(existingTargetBranch >= 0, 'existing target branch must remain explicit');
  assert.ok(downloadStart > existingTargetBranch, 'existing target verification must precede download');
  const existingTargetContract = installerSource.slice(existingTargetBranch, downloadStart);
  assert.match(existingTargetContract, /verify_installed_binary/u);
  assert.match(existingTargetContract, /exit 0/u);

  const arm = elfHeader(183);
  const x86 = elfHeader(62);
  const armPath = join(fixture, 'trivy-arm64');
  const x86Path = join(fixture, 'trivy-amd64');
  await writeFile(armPath, arm);
  await writeFile(x86Path, x86);

  const verify = (path, digest) => runInstaller([
    '--test-verify-elf',
    path,
    digest,
  ]);
  const accepted = verify(armPath, sha256(arm));
  assert.equal(accepted.status, 0, accepted.stderr);
  const wrongMachine = verify(x86Path, sha256(x86));
  assert.notEqual(wrongMachine.status, 0, 'x86_64 ELF must fail closed');
  const wrongDigest = verify(armPath, sha256(x86));
  assert.notEqual(wrongDigest.status, 0, 'digest drift must fail closed');

  const armMetadata = `${fileMetadata(armPath)}:1`;
  const fileContract = path => runInstaller([
    '--test-verify-file-contract',
    path,
    sha256(arm),
    armMetadata,
  ]);
  const singleLink = fileContract(armPath);
  assert.equal(singleLink.status, 0, `single-link file contract must pass\n${singleLink.stderr}`);
  const armAlias = join(fixture, 'trivy-arm64-hardlink');
  await link(armPath, armAlias);
  assert.notEqual(
    fileContract(armPath).status,
    0,
    'an otherwise exact existing target with a second hard link must fail closed',
  );
  await rm(armAlias);
  assert.equal(fileContract(armPath).status, 0, 'removing the extra link must restore the contract');

  const installDirectory = join(fixture, 'install');
  const stagedPath = join(installDirectory, '.trivy.staged');
  const targetPath = join(installDirectory, 'trivy-0.74.0');
  await mkdir(installDirectory);
  await writeFile(stagedPath, arm);
  const publishedMetadata = `${fileMetadata(stagedPath)}:1`;
  const publish = staged => runInstaller([
    '--test-publish',
    staged,
    targetPath,
    installDirectory,
  ]);
  const published = publish(stagedPath);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(await pathExists(stagedPath), false, 'publication must unlink its staged hard link');
  assert.equal(
    fileMetadata(targetPath),
    publishedMetadata.slice(0, publishedMetadata.lastIndexOf(':')),
    'published target owner/group/mode must be unchanged',
  );
  const verifyPublished = () => runInstaller([
    '--test-verify-file-contract',
    targetPath,
    sha256(arm),
    publishedMetadata,
  ]);
  assert.equal(verifyPublished().status, 0, 'published target must have exact nlink=1');
  assert.equal(verifyPublished().status, 0, 'repeated existing-target verification must be idempotent');

  const retryStaged = join(installDirectory, '.trivy.retry.staged');
  await writeFile(retryStaged, x86);
  const beforeRetry = await readFile(targetPath);
  const existingTarget = publish(retryStaged);
  assert.notEqual(existingTarget.status, 0, 'atomic publication must refuse an existing target');
  assert.equal(await pathExists(retryStaged), true, 'existing-target rejection must preserve the staged candidate');
  assert.deepEqual(await readFile(targetPath), beforeRetry, 'existing-target rejection must not overwrite the target');

  const publishedAlias = join(installDirectory, 'trivy-hardlink-alias');
  await link(targetPath, publishedAlias);
  const hardlinkedRetry = verifyPublished();
  assert.notEqual(hardlinkedRetry.status, 0, 'hard-linked existing install must be rejected');
  assert.deepEqual(await readFile(targetPath), beforeRetry, 'hard-link rejection must preserve the target');
  assert.equal(await pathExists(retryStaged), true, 'hard-link rejection must preserve the staged candidate');
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log('PASS SBC Trivy ARM64 installer ELF/digest/nlink/publication gate');
