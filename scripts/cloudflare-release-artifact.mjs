import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST_NAME = 'manifest.json';
const PAYLOAD_NAME = 'payload';
const SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function toPosixPath(value) {
  return value.split(sep).join('/');
}

function pathInside(parent, candidate) {
  const child = relative(parent, candidate);
  return child !== '' && !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child);
}

async function regularFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`release payload must not contain symlinks: ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`release payload contains an unsupported entry: ${absolute}`);
    }
  }
  await walk(root);
  return files;
}

async function copyTree(source, destination) {
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`release input must be a regular directory: ${source}`);
  }
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const sourceEntry = resolve(source, entry.name);
    const destinationEntry = resolve(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`release input must not contain symlinks: ${sourceEntry}`);
    if (entry.isDirectory()) await copyTree(sourceEntry, destinationEntry);
    else if (entry.isFile()) {
      await mkdir(dirname(destinationEntry), { recursive: true });
      await copyFile(sourceEntry, destinationEntry);
    } else throw new Error(`release input contains an unsupported entry: ${sourceEntry}`);
  }
}

async function describePayload(payloadRoot) {
  const files = [];
  for (const absolute of await regularFiles(payloadRoot)) {
    const bytes = await readFile(absolute);
    files.push({
      path: toPosixPath(relative(payloadRoot, absolute)),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const digestInput = files
    .map(file => `${file.sha256} ${file.bytes} ${file.path}\n`)
    .join('');
  return { files, payloadSha256: sha256(digestInput) };
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('release manifest must be an object');
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported release manifest schema');
  if (!GIT_COMMIT_PATTERN.test(manifest.gitCommit || '')) throw new Error('release manifest has an invalid git commit');
  if (!SHA256_PATTERN.test(manifest.payloadSha256 || '')) throw new Error('release manifest has an invalid payload hash');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('release manifest has no files');
  }
  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('invalid release file entry');
    if (
      typeof file.path !== 'string'
      || file.path.length === 0
      || file.path.includes('\\')
      || file.path.startsWith('/')
      || file.path.split('/').includes('..')
    ) throw new Error('release manifest contains an unsafe path');
    if (paths.has(file.path)) throw new Error(`release manifest contains a duplicate path: ${file.path}`);
    paths.add(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !SHA256_PATTERN.test(file.sha256 || '')) {
      throw new Error(`release manifest contains invalid metadata for ${file.path}`);
    }
  }
}

export async function packageRelease({
  projectRoot,
  outputDirectory,
  gitCommit,
  workerBundle = null,
  githubRunId = null,
  githubRunAttempt = null,
  generatedAt = new Date().toISOString(),
}) {
  const root = resolve(projectRoot);
  const output = resolve(outputDirectory);
  if (!pathInside(root, output)) throw new Error('release output must be a child of the project root');
  if (output !== resolve(root, '.cloudflare-release')) {
    throw new Error('release output must be the project .cloudflare-release directory');
  }
  if (!GIT_COMMIT_PATTERN.test(gitCommit || '')) throw new Error('git commit must be a full lowercase SHA-1');

  const dist = resolve(root, 'dist');
  const compiledWorker = resolve(workerBundle || resolve(root, '.cloudflare-functions-build', 'index.js'));
  if (pathInside(output, dist) || pathInside(output, compiledWorker)) {
    throw new Error('release output must not contain its inputs');
  }
  const workerStat = await lstat(compiledWorker);
  if (!workerStat.isFile() || workerStat.isSymbolicLink()) {
    throw new Error('compiled Pages Functions worker must be a regular file');
  }
  const workerSource = await readFile(compiledWorker, 'utf8');
  if (!/\bASSETS\b/.test(workerSource) || !/\.fetch\(/.test(workerSource) || !/export\s*\{/.test(workerSource)) {
    throw new Error('compiled Pages Functions worker does not contain the ASSETS fallback contract');
  }
  const routes = JSON.parse(await readFile(resolve(dist, '_routes.json'), 'utf8'));
  if (routes?.version !== 1 || !Array.isArray(routes.include)) {
    throw new Error('Cloudflare _routes.json is invalid');
  }
  for (const requiredRoute of ['/backend-api/*', '/tunnel-admin/update', '/watch', '/playing', '/knowledge-map']) {
    if (!routes.include.includes(requiredRoute)) {
      throw new Error(`Cloudflare _routes.json is missing ${requiredRoute}`);
    }
  }

  await rm(output, { recursive: true, force: true });
  const payload = resolve(output, PAYLOAD_NAME);
  await copyTree(dist, resolve(payload, 'dist'));
  await copyFile(compiledWorker, resolve(payload, 'dist', '_worker.js'));

  const description = await describePayload(payload);
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    gitCommit,
    githubRunId: githubRunId || null,
    githubRunAttempt: githubRunAttempt || null,
    toolchain: {
      node: process.version,
      wrangler: packageJson.devDependencies?.wrangler || null,
    },
    payloadSha256: description.payloadSha256,
    files: description.files,
  };
  await writeFile(resolve(output, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function verifyRelease({ releaseDirectory, expectedCommit = null, expectedSha256 = null }) {
  const releaseRoot = resolve(releaseDirectory);
  const manifestPath = resolve(releaseRoot, MANIFEST_NAME);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error('release manifest must be a regular file');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifestShape(manifest);
  if (expectedCommit && !GIT_COMMIT_PATTERN.test(expectedCommit)) throw new Error('expected commit is invalid');
  if (expectedSha256 && !SHA256_PATTERN.test(expectedSha256)) throw new Error('expected release hash is invalid');
  if (expectedCommit && manifest.gitCommit !== expectedCommit) {
    throw new Error(`release commit mismatch: expected ${expectedCommit}, received ${manifest.gitCommit}`);
  }
  if (expectedSha256 && manifest.payloadSha256 !== expectedSha256) {
    throw new Error(`release hash mismatch: expected ${expectedSha256}, received ${manifest.payloadSha256}`);
  }

  const actual = await describePayload(resolve(releaseRoot, PAYLOAD_NAME));
  if (actual.payloadSha256 !== manifest.payloadSha256) throw new Error('release payload hash mismatch');
  if (JSON.stringify(actual.files) !== JSON.stringify(manifest.files)) {
    throw new Error('release payload file manifest mismatch');
  }
  return manifest;
}

function parseArguments(argv) {
  const command = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || value === undefined) throw new Error(`unsupported or incomplete option: ${option}`);
    if (values.has(option)) throw new Error(`duplicate option: ${option}`);
    values.set(option, value);
  }
  return { command, values };
}

async function appendGitHubOutput(path, manifest) {
  if (!path) return;
  await writeFile(
    path,
    `release_sha256=${manifest.payloadSha256}\nrelease_commit=${manifest.gitCommit}\n`,
    { encoding: 'utf8', flag: 'a' },
  );
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  const projectRoot = resolve(values.get('--project-root') || process.cwd());
  const releaseDirectory = resolve(values.get('--release-dir') || resolve(projectRoot, '.cloudflare-release'));
  let manifest;
  if (command === 'package') {
    manifest = await packageRelease({
      projectRoot,
      outputDirectory: releaseDirectory,
      gitCommit: values.get('--git-commit') || '',
      workerBundle: values.get('--worker-bundle') || null,
      githubRunId: values.get('--github-run-id') || null,
      githubRunAttempt: values.get('--github-run-attempt') || null,
    });
  } else if (command === 'verify') {
    manifest = await verifyRelease({
      releaseDirectory,
      expectedCommit: values.get('--expected-commit') || null,
      expectedSha256: values.get('--expected-sha256') || null,
    });
  } else throw new Error(`unsupported command: ${command || '(missing)'}`);

  await appendGitHubOutput(values.get('--github-output'), manifest);
  console.log(JSON.stringify({
    releaseDirectory,
    gitCommit: manifest.gitCommit,
    payloadSha256: manifest.payloadSha256,
    fileCount: manifest.files.length,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(`Cloudflare release artifact error: ${error.message}`);
    process.exitCode = 1;
  });
}
