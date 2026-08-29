import assert from 'node:assert/strict';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = Number(option(name, fallback));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

const baseUrl = option('--base-url', process.env.SBC_API_URL);
if (!baseUrl) {
  throw new Error('Set SBC_API_URL or pass --base-url https://diva-player.pages.dev/backend-api.');
}
const requestPath = option(
  '--path',
  '/api/recommend?songId=3022&count=20&offset=0&sessionProgress=0',
);
if (!requestPath.startsWith('/api/')) throw new Error('--path must start with /api/.');

const requestCount = boundedInteger('--requests', 32, 1, 64);
const concurrency = boundedInteger('--concurrency', 32, 1, 32);
const timeoutMilliseconds = boundedInteger('--timeout-ms', 15_000, 1_000, 30_000);
const requireShed = process.argv.includes('--require-shed');
const target = `${new URL(baseUrl).toString().replace(/\/$/, '')}${requestPath}`;
let cursor = 0;
const results = [];

async function worker() {
  while (cursor < requestCount) {
    const requestNumber = cursor;
    cursor += 1;
    const startedAt = performance.now();
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMilliseconds) });
      const body = await response.text();
      results.push({
        requestNumber,
        status: response.status,
        elapsedMs: Math.round(performance.now() - startedAt),
        retryAfter: response.headers.get('retry-after'),
        rateLimit: response.headers.get('x-diva-rate-limit'),
        bulkhead: response.headers.get('x-diva-bulkhead'),
        body,
      });
    } catch (error) {
      results.push({
        requestNumber,
        status: 0,
        elapsedMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: Math.min(concurrency, requestCount) }, () => worker()));
const statusCounts = Object.fromEntries(
  [...new Set(results.map(result => result.status))]
    .sort((left, right) => left - right)
    .map(status => [status, results.filter(result => result.status === status).length]),
);
const successes = results.filter(result => result.status === 200);
const rejections = results.filter(result => result.status === 503);
const unexpected = results.filter(result => result.status !== 200 && result.status !== 503);

for (const result of rejections) {
  assert.equal(result.retryAfter, '1', 'A bulkhead rejection must provide Retry-After: 1.');
  assert.match(result.rateLimit ?? '', /^concurrency;/, 'A bulkhead rejection must identify concurrency pressure.');
  assert.ok(result.bulkhead, 'A bulkhead rejection must identify its lane.');
  const payload = JSON.parse(result.body);
  assert.equal(payload.error, 'server_busy');
}
assert.equal(unexpected.length, 0, `Unexpected responses: ${JSON.stringify(unexpected)}`);
assert.ok(successes.length > 0, 'The probe did not complete any successful request.');
if (requireShed) assert.ok(rejections.length > 0, 'The bounded burst did not exercise load shedding.');

const sortedLatency = successes.map(result => result.elapsedMs).sort((left, right) => left - right);
const p95Index = Math.max(0, Math.ceil(sortedLatency.length * 0.95) - 1);
console.log(JSON.stringify({
  target,
  requestCount,
  concurrency,
  wallMilliseconds: Math.round(performance.now() - startedAt),
  successP95Milliseconds: sortedLatency[p95Index],
  statusCounts,
}, null, 2));
