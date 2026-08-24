import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateRuntimeSnapshot,
  parseByteSize,
  parseContainerHealth,
  parseDockerStats,
  parseHaProxyStats,
  parseHostMemory,
  parsePostgresActivity,
  rotateHistoryIfNeeded,
} from './collect-sbc-runtime-health.mjs';

assert.equal(parseByteSize('129.8MiB'), 129.8 * 1024 ** 2);
assert.equal(parseByteSize('1.5 GiB'), 1.5 * 1024 ** 3);
assert.equal(parseByteSize('invalid'), null);

const containers = parseDockerStats([
  JSON.stringify({ Name: 'vocadb_api_a', CPUPerc: '1.2%', MemUsage: '129.8MiB / 1GiB', MemPerc: '12.68%', PIDs: '18' }),
  JSON.stringify({ Name: 'vocadb_api_b', CPUPerc: '0%', MemUsage: '82.41MiB / 1GiB', MemPerc: '8.05%', PIDs: '17' }),
].join('\n'));
assert.equal(containers.length, 2);
assert.equal(containers[0].memoryLimitBytes, 1024 ** 3);
assert.equal(containers[1].pids, 17);

assert.deepEqual(parseContainerHealth('/vocadb_api_a\thealthy\n/vocadb_api_b\trunning\n'), {
  vocadb_api_a: 'healthy',
  vocadb_api_b: 'running',
});
assert.deepEqual(parsePostgresActivity('diva-api-a\t1\t8\ndiva-api-b\t0\t7\n'), {
  applications: [
    { applicationName: 'diva-api-a', active: 1, total: 8 },
    { applicationName: 'diva-api-b', active: 0, total: 7 },
  ],
  active: 1,
  total: 15,
});

const haproxy = parseHaProxyStats([
  '# pxname,svname,scur,status,',
  'api_nodes,api_a,2,UP,',
  'api_nodes,api_b,0,MAINT,',
  'api_front,FRONTEND,2,OPEN,',
].join('\n'));
assert.deepEqual(haproxy, [
  { slot: 'api_a', status: 'UP', currentSessions: 2 },
  { slot: 'api_b', status: 'MAINT', currentSessions: 0 },
]);

const hostMemory = parseHostMemory([
  'MemTotal:       8000000 kB',
  'MemAvailable:   3200000 kB',
  'SwapTotal:     20000000 kB',
  'SwapFree:      12500000 kB',
].join('\n'), 'pswpin 123\npswpout 45\n', [
  'some avg10=1.50 avg60=2.50 avg300=3.50 total=1000',
  'full avg10=0.50 avg60=1.50 avg300=2.50 total=500',
].join('\n'));
assert.equal(hostMemory.availablePercent, 40);
assert.equal(hostMemory.swapUsedPercent, 37.5);
assert.equal(hostMemory.swapInPages, 123);
assert.equal(hostMemory.swapOutPages, 45);
assert.equal(hostMemory.pressure.some.avg60Percent, 2.5);
assert.equal(hostMemory.pressure.full.totalMicros, 500);

const baseSnapshot = {
  checkedAt: '2026-08-10T00:00:00.000Z',
  containers: [
    { name: 'vocadb_api_a', health: 'healthy', memoryUsedBytes: 400 * 1024 ** 2 },
    { name: 'vocadb_api_b', health: 'healthy', memoryUsedBytes: 100 * 1024 ** 2 },
  ],
  postgres: { total: 30, active: 1, applications: [] },
  haproxy: [{ slot: 'api_a', status: 'UP', currentSessions: 0 }, { slot: 'api_b', status: 'UP', currentSessions: 0 }],
  hostMemory: { availablePercent: 50 },
  disk: { usedPercent: 70 },
};
const warning = evaluateRuntimeSnapshot(baseSnapshot);
assert.equal(warning.status, 'warning');
assert.deepEqual(warning.violations.map(item => item.id).sort(), ['memory:vocadb_api_a', 'postgres:connections']);
const critical = evaluateRuntimeSnapshot(baseSnapshot, warning);
assert.equal(critical.status, 'critical');
assert.equal(critical.critical.length, 2);
const recovered = evaluateRuntimeSnapshot({
  ...baseSnapshot,
  containers: baseSnapshot.containers.map(container => ({ ...container, memoryUsedBytes: 100 * 1024 ** 2 })),
  postgres: { ...baseSnapshot.postgres, total: 10 },
}, critical);
assert.equal(recovered.status, 'ok');
assert.deepEqual(recovered.consecutiveViolations, {});

const lowHostMemoryWarning = evaluateRuntimeSnapshot({
  ...baseSnapshot,
  containers: baseSnapshot.containers.map(container => ({ ...container, memoryUsedBytes: 100 * 1024 ** 2 })),
  postgres: { ...baseSnapshot.postgres, total: 10 },
  hostMemory: { availablePercent: 8 },
});
assert(lowHostMemoryWarning.violations.some(item => item.id === 'host:memory-available'));
const lowHostMemoryCritical = evaluateRuntimeSnapshot(lowHostMemoryWarning, lowHostMemoryWarning);
assert(lowHostMemoryCritical.critical.some(item => item.id === 'host:memory-available'));

const collectionFailure = evaluateRuntimeSnapshot({
  ...baseSnapshot,
  collectionErrors: [{ source: 'postgres', error: 'connection refused' }],
  containers: baseSnapshot.containers,
  postgres: { total: null, active: null, applications: [], error: 'connection refused' },
  haproxy: [{ slot: 'api_a', status: 'UP', currentSessions: 0 }],
  disk: { usedPercent: null, error: 'unavailable' },
});
assert(collectionFailure.violations.some(item => item.id === 'collector:postgres'));
assert(collectionFailure.violations.some(item => item.id === 'haproxy:api_b'));
assert.deepEqual(parseDockerStats('{not-json}\n'), []);

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'diva-runtime-health-'));
try {
  const historyPath = join(temporaryDirectory, 'runtime.jsonl');
  await writeFile(historyPath, 'old-history\n', 'utf8');
  assert.equal(await rotateHistoryIfNeeded(historyPath, 4), true);
  assert.equal(await readFile(`${historyPath}.1`, 'utf8'), 'old-history\n');
  await writeFile(historyPath, 'new\n', 'utf8');
  assert.equal(await rotateHistoryIfNeeded(historyPath, 100), false);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('PASS SBC runtime health collector contracts');
