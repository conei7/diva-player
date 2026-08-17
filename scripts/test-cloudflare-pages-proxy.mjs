import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest as proxyBackend } from '../functions/backend-api/[[path]].js';
import { onRequest as proxyInvidious } from '../functions/invidious-api/[[path]].js';
import { onRequest as updateTunnel } from '../functions/tunnel-admin/update.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (target, init) => {
  calls.push({ target: String(target), init });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

try {
  const pagesRoutes = JSON.parse(await readFile(new URL('../public/_routes.json', import.meta.url), 'utf8'));
  assert(pagesRoutes.include.includes('/chorus-highlights'), 'Chorus highlights must use the Pages SPA fallback.');
  assert(pagesRoutes.include.includes('/knowledge-map'), 'Knowledge map must use the Pages SPA fallback.');
  assert(pagesRoutes.include.includes('/settings/hidden-songs'), 'Hidden songs settings must use the Pages SPA fallback.');

  const env = {
    PAGES_PROXY_KEY: 'test-proxy-key',
    TUNNEL_CONFIG: {
      get: async key => key === 'quick_tunnel_url' ? 'https://stable-test.trycloudflare.com' : null,
    },
  };
  const backendRequest = new Request('https://diva-player.pages.dev/backend-api/api/health?full=1');
  const backendResponse = await proxyBackend({
    request: backendRequest,
    env,
  });
  assert.equal(backendResponse.status, 200);
  assert.equal(calls[0].target, 'https://stable-test.trycloudflare.com/backend-api/api/health?full=1');
  assert.equal(calls[0].init.headers.get('x-diva-pages-proxy'), '1');
  assert.equal(calls[0].init.headers.get('x-diva-client-key'), 'pages-anonymous');
  assert.equal(calls[0].init.headers.get('x-diva-pages-proxy-key'), 'test-proxy-key');
  assert.equal(calls[0].init.headers.get('x-forwarded-for'), null);
  assert.equal(calls[0].init.signal, backendRequest.signal);

  const invalidResponse = await proxyBackend({
    request: new Request('https://diva-player.pages.dev/backend-api/api/health'),
    env: { PAGES_PROXY_KEY: 'test-proxy-key', TUNNEL_CONFIG: { get: async () => 'https://example.com' } },
  });
  assert.equal(invalidResponse.status, 503);
  assert.equal(calls.length, 1, 'Invalid tunnel origins must never be fetched.');

  const missingProxyKey = await proxyBackend({
    request: new Request('https://diva-player.pages.dev/backend-api/api/health'),
    env: { TUNNEL_CONFIG: { get: async () => 'https://stable-test.trycloudflare.com' } },
  });
  assert.equal(missingProxyKey.status, 503);
  assert.equal(calls.length, 1, 'An unauthenticated Pages proxy must fail closed.');

  const namedRequest = new Request('https://diva-player.pages.dev/backend-api/api/health?full=1', {
    headers: {
      'cf-access-client-id': 'attacker-id',
      'cf-access-client-secret': 'attacker-secret',
    },
  });
  const namedResponse = await proxyBackend({
    request: namedRequest,
    env: {
      DIVA_API_ORIGIN_MODE: 'named',
      DIVA_NAMED_TUNNEL_ORIGIN: 'https://api-origin.example.net',
      CF_ACCESS_CLIENT_ID: 'pages-client-id',
      CF_ACCESS_CLIENT_SECRET: 'pages-client-secret',
      PAGES_PROXY_KEY: 'test-proxy-key',
    },
  });
  assert.equal(namedResponse.status, 200);
  assert.equal(calls[1].target, 'https://api-origin.example.net/api/health?full=1');
  assert.equal(calls[1].init.headers.get('cf-access-client-id'), 'pages-client-id');
  assert.equal(calls[1].init.headers.get('cf-access-client-secret'), 'pages-client-secret');
  assert.equal(calls[1].init.signal, namedRequest.signal);

  const doubleSlashRequest = new Request(
    'https://diva-player.pages.dev/backend-api//attacker.example/steal?x=1',
  );
  const doubleSlashResponse = await proxyBackend({
    request: doubleSlashRequest,
    env: {
      DIVA_API_ORIGIN_MODE: 'named',
      DIVA_NAMED_TUNNEL_ORIGIN: 'https://api-origin.example.net',
      CF_ACCESS_CLIENT_ID: 'pages-client-id',
      CF_ACCESS_CLIENT_SECRET: 'pages-client-secret',
      PAGES_PROXY_KEY: 'test-proxy-key',
    },
  });
  assert.equal(doubleSlashResponse.status, 200);
  assert.equal(new URL(calls[2].target).origin, 'https://api-origin.example.net');
  assert.equal(new URL(calls[2].target).pathname, '//attacker.example/steal');

  for (const invalidNamedEnv of [
    {
      DIVA_API_ORIGIN_MODE: 'named',
      DIVA_NAMED_TUNNEL_ORIGIN: 'http://api-origin.example.net',
      CF_ACCESS_CLIENT_ID: 'id',
      CF_ACCESS_CLIENT_SECRET: 'secret',
    },
    {
      DIVA_API_ORIGIN_MODE: 'named',
      DIVA_NAMED_TUNNEL_ORIGIN: 'https://diva-player.pages.dev',
      CF_ACCESS_CLIENT_ID: 'id',
      CF_ACCESS_CLIENT_SECRET: 'secret',
    },
    {
      DIVA_API_ORIGIN_MODE: 'named',
      DIVA_NAMED_TUNNEL_ORIGIN: 'https://other-project.pages.dev',
      CF_ACCESS_CLIENT_ID: 'id',
      CF_ACCESS_CLIENT_SECRET: 'secret',
    },
    {
      DIVA_API_ORIGIN_MODE: 'named',
      DIVA_NAMED_TUNNEL_ORIGIN: 'https://diva-player.pages.dev.',
      CF_ACCESS_CLIENT_ID: 'id',
      CF_ACCESS_CLIENT_SECRET: 'secret',
    },
    {
      DIVA_API_ORIGIN_MODE: 'named',
      DIVA_NAMED_TUNNEL_ORIGIN: 'https://127.0.0.1',
      CF_ACCESS_CLIENT_ID: 'id',
      CF_ACCESS_CLIENT_SECRET: 'secret',
    },
    {
      DIVA_API_ORIGIN_MODE: 'named',
      DIVA_NAMED_TUNNEL_ORIGIN: 'https://api-origin.example.net',
      CF_ACCESS_CLIENT_ID: 'id',
    },
    { DIVA_API_ORIGIN_MODE: 'unexpected' },
  ]) {
    const response = await proxyBackend({
      request: new Request('https://diva-player.pages.dev/backend-api/api/health'),
      env: { ...invalidNamedEnv, PAGES_PROXY_KEY: 'test-proxy-key' },
    });
    assert.equal(response.status, 503);
  }
  assert.equal(calls.length, 3, 'Invalid named tunnel settings must never be fetched.');

  const invidiousResponse = await proxyInvidious({
    request: new Request('https://diva-player.pages.dev/invidious-api/api/v1/playlists/PL123456?page=1'),
  });
  assert.equal(invidiousResponse.status, 200);
  assert.equal(calls[3].target, 'https://inv.nadeko.net/api/v1/playlists/PL123456?page=1');
  const unsupportedInvidiousResponse = await proxyInvidious({
    request: new Request('https://diva-player.pages.dev/invidious-api/api/v1/search?q=miku'),
  });
  assert.equal(unsupportedInvidiousResponse.status, 404);
  assert.equal(calls.length, 4, 'Unsupported Invidious paths must never be fetched.');
  const invalidPageResponse = await proxyInvidious({
    request: new Request('https://diva-player.pages.dev/invidious-api/api/v1/playlists/PL123456?page=51'),
  });
  assert.equal(invalidPageResponse.status, 400);
  const invalidMethodResponse = await proxyInvidious({
    request: new Request('https://diva-player.pages.dev/invidious-api/api/v1/playlists/PL123456', { method: 'POST' }),
  });
  assert.equal(invalidMethodResponse.status, 405);
  assert.equal(calls.length, 4, 'Invalid Invidious requests must never be fetched.');

  let written = null;
  const proofKey = 'test-origin-proof-key';
  const updateEnv = {
    TUNNEL_SYNC_TOKEN: 'test-secret',
    TUNNEL_ORIGIN_PROOF_KEY: proofKey,
    TUNNEL_CONFIG: { put: async (key, value) => { written = { key, value }; } },
  };
  const unauthorized = await updateTunnel({
    request: new Request('https://diva-player.pages.dev/tunnel-admin/update', {
      method: 'POST',
      body: JSON.stringify({ tunnelUrl: 'https://new-origin.trycloudflare.com' }),
    }),
    env: updateEnv,
  });
  assert.equal(unauthorized.status, 401);
  const tunnelUrl = 'https://new-origin.trycloudflare.com';
  const timestamp = Math.floor(Date.now() / 1000);
  const proof = createHmac('sha256', proofKey)
    .update(`${timestamp}\n${tunnelUrl}`)
    .digest('hex');
  const updated = await updateTunnel({
    request: new Request('https://diva-player.pages.dev/tunnel-admin/update', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ tunnelUrl, timestamp, proof }),
    }),
    env: updateEnv,
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(written, { key: 'quick_tunnel_url', value: tunnelUrl });

  const invalidProof = await updateTunnel({
    request: new Request('https://diva-player.pages.dev/tunnel-admin/update', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ tunnelUrl, timestamp, proof: '0'.repeat(64) }),
    }),
    env: updateEnv,
  });
  assert.equal(invalidProof.status, 401);

  const disabledUpdate = await updateTunnel({
    request: new Request('https://diva-player.pages.dev/tunnel-admin/update', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ tunnelUrl, timestamp, proof }),
    }),
    env: { ...updateEnv, DIVA_API_ORIGIN_MODE: 'named' },
  });
  assert.equal(disabledUpdate.status, 410);
  console.log('PASS Cloudflare Pages API proxy routing');
} finally {
  globalThis.fetch = originalFetch;
}

// The production env file intentionally contains plain KEY=value assignments,
// not shell `export` statements. Exercise the real sync script with a fake
// Python/curl toolchain so a future environment-propagation regression fails.
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(scriptsDirectory, '..');
const syncFixture = await mkdtemp(join(scriptsDirectory, '.quick-tunnel-sync-test-'));
const fixturePath = path => relative(projectDirectory, path).replaceAll('\\', '/');
const shellAbsolutePath = path => path
  .replaceAll('\\', '/')
  .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
try {
  const fakeBin = join(syncFixture, 'bin');
  const envFile = join(syncFixture, 'cloudflare.env');
  const tunnelLog = join(syncFixture, 'cloudflared.log');
  const curlCapture = join(syncFixture, 'curl.args');
  await mkdir(fakeBin);
  await writeFile(envFile, [
    'PAGES_SYNC_TOKEN=test-sync-token',
    'PAGES_ORIGIN_PROOF_KEY=test-origin-proof-key',
    'PAGES_SYNC_URL=https://diva-player.pages.dev/tunnel-admin/update',
    '',
  ].join('\n'));
  await writeFile(tunnelLog, 'https://sync-fixture.trycloudflare.com\n');
  await writeFile(join(fakeBin, 'python3'), `#!/bin/sh
set -eu
: "\${PAGES_ORIGIN_PROOF_KEY:?origin proof key was not exported to Python}"
printf '{"tunnelUrl":"fixture","timestamp":1,"proof":"fixture"}\\n'
`);
  await writeFile(join(fakeBin, 'curl'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" > "$SYNC_CAPTURE"
printf '{"success":true}\\n'
`);
  await Promise.all([
    chmod(join(fakeBin, 'python3'), 0o755),
    chmod(join(fakeBin, 'curl'), 0o755),
  ]);

  const inheritedPath = process.env.PATH ?? process.env.Path ?? '';
  const spawnEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  );
  const syncResult = spawnSync('sh', [fixturePath(join(scriptsDirectory, 'sync-quick-tunnel-to-cloudflare.sh'))], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: {
      ...spawnEnvironment,
      PATH: `${shellAbsolutePath(fakeBin)}:${inheritedPath}`,
      DIVA_CLOUDFLARE_ENV: fixturePath(envFile),
      DIVA_CLOUDFLARED_LOG: fixturePath(tunnelLog),
      DIVA_PYTHON_COMMAND: fixturePath(join(fakeBin, 'python3')),
      DIVA_CURL_COMMAND: fixturePath(join(fakeBin, 'curl')),
      SYNC_CAPTURE: fixturePath(curlCapture),
    },
  });
  assert.equal(syncResult.status, 0, syncResult.stderr);
  assert.match(await readFile(curlCapture, 'utf8'), /Authorization: Bearer test-sync-token/);
} finally {
  await rm(syncFixture, { recursive: true, force: true });
}
