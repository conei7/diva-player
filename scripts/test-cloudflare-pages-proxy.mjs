import assert from 'node:assert/strict';
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
  const env = {
    TUNNEL_CONFIG: {
      get: async key => key === 'quick_tunnel_url' ? 'https://stable-test.trycloudflare.com' : null,
    },
  };
  const backendResponse = await proxyBackend({
    request: new Request('https://diva-player.pages.dev/backend-api/api/health?full=1'),
    env,
  });
  assert.equal(backendResponse.status, 200);
  assert.equal(calls[0].target, 'https://stable-test.trycloudflare.com/backend-api/api/health?full=1');
  assert.equal(calls[0].init.headers.get('x-diva-pages-proxy'), '1');

  const invalidResponse = await proxyBackend({
    request: new Request('https://diva-player.pages.dev/backend-api/api/health'),
    env: { TUNNEL_CONFIG: { get: async () => 'https://example.com' } },
  });
  assert.equal(invalidResponse.status, 503);
  assert.equal(calls.length, 1, 'Invalid tunnel origins must never be fetched.');

  const invidiousResponse = await proxyInvidious({
    request: new Request('https://diva-player.pages.dev/invidious-api/api/v1/search?q=miku'),
  });
  assert.equal(invidiousResponse.status, 200);
  assert.equal(calls[1].target, 'https://inv.nadeko.net/api/v1/search?q=miku');

  let written = null;
  const updateEnv = {
    TUNNEL_SYNC_TOKEN: 'test-secret',
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
  const updated = await updateTunnel({
    request: new Request('https://diva-player.pages.dev/tunnel-admin/update', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ tunnelUrl: 'https://new-origin.trycloudflare.com' }),
    }),
    env: updateEnv,
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(written, { key: 'quick_tunnel_url', value: 'https://new-origin.trycloudflare.com' });
  console.log('PASS Cloudflare Pages API proxy routing');
} finally {
  globalThis.fetch = originalFetch;
}
