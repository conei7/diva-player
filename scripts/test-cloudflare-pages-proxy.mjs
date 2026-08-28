import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest as proxyBackend } from '../functions/backend-api/[[path]].js';
import { onRequest as proxyInvidious } from '../functions/invidious-api/[[path]].js';
import { onRequest as serveSpaFallback } from '../functions/[[path]].js';
import { onRequest as updateTunnel } from '../functions/tunnel-admin/update.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (target, init) => {
  calls.push({ target: String(target), init });
  return new Response(JSON.stringify({ ok: true, status: 'ready' }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-diva-origin-role': 'standby',
      'x-diva-standby-state': 'stale',
    },
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
  const backendRequest = new Request(
    'https://diva-player.pages.dev/backend-api/api/health?full=1',
    {
      headers: {
        'x-diva-origin-role': 'standby',
        'x-diva-standby-state': 'fresh',
      },
    },
  );
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
  assert.equal(calls[0].init.headers.get('x-diva-origin-role'), null);
  assert.equal(calls[0].init.headers.get('x-diva-standby-state'), null);
  assert(calls[0].init.signal instanceof AbortSignal);
  assert.notEqual(calls[0].init.signal, backendRequest.signal);
  assert.equal(backendResponse.headers.get('x-diva-origin-role'), 'primary');
  assert.equal(backendResponse.headers.get('x-diva-standby-state'), 'missing');

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
  assert(calls[1].init.signal instanceof AbortSignal);
  assert.notEqual(calls[1].init.signal, namedRequest.signal);
  assert.equal(namedResponse.headers.get('x-diva-origin-role'), 'named');
  assert.equal(namedResponse.headers.get('x-diva-standby-state'), 'unknown');

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

  const spaResponse = await serveSpaFallback({
    request: new Request('https://diva-player.pages.dev/watch?v=10767'),
    env: {
      ASSETS: {
        fetch: async () => new Response('<!doctype html><title>DIVA Player</title>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      },
    },
  });
  assert.match(spaResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(spaResponse.headers.get('content-security-policy'), /https:\/\/www\.youtube\.com/);
  assert.equal(spaResponse.headers.get('x-frame-options'), 'DENY');
  assert.equal(spaResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(spaResponse.headers.get('permissions-policy'), /camera=\(\)/);

  const writes = [];
  const proofKey = 'test-origin-proof-key';
  const updateEnv = {
    TUNNEL_SYNC_TOKEN: 'test-secret',
    TUNNEL_ORIGIN_PROOF_KEY: proofKey,
    PAGES_PROXY_KEY: 'test-proxy-key',
    TUNNEL_CONFIG: {
      put: async (key, value, options) => { writes.push({ key, value, options }); },
    },
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
  assert.deepEqual(writes.map(write => write.key), [
    'quick_tunnel_primary_url',
    'quick_tunnel_url',
  ]);
  assert(writes.every(write => write.value === tunnelUrl));
  assert(writes.every(write => Number.isFinite(Date.parse(write.options?.metadata?.checkedAt))));
  assert.equal(
    writes[0].options.metadata.checkedAt,
    writes[1].options.metadata.checkedAt,
    'Primary and legacy keys must share one server-side health-check timestamp.',
  );
  assert.equal(calls[4].target, `${tunnelUrl}/backend-api/api/ready`);
  assert.equal(calls[4].init.headers['x-diva-pages-proxy'], '1');
  assert.equal(calls[4].init.headers['x-diva-pages-proxy-key'], 'test-proxy-key');
  assert.equal(calls[4].init.redirect, 'manual');

  const healthyOriginFetch = globalThis.fetch;
  globalThis.fetch = async (target, init) => {
    calls.push({ target: String(target), init });
    return new Response('<html>wrong route</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };
  const writesBeforeInvalidReadiness = writes.length;
  const invalidReadiness = await updateTunnel({
    request: new Request('https://diva-player.pages.dev/tunnel-admin/update', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ tunnelUrl, timestamp, proof }),
    }),
    env: updateEnv,
  });
  assert.equal(invalidReadiness.status, 424);
  assert.equal(writes.length, writesBeforeInvalidReadiness);
  assert.equal(calls[5].init.redirect, 'manual');
  globalThis.fetch = healthyOriginFetch;

  const missingHealthCredential = await updateTunnel({
    request: new Request('https://diva-player.pages.dev/tunnel-admin/update', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ tunnelUrl, timestamp, proof }),
    }),
    env: { ...updateEnv, PAGES_PROXY_KEY: '' },
  });
  assert.equal(missingHealthCredential.status, 503);
  assert.equal(calls.length, 6, 'Tunnel health must not run without the Pages proxy credential.');

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

  const standbyUrl = 'https://standby-origin.trycloudflare.com';
  const standbyProof = createHmac('sha256', proofKey)
    .update(`${timestamp}\nstandby\n${standbyUrl}`)
    .digest('hex');
  const standbyUpdated = await updateTunnel({
    request: new Request('https://diva-player.pages.dev/tunnel-admin/update', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        tunnelUrl: standbyUrl,
        originRole: 'standby',
        timestamp,
        proof: standbyProof,
      }),
    }),
    env: updateEnv,
  });
  assert.equal(standbyUpdated.status, 200);
  assert.equal(writes.at(-1).key, 'quick_tunnel_standby_url');
  assert.equal(writes.at(-1).value, standbyUrl);
  assert(Number.isFinite(Date.parse(writes.at(-1).options?.metadata?.checkedAt)));

  const failoverCalls = [];
  globalThis.fetch = async (target, init) => {
    failoverCalls.push({ target: String(target), init });
    return new Response(
      JSON.stringify({ origin: failoverCalls.length === 1 ? 'primary' : 'standby' }),
      {
        status: failoverCalls.length === 1 ? 503 : 200,
        headers: {
          'x-diva-origin-role': 'primary',
          'x-diva-standby-state': 'stale',
        },
      },
    );
  };
  const failoverResponse = await proxyBackend({
    request: new Request('https://diva-player.pages.dev/backend-api/api/health?full=1'),
    env: {
      PAGES_PROXY_KEY: 'test-proxy-key',
      TUNNEL_CONFIG: {
        getWithMetadata: async key => ({
          value: ({
            quick_tunnel_primary_url: tunnelUrl,
            quick_tunnel_standby_url: standbyUrl,
          })[key] ?? null,
          metadata: key === 'quick_tunnel_standby_url'
            ? { checkedAt: new Date().toISOString() }
            : null,
        }),
      },
    },
  });
  assert.equal(failoverResponse.status, 200);
  assert.equal(failoverCalls.length, 2);
  assert.equal(failoverCalls[0].target, `${tunnelUrl}/backend-api/api/health?full=1`);
  assert.equal(failoverCalls[1].target, `${standbyUrl}/backend-api/api/health?full=1`);
  assert.equal(failoverResponse.headers.get('x-diva-origin-role'), 'standby');
  assert.equal(failoverResponse.headers.get('x-diva-standby-state'), 'fresh');

  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const staleStandbyResponse = await proxyBackend({
    request: new Request('https://diva-player.pages.dev/backend-api/api/ready'),
    env: {
      PAGES_PROXY_KEY: 'test-proxy-key',
      TUNNEL_CONFIG: {
        getWithMetadata: async key => ({
          value: ({
            quick_tunnel_primary_url: tunnelUrl,
            quick_tunnel_standby_url: standbyUrl,
          })[key] ?? null,
          metadata: key === 'quick_tunnel_standby_url'
            ? { checkedAt: new Date(Date.now() - (16 * 60 * 1000)).toISOString() }
            : null,
        }),
      },
    },
  });
  assert.equal(staleStandbyResponse.headers.get('x-diva-origin-role'), 'primary');
  assert.equal(staleStandbyResponse.headers.get('x-diva-standby-state'), 'stale');

  const futureStandbyResponse = await proxyBackend({
    request: new Request('https://diva-player.pages.dev/backend-api/api/ready'),
    env: {
      PAGES_PROXY_KEY: 'test-proxy-key',
      TUNNEL_CONFIG: {
        getWithMetadata: async key => ({
          value: ({
            quick_tunnel_primary_url: tunnelUrl,
            quick_tunnel_standby_url: standbyUrl,
          })[key] ?? null,
          metadata: key === 'quick_tunnel_standby_url'
            ? { checkedAt: new Date(Date.now() + (2 * 60 * 1000)).toISOString() }
            : null,
        }),
      },
    },
  });
  assert.equal(futureStandbyResponse.headers.get('x-diva-standby-state'), 'stale');

  let duplicateOriginCallCount = 0;
  globalThis.fetch = async () => {
    duplicateOriginCallCount += 1;
    return new Response('{}', { status: 200 });
  };
  const duplicateStandbyResponse = await proxyBackend({
    request: new Request('https://diva-player.pages.dev/backend-api/api/ready'),
    env: {
      PAGES_PROXY_KEY: 'test-proxy-key',
      TUNNEL_CONFIG: {
        getWithMetadata: async key => ({
          value: ({
            quick_tunnel_primary_url: tunnelUrl,
            quick_tunnel_standby_url: tunnelUrl.toUpperCase(),
          })[key] ?? null,
          metadata: key === 'quick_tunnel_standby_url'
            ? { checkedAt: new Date().toISOString() }
            : null,
        }),
      },
    },
  });
  assert.equal(duplicateOriginCallCount, 1);
  assert.equal(duplicateStandbyResponse.headers.get('x-diva-origin-role'), 'primary');
  assert.equal(duplicateStandbyResponse.headers.get('x-diva-standby-state'), 'missing');

  const postFailoverCalls = [];
  globalThis.fetch = async (target, init) => {
    postFailoverCalls.push({
      target: String(target),
      body: init.body ? await new Response(init.body).text() : '',
    });
    return new Response('{}', { status: postFailoverCalls.length === 1 ? 503 : 200 });
  };
  const postBody = JSON.stringify({ songIds: [1, 2, 3] });
  const postFailoverResponse = await proxyBackend({
    request: new Request(
      'https://diva-player.pages.dev/backend-api/api/discovery/knowledge-map',
      { method: 'POST', body: postBody, headers: { 'content-type': 'application/json' } },
    ),
    env: {
      PAGES_PROXY_KEY: 'test-proxy-key',
      TUNNEL_CONFIG: {
        get: async key => ({
          quick_tunnel_primary_url: tunnelUrl,
          quick_tunnel_standby_url: standbyUrl,
        })[key] ?? null,
      },
    },
  });
  assert.equal(postFailoverResponse.status, 503);
  assert.deepEqual(postFailoverCalls.map(call => call.body), [postBody]);
  assert.equal(postFailoverResponse.headers.get('x-diva-origin-role'), 'primary');
  assert.equal(
    postFailoverResponse.headers.get('x-diva-standby-state'),
    'unknown',
    'KV records created before metadata support must fail closed until revalidated.',
  );

  const freshFailoverEnv = {
    PAGES_PROXY_KEY: 'test-proxy-key',
    TUNNEL_CONFIG: {
      getWithMetadata: async key => ({
        value: ({
          quick_tunnel_primary_url: tunnelUrl,
          quick_tunnel_standby_url: standbyUrl,
        })[key] ?? null,
        metadata: key === 'quick_tunnel_standby_url'
          ? { checkedAt: new Date().toISOString() }
          : null,
      }),
    },
  };
  for (const path of [
    '/backend-api/api/recommend/multi',
    '/backend-api/api/recommend/dig',
    '/backend-api/api/discovery/knowledge-map',
  ]) {
    postFailoverCalls.length = 0;
    const readOnlyPostFailoverResponse = await proxyBackend({
      request: new Request(
        `https://diva-player.pages.dev${path}`,
        { method: 'POST', body: postBody, headers: { 'content-type': 'application/json' } },
      ),
      env: freshFailoverEnv,
    });
    assert.equal(readOnlyPostFailoverResponse.status, 200);
    assert.deepEqual(postFailoverCalls.map(call => call.body), [postBody, postBody]);
    assert.equal(readOnlyPostFailoverResponse.headers.get('x-diva-origin-role'), 'standby');
  }

  postFailoverCalls.length = 0;
  const mutatingPostResponse = await proxyBackend({
    request: new Request(
      'https://diva-player.pages.dev/backend-api/api/future-write',
      { method: 'POST', body: postBody, headers: { 'content-type': 'application/json' } },
    ),
    env: freshFailoverEnv,
  });
  assert.equal(mutatingPostResponse.status, 503);
  assert.deepEqual(postFailoverCalls.map(call => call.body), [postBody]);
  assert.equal(mutatingPostResponse.headers.get('x-diva-origin-role'), 'primary');

  postFailoverCalls.length = 0;
  const mutatingPutResponse = await proxyBackend({
    request: new Request(
      'https://diva-player.pages.dev/backend-api/api/future-write',
      { method: 'PUT', body: postBody, headers: { 'content-type': 'application/json' } },
    ),
    env: freshFailoverEnv,
  });
  assert.equal(mutatingPutResponse.status, 503);
  assert.deepEqual(postFailoverCalls.map(call => call.body), [postBody]);
  assert.equal(mutatingPutResponse.headers.get('x-diva-origin-role'), 'primary');

  let mutatingTransportCallCount = 0;
  globalThis.fetch = async () => {
    mutatingTransportCallCount += 1;
    throw new Error('ambiguous primary transport failure');
  };
  const mutatingTransportResponse = await proxyBackend({
    request: new Request(
      'https://diva-player.pages.dev/backend-api/api/future-write',
      { method: 'POST', body: postBody, headers: { 'content-type': 'application/json' } },
    ),
    env: freshFailoverEnv,
  });
  assert.equal(mutatingTransportResponse.status, 502);
  assert.equal(mutatingTransportCallCount, 1);
  assert.equal(mutatingTransportResponse.headers.get('x-diva-origin-role'), 'primary');

  let unavailableCallCount = 0;
  globalThis.fetch = async () => {
    unavailableCallCount += 1;
    if (unavailableCallCount === 1) return new Response('primary failed', { status: 503 });
    throw new Error('standby unavailable');
  };
  const unavailableResponse = await proxyBackend({
    request: new Request('https://diva-player.pages.dev/backend-api/api/ready'),
    env: {
      PAGES_PROXY_KEY: 'test-proxy-key',
      TUNNEL_CONFIG: {
        get: async key => ({
          quick_tunnel_primary_url: tunnelUrl,
          quick_tunnel_standby_url: standbyUrl,
        })[key] ?? null,
      },
    },
  });
  assert.equal(unavailableResponse.status, 503);
  assert.equal(await unavailableResponse.text(), 'primary failed');
  assert.equal(unavailableCallCount, 1);
  assert.equal(unavailableResponse.headers.get('x-diva-origin-role'), 'primary');
  assert.equal(unavailableResponse.headers.get('x-diva-standby-state'), 'unknown');

  const originalAbortTimeout = AbortSignal.timeout;
  try {
    for (const abortSource of ['caller', 'timeout']) {
      const callerController = new AbortController();
      const timeoutController = new AbortController();
      let streamedSignal;
      AbortSignal.timeout = milliseconds => {
        assert.equal(milliseconds, 15_000);
        return timeoutController.signal;
      };
      globalThis.fetch = async (_target, init) => {
        streamedSignal = init.signal;
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      };
      const streamingResponse = await proxyBackend({
        request: new Request(
          'https://diva-player.pages.dev/backend-api/api/ready',
          { signal: callerController.signal },
        ),
        env: freshFailoverEnv,
      });
      assert.equal(streamedSignal.aborted, false);
      if (abortSource === 'caller') callerController.abort('caller disconnected');
      else timeoutController.abort(new Error('origin timeout'));
      await Promise.resolve();
      assert.equal(
        streamedSignal.aborted,
        true,
        `${abortSource} abort must remain attached while the origin body streams.`,
      );
      await streamingResponse.body.cancel().catch(() => {});
    }
  } finally {
    AbortSignal.timeout = originalAbortTimeout;
  }
  globalThis.fetch = originalFetch;
  console.log('PASS Cloudflare Pages API proxy routing');
} finally {
  globalThis.fetch = originalFetch;
}

// Exercise the real environment parser and HMAC builder without sending a
// request. Secrets must stay out of argv, child environments, and output.
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(scriptsDirectory, '..');
const syncFixture = await mkdtemp(join(scriptsDirectory, '.quick-tunnel-sync-test-'));
const fixturePath = path => relative(projectDirectory, path).replaceAll('\\', '/');
const shellAbsolutePath = path => path
  .replaceAll('\\', '/')
  .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
try {
  const envFile = join(syncFixture, 'cloudflare.env');
  const tunnelLog = join(syncFixture, 'cloudflared.log');
  await writeFile(envFile, [
    'PAGES_SYNC_TOKEN=test-sync-token',
    'PAGES_ORIGIN_PROOF_KEY=test-origin-proof-key-0123456789abcdef',
    'PAGES_SYNC_URL=https://diva-player.pages.dev/tunnel-admin/update',
    '',
  ].join('\n'));
  await chmod(envFile, 0o600);
  await writeFile(tunnelLog, 'https://sync-fixture.trycloudflare.com\n');

  const spawnEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  );
  const syncResult = spawnSync('sh', [fixturePath(join(scriptsDirectory, 'sync-quick-tunnel-to-cloudflare.sh'))], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: {
      ...spawnEnvironment,
      PATH: process.env.PATH ?? process.env.Path ?? '',
      DIVA_CLOUDFLARE_ENV: fixturePath(envFile),
      DIVA_CLOUDFLARED_LOG: fixturePath(tunnelLog),
      DIVA_PYTHON_COMMAND: process.platform === 'win32'
        ? shellAbsolutePath(join(
          projectDirectory,
          '..',
          'diva-data-pipeline',
          'ml_pipeline',
          '.venv',
          'Scripts',
          'python.exe',
        ))
        : 'python3',
      DIVA_SYNC_HELPER: fixturePath(join(scriptsDirectory, 'sync-quick-tunnel-to-cloudflare.py')),
      DIVA_SYNC_DRY_RUN: '1',
      DIVA_TUNNEL_ORIGIN_ROLE: 'standby',
    },
  });
  assert.equal(syncResult.status, 0, syncResult.stderr);
  assert.match(syncResult.stdout, /"originRole":"standby"/);
  assert.match(syncResult.stdout, /"proofLength":64/);
  assert.doesNotMatch(syncResult.stdout + syncResult.stderr, /test-sync-token|test-origin-proof-key/);
} finally {
  await rm(syncFixture, { recursive: true, force: true });
}
