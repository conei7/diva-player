import assert from 'node:assert/strict';
import {
  chmod,
  cp,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const deploySource = (await readFile(
  join(scriptsDirectory, 'deploy-sbc-api-rolling.sh'),
  'utf8',
)).replaceAll('\r\n', '\n');

const extractEmbeddedPython = (anchor, invocationSuffix) => {
  const anchorIndex = deploySource.indexOf(anchor);
  assert.notEqual(anchorIndex, -1, `embedded validator anchor is missing: ${anchor}`);
  assert.equal(
    deploySource.indexOf(anchor, anchorIndex + anchor.length),
    -1,
    `embedded validator anchor is ambiguous: ${anchor}`,
  );
  const commandPrefix = '"$PYTHON_COMMAND" -I -c \'\n';
  const codeStart = deploySource.lastIndexOf(commandPrefix, anchorIndex) + commandPrefix.length;
  assert.ok(codeStart >= commandPrefix.length, `validator command prefix is missing: ${anchor}`);
  const codeEnd = deploySource.indexOf(invocationSuffix, anchorIndex);
  assert.notEqual(codeEnd, -1, `validator command suffix is missing: ${anchor}`);
  return deploySource.slice(codeStart, codeEnd);
};

const preValidator = extractEmbeddedPython(
  'import posixpath\nimport tarfile',
  '\n\' "$SOURCE_TREE_ENTRIES_FILE" "$SOURCE_ARCHIVE_FILE"',
);
const postValidator = extractEmbeddedPython(
  'root = os.fsencode(snapshot_root)',
  '\n\' "$SOURCE_TREE_ENTRIES_FILE" "$SOURCE_SNAPSHOT_ROOT" 0 0',
);
assert.match(preValidator, /tarfile\.open\(archive_file, mode="r:"\)/u);
assert.match(postValidator, /getattr\(os, "O_NOFOLLOW", 0\)/u);

const findPython = () => {
  const configuredPython = process.env.DIVA_SOURCE_SNAPSHOT_TEST_PYTHON ?? process.env.PYTHON;
  const bundledPython = join(
    homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python',
    process.platform === 'win32' ? 'python.exe' : 'bin/python3',
  );
  const candidates = configuredPython
    ? [[configuredPython, []]]
    : process.platform === 'win32'
      ? [['python', []], ['py', ['-3']], [bundledPython, []]]
      : [['python3', []], ['python', []], [bundledPython, []]];
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '-I', '-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && probe.stdout.trim() === '3') {
      return { command, prefix };
    }
  }
  assert.fail('Python 3 is required for source snapshot validation tests');
};

const python = findPython();
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
  return result;
};
const runValidator = (source, args) => spawnSync(
  python.command,
  [...python.prefix, '-I', '-c', source, ...args],
  { encoding: 'utf8' },
);

const tarBuilder = String.raw`
import base64
import io
import json
import tarfile
import sys

archive_file, recipe_file = sys.argv[1:]
recipe = json.load(open(recipe_file, "r", encoding="utf-8"))
with tarfile.open(archive_file, "w", format=tarfile.PAX_FORMAT) as archive:
    for item in recipe:
        info = tarfile.TarInfo(item["name"])
        info.mode = item.get("mode", 0o644)
        info.uid = 0
        info.gid = 0
        info.mtime = 0
        kind = item.get("type", "file")
        if kind == "file":
            content = base64.b64decode(item.get("content", ""))
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
        elif kind == "dir":
            info.type = tarfile.DIRTYPE
            info.size = 0
            archive.addfile(info)
        elif kind == "symlink":
            info.type = tarfile.SYMTYPE
            info.linkname = item.get("linkname", "target")
            archive.addfile(info)
        elif kind == "hardlink":
            info.type = tarfile.LNKTYPE
            info.linkname = item.get("linkname", "plain.txt")
            archive.addfile(info)
        elif kind == "device":
            info.type = tarfile.CHRTYPE
            info.devmajor = 1
            info.devminor = 3
            archive.addfile(info)
        else:
            raise SystemExit("unsupported recipe type")
`;

const inspectTar = String.raw`
import hashlib
import tarfile
import sys
entries = {}
for entry in open(sys.argv[2], "rb").read().split(b"\0")[:-1]:
    metadata, path = entry.split(b"\t", 1)
    mode, kind, object_id = metadata.split(b" ")
    entries[path] = (mode, object_id)
with tarfile.open(sys.argv[1], "r:") as archive:
    for member in archive:
        if member.isreg():
            content = archive.extractfile(member).read()
            digest = hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()
        else:
            digest = "-"
        print(repr(member.name), oct(member.mode), member.type, member.size, digest,
              entries.get(member.name.encode()))
`;
const inspectTree = String.raw`
import os
import stat
import sys
for current, directories, files in os.walk(sys.argv[1]):
    for name in directories + files:
        path = os.path.join(current, name)
        info = os.lstat(path)
        print(os.path.relpath(path, sys.argv[1]), oct(stat.S_IMODE(info.st_mode)),
              info.st_nlink, stat.S_ISREG(info.st_mode), stat.S_ISDIR(info.st_mode))
`;

const encoded = value => Buffer.from(value).toString('base64');
const plainContent = 'immutable source\n';
const scriptContent = '#!/bin/sh\nprintf "snapshot\\n"\n';
const longDirectory = `pax-${'x'.repeat(110)}`;
const longPath = `${longDirectory}/long-source.txt`;
const longContent = 'PAX long-path source\n';
assert.ok(Buffer.byteLength(longPath, 'utf8') > 100);
const validRecipe = () => [
  { name: 'bin', type: 'dir', mode: 0o755 },
  { name: 'bin/run.sh', type: 'file', mode: 0o755, content: encoded(scriptContent) },
  { name: longDirectory, type: 'dir', mode: 0o755 },
  { name: longPath, type: 'file', mode: 0o644, content: encoded(longContent) },
  { name: 'plain.txt', type: 'file', mode: 0o644, content: encoded(plainContent) },
];

const temporaryRoot = await mkdtemp(join(tmpdir(), 'diva-source-snapshot-'));
try {
  const repository = join(temporaryRoot, 'repository');
  const archiveFile = join(temporaryRoot, 'source.tar');
  const entriesFile = join(temporaryRoot, 'entries.bin');
  await mkdir(join(repository, 'bin'), { recursive: true });
  await mkdir(join(repository, longDirectory));
  await writeFile(join(repository, 'plain.txt'), plainContent);
  await writeFile(join(repository, 'bin', 'run.sh'), scriptContent);
  await writeFile(join(repository, longPath), longContent);
  await chmod(join(repository, 'bin', 'run.sh'), 0o755);
  run('git', ['init', '--quiet'], { cwd: repository });
  run('git', ['config', 'user.name', 'DIVA snapshot fixture'], { cwd: repository });
  run('git', ['config', 'user.email', 'snapshot-fixture@example.invalid'], { cwd: repository });
  run('git', ['config', 'core.autocrlf', 'false'], { cwd: repository });
  run('git', ['config', 'core.filemode', 'true'], { cwd: repository });
  run('git', ['add', '--', 'bin/run.sh', longPath, 'plain.txt'], { cwd: repository });
  run('git', ['update-index', '--chmod=+x', '--', 'bin/run.sh'], { cwd: repository });
  run('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repository });
  const entries = spawnSync('git', ['ls-tree', '-rz', '--full-tree', 'HEAD'], {
    cwd: repository,
  });
  assert.equal(entries.status, 0, entries.stderr?.toString() ?? 'git ls-tree failed');
  await writeFile(entriesFile, entries.stdout);
  run('git', ['-c', 'tar.umask=0022', 'archive', '--format=tar', `--output=${archiveFile}`, 'HEAD'], {
    cwd: repository,
  });

  const validPre = runValidator(preValidator, [entriesFile, archiveFile]);
  const validArchiveListing = spawnSync(
    python.command,
    [...python.prefix, '-I', '-c', inspectTar, archiveFile, entriesFile],
    { encoding: 'utf8' },
  ).stdout;
  assert.equal(
    validPre.status,
    0,
    `valid git archive was rejected:\n${validPre.stderr}\narchive members:\n${validArchiveListing}`,
  );

  const supportsProductionExtraction = process.platform === 'linux';
  const extractedRoot = join(temporaryRoot, 'extracted');
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const expectedGid = typeof process.getgid === 'function' ? process.getgid() : null;
  if (supportsProductionExtraction) {
    assert.notEqual(expectedUid, null);
    assert.notEqual(expectedGid, null);
    await mkdir(extractedRoot);
    run('/usr/bin/env', [
      '-i',
      'HOME=/root',
      'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
      'LANG=C',
      'LC_ALL=C',
      '/usr/bin/tar',
      '--extract',
      '--file', archiveFile,
      '--directory', extractedRoot,
      '--no-same-owner',
      '--same-permissions',
    ]);
    const validPost = runValidator(postValidator, [
      entriesFile,
      extractedRoot,
      String(expectedUid),
      String(expectedGid),
    ]);
    const validTreeListing = spawnSync(
      python.command,
      [...python.prefix, '-I', '-c', inspectTree, extractedRoot],
      { encoding: 'utf8' },
    ).stdout;
    assert.equal(
      validPost.status,
      0,
      `valid extracted git archive was rejected:\n${validPost.stderr}\nextracted entries:\n${validTreeListing}`,
    );
  }

  const invalidRecipes = new Map([
    ['traversal', [...validRecipe(), { name: '../escape', content: encoded('escape') }]],
    ['absolute path', [...validRecipe(), { name: '/escape', content: encoded('escape') }]],
    ['symlink', validRecipe().map(item => item.name === 'plain.txt'
      ? { name: 'plain.txt', type: 'symlink', linkname: 'bin/run.sh', mode: 0o777 }
      : item)],
    ['hardlink', validRecipe().map(item => item.name === 'plain.txt'
      ? { name: 'plain.txt', type: 'hardlink', linkname: 'bin/run.sh', mode: 0o644 }
      : item)],
    ['device', validRecipe().map(item => item.name === 'plain.txt'
      ? { name: 'plain.txt', type: 'device', mode: 0o644 }
      : item)],
    ['duplicate', [...validRecipe(), { name: 'plain.txt', content: encoded(plainContent) }]],
    ['mode mismatch', validRecipe().map(item => item.name === 'plain.txt'
      ? { ...item, mode: 0o755 }
      : item)],
    ['missing file', validRecipe().filter(item => item.name !== 'plain.txt')],
    ['extra file', [...validRecipe(), { name: 'extra.txt', content: encoded('extra') }]],
    ['blob mismatch', validRecipe().map(item => item.name === 'plain.txt'
      ? { ...item, content: encoded('tampered source\n') }
      : item)],
  ]);

  for (const [name, recipe] of invalidRecipes) {
    const recipeFile = join(temporaryRoot, `${name.replaceAll(' ', '-')}.json`);
    const invalidArchive = join(temporaryRoot, `${name.replaceAll(' ', '-')}.tar`);
    await writeFile(recipeFile, JSON.stringify(recipe));
    run(python.command, [
      ...python.prefix,
      '-I',
      '-c',
      tarBuilder,
      invalidArchive,
      recipeFile,
    ]);
    const result = runValidator(preValidator, [entriesFile, invalidArchive]);
    assert.notEqual(result.status, 0, `${name} archive unexpectedly passed pre-extraction validation`);
  }

  let postCases = 0;
  if (supportsProductionExtraction) {
    const assertPostRejects = async (name, mutate) => {
      const root = join(temporaryRoot, `post-${name}`);
      await cp(extractedRoot, root, { recursive: true });
      await mutate(root);
      const result = runValidator(postValidator, [
        entriesFile,
        root,
        String(expectedUid),
        String(expectedGid),
      ]);
      assert.notEqual(result.status, 0, `post-extraction ${name} unexpectedly passed validation`);
      postCases += 1;
    };
    await assertPostRejects('content-drift', root => (
      writeFile(join(root, 'plain.txt'), 'post-extraction drift\n')
    ));
    await assertPostRejects('missing-file', root => unlink(join(root, 'plain.txt')));
    await assertPostRejects('file-symlink', async root => {
      const target = join(temporaryRoot, 'file-symlink-target.txt');
      await writeFile(target, plainContent);
      await chmod(target, 0o644);
      await unlink(join(root, 'plain.txt'));
      await symlink(target, join(root, 'plain.txt'));
    });
    await assertPostRejects('directory-symlink', async root => {
      await rm(join(root, 'bin'), { recursive: true, force: true });
      await symlink('.', join(root, 'bin'), 'dir');
    });
    await assertPostRejects('hardlink', async root => {
      const target = join(temporaryRoot, 'hardlink-target.txt');
      await writeFile(target, plainContent);
      await chmod(target, 0o644);
      await unlink(join(root, 'plain.txt'));
      await link(target, join(root, 'plain.txt'));
    });
    await assertPostRejects('mode-drift', root => chmod(join(root, 'plain.txt'), 0o755));
    await assertPostRejects('extra-file', root => writeFile(join(root, 'extra.txt'), 'extra\n'));
    await assertPostRejects('unexpected-empty-directory', root => (
      mkdir(join(root, 'unexpected-empty'), { mode: 0o755 })
    ));
    await assertPostRejects('directory-mode-drift', root => chmod(join(root, 'bin'), 0o700));
    const wrongUidResult = runValidator(postValidator, [
      entriesFile,
      extractedRoot,
      String(expectedUid + 1),
      String(expectedGid),
    ]);
    assert.notEqual(wrongUidResult.status, 0, 'post-extraction wrong UID unexpectedly passed');
    const wrongGidResult = runValidator(postValidator, [
      entriesFile,
      extractedRoot,
      String(expectedUid),
      String(expectedGid + 1),
    ]);
    assert.notEqual(wrongGidResult.status, 0, 'post-extraction wrong GID unexpectedly passed');
    postCases += 2;
    postCases += 1;
  }

  const platformNote = supportsProductionExtraction
    ? ''
    : '; GNU tar and post-extraction cases run in Linux CI';
  console.log(
    `Source snapshot validators: PASS (${invalidRecipes.size + 1 + postCases} cases${platformNote})`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
