// Representative recommendation regression check for the deployed API.
// It is intentionally independent from browser state so it can run from CI.
import { writeFile } from 'node:fs/promises';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_LATENCY_MS = 15_000;
const DEFAULT_MAX_ARTIST_SHARE = 0.75;
const DEFAULT_MAX_SEED_OVERLAP = 0.85;
const DEFAULT_MAX_MODE_OVERLAP = 0.95;
const DEFAULT_MIN_UNIQUE_RATIO = 0.35;
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

function getRatioOption(name, defaultValue) {
  const argumentIndex = process.argv.indexOf(name);
  const provided = argumentIndex >= 0 ? Number(process.argv[argumentIndex + 1]) : defaultValue;
  if (!Number.isFinite(provided) || provided < 0 || provided > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return provided;
}

function getReportFile() {
  const argumentIndex = process.argv.indexOf('--report-file');
  if (argumentIndex < 0) return undefined;
  const reportFile = process.argv[argumentIndex + 1];
  if (!reportFile || reportFile.startsWith('--')) throw new Error('--report-file requires a path.');
  return reportFile;
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
  return data.items;
}

function normalizeArtist(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
}

function getMaxArtistShare(items) {
  if (items.length === 0) return 0;
  const counts = new Map();
  for (const item of items) {
    const artist = normalizeArtist(item.artist);
    if (!artist) continue;
    counts.set(artist, (counts.get(artist) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values()) / items.length;
}

function jaccard(itemsA, itemsB) {
  const a = new Set(itemsA.map(item => item.songId));
  const b = new Set(itemsB.map(item => item.songId));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const id of a) if (b.has(id)) intersection += 1;
  return intersection / union.size;
}

function maxPairwiseOverlap(lists) {
  let maximum = 0;
  for (let left = 0; left < lists.length; left += 1) {
    for (let right = left + 1; right < lists.length; right += 1) {
      maximum = Math.max(maximum, jaccard(lists[left], lists[right]));
    }
  }
  return maximum;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

async function main() {
  const baseUrl = getBaseUrl();
  const maxLatencyMs = getMaxLatency();
  const maxArtistShare = getRatioOption('--max-artist-share', DEFAULT_MAX_ARTIST_SHARE);
  const maxSeedOverlap = getRatioOption('--max-seed-overlap', DEFAULT_MAX_SEED_OVERLAP);
  const maxModeOverlap = getRatioOption('--max-mode-overlap', DEFAULT_MAX_MODE_OVERLAP);
  const minUniqueRatio = getRatioOption('--min-unique-ratio', DEFAULT_MIN_UNIQUE_RATIO);
  const reportFile = getReportFile();
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
  assert(Number.isInteger(audioFeatures.actionableTargetCount), 'Audio actionable backlog is missing from /api/health.');
  assert(Number.isInteger(audioFeatures.actionablePendingCount), 'Audio actionable pending count is missing from /api/health.');
  assert(audioFeatures.ok !== false, `Audio feature backlog is unhealthy: ${audioFeatures.error ?? 'unknown'}.`);
  console.log(`PASS audio feature health (${audioFeatures.computedCount}/${audioFeatures.targetCount} computed, pending ${audioFeatures.pendingCount}; actionable ${audioFeatures.actionablePendingCount}/${audioFeatures.actionableTargetCount} pending)`);

  const search = await getJson(
    baseUrl,
    '/api/songs/search?sort=FavoritedTimes&order=desc&start=0&maxResults=24&audioComputed=true',
  );
  assert(search.data.items?.length > 0, 'No audio-computed seed songs were returned.');
  const seeds = search.data.items.slice(0, SAMPLE_SIZE);
  const endpoints = ['/api/recommend', '/api/recommend/metadata', '/api/recommend/audio'];
  const nonEmptyByEndpoint = new Map(endpoints.map(endpoint => [endpoint, 0]));
  const itemsByEndpoint = new Map(endpoints.map(endpoint => [endpoint, []]));
  const itemsBySeed = new Map(seeds.map(seed => [seed.id, new Map()]));

  for (const seed of seeds) {
    for (const endpoint of endpoints) {
      const sessionProgress = endpoint === '/api/recommend' ? '&sessionProgress=0' : '';
      const result = await getJson(baseUrl, `${endpoint}?songId=${seed.id}&count=20&offset=0${sessionProgress}`);
      const items = validateItems(result.data, endpoint, seed.id);
      const count = items.length;
      latencySamples.push(result.elapsedMs);
      endpointCounts.set(endpoint, [...(endpointCounts.get(endpoint) ?? []), count]);
      itemsByEndpoint.get(endpoint).push(items);
      itemsBySeed.get(seed.id).set(endpoint, items);
      if (count > 0) nonEmptyByEndpoint.set(endpoint, nonEmptyByEndpoint.get(endpoint) + 1);
    }
  }

  const p95 = percentile(latencySamples, 0.95);

  const endpointQuality = endpoints.map(endpoint => {
    const lists = itemsByEndpoint.get(endpoint);
    const flattened = lists.flat();
    const uniqueRatio = flattened.length === 0
      ? 0
      : new Set(flattened.map(item => item.songId)).size / flattened.length;
    return {
      endpoint,
      maxArtistShare: Math.max(0, ...lists.map(getMaxArtistShare)),
      maxSeedOverlap: maxPairwiseOverlap(lists),
      uniqueRatio,
    };
  });

  let observedMaxModeOverlap = 0;
  for (const endpointMap of itemsBySeed.values()) {
    observedMaxModeOverlap = Math.max(
      observedMaxModeOverlap,
      maxPairwiseOverlap(endpoints.map(endpoint => endpointMap.get(endpoint) ?? [])),
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    sampleSize: seeds.length,
    seedIds: seeds.map(seed => seed.id),
    health: {
      discoveryQuality: health.data.discoveryQuality,
      audioFeatures,
    },
    latency: { p95Ms: p95, maximumMs: maxLatencyMs },
    quality: {
      endpoints: endpointQuality,
      maxModeOverlap: observedMaxModeOverlap,
      thresholds: { maxArtistShare, maxSeedOverlap, maxModeOverlap, minUniqueRatio },
    },
  };
  if (reportFile) await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  for (const endpoint of endpoints) {
    assert(nonEmptyByEndpoint.get(endpoint) >= 3, `${endpoint} returned no candidates for most representative seeds.`);
  }
  assert(p95 <= maxLatencyMs, `Recommendation p95 latency ${p95}ms exceeded ${maxLatencyMs}ms.`);
  for (const quality of endpointQuality) {
    assert(quality.maxArtistShare <= maxArtistShare, `${quality.endpoint} artist share ${quality.maxArtistShare.toFixed(3)} exceeded ${maxArtistShare}.`);
    assert(quality.maxSeedOverlap <= maxSeedOverlap, `${quality.endpoint} seed overlap ${quality.maxSeedOverlap.toFixed(3)} exceeded ${maxSeedOverlap}.`);
    assert(quality.uniqueRatio >= minUniqueRatio, `${quality.endpoint} unique ratio ${quality.uniqueRatio.toFixed(3)} fell below ${minUniqueRatio}.`);
  }
  assert(observedMaxModeOverlap <= maxModeOverlap, `Recommendation mode overlap ${observedMaxModeOverlap.toFixed(3)} exceeded ${maxModeOverlap}.`);

  const summary = endpoints.map(endpoint => {
    const counts = endpointCounts.get(endpoint);
    return `${endpoint} n=${counts.length} nonEmpty=${nonEmptyByEndpoint.get(endpoint)} avg=${Math.round(counts.reduce((sum, count) => sum + count, 0) / counts.length)}`;
  });
  console.log(`PASS recommendation regression (${summary.join('; ')})`);
  console.log(`PASS recommendation latency (p95=${p95}ms, max=${maxLatencyMs}ms)`);
  console.log(`PASS recommendation diversity (${endpointQuality.map(quality => `${quality.endpoint} artist=${quality.maxArtistShare.toFixed(2)} seedOverlap=${quality.maxSeedOverlap.toFixed(2)} unique=${quality.uniqueRatio.toFixed(2)}`).join('; ')}; modeOverlap=${observedMaxModeOverlap.toFixed(2)})`);
}

main().catch(error => {
  console.error(`Recommendation regression check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
