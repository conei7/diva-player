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
  console.log(`PASS API health (PostgreSQL ${health.dependencies.postgres.latencyMs}ms, Qdrant ${health.dependencies.qdrant.latencyMs}ms)`);
  console.log(`PASS discovery quality health (${health.discoveryQuality.total} songs, short ${(health.discoveryQuality.shortRatio * 100).toFixed(2)}%, Nico ${(health.discoveryQuality.nicoRatio * 100).toFixed(2)}%)`);

  const search = await getJson(
    baseUrl,
    '/api/songs/search?sort=FavoritedTimes&order=desc&start=0&maxResults=8&audioComputed=true',
  );
  assert(Array.isArray(search.items) && search.items.length > 0, 'PostgreSQL search returned no results.');
  assert(Number.isInteger(search.items[0].id), 'PostgreSQL search returned an invalid song ID.');
  console.log(`PASS PostgreSQL search (${search.items.length} songs)`);

  const seedId = search.items[0].id;
  const views = await getJson(baseUrl, `/api/songs/views?ids=${seedId}`);
  assert(views[String(seedId)] || views[seedId], 'PostgreSQL views endpoint did not return the requested song.');
  console.log('PASS PostgreSQL view data');

  const trending = await getJson(baseUrl, '/api/songs/trending?days=30&start=0&maxResults=8');
  assert(Array.isArray(trending.items), 'Trending endpoint did not return an items array.');
  console.log(`PASS PostgreSQL trending (${trending.items.length} songs)`);

  const seededA = await getJson(baseUrl, '/api/songs/trending?days=7&start=0&maxResults=24&mode=surge&seed=11');
  const seededB = await getJson(baseUrl, '/api/songs/trending?days=7&start=0&maxResults=24&mode=surge&seed=11');
  const seededC = await getJson(baseUrl, '/api/songs/trending?days=7&start=0&maxResults=24&mode=surge&seed=12');
  assert(JSON.stringify(seededA.items.map(item => item.id)) === JSON.stringify(seededB.items.map(item => item.id)), 'Trending seed is not stable.');
  assert(seededA.items.length < 2 || JSON.stringify(seededA.items.map(item => item.id)) !== JSON.stringify(seededC.items.map(item => item.id)), 'Trending seed has no exploration effect.');
  console.log(`PASS seeded trending stability (${seededA.items.length} items)`);

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

  console.log('SBC API integration test passed.');
}

main().catch(error => {
  console.error(`SBC API integration test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
