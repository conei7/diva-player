// Representative recommendation regression check for the deployed API.
// It is intentionally independent from browser state so it can run from CI.
import { writeFile } from 'node:fs/promises';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_LATENCY_MS = 15_000;
const DEFAULT_MAX_ARTIST_SHARE = 0.75;
const DEFAULT_MAX_PRODUCER_SHARE = 0.70;
const DEFAULT_MAX_VOCALIST_SHARE = 0.85;
const DEFAULT_MAX_SEED_OVERLAP = 0.85;
const DEFAULT_MAX_MODE_OVERLAP = 0.95;
const DEFAULT_MIN_UNIQUE_RATIO = 0.35;
const DEFAULT_MIN_HYBRID_MINOR_SHARE = 0.20;
const DEFAULT_MAX_HYBRID_MINOR_SHARE = 0.80;
const DEFAULT_MAX_SEED_PRODUCER_SHARE = 0.40;
const SAMPLE_SIZE = 10;

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

async function postJson(baseUrl, path, body) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

function validateDigItems(data, endpoint, excludedIds) {
  assert(data && Array.isArray(data.items), `${endpoint} did not return an items array.`);
  const ids = data.items.map(item => item.id);
  assert(ids.every(Number.isInteger), `${endpoint} returned an invalid full song id.`);
  assert(ids.every(id => !excludedIds.has(id)), `${endpoint} returned an excluded song.`);
  assert(new Set(ids).size === ids.length, `${endpoint} returned duplicate song IDs.`);
  assert(data.items.every(item => typeof item.name === 'string'), `${endpoint} returned an invalid full song name.`);
  return data.items;
}

function getDigProducerShare(items) {
  if (items.length === 0) return 0;
  const counts = new Map();
  for (const item of items) {
    const producerIds = (item.artists ?? [])
      .filter(artist => String(artist.categories ?? '').split(',').map(value => value.trim()).some(category => ['Producer', 'Band', 'Circle'].includes(category)))
      .map(artist => artist.artist?.id ?? `name:${normalizeArtist(artist.name)}`);
    for (const producerId of new Set(producerIds)) {
      counts.set(producerId, (counts.get(producerId) ?? 0) + 1);
    }
  }
  return Math.max(0, ...counts.values()) / items.length;
}

function getSongProducerKeys(item) {
  return [...new Set((item.artists ?? [])
    .filter(artist => String(artist.categories ?? '').split(',').map(value => value.trim()).some(category => ['Producer', 'Band', 'Circle'].includes(category)))
    .map(artist => artist.artist?.id ?? `name:${normalizeArtist(artist.name)}`))];
}

function getSeedProducerShare(items) {
  if (items.length === 0) return 0;
  const counts = new Map();
  for (const item of items) {
    for (const producer of getSongProducerKeys(item)) counts.set(producer, (counts.get(producer) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values()) / items.length;
}

function digJaccard(itemsA, itemsB) {
  const a = new Set(itemsA.map(item => item.id));
  const b = new Set(itemsB.map(item => item.id));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const id of a) if (b.has(id)) intersection += 1;
  return intersection / union.size;
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

function getMaxIdShare(items, field) {
  if (items.length === 0) return 0;
  const counts = new Map();
  for (const item of items) {
    for (const id of new Set(Array.isArray(item[field]) ? item[field] : [])) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return Math.max(0, ...counts.values()) / items.length;
}

function getPopularitySummary(items) {
  const totals = items
    .map(item => Math.max(0, Number(item.youtubeViews) || 0) + Math.max(0, Number(item.nicoViews) || 0))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (totals.length === 0) return { medianViews: 0, minorShare: 0 };
  return {
    medianViews: totals[Math.floor(totals.length / 2)],
    minorShare: totals.filter(value => value <= 150_000).length / totals.length,
  };
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

async function getRepresentativeSeeds(baseUrl) {
  const definitions = [
    {
      group: 'popular',
      count: 3,
      path: '/api/songs/search?sort=FavoritedTimes&order=desc&start=0&maxResults=24&audioComputed=yes&discoveryOnly=true&onlyWithPVs=true',
    },
    {
      group: 'mid-tail',
      count: 3,
      path: '/api/songs/search?sort=FavoritedTimes&order=desc&start=0&maxResults=24&audioComputed=yes&discoveryOnly=true&onlyWithPVs=true&minYoutubeViews=10000&maxYoutubeViews=500000',
    },
    {
      group: 'recent',
      count: 2,
      path: '/api/songs/search?sort=PublishDate&order=desc&start=0&maxResults=24&audioComputed=yes&discoveryOnly=true&onlyWithPVs=true',
    },
    {
      group: 'audio-missing',
      count: 2,
      path: '/api/songs/search?sort=PublishDate&order=desc&start=0&maxResults=24&audioComputed=no&discoveryOnly=true&onlyWithPVs=true',
    },
  ];
  const responses = await Promise.all(definitions.map(async definition => ({
    ...definition,
    items: (await getJson(baseUrl, definition.path)).data.items ?? [],
  })));
  const selected = [];
  const seen = new Set();
  const producerCounts = new Map();
  for (const response of responses) {
    for (const item of response.items) {
      if (selected.filter(seed => seed.group === response.group).length >= response.count) break;
      if (!Number.isInteger(item.id) || seen.has(item.id)) continue;
      const producerKeys = getSongProducerKeys(item);
      if (producerKeys.some(key => (producerCounts.get(key) ?? 0) >= 2)) continue;
      seen.add(item.id);
      selected.push({ ...item, group: response.group });
      for (const key of producerKeys) producerCounts.set(key, (producerCounts.get(key) ?? 0) + 1);
    }
  }
  for (const response of responses) {
    for (const item of response.items) {
      if (selected.length >= SAMPLE_SIZE) break;
      if (!Number.isInteger(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      selected.push({ ...item, group: response.group });
    }
  }
  return selected.slice(0, SAMPLE_SIZE);
}

async function main() {
  const baseUrl = getBaseUrl();
  const maxLatencyMs = getMaxLatency();
  const maxArtistShare = getRatioOption('--max-artist-share', DEFAULT_MAX_ARTIST_SHARE);
  const maxProducerShare = getRatioOption('--max-producer-share', DEFAULT_MAX_PRODUCER_SHARE);
  const maxVocalistShare = getRatioOption('--max-vocalist-share', DEFAULT_MAX_VOCALIST_SHARE);
  const maxSeedOverlap = getRatioOption('--max-seed-overlap', DEFAULT_MAX_SEED_OVERLAP);
  const maxModeOverlap = getRatioOption('--max-mode-overlap', DEFAULT_MAX_MODE_OVERLAP);
  const minUniqueRatio = getRatioOption('--min-unique-ratio', DEFAULT_MIN_UNIQUE_RATIO);
  const minHybridMinorShare = getRatioOption('--min-hybrid-minor-share', DEFAULT_MIN_HYBRID_MINOR_SHARE);
  const maxHybridMinorShare = getRatioOption('--max-hybrid-minor-share', DEFAULT_MAX_HYBRID_MINOR_SHARE);
  const maxSeedProducerShare = getRatioOption('--max-seed-producer-share', DEFAULT_MAX_SEED_PRODUCER_SHARE);
  const reportFile = getReportFile();
  const latencySamples = [];
  const latencyByEndpoint = new Map();
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

  const seeds = await getRepresentativeSeeds(baseUrl);
  assert(seeds.length === SAMPLE_SIZE, `Only ${seeds.length}/${SAMPLE_SIZE} representative seed songs were returned.`);
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
      latencyByEndpoint.set(endpoint, [...(latencyByEndpoint.get(endpoint) ?? []), result.elapsedMs]);
      endpointCounts.set(endpoint, [...(endpointCounts.get(endpoint) ?? []), count]);
      itemsByEndpoint.get(endpoint).push(items);
      itemsBySeed.get(seed.id).set(endpoint, items);
      if (count > 0) nonEmptyByEndpoint.set(endpoint, nonEmptyByEndpoint.get(endpoint) + 1);
    }
  }

  const digSeedIds = new Set(seeds.slice(0, 3).map(seed => seed.id));
  const digResult = await postJson(baseUrl, '/api/recommend/dig', {
    seeds: [...digSeedIds].map((songId, index) => ({ songId, weight: 1 - index * 0.15 })),
    count: 20,
    offset: 0,
    generationSeed: 23,
    excludeSongIds: [...digSeedIds],
  });
  const digItems = validateDigItems(digResult.data, '/api/recommend/dig', digSeedIds);
  assert(digItems.length > 0, '/api/recommend/dig returned no discovery candidates.');
  assert(digResult.elapsedMs <= maxLatencyMs, `/api/recommend/dig latency ${digResult.elapsedMs}ms exceeded ${maxLatencyMs}ms.`);
  const alternateDigResult = await postJson(baseUrl, '/api/recommend/dig', {
    seeds: [...digSeedIds].map((songId, index) => ({ songId, weight: 1 - index * 0.15 })),
    count: 20,
    offset: 0,
    generationSeed: 29,
    excludeSongIds: [...digSeedIds],
  });
  const alternateDigItems = validateDigItems(alternateDigResult.data, '/api/recommend/dig', digSeedIds);
  const digGenerationOverlap = digJaccard(digItems, alternateDigItems);
  const digMaxProducerShare = Math.max(getDigProducerShare(digItems), getDigProducerShare(alternateDigItems));
  assert(digGenerationOverlap < 0.85, `/api/recommend/dig generation overlap ${digGenerationOverlap.toFixed(3)} indicates ineffective random discovery.`);
  assert(digMaxProducerShare < 0.5, `/api/recommend/dig producer share ${digMaxProducerShare.toFixed(3)} indicates catalog concentration.`);

  const p95 = percentile(latencySamples, 0.95);
  const endpointLatency = Object.fromEntries(endpoints.map(endpoint => [endpoint, {
    p50Ms: percentile(latencyByEndpoint.get(endpoint) ?? [], 0.50),
    p95Ms: percentile(latencyByEndpoint.get(endpoint) ?? [], 0.95),
  }]));

  const endpointQuality = endpoints.map(endpoint => {
    const lists = itemsByEndpoint.get(endpoint);
    const flattened = lists.flat();
    const uniqueRatio = flattened.length === 0
      ? 0
      : new Set(flattened.map(item => item.songId)).size / flattened.length;
    return {
      endpoint,
      maxArtistShare: Math.max(0, ...lists.map(getMaxArtistShare)),
      maxProducerShare: Math.max(0, ...lists.map(items => getMaxIdShare(items, 'producerIds'))),
      maxVocalistShare: Math.max(0, ...lists.map(items => getMaxIdShare(items, 'vocalistIds'))),
      maxSeedOverlap: maxPairwiseOverlap(lists),
      uniqueRatio,
      ...getPopularitySummary(flattened),
      groupMetadataCoverage: flattened.length === 0
        ? 0
        : flattened.filter(item => Array.isArray(item.producerIds) && Array.isArray(item.vocalistIds)).length / flattened.length,
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
    seedGroups: Object.fromEntries(seeds.map(seed => [seed.id, seed.group])),
    seedProducerShare: getSeedProducerShare(seeds),
    seedAudioCoverage: seeds.filter(seed => seed.audioComputed === true).length / seeds.length,
    seedResults: seeds.map(seed => ({
      id: seed.id,
      group: seed.group,
      counts: Object.fromEntries(endpoints.map(endpoint => [
        endpoint,
        itemsBySeed.get(seed.id).get(endpoint)?.length ?? 0,
      ])),
    })),
    health: {
      discoveryQuality: health.data.discoveryQuality,
      audioFeatures,
    },
    latency: { p95Ms: p95, maximumMs: maxLatencyMs, endpoints: endpointLatency },
    dig: {
      count: digItems.length,
      latencyMs: digResult.elapsedMs,
      seedIds: [...digSeedIds],
      generationOverlap: digGenerationOverlap,
      maxProducerShare: digMaxProducerShare,
    },
    quality: {
      endpoints: endpointQuality,
      maxModeOverlap: observedMaxModeOverlap,
      thresholds: {
        maxArtistShare, maxProducerShare, maxVocalistShare,
        maxSeedOverlap, maxModeOverlap, minUniqueRatio,
        minHybridMinorShare, maxHybridMinorShare, maxSeedProducerShare,
      },
    },
  };
  if (reportFile) await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  for (const endpoint of endpoints) {
    const required = endpoint === '/api/recommend/audio'
      ? seeds.filter(seed => seed.audioComputed === true).length
      : seeds.length;
    assert(nonEmptyByEndpoint.get(endpoint) >= required, `${endpoint} returned candidates for ${nonEmptyByEndpoint.get(endpoint)}/${required} applicable representative seeds.`);
  }
  assert(p95 <= maxLatencyMs, `Recommendation p95 latency ${p95}ms exceeded ${maxLatencyMs}ms.`);
  for (const endpoint of endpoints) {
    assert(endpointLatency[endpoint].p95Ms <= maxLatencyMs, `${endpoint} p95 latency ${endpointLatency[endpoint].p95Ms}ms exceeded ${maxLatencyMs}ms.`);
  }
  assert(getSeedProducerShare(seeds) <= maxSeedProducerShare, `Representative seed producer share ${getSeedProducerShare(seeds).toFixed(3)} exceeded ${maxSeedProducerShare}.`);
  for (const quality of endpointQuality) {
    assert(quality.maxArtistShare <= maxArtistShare, `${quality.endpoint} artist share ${quality.maxArtistShare.toFixed(3)} exceeded ${maxArtistShare}.`);
    if (quality.groupMetadataCoverage >= 0.8) {
      assert(quality.maxProducerShare <= maxProducerShare, `${quality.endpoint} producer share ${quality.maxProducerShare.toFixed(3)} exceeded ${maxProducerShare}.`);
      assert(quality.maxVocalistShare <= maxVocalistShare, `${quality.endpoint} vocalist share ${quality.maxVocalistShare.toFixed(3)} exceeded ${maxVocalistShare}.`);
    }
    assert(quality.maxSeedOverlap <= maxSeedOverlap, `${quality.endpoint} seed overlap ${quality.maxSeedOverlap.toFixed(3)} exceeded ${maxSeedOverlap}.`);
    assert(quality.uniqueRatio >= minUniqueRatio, `${quality.endpoint} unique ratio ${quality.uniqueRatio.toFixed(3)} fell below ${minUniqueRatio}.`);
  }
  assert(observedMaxModeOverlap <= maxModeOverlap, `Recommendation mode overlap ${observedMaxModeOverlap.toFixed(3)} exceeded ${maxModeOverlap}.`);
  const hybridQuality = endpointQuality.find(quality => quality.endpoint === '/api/recommend');
  assert(hybridQuality.minorShare >= minHybridMinorShare, `Hybrid minor share ${hybridQuality.minorShare.toFixed(3)} fell below ${minHybridMinorShare}.`);
  assert(hybridQuality.minorShare <= maxHybridMinorShare, `Hybrid minor share ${hybridQuality.minorShare.toFixed(3)} exceeded ${maxHybridMinorShare}.`);

  const summary = endpoints.map(endpoint => {
    const counts = endpointCounts.get(endpoint);
    return `${endpoint} n=${counts.length} nonEmpty=${nonEmptyByEndpoint.get(endpoint)} avg=${Math.round(counts.reduce((sum, count) => sum + count, 0) / counts.length)}`;
  });
  console.log(`PASS representative seeds (${seeds.map(seed => `${seed.group}:${seed.id}`).join(', ')})`);
  console.log(`PASS recommendation regression (${summary.join('; ')})`);
  console.log(`PASS recommendation latency (overall p95=${p95}ms; ${endpoints.map(endpoint => `${endpoint} p50=${endpointLatency[endpoint].p50Ms} p95=${endpointLatency[endpoint].p95Ms}`).join('; ')})`);
  console.log(`PASS representative seed balance (producerShare=${getSeedProducerShare(seeds).toFixed(2)}, audioCoverage=${(seeds.filter(seed => seed.audioComputed === true).length / seeds.length).toFixed(2)})`);
  console.log(`PASS Dig discovery (${digItems.length} candidates, latency=${digResult.elapsedMs}ms, generationOverlap=${digGenerationOverlap.toFixed(2)}, producerShare=${digMaxProducerShare.toFixed(2)})`);
  console.log(`PASS recommendation diversity (${endpointQuality.map(quality => `${quality.endpoint} artist=${quality.maxArtistShare.toFixed(2)} producer=${quality.maxProducerShare.toFixed(2)} vocalist=${quality.maxVocalistShare.toFixed(2)} seedOverlap=${quality.maxSeedOverlap.toFixed(2)} unique=${quality.uniqueRatio.toFixed(2)} minor=${quality.minorShare.toFixed(2)} metadata=${quality.groupMetadataCoverage.toFixed(2)}`).join('; ')}; modeOverlap=${observedMaxModeOverlap.toFixed(2)})`);
}

main().catch(error => {
  console.error(`Recommendation regression check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
