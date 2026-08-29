import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  evaluatePublicDrHealth,
  runPublicDrHealth,
} from './check-public-dr-health.mjs';

const [
  compose,
  gateway,
  nginx,
  provisioner,
  deploy,
  watchdog,
  watchdogService,
  watchdogTimer,
  tunnelRunner,
  tunnelUnit,
  tunnelSync,
  tunnelSyncHelper,
  tunnelInstaller,
  tunnelSyncUnit,
  tunnelSyncTimer,
  pagesProxy,
  tunnelAdmin,
  publicDrMonitor,
  publicDrWorkflow,
  packageJson,
  primaryCompose,
  primaryGateway,
] = (await Promise.all([
  readFile(new URL('../backend/docker-compose.dr-standby.yml', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api-gateway/haproxy.dr-standby.cfg', import.meta.url), 'utf8'),
  readFile(new URL('../nginx.dr-standby.conf', import.meta.url), 'utf8'),
  readFile(new URL('./provision-wsl-dr-api-role.sh', import.meta.url), 'utf8'),
  readFile(new URL('./deploy-wsl-dr-standby.sh', import.meta.url), 'utf8'),
  readFile(new URL('./check-wsl-dr-standby.sh', import.meta.url), 'utf8'),
  readFile(new URL('./diva-wsl-dr-watchdog.service', import.meta.url), 'utf8'),
  readFile(new URL('./diva-wsl-dr-watchdog.timer', import.meta.url), 'utf8'),
  readFile(new URL('./run-wsl-dr-quick-tunnel.sh', import.meta.url), 'utf8'),
  readFile(new URL('./diva-wsl-dr-quick-tunnel.service', import.meta.url), 'utf8'),
  readFile(new URL('./sync-quick-tunnel-to-cloudflare.sh', import.meta.url), 'utf8'),
  readFile(new URL('./sync-quick-tunnel-to-cloudflare.py', import.meta.url), 'utf8'),
  readFile(new URL('./install-wsl-dr-quick-tunnel.sh', import.meta.url), 'utf8'),
  readFile(new URL('./diva-wsl-dr-quick-tunnel-sync.service', import.meta.url), 'utf8'),
  readFile(new URL('./diva-wsl-dr-quick-tunnel-sync.timer', import.meta.url), 'utf8'),
  readFile(new URL('../functions/backend-api/[[path]].js', import.meta.url), 'utf8'),
  readFile(new URL('../functions/tunnel-admin/update.js', import.meta.url), 'utf8'),
  readFile(new URL('./check-public-dr-health.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/public-dr-health.yml', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../backend/docker-compose.yml', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api-gateway/haproxy.cfg', import.meta.url), 'utf8'),
])).map(content => content.replaceAll('\r\n', '\n'));

function capturedInteger(content, pattern, label) {
  const match = content.match(pattern);
  assert.ok(match, `${label} was not found`);
  return Number(match[1]);
}

function capturedIntegers(content, pattern) {
  return [...content.matchAll(pattern)].map(match => Number(match[1]));
}

assert.match(compose, /container_name: diva_dr_api_a/);
assert.match(compose, /container_name: diva_dr_api_b/);
assert.match(compose, /container_name: diva_dr_api_gateway/);
assert.match(compose, /container_name: diva_dr_web/);
// The shared API anchor applies one host-network declaration to both slots;
// gateway and Web carry their own declarations.
assert.equal((compose.match(/network_mode: host/g) ?? []).length, 3);
assert.doesNotMatch(compose, /^\s+ports:/m);
assert.match(compose, /Host=127\.0\.0\.1;Port=5432;Database=diva_standby/);
assert.match(compose, /Recommender__QdrantEndpoint: "http:\/\/127\.0\.0\.1:16334"/);
assert.match(compose, /Recommender__QdrantRestEndpoint: "http:\/\/127\.0\.0\.1:16333"/);
assert.match(compose, /Maximum Pool Size=8/);
assert.match(compose, /Recommender__Bulkhead__AggregatePermitLimit: "3"/);
assert.match(compose, /Recommender__Bulkhead__DatabaseConnectionReserve: "2"/);
assert.match(compose, /Recommender__Bulkhead__HeavyPermitLimit: "3"/);
assert.match(compose, /Recommender__Bulkhead__ProviderPermitLimit: "1"/);
assert.match(compose, /Recommender__Bulkhead__QueueTimeoutMilliseconds: "1000"/);
assert.match(compose, /mem_limit: "384m"/);
assert.equal((compose.match(/mem_limit: "128m"/g) ?? []).length, 2);
assert.match(compose, /pids_limit: 128/);
assert.equal((compose.match(/pids_limit: 64/g) ?? []).length, 2);
assert.match(compose, /DIVA_API_DB_PASSWORD:\?DIVA_API_DB_PASSWORD is required/);
assert.match(compose, /PAGES_PROXY_KEY:\?PAGES_PROXY_KEY is required/);
assert.doesNotMatch(compose, /DIVA_DB_ADMIN_PASSWORD/);
assert.doesNotMatch(compose, /postgres_data|qdrant_data/);
assert.match(compose, /cap_drop:\s*\n\s+- ALL/);
assert.match(compose, /no-new-privileges=true/);
assert.match(gateway, /bind 127\.0\.0\.1:15000/);
assert.match(gateway, /maxconn 128/);
assert.match(gateway, /timeout queue 2s/);
assert.match(gateway, /timeout http-request 10s/);
assert.match(gateway, /frontend api_front[\s\S]*maxconn 64/);
assert.match(gateway, /server api_a 127\.0\.0\.1:15001 maxconn 32 check/);
assert.match(gateway, /server api_b 127\.0\.0\.1:15002 maxconn 32 check/);
assert.match(primaryCompose, /Recommender__Bulkhead__AggregatePermitLimit: "\$\{DIVA_API_AGGREGATE_CONCURRENCY:-6\}"/);
assert.match(primaryCompose, /mem_limit: "768m"/);
assert.match(primaryGateway, /maxconn 512/);
const drAggregate = capturedInteger(
  compose,
  /Recommender__Bulkhead__AggregatePermitLimit: "(\d+)"/,
  'DR aggregate cap',
);
const primaryAggregate = capturedInteger(
  primaryCompose,
  /Recommender__Bulkhead__AggregatePermitLimit: "\$\{DIVA_API_AGGREGATE_CONCURRENCY:-(\d+)\}"/,
  'primary aggregate cap',
);
assert.ok(drAggregate < primaryAggregate, 'DR aggregate cap must remain below primary');

for (const [label, pattern] of [
  ['memory reservation', /mem_reservation: "(\d+)m"/g],
  ['memory limit', /mem_limit: "(\d+)m"/g],
  ['PID limit', /pids_limit: (\d+)/g],
]) {
  const drValues = capturedIntegers(compose, pattern);
  const primaryValues = capturedIntegers(primaryCompose, pattern);
  assert.equal(drValues.length, 3, `DR ${label} contract must cover API, gateway, and Web`);
  assert.equal(primaryValues.length, 3, `primary ${label} contract must cover API, gateway, and Web`);
  assert.ok(
    drValues.every((value, index) => value < primaryValues[index]),
    `every DR ${label} must remain below its primary counterpart`,
  );
}

const drMaxConnections = capturedIntegers(gateway, /\bmaxconn\s+(\d+)/g);
const primaryMaxConnections = capturedIntegers(primaryGateway, /\bmaxconn\s+(\d+)/g);
assert.deepEqual(drMaxConnections.length, primaryMaxConnections.length);
assert.ok(
  drMaxConnections.every((value, index) => value < primaryMaxConnections[index]),
  'every DR HAProxy connection cap must remain below its primary counterpart',
);
for (const timeout of ['connect', 'queue', 'http-request', 'client', 'server']) {
  const drSeconds = capturedInteger(
    gateway,
    new RegExp(`timeout ${timeout} (\\d+)s`),
    `DR HAProxy ${timeout} timeout`,
  );
  const primarySeconds = capturedInteger(
    primaryGateway,
    new RegExp(`timeout ${timeout} (\\d+)s`),
    `primary HAProxy ${timeout} timeout`,
  );
  assert.ok(drSeconds < primarySeconds, `DR HAProxy ${timeout} timeout must remain below primary`);
}
assert.match(nginx, /listen 127\.0\.0\.1:18080/);
assert.match(nginx, /absolute_redirect off/);
assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:15000\//);

assert.match(provisioner, /0018_runtime_database_roles\.sql/);
assert.match(provisioner, /root:root/);
assert.match(provisioner, /8#\$env_mode & 077/);
assert.match(provisioner, /diva_api_login_\[a-z0-9\]/);
assert.match(provisioner, /SET LOCAL log_statement = 'none'/);
assert.match(provisioner, /PGPASSFILE="\$passfile"/);
assert.doesNotMatch(provisioner, /echo .*api_password|printf .*api_password/);
assert.match(deploy, /config --quiet/);
assert.match(deploy, /backend-api\/api\/ready/);
assert.match(deploy, /check-wsl-dr-standby\.sh/);
assert.match(deploy, /diva-wsl-dr-watchdog\.service/);
assert.match(deploy, /diva-wsl-dr-watchdog\.timer/);
assert.match(deploy, /regular non-symlink file/);
assert.match(deploy, /must be absent or a regular non-symlink file/);
assert.match(deploy, /install -T -o root -g root -m 0755/);
assert.match(deploy, /install -T -o root -g root -m 0644/);
assert.match(deploy, /--max-redirs 0/);
assert.match(deploy, /--write-out '%\{http_code\}'/);
assert.match(deploy, /"\$http_code" != 200/);
assert.match(deploy, /payload\.get\("status"\) == "ready"/);
assert.match(deploy, /systemctl daemon-reload/);
assert.match(deploy, /systemctl enable --now diva-wsl-dr-watchdog\.timer/);
assert.match(deploy, /systemctl is-enabled --quiet diva-wsl-dr-watchdog\.timer/);
assert.match(deploy, /systemctl is-active --quiet diva-wsl-dr-watchdog\.timer/);
assert.match(deploy, /flock 9/);
assert.match(deploy, /flock -u 9/);
assert.match(deploy, /systemctl restart diva-wsl-dr-watchdog\.service/);
assert.match(deploy, /timeout --foreground --signal=KILL "\$\{remaining\}s"/);
assert.match(deploy, /property=Result/);
assert.match(deploy, /property=ExecMainStatus/);
assert.match(deploy, /"\$status" == 75/);

assert.match(watchdog, /pg_isready/);
assert.match(watchdog, /127\.0\.0\.1:16333\/healthz/);
assert.match(watchdog, /Repair one slot per run/);
assert.match(watchdog, /flock -n 9/);
assert.match(watchdog, /127\.0\.0\.1:18080\/backend-api\/api\/ready/);
assert.match(watchdog, /127\.0\.0\.1:18080\/diva-player\//);
assert.match(watchdog, /containers_starting=1/);
assert.match(watchdog, /sleep 2/);
assert.match(watchdog, /diva-wsl-dr-quick-tunnel\.service/);
assert.match(watchdog, /diva-wsl-dr-quick-tunnel-sync\.timer/);
assert.match(watchdog, /systemctl restart "\$TUNNEL_SERVICE"/);
assert.match(watchdog, /systemctl restart "\$SYNC_TIMER"/);
assert.match(watchdog, /ExecMainStatus/);
assert.match(watchdog, /ExecMainExitTimestampMonotonic/);
assert.match(watchdog, /SYNC_MAX_AGE_SECONDS/);
assert.match(watchdog, /systemctl restart "\$SYNC_SERVICE"/);
assert.match(watchdog, /timeout --foreground --kill-after=5s "\$COMMAND_TIMEOUT_SECONDS"/);
assert.match(watchdog, /timeout --foreground --kill-after=5s "\$REPAIR_TIMEOUT_SECONDS"/);
assert.match(watchdog, /--max-redirs 0/);
assert.match(watchdog, /--write-out '%\{http_code\}'/);
assert.match(watchdog, /"\$http_code" != 200/);
assert.match(watchdog, /payload\.get\("status"\) == sys\.argv\[2\]/);
assert.match(watchdog, /probe_loopback .*\/api\/ready ready/);
assert.doesNotMatch(watchdog, /cloudflare\.env|PAGES_SYNC_TOKEN|Authorization/);
assert.match(watchdogService, /DIVA_DR_SYNC_MAX_AGE_SECONDS=900/);
assert.match(watchdogService, /TimeoutStartSec=120s/);
assert.match(watchdogService, /TimeoutStopSec=15s/);
assert.match(watchdogService, /SuccessExitStatus=75/);
assert.match(watchdogService, /CapabilityBoundingSet=/);
assert.match(watchdogService, /ReadWritePaths=-\/etc\/systemd\/system -\/run\/lock/);
assert.match(watchdogService, /ProtectSystem=strict/);
assert.match(watchdogService, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
assert.match(watchdogTimer, /OnUnitActiveSec=1min/);
assert.match(tunnelRunner, /backend-api\/api\/ready/);
assert.match(tunnelRunner, /--no-autoupdate/);
assert.match(tunnelRunner, /--protocol http2/);
assert.match(tunnelRunner, /chmod 0640/);
assert.match(tunnelRunner, /install -d -m 0750/);
assert.match(tunnelUnit, /ProtectSystem=strict/);
assert.match(tunnelUnit, /User=diva-dr-tunnel/);
assert.doesNotMatch(tunnelUnit, /sync-wsl-dr-origin-to-cloudflare/);
assert.match(tunnelUnit, /CapabilityBoundingSet=/);
assert.match(tunnelSync, /DIVA_TUNNEL_ORIGIN_ROLE/);
assert.doesNotMatch(tunnelSync, /\. "\$ENV_FILE"|Authorization: Bearer/);
assert.match(tunnelSyncHelper, /NoRedirectHandler/);
assert.match(tunnelSyncHelper, /RETRYABLE_HTTP_CODES.*424/);
assert.match(tunnelSyncHelper, /Refresh it on every/);
assert.match(tunnelSyncHelper, /outside the fixed Pages update endpoint/);
assert.match(tunnelSyncHelper, /must not be accessible by group\/other/);
assert.match(tunnelInstaller, /useradd --system --user-group/);
assert.match(tunnelInstaller, /systemctl restart diva-wsl-dr-quick-tunnel\.service/);
assert.match(tunnelInstaller, /systemctl enable --now diva-wsl-dr-quick-tunnel-sync\.timer/);
assert.match(tunnelInstaller, /diva-wsl-dr-maintenance\.lock/);
assert.match(tunnelInstaller, /flock -u 9/);
assert.match(tunnelInstaller, /--write-out '%\{http_code\}'/);
assert.match(tunnelInstaller, /payload\.get\("status"\) == "ready"/);
assert.match(tunnelInstaller, /systemctl restart diva-wsl-dr-watchdog\.service/);
assert.match(tunnelInstaller, /timeout --foreground --signal=KILL "\$\{remaining\}s"/);
assert.match(tunnelInstaller, /property=ExecMainStatus/);
assert.match(tunnelInstaller, /"\$status" == 75/);
assert.match(tunnelSyncUnit, /Requires=diva-wsl-dr-quick-tunnel\.service/);
assert.match(tunnelSyncUnit, /ExecStart=.*sync-wsl-dr-origin-to-cloudflare\.sh/);
assert.match(tunnelSyncUnit, /SupplementaryGroups=diva-dr-tunnel/);
assert.match(tunnelSyncUnit, /ProtectSystem=strict/);
assert.match(tunnelSyncTimer, /OnActiveSec=1min/);
assert.match(tunnelSyncTimer, /OnUnitInactiveSec=5min/);
assert.match(pagesProxy, /quick_tunnel_primary_url/);
assert.match(pagesProxy, /quick_tunnel_standby_url/);
assert.match(pagesProxy, /firstResponse\.status < 500/);
assert.match(pagesProxy, /getWithMetadata/);
assert.match(pagesProxy, /X-Diva-Origin-Role/);
assert.match(pagesProxy, /X-Diva-Standby-State/);
assert.match(pagesProxy, /15 \* 60 \* 1000/);
assert.match(tunnelAdmin, /originRole/);
assert.match(tunnelAdmin, /quick_tunnel_standby_url/);
assert.match(tunnelAdmin, /metadata.*checkedAt/);
assert.match(tunnelAdmin, /health\.status !== 200/);
assert.match(tunnelAdmin, /healthPayload\.status !== 'ready'/);
assert.match(publicDrMonitor, /'\/backend-api\/api\/ready'/);
assert.match(publicDrMonitor, /'\/backend-api\/api\/health'/);
assert.match(publicDrMonitor, /AbortSignal\.timeout/);
assert.match(publicDrWorkflow, /cron: '\*\/15 \* \* \* \*'/);
assert.match(publicDrWorkflow, /workflow_run:/);
assert.match(publicDrWorkflow, /workflows: \['Deploy DIVA Player'\]/);
assert.match(publicDrWorkflow, /github\.event\.workflow_run\.conclusion == 'success'/);
assert.match(publicDrWorkflow, /if: github\.event_name == 'workflow_run'/);
assert.match(publicDrWorkflow, /run: sleep 60/);
assert.match(publicDrWorkflow, /retention-days: 14/);
assert.doesNotMatch(publicDrWorkflow, /secrets\./);
assert.equal(
  JSON.parse(packageJson).scripts['check:public-dr-health'],
  'node scripts/check-public-dr-health.mjs',
);

const healthyProbes = [1, 2].flatMap(round => [
  { round, path: '/', ok: true, originRole: null, standbyState: null },
  {
    round,
    path: '/backend-api/api/ready',
    ok: true,
    originRole: 'primary',
    standbyState: 'fresh',
  },
  {
    round,
    path: '/backend-api/api/health',
    ok: true,
    originRole: 'primary',
    standbyState: 'fresh',
  },
]);
assert.deepEqual(evaluatePublicDrHealth(healthyProbes), { ok: true, issues: [] });

const transientFailure = structuredClone(healthyProbes);
transientFailure.find(probe => probe.round === 1 && probe.path === '/').ok = false;
assert.equal(evaluatePublicDrHealth(transientFailure).ok, true);

const latestOutage = healthyProbes.map(probe => (
  probe.round === 2 ? { ...probe, ok: false } : probe
));
assert.equal(evaluatePublicDrHealth(latestOutage).ok, false);

const staleStandby = structuredClone(healthyProbes);
staleStandby.find(probe => probe.path.endsWith('/ready')).standbyState = 'stale';
assert.equal(evaluatePublicDrHealth(staleStandby).ok, false);

const persistentFailover = healthyProbes.map(probe => (
  probe.path === '/'
    ? probe
    : { ...probe, originRole: 'standby' }
));
const persistentFailoverResult = evaluatePublicDrHealth(persistentFailover);
assert.equal(persistentFailoverResult.ok, false);
assert(persistentFailoverResult.issues.some(issue => issue.includes('two consecutive rounds')));

const publicOutage = healthyProbes.map(probe => ({ ...probe, ok: false }));
assert.equal(evaluatePublicDrHealth(publicOutage).ok, false);

const originalFetch = globalThis.fetch;
const monitorOptions = {
  baseUrl: 'https://diva-player.pages.dev',
  timeoutMs: 1000,
  intervalMs: 1,
};
const validPublicResponse = path => {
  if (path.endsWith('/api/ready')) {
    return Response.json({ status: 'ready' }, {
      status: 200,
      headers: {
        'x-diva-origin-role': 'primary',
        'x-diva-standby-state': 'fresh',
      },
    });
  }
  if (path.endsWith('/api/health')) {
    return Response.json({ status: 'ok' }, {
      status: 200,
      headers: {
        'x-diva-origin-role': 'primary',
        'x-diva-standby-state': 'fresh',
      },
    });
  }
  return new Response('<!doctype html>', { status: 200 });
};
try {
  globalThis.fetch = async target => validPublicResponse(new URL(target).pathname);
  assert.equal((await runPublicDrHealth(monitorOptions)).ok, true);

  let callCount = 0;
  globalThis.fetch = async target => {
    const path = new URL(target).pathname;
    const round = Math.floor(callCount / 3) + 1;
    callCount += 1;
    if (round === 2 && path.endsWith('/api/ready')) {
      return new Response('<html>wrong route</html>', {
        status: 200,
        headers: {
          'x-diva-origin-role': 'primary',
          'x-diva-standby-state': 'fresh',
        },
      });
    }
    return validPublicResponse(path);
  };
  assert.equal((await runPublicDrHealth(monitorOptions)).ok, false);

  globalThis.fetch = async target => {
    const path = new URL(target).pathname;
    if (path.endsWith('/api/health')) {
      return new Response(null, {
        status: 204,
        headers: {
          'x-diva-origin-role': 'primary',
          'x-diva-standby-state': 'fresh',
        },
      });
    }
    return validPublicResponse(path);
  };
  assert.equal((await runPublicDrHealth(monitorOptions)).ok, false);

  globalThis.fetch = async target => {
    const path = new URL(target).pathname;
    if (path.endsWith('/api/ready')) {
      return Response.json({ status: 'warming' }, {
        status: 200,
        headers: {
          'x-diva-origin-role': 'primary',
          'x-diva-standby-state': 'fresh',
        },
      });
    }
    return validPublicResponse(path);
  };
  assert.equal((await runPublicDrHealth(monitorOptions)).ok, false);

  globalThis.fetch = async target => {
    const path = new URL(target).pathname;
    if (path.endsWith('/api/ready')) {
      return new Response('{"status":"ready"}', {
        status: 200,
        headers: {
          'content-length': String((1024 * 1024) + 1),
          'x-diva-origin-role': 'primary',
          'x-diva-standby-state': 'fresh',
        },
      });
    }
    return validPublicResponse(path);
  };
  assert.equal((await runPublicDrHealth(monitorOptions)).ok, false);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('PASS isolated WSL DR standby topology contract');
