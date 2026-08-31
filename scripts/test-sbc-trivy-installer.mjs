import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const installer = join(scriptsDirectory, 'install-sbc-trivy.sh');
const bash = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const fixture = await mkdtemp(join(tmpdir(), 'diva-trivy-elf-'));

const sha256 = value => createHash('sha256').update(value).digest('hex');
const shellPath = value => (
  process.platform === 'win32'
    ? `/${value[0].toLowerCase()}${value.slice(2).replaceAll('\\', '/')}`
    : value
);
const elfHeader = machine => Buffer.from([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x02, 0x00, machine & 0xff, machine >> 8,
]);

try {
  const arm = elfHeader(183);
  const x86 = elfHeader(62);
  const armPath = join(fixture, 'trivy-arm64');
  const x86Path = join(fixture, 'trivy-amd64');
  await writeFile(armPath, arm);
  await writeFile(x86Path, x86);

  const verify = (path, digest) => spawnSync(
    bash,
    [shellPath(installer), '--test-verify-elf', shellPath(path), digest],
    {
      encoding: 'utf8',
      env: { ...process.env, DIVA_TRIVY_INSTALL_TEST_MODE: '1' },
      windowsHide: true,
    },
  );
  const accepted = verify(armPath, sha256(arm));
  assert.equal(accepted.status, 0, accepted.stderr);
  const wrongMachine = verify(x86Path, sha256(x86));
  assert.notEqual(wrongMachine.status, 0, 'x86_64 ELF must fail closed');
  const wrongDigest = verify(armPath, sha256(x86));
  assert.notEqual(wrongDigest.status, 0, 'digest drift must fail closed');
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log('PASS SBC Trivy ARM64 installer ELF/digest gate');
