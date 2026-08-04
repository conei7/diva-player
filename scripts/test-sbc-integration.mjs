// This is a functional integration test. Cold trending queries can scan a large daily history table.
const DEFAULT_TIMEOUT_MS = 35_000;

function getBaseUrl() {
  const argumentIndex = process.argv.indexOf('--base-url');
  const provided = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.SBC_API_URL;
  if (!provided) {
    throw new Error('Set SBC_API_URL or pass --base-url http://192.168.40.79:5000.');
  }
  return new URL(provided).toString().replace(/\/$/, '');
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}.`);
  }
  return response.json();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSongItems(data, endpoint) {
  assert(data && Array.isArray(data.items), `${endpoint} did not return an items array.`);
  for (const item of data.items) {
    assert(Number.isInteger(item.songId), `${endpoint} returned an invalid songId.`);
    assert(typeof item.name === 'string', `${endpoint} returned an invalid song name.`);
    assert(Array.isArray(item.producerIds), `${endpoint} omitted producer IDs.`);
    assert(Array.isArray(item.vocalistIds), `${endpoint} omitted vocalist IDs.`);
    assert(Number.isFinite(item.youtubeViews) && Number.isFinite(item.nicoViews), `${endpoint} omitted view counts.`);
  }
}

function assertDigItems(data, endpoint) {
  assert(data && Array.isArray(data.items), `${endpoint} did not return an items array.`);
  for (const item of data.items) {
    assert(Number.isInteger(item.id), `${endpoint} returned an invalid full song id.`);
    assert(typeof item.name === 'string', `${endpoint} returned an invalid full song name.`);
  }
}

async function findSeedWithResults(baseUrl, endpoint) {
  const search = await getJson(
    baseUrl,
    '/api/songs/search?sort=FavoritedTimes&order=desc&start=0&maxResults=12&audioComputed=true',
  );
  assert(Array.isArray(search.items) && search.items.length > 0, 'PostgreSQL search returned no audio-computed songs.');

  for (const song of search.items) {
    const data = await getJson(baseUrl, `${endpoint}?songId=${song.id}&count=8&offset=0`);
    assertSongItems(data, endpoint);
    if (data.items.length > 0) {
      assert(data.items.every(item => item.songId !== song.id), `${endpoint} returned its seed song.`);
      return { seed: song, data };
    }
  }
  throw new Error(`${endpoint} returned no candidates for 12 audio-computed seed songs.`);
}

async function main() {
  const baseUrl = getBaseUrl();
  console.log(`SBC API integration test: ${baseUrl}`);

  const health = await getJson(baseUrl, '/api/health');
  assert(health.status === 'ok', 'Health endpoint did not return status=ok.');
  assert(health.dependencies?.postgres?.ok === true, 'PostgreSQL is not healthy.');
  assert(health.dependencies?.qdrant?.ok === true, 'Qdrant is not healthy.');
  assert(health.discoveryQuality?.total > 0, 'Discovery quality table is empty.');
  assert(health.discoveryQuality?.nicoRatio > 0, 'Discovery quality Nico presence ratio is zero.');
  assert(health.audioFeatures && Number.isInteger(health.audioFeatures.targetCount), 'Audio feature health is missing.');
  assert(Number.isInteger(health.audioFeatures.actionableTargetCount), 'Audio actionable backlog is missing.');
  assert(Number.isInteger(health.audioFeatures.actionablePendingCount), 'Audio actionable pending count is missing.');
  assert(health.audioFeatures.ok !== false, `Audio feature backlog is unhealthy: ${health.audioFeatures.error ?? 'unknown'}.`);
  console.log(`PASS API health (PostgreSQL ${health.dependencies.postgres.latencyMs}ms, Qdrant ${health.dependencies.qdrant.latencyMs}ms)`);
  console.log(`PASS discovery quality health (${health.discoveryQuality.total} songs, short ${(health.discoveryQuality.shortRatio * 100).toFixed(2)}%, Nico ${(health.discoveryQuality.nicoRatio * 100).toFixed(2)}%)`);
  console.log(`PASS audio feature health (${health.audioFeatures.computedCount}/${health.audioFeatures.targetCount} computed, pending ${health.audioFeatures.pendingCount}; actionable ${health.audioFeatures.actionablePendingCount}/${health.audioFeatures.actionableTargetCount} pending)`);

  const search = await getJson(
    baseUrl,
    '/api/songs/search?sort=FavoritedTimes&order=desc&start=0&maxResults=8&audioComputed=true',
  );
  assert(Array.isArray(search.items) && search.items.length > 0, 'PostgreSQL search returned no results.');
  assert(Number.isInteger(search.items[0].id), 'PostgreSQL search returned an invalid song ID.');
  console.log(`PASS PostgreSQL search (${search.items.length} songs)`);

  const globalFilterSearch = await getJson(
    baseUrl,
    '/api/songs/search?sort=YoutubeViews&order=desc&start=0&maxResults=1&minYoutubeViews=9223372036854775807',
  );
  assert(globalFilterSearch.totalCount === 0 && globalFilterSearch.items.length === 0, 'Global view threshold was not applied by SBC search.');
  console.log('PASS global search filter parameters');

  const seedId = search.items[0].id;
  const batchIds = search.items.slice(0, 3).map(item => item.id);
  const compactBatch = await getJson(baseUrl, `/api/songs/batch?ids=${batchIds.join(',')}`);
  assert(Array.isArray(compactBatch.items) && compactBatch.items.length === batchIds.length, 'Compact song batch omitted requested songs.');
  assert(JSON.stringify(compactBatch.items.map(item => item.id)) === JSON.stringify(batchIds), 'Compact song batch changed request order.');
  assert(compactBatch.items.every(item => Array.isArray(item.artists) && Array.isArray(item.pvs) && Array.isArray(item.tags)), 'Compact song batch omitted playback or ranking fields.');
  assert(compactBatch.items.every(item => item.webLinks === undefined), 'Compact song batch retained heavy webLinks metadata.');
  assert(compactBatch.items.every(item => item.tags.every(tag => tag.tag?.name && tag.tag.additionalNames === undefined)), 'Compact song batch retained heavy tag metadata.');
  assert(compactBatch.items.every(item => item.pvs.every(pv => pv.description === undefined)), 'Compact song batch retained PV descriptions.');
  console.log(`PASS compact song batch (${compactBatch.items.length} ordered songs)`);

  const views = await getJson(baseUrl, `/api/songs/views?ids=${seedId}`);
  assert(views[String(seedId)] || views[seedId], 'PostgreSQL views endpoint did not return the requested song.');
  console.log('PASS PostgreSQL view data');

  const trending = await getJson(baseUrl, '/api/songs/trending?days=30&start=0&maxResults=8');
  assert(Array.isArray(trending.items), 'Trending endpoint did not return an items array.');
  console.log(`PASS PostgreSQL trending (${trending.items.length} songs)`);

  for (const [mode, days] of [['alltime', 30], ['pace', 30], ['surge', 7], ['recent', 30]]) {
    const rankedA = await getJson(baseUrl, `/api/songs/trending?days=${days}&start=0&maxResults=24&mode=${mode}&seed=11`);
    const rankedB = await getJson(baseUrl, `/api/songs/trending?days=${days}&start=0&maxResults=24&mode=${mode}&seed=12`);
    assert(JSON.stringify(rankedA.items.map(item => item.id)) === JSON.stringify(rankedB.items.map(item => item.id)), `${mode} ranking changed with its exploration seed.`);
    if (mode === 'surge') {
      assert(rankedA.items.length === 24, `Surge ranking returned only ${rankedA.items.length}/24 songs.`);
      assert(rankedA.items.every(item => Number(item.viewGrowth) > 0), 'Surge ranking omitted recent growth evidence.');
      assert(rankedA.items.every(item => Number(item.surgeRate) >= 1.25), 'Surge ranking included a song below the acceleration boundary.');
      assert(rankedA.items.every(item => Number(item.trendWindowDays) >= 7 && Number(item.trendWindowDays) <= 10), 'Surge ranking returned an incorrect trend window.');
    }
    console.log(`PASS deterministic ${mode} ranking (${rankedA.items.length} items)`);
  }

  const metadata = await findSeedWithResults(baseUrl, '/api/recommend/metadata');
  console.log(`PASS Qdrant metadata similarity (seed ${metadata.seed.id}, ${metadata.data.items.length} candidates)`);

  const audio = await findSeedWithResults(baseUrl, '/api/recommend/audio');
  console.log(`PASS Qdrant audio similarity (seed ${audio.seed.id}, ${audio.data.items.length} candidates)`);

  const recommended = await getJson(baseUrl, `/api/recommend?songId=${metadata.seed.id}&count=8&offset=0&sessionProgress=0`);
  assertSongItems(recommended, '/api/recommend');
  assert(!recommended.error, `/api/recommend returned an error: ${recommended.error}`);
  console.log(`PASS hybrid recommendation (${recommended.items.length} candidates)`);

  const multiResponse = await fetch(`${baseUrl}/api/recommend/multi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seeds: [
        { songId: metadata.seed.id, weight: 1.0 },
        { songId: audio.seed.id, weight: 0.7 },
      ],
      count: 8,
      excludeSongIds: [metadata.seed.id, audio.seed.id],
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  assert(multiResponse.ok, `/api/recommend/multi returned HTTP ${multiResponse.status}.`);
  const multi = await multiResponse.json();
  assertSongItems(multi, '/api/recommend/multi');
  assert(!multi.error, `/api/recommend/multi returned an error: ${multi.error}`);
  assert(multi.items.every(item => item.songId !== metadata.seed.id && item.songId !== audio.seed.id), '/api/recommend/multi returned an excluded song.');
  console.log(`PASS multi-seed recommendation (${multi.items.length} candidates)`);

  const digResponse = await fetch(`${baseUrl}/api/recommend/dig`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seeds: [
        { songId: metadata.seed.id, weight: 1.0 },
        { songId: audio.seed.id, weight: 0.8 },
      ],
      count: 8,
      offset: 0,
      generationSeed: 17,
      excludeSongIds: [metadata.seed.id, audio.seed.id],
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  assert(digResponse.ok, `/api/recommend/dig returned HTTP ${digResponse.status}.`);
  const dig = await digResponse.json();
  assertDigItems(dig, '/api/recommend/dig');
  assert(dig.items.length > 0, '/api/recommend/dig returned no discovery candidates.');
  assert(dig.items.every(item => item.id !== metadata.seed.id && item.id !== audio.seed.id), '/api/recommend/dig returned an excluded song.');
  assert(new Set(dig.items.map(item => item.id)).size === dig.items.length, '/api/recommend/dig returned duplicate song IDs.');
  console.log(`PASS Dig discovery recommendation (${dig.items.length} full song candidates)`);

  console.log('SBC API integration test passed.');
}

main().catch(error => {
  console.error(`SBC API integration test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
