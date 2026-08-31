import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { onRequest as proxyBackend } from '../functions/backend-api/[[path]].js';
import { onRequest as updateTunnel } from '../functions/tunnel-admin/update.js';
import {
  evaluatePublicPrimaryHealth,
  runPublicPrimaryHealth,
} from './check-public-dr-health.mjs';

const [
  pagesProxy,
  tunnelAdmin,
  publicPrimaryMonitor,
  publicPrimaryWorkflow,
  deployWorkflow,
  prepush,
  packageJsonSource,
] = await Promise.all([
  readFile(new URL('../functions/backend-api/[[path]].js', import.meta.url), 'utf8'),
  readFile(new URL('../functions/tunnel-admin/update.js', import.meta.url), 'utf8'),
  readFile(new URL('./check-public-dr-health.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/public-dr-health.yml', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'),
  readFile(new URL('./test-prepush.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

const packageJson = JSON.parse(packageJsonSource);

assert.match(pagesProxy, /quick_tunnel_primary_url/);
assert.doesNotMatch(pagesProxy, /quick_tunnel_standby_url/);
assert.doesNotMatch(pagesProxy, /canFailover|fallbackOrigin|role:\s*['"]standby['"]/);
assert.match(pagesProxy, /X-Diva-Origin-Role['"],\s*['"]primary['"]/);
assert.match(pagesProxy, /X-Diva-Standby-State['"],\s*['"]missing['"]/);

assert.match(tunnelAdmin, /originRole === ['"]standby['"]/);
assert.match(tunnelAdmin, /standby origin is retired/);
assert.match(tunnelAdmin, /status:\s*410/);
assert.match(tunnelAdmin, /TUNNEL_CONFIG\.delete\(RETIRED_STANDBY_TUNNEL_KEY\)/);
assert.doesNotMatch(tunnelAdmin, /standby:\s*['"]quick_tunnel_standby_url['"]/);

assert.match(publicPrimaryMonitor, /mode:\s*['"]primary-only['"]/);
assert.match(publicPrimaryWorkflow, /name:\s*Public primary health monitor/);
assert.match(publicPrimaryWorkflow, /cron:\s*['"]7,22,37,52 \* \* \* \*['"]/);
assert.match(publicPrimaryWorkflow, /npm run check:public-primary-health/);
assert.doesNotMatch(publicPrimaryWorkflow, /secrets\./);

assert.equal(
  packageJson.scripts['test:primary-topology'],
  'node scripts/test-primary-topology.mjs',
);
assert.equal(packageJson.scripts['test:dr-standby-topology'], undefined);
assert.equal(packageJson.scripts['test:wsl-dr-deployment'], undefined);
assert.match(prepush, /['"]test:primary-topology['"]/);
assert.doesNotMatch(prepush, /test:dr-standby-topology|test:wsl-dr-deployment/);
assert.doesNotMatch(
  prepush,
  /test-wsl-dr-api-bridge-receipt\.py|test-wsl-dr-lock-guardian\.py/,
);
assert.match(deployWorkflow, /Primary-only public topology contract/);
assert.match(deployWorkflow, /npm run test:primary-topology/);
assert.doesNotMatch(
  deployWorkflow,
  /test:dr-standby-topology|test:wsl-dr-deployment|test-wsl-dr-api-bridge-receipt\.py|test-wsl-dr-lock-guardian\.py/,
);

const healthyProbes = [1, 2].flatMap(round => [
  { round, path: '/', ok: true, originRole: null, standbyState: null },
  {
    round,
    path: '/backend-api/api/ready',
    ok: true,
    originRole: 'primary',
    standbyState: 'missing',
  },
  {
    round,
    path: '/backend-api/api/health',
    ok: true,
    originRole: 'primary',
    standbyState: 'missing',
  },
]);
assert.deepEqual(evaluatePublicPrimaryHealth(healthyProbes), { ok: true, issues: [] });

for (const invalid of [
  { originRole: 'standby', standbyState: 'fresh' },
  { originRole: 'primary', standbyState: 'fresh' },
  { originRole: 'named', standbyState: 'unknown' },
]) {
  const probes = healthyProbes.map(probe => (
    probe.path === '/'
      ? probe
      : { ...probe, ...invalid }
  ));
  assert.equal(evaluatePublicPrimaryHealth(probes).ok, false);
}

const standbyRegistration = await updateTunnel({
  request: new Request('https://diva-player.pages.dev/tunnel-admin/update', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ originRole: 'standby' }),
  }),
  env: {
    DIVA_API_ORIGIN_MODE: 'quick',
    TUNNEL_SYNC_TOKEN: 'test-token',
    TUNNEL_ORIGIN_PROOF_KEY: 'test-proof-key',
    PAGES_PROXY_KEY: 'test-pages-key',
  },
});
assert.equal(standbyRegistration.status, 410);

const originalFetch = globalThis.fetch;
try {
  const proxyCalls = [];
  globalThis.fetch = async (target, init) => {
    proxyCalls.push({ target: String(target), init });
    return Response.json({ error: 'primary unavailable' }, {
      status: 503,
      headers: {
        'x-diva-origin-role': 'standby',
        'x-diva-standby-state': 'fresh',
      },
    });
  };
  const requestedKeys = [];
  const proxyResponse = await proxyBackend({
    request: new Request(
      'https://diva-player.pages.dev/backend-api/api/health?full=1',
    ),
    env: {
      PAGES_PROXY_KEY: 'test-pages-key',
      TUNNEL_CONFIG: {
        getWithMetadata: async key => {
          requestedKeys.push(key);
          return key === 'quick_tunnel_primary_url'
            ? { value: 'https://primary-origin.trycloudflare.com', metadata: null }
            : { value: null, metadata: null };
        },
      },
    },
  });
  assert.deepEqual(requestedKeys.sort(), ['quick_tunnel_primary_url', 'quick_tunnel_url']);
  assert.equal(proxyCalls.length, 1);
  assert.equal(
    proxyCalls[0].target,
    'https://primary-origin.trycloudflare.com/backend-api/api/health?full=1',
  );
  assert.equal(proxyResponse.status, 503);
  assert.equal(proxyResponse.headers.get('x-diva-origin-role'), 'primary');
  assert.equal(proxyResponse.headers.get('x-diva-standby-state'), 'missing');

  globalThis.fetch = async target => {
    const path = new URL(target).pathname;
    if (path.endsWith('/api/ready')) {
      return Response.json({ status: 'ready' }, {
        status: 200,
        headers: {
          'x-diva-origin-role': 'primary',
          'x-diva-standby-state': 'missing',
        },
      });
    }
    if (path.endsWith('/api/health')) {
      return Response.json({ status: 'ok' }, {
        status: 200,
        headers: {
          'x-diva-origin-role': 'primary',
          'x-diva-standby-state': 'missing',
        },
      });
    }
    return new Response('<!doctype html>', { status: 200 });
  };
  const report = await runPublicPrimaryHealth({
    baseUrl: 'https://diva-player.pages.dev',
    timeoutMs: 1000,
    intervalMs: 1,
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.routingContract, {
    mode: 'primary-only',
    originRole: 'primary',
    standbyState: 'missing',
  });
} finally {
  globalThis.fetch = originalFetch;
}

console.log('PASS primary-only public topology contract');
