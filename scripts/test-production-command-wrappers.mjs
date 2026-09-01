import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const deploymentSource = await readFile(
  join(scriptsDirectory, 'deploy-sbc-api-rolling.sh'),
  'utf8',
);
const creatorStartMarker = [
  '        /usr/bin/env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin \\\n',
  "            LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/bin/python3 -I -c '\n",
].join('');
const creatorEndMarker = [
  "\n' \"$PRIVATE_DOCKER_CONFIG\" \"$PRIVATE_COMMAND_DIR\" \\\n",
  '            "$PRIVATE_DOCKER_WRAPPER" "$PRIVATE_COMPOSE_WRAPPER" || return 1',
].join('');
const creatorStart = deploymentSource.indexOf(creatorStartMarker);
assert.notEqual(creatorStart, -1, 'production command-wrapper creator start is missing');
assert.equal(
  deploymentSource.indexOf(creatorStartMarker, creatorStart + creatorStartMarker.length),
  -1,
  'production command-wrapper creator must be unique',
);
const payloadStart = creatorStart + creatorStartMarker.length;
const creatorEnd = deploymentSource.indexOf(creatorEndMarker, payloadStart);
assert.notEqual(creatorEnd, -1, 'production command-wrapper creator end is missing');
const productionCreator = deploymentSource.slice(payloadStart, creatorEnd);

assert.match(
  productionCreator,
  /os\.execve\("\/usr\/bin\/docker", \["\/usr\/bin\/docker", \*sys\.argv\[1:\]\], %s\)/u,
);
assert.match(
  productionCreator,
  /for name in \("DIVA_API_IMAGE", "DIVA_GATEWAY_IMAGE", "DIVA_WEB_IMAGE"\):/u,
);
assert.match(
  productionCreator,
  /os\.execve\(\n    "\/usr\/libexec\/docker\/cli-plugins\/docker-compose",/u,
);

const bundledPython = join(
  homedir(),
  '.cache',
  'codex-runtimes',
  'codex-primary-runtime',
  'dependencies',
  'python',
  process.platform === 'win32' ? 'python.exe' : 'bin/python3',
);
const pythonProbe = ['python3', 'python', bundledPython]
  .map(command => spawnSync(command, ['-I', '-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
  }))
  .find(result => result.status === 0);
assert.ok(pythonProbe, 'an isolated Python 3 interpreter is required');
assert.equal(
  pythonProbe.status,
  0,
  `Python probe failed: ${pythonProbe.stderr?.trim() || 'no stderr'}`,
);
const pythonExecutable = pythonProbe.stdout.trim();
assert.ok(pythonExecutable, 'Python probe returned an empty executable path');
const nestedFakeBinaryLiteral = JSON.stringify(process.execPath.replaceAll('\\', '/'));

const directorySyncBlock = `directory_descriptor = os.open(
    command_dir,
    os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
)
try:
    os.fsync(directory_descriptor)
finally:
    os.close(directory_descriptor)`;

let executableCreator = productionCreator
  .replaceAll('"/usr/bin/docker"', nestedFakeBinaryLiteral)
  .replaceAll(
    '"/usr/libexec/docker/cli-plugins/docker-compose"',
    nestedFakeBinaryLiteral,
  );
const rootOwnershipContract = 'metadata.st_uid != 0 or metadata.st_gid != 0';
assert.ok(executableCreator.includes(rootOwnershipContract));
if (process.platform !== 'win32') {
  executableCreator = executableCreator.replace(
    rootOwnershipContract,
    'metadata.st_uid != os.getuid() or metadata.st_gid != os.getgid()',
  );
}
if (process.platform === 'win32') {
  assert.ok(executableCreator.includes(directorySyncBlock));
  const unixMetadataContract = `or stat.S_IMODE(metadata.st_mode) != 0o500 \\
                or metadata.st_uid != 0 or metadata.st_gid != 0 \\
                or metadata.st_size != len(payload)`;
  assert.ok(executableCreator.includes(unixMetadataContract));
  executableCreator = executableCreator
    .replace(directorySyncBlock, '# Directory fsync is unavailable on Windows test hosts.')
    .replace('os.O_WRONLY |', 'os.O_WRONLY | getattr(os, "O_BINARY", 0) |')
    .replaceAll('os.O_CLOEXEC', 'getattr(os, "O_CLOEXEC", 0)')
    .replaceAll('os.O_NOFOLLOW', 'getattr(os, "O_NOFOLLOW", 0)')
    .replace('os.fchmod(descriptor, 0o500)', '# fchmod is unavailable on Windows test hosts.')
    .replace(
      unixMetadataContract,
      'or metadata.st_size != len(payload)',
    );
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'diva-command-wrapper-test-'));
const dockerConfig = join(temporaryRoot, 'docker-cli-config');
const commandDirectory = join(temporaryRoot, 'command-wrappers');
const dockerWrapper = join(commandDirectory, 'docker');
const composeWrapper = join(commandDirectory, 'docker-compose');
const recorder = join(temporaryRoot, 'record-environment.mjs');

try {
  await mkdir(dockerConfig);
  await mkdir(commandDirectory);
  await writeFile(
    recorder,
    [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(',
      '  process.argv[2],',
      '  JSON.stringify({',
      '    argv0: process.argv0,',
      '    binary: process.execPath,',
      '    rawArguments: process.argv,',
      '    arguments: process.argv.slice(3),',
      '    environment: process.env,',
      '  }),',
      "  'utf8',",
      ');',
      '',
    ].join('\n'),
    'utf8',
  );

  const creatorResult = spawnSync(
    pythonExecutable,
    ['-I', '-c', executableCreator, dockerConfig, commandDirectory, dockerWrapper, composeWrapper],
    { encoding: 'utf8' },
  );
  assert.equal(
    creatorResult.status,
    0,
    `production wrapper creator failed: ${creatorResult.stderr.trim() || 'no stderr'}`,
  );

  for (const wrapper of [dockerWrapper, composeWrapper]) {
    const wrapperSource = await readFile(wrapper, 'utf8');
    assert.ok(
      wrapperSource.startsWith('#!/usr/bin/python3 -I\n'),
      `${wrapper} must retain the exact isolated system-Python shebang`,
    );
    const syntaxResult = spawnSync(
      pythonExecutable,
      ['-I', '-c', 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_bytes())', wrapper],
      { encoding: 'utf8' },
    );
    assert.equal(
      syntaxResult.status,
      0,
      `${wrapper} syntax check failed: ${syntaxResult.stderr.trim() || 'no stderr'}`,
    );
  }

  const hostileEnvironment = {
    ...process.env,
    BUILDKIT_HOST: 'tcp://attacker.invalid:1234',
    COMPOSE_BAKE: 'true',
    COMPOSE_FILE: 'attacker-compose.yml',
    COMPOSE_PROFILES: 'attacker',
    DIVA_API_IMAGE: 'registry.invalid/diva-api:test',
    DIVA_GATEWAY_IMAGE: 'registry.invalid/diva-gateway:test',
    DIVA_WEB_IMAGE: 'registry.invalid/diva-web:test',
    DOCKER_CONFIG: join(temporaryRoot, 'attacker-docker-config'),
    DOCKER_CONTEXT: 'attacker',
    DOCKER_HOST: 'tcp://attacker.invalid:2375',
    HOME: join(temporaryRoot, 'attacker-home'),
    PATH: join(temporaryRoot, 'attacker-path'),
    PYTHONHOME: join(temporaryRoot, 'attacker-python-home'),
    PYTHONPATH: join(temporaryRoot, 'attacker-python-path'),
    TAR_OPTIONS: '--checkpoint-action=exec=attacker',
  };
  const expectedBaseEnvironment = {
    DOCKER_CONFIG: dockerConfig,
    HOME: '/root',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  };

  async function executeWrapper(wrapper, label) {
    const output = join(temporaryRoot, `${label}.json`);
    let result;
    if (process.platform === 'win32') {
      const execveHarness = [
        'import json',
        'import os',
        'import pathlib',
        'import sys',
        'wrapper, output, *wrapper_arguments = sys.argv[1:]',
        'def capture_execve(binary, arguments, environment):',
        '    pathlib.Path(output).write_text(json.dumps({',
        '        "binary": binary,',
        '        "argv0": arguments[0],',
        '        "rawArguments": arguments,',
        '        "arguments": arguments[3:],',
        '        "environment": environment,',
        '    }, sort_keys=True), encoding="utf-8")',
        '    raise SystemExit(0)',
        'os.execve = capture_execve',
        'sys.argv = [wrapper, *wrapper_arguments]',
        'exec(compile(pathlib.Path(wrapper).read_bytes(), wrapper, "exec"), {"__name__": "__main__"})',
      ].join('\n');
      result = spawnSync(
        pythonExecutable,
        [
          '-I', '-c', execveHarness, wrapper, output,
          recorder, output, label, '--version',
        ],
        { encoding: 'utf8', env: hostileEnvironment },
      );
    } else {
      result = spawnSync(
        wrapper,
        [recorder, output, label, '--version'],
        { encoding: 'utf8', env: hostileEnvironment },
      );
    }
    assert.equal(
      result.status,
      0,
      `${label} wrapper failed: ${result.stderr.trim() || 'no stderr'}`,
    );
    const record = JSON.parse(await readFile(output, 'utf8'));
    const normalizeExecutable = value => process.platform === 'win32'
      ? value.replaceAll('\\', '/').toLowerCase()
      : value;
    assert.equal(normalizeExecutable(record.binary), normalizeExecutable(process.execPath));
    assert.equal(normalizeExecutable(record.argv0), normalizeExecutable(process.execPath));
    assert.deepEqual(record.rawArguments.slice(1), [recorder, output, label, '--version']);
    return record;
  }

  const dockerRecord = await executeWrapper(dockerWrapper, 'docker');
  assert.deepEqual(dockerRecord.arguments, ['docker', '--version']);
  assert.deepEqual(dockerRecord.environment, expectedBaseEnvironment);

  const composeRecord = await executeWrapper(composeWrapper, 'compose');
  assert.deepEqual(composeRecord.arguments, ['compose', '--version']);
  assert.deepEqual(composeRecord.environment, {
    ...expectedBaseEnvironment,
    DIVA_API_IMAGE: hostileEnvironment.DIVA_API_IMAGE,
    DIVA_GATEWAY_IMAGE: hostileEnvironment.DIVA_GATEWAY_IMAGE,
    DIVA_WEB_IMAGE: hostileEnvironment.DIVA_WEB_IMAGE,
  });

  console.log('Production Docker/Compose command wrapper behavior: PASS');
} finally {
  if (process.platform === 'win32') {
    await Promise.all([
      chmod(dockerWrapper, 0o700).catch(() => {}),
      chmod(composeWrapper, 0o700).catch(() => {}),
    ]);
  }
  await rm(temporaryRoot, { force: true, recursive: true });
}
