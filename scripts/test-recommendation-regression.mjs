// Representative recommendation regression check for the deployed API.
// It is intentionally independent from browser state so it can run from CI.
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_LATENCY_MS = 15_000;
const SAMPLE_SIZE = 5;

function getBaseUrl() {
  const argumentIndex = process.argv.indexOf('--base-url');
  const provided = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.SBC_API_URL;
  if (!provided) throw new Error('Set SBC_API_URL or pass --base-url https://diva-player.pages.dev/backend-api.');
  return new URL(provided).toString().replace(/\/$/, '');
}

function getMaxLatency() {
  const argumentIndex = process.argv.indexOf('--max-latency-ms');
  const provided = argumentIndex >= 0 ? Number(process.argv[argumentIndex + 1]) : DEFAULT_MAX_LATENCY_MS;
  if (!Number.isFinite(provided) || provided <= 0) throw new Error('--max-latency-ms must be a positive number.');
  return provided;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getJson(baseUrl, path) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`);
  return { data: await response.json(), elapsedMs };
}

function validateItems(data, endpoint, seedId) {
  assert(data && Array.isArray(data.items), `${endpoint} did not return an items array.`);
  const ids = data.items.map(item => item.songId);
  assert(ids.every(Number.isInteger), `${endpoint} returned an invalid songId.`);
  assert(!ids.includes(seedId), `${endpoint} returned its seed song ${seedId}.`);
  assert(new Set(ids).size === ids.length, `${endpoint} returned duplicate song IDs.`);
  return ids.length;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

async function main() {
  const baseUrl = getBaseUrl();
  const maxLatencyMs = getMaxLatency();
  const latencySamples = [];
  const endpointCounts = new Map();
  console.log(`Recommendation regression check: ${baseUrl}`);

  const health = await getJson(baseUrl, '/api/health');
  assert(health.data.status === 'ok', 'API health status is not ok.');
  assert(health.data.dependencies?.postgres?.ok === true, 'PostgreSQL is not healthy.');
  assert(health.data.dependencies?.qdrant?.ok === true, 'Qdrant is not healthy.');
  assert(health.data.discoveryQuality?.ok !== false, `Discovery quality is unhealthy: ${health.data.discoveryQuality?.error ?? 'unknown'}.`);
  const audioFeatures = health.data.audioFeatures;
  assert(audioFeatures && Number.isInteger(audioFeatures.targetCount), 'Audio feature health is missing from /api/health.');
  assert(audioFeatures.ok !== false, `Audio feature backlog is unhealthy: ${audioFeatures.error ?? 'unknown'}.`);
  console.log(`PASS audio feature health (${audioFeatures.computedCount}/${audioFeatures.targetCount} computed, pending ${audioFeatures.pendingCount})`);

  const search = await getJson(
    baseUrl,
    '/api/songs/search?sort=FavoritedTimes&order=desc&start=0&maxResults=24&audioComputed=true',
  );
  assert(search.data.items?.length > 0, 'No audio-computed seed songs were returned.');
  const seeds = search.data.items.slice(0, SAMPLE_SIZE);
  const endpoints = ['/api/recommend', '/api/recommend/metadata', '/api/recommend/audio'];
  const nonEmptyByEndpoint = new Map(endpoints.map(endpoint => [endpoint, 0]));

  for (const seed of seeds) {
    for (const endpoint of endpoints) {
      const result = await getJson(baseUrl, `${endpoint}?songId=${seed.id}&count=20&offset=0`);
      const count = validateItems(result.data, endpoint, seed.id);
      latencySamples.push(result.elapsedMs);
      endpointCounts.set(endpoint, [...(endpointCounts.get(endpoint) ?? []), count]);
      if (count > 0) nonEmptyByEndpoint.set(endpoint, nonEmptyByEndpoint.get(endpoint) + 1);
    }
  }

  for (const endpoint of endpoints) {
    assert(nonEmptyByEndpoint.get(endpoint) >= 3, `${endpoint} returned no candidates for most representative seeds.`);
  }
  const p95 = percentile(latencySamples, 0.95);
  assert(p95 <= maxLatencyMs, `Recommendation p95 latency ${p95}ms exceeded ${maxLatencyMs}ms.`);

  const summary = endpoints.map(endpoint => {
    const counts = endpointCounts.get(endpoint);
    return `${endpoint} n=${counts.length} nonEmpty=${nonEmptyByEndpoint.get(endpoint)} avg=${Math.round(counts.reduce((sum, count) => sum + count, 0) / counts.length)}`;
  });
  console.log(`PASS recommendation regression (${summary.join('; ')})`);
  console.log(`PASS recommendation latency (p95=${p95}ms, max=${maxLatencyMs}ms)`);
}

main().catch(error => {
  console.error(`Recommendation regression check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
