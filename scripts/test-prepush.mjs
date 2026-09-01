import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

const root = process.cwd();
const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? process.execPath : 'npm';
const npmPrefix = isWindows
  ? [process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  : [];
const dotnetEnvironment = { ...process.env, DOTNET_ROLL_FORWARD: process.env.DOTNET_ROLL_FORWARD || 'Major' };

function run(command, args, options = {}) {
  const label = options.label || `${command} ${args.join(' ')}`;
  console.log(`\n=== ${label} ===`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env || process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code ?? 'unknown'}`));
    });
  });
}

async function waitForUrl(url, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Preview exited before ${url} became ready.`);
    try {
      const response = await fetch(url);
      if (response.ok) {
        // A stale preview on the same port must not make a newly failed child
        // look healthy. Give the spawned process time to report a bind error.
        await new Promise(resolve => setTimeout(resolve, 100));
        if (child.exitCode !== null) throw new Error(`Preview exited after ${url} responded.`);
        return;
      }
    } catch {
      // Preview is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Preview did not become ready: ${url}`);
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate an E2E preview port.'));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function withPreview(pathname, callback) {
  const viteScript = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteScript)) throw new Error('Vite is not installed. Run npm ci first.');
  const port = await findAvailablePort();
  const child = spawn(process.execPath, [
    viteScript,
    'preview',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--strictPort',
    '--base', pathname,
  ], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const baseUrl = `http://127.0.0.1:${port}${pathname}`;
  try {
    await waitForUrl(baseUrl, child);
    await callback(baseUrl);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

function resolvePython() {
  if (process.env.DIVA_PYTHON) return { command: process.env.DIVA_PYTHON, prefix: [] };
  return isWindows
    ? { command: 'py', prefix: ['-3.10'] }
    : { command: 'python3', prefix: [] };
}

const npmScripts = async scripts => {
  for (const script of scripts) await run(npmCommand, [...npmPrefix, 'run', script], { label: script });
};

async function main() {
  await npmScripts(['lint', 'test']);
  await run('dotnet', ['restore', 'diva-player.sln', '--locked-mode'], { label: 'Restore locked API dependencies', env: dotnetEnvironment });
  await run('dotnet', ['build', 'backend/api/VocadbRecommender/VocadbRecommender.csproj', '--configuration', 'Release', '--no-restore'], { label: 'Build API', env: dotnetEnvironment });
  await run('dotnet', ['test', 'backend/api/VocadbRecommender.Tests/VocadbRecommender.Tests.csproj', '--configuration', 'Release', '--no-restore'], { label: 'Test API', env: dotnetEnvironment });
  await npmScripts([
    'test:deployment-topology',
    'test:sbc-trivy-installer',
    'test:primary-topology',
    'test:rolling-deployment',
    'test:stateful-hardening',
    'test:runtime-health',
  ]);
  const python = resolvePython();
  const pythonContracts = [
    ['scripts/test-attest-disaster-backup-payloads.py', 'Backup payload attester trustee policy'],
    ['scripts/test-container-image-scan-validator.py', 'Container image scan receipt contract'],
    ['scripts/test-postgres-container-images.py', 'PostgreSQL container image contract'],
    ['scripts/test-sbc-runtime-contract.py', 'Python SBC runtime contract'],
    ['scripts/test-sbc-qdrant-storage-upgrade.py', 'Python SBC Qdrant upgrade controller'],
    ['scripts/test-sbc-api-bridge-consumption.py', 'Python SBC API bridge receipt consumption'],
  ];
  for (const [script, label] of pythonContracts) {
    await run(python.command, [...python.prefix, '-B', script], { label });
  }
  await run(python.command, [...python.prefix, '-B', 'scripts/test-runtime-health-collector.py'], { label: 'Python runtime health collector contract' });
  await npmScripts([
    'test:db-role-provisioning',
    'test:migration-runner',
    'test:tag-parent-fk-migration',
    'test:cloudflare-release',
    'build',
  ]);

  await withPreview('/diva-player/', async baseUrl => {
    for (const script of [
      'test:e2e:player-controls',
      'test:e2e:hidden-songs',
      'test:e2e:external-players',
      'test:e2e:mobile-player-gestures',
      'test:e2e:youtube-playlist-sync',
      'test:e2e:nico-playlist-sync',
      'test:e2e:playlists',
      'test:e2e:knowledge-map',
      'test:e2e:advanced-search',
      'test:e2e:background-playback',
      'test:e2e:navigation',
      'test:performance-budget',
      'test:e2e:multi-tab-player',
    ]) {
      await run(npmCommand, [...npmPrefix, 'run', script, '--', baseUrl], { label: `${script} (${baseUrl})` });
    }
    await run(npmCommand, [...npmPrefix, 'run', 'test:e2e:settings', '--', '--base-url', baseUrl], {
      label: `test:e2e:settings (${baseUrl})`,
    });
    await run(npmCommand, [...npmPrefix, 'run', 'test:e2e:mobile', '--', '--base-url', baseUrl], { label: `test:e2e:mobile (${baseUrl})` });
    await run(npmCommand, [...npmPrefix, 'run', 'test:cloudflare-proxy'], { label: 'Cloudflare proxy contract test' });
  });

  await run(npmCommand, [...npmPrefix, 'run', 'build:cloudflare'], { label: 'Build Cloudflare artifact' });
  await withPreview('/', async baseUrl => {
    await run(npmCommand, [...npmPrefix, 'run', 'test:e2e:pages-nico', '--', baseUrl, '--local-fixture'], {
      label: 'Local equivalent of post-deploy Nico smoke',
    });
  });

  console.log('\nPASS pre-push frontend/API/contracts/E2E suite');
  console.log('NOTE disposable PostgreSQL migration harness remains environment-specific; run it locally whenever database or migration files change.');
}

main().catch(error => {
  console.error(`\nPre-push suite failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
