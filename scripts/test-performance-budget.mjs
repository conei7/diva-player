import puppeteer from 'puppeteer';

const PAGE_TIMEOUT_MS = 45_000;
const HISTORY_METADATA_DELAY_MS = 5_000;
const BUDGETS_MS = {
  'home.first-card': 1_500,
  'home.first-content': 1_500,
  'home.load': 10_000,
  'home.paint': 1_500,
  'search.paint': 3_000,
};

function getBaseUrl() {
  const provided = process.argv[2] ?? process.env.PERF_BUDGET_BASE_URL ?? 'http://127.0.0.1:4173/diva-player/';
  const url = new URL(provided);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const fixtureProducer = {
  id: 424242,
  artistType: 'Producer',
  name: 'DIVA Performance Producer',
  additionalNames: '',
  deleted: false,
  releaseDate: '2020-01-01T00:00:00Z',
  status: 'Finished',
  version: 1,
};
const fixtureVocalist = {
  id: 424243,
  artistType: 'Vocaloid',
  name: 'DIVA Performance Vocalist',
  additionalNames: '',
  deleted: false,
  releaseDate: '2020-01-01T00:00:00Z',
  status: 'Finished',
  version: 1,
};
const fixtureSong = {
  artists: [
    {
      artist: fixtureProducer,
      categories: 'Producer',
      effectiveRoles: 'Producer',
      id: fixtureProducer.id,
      isCustomName: false,
      isSupport: false,
      name: fixtureProducer.name,
      roles: 'Producer',
    },
    {
      artist: fixtureVocalist,
      categories: 'Vocalist',
      effectiveRoles: 'Vocalist',
      id: fixtureVocalist.id,
      isCustomName: false,
      isSupport: false,
      name: fixtureVocalist.name,
      roles: 'Vocalist',
    },
  ],
  artistString: fixtureProducer.name,
  createDate: '2020-01-01T00:00:00Z',
  defaultName: 'DIVA Performance Song',
  defaultNameLanguage: 'Japanese',
  favoritedTimes: 42,
  id: 2501,
  lengthSeconds: 180,
  name: 'DIVA Performance Song',
  publishDate: '2020-01-01T00:00:00Z',
  pvs: [],
  pvServices: '',
  ratingScore: 5,
  songType: 'Original',
  status: 'Finished',
  tags: [],
  thumbUrl: '',
  version: 1,
  youtubeViews: 1234,
  nicoViews: 567,
};

function fixtureSongForId(id) {
  return {
    ...fixtureSong,
    id,
    name: `DIVA Performance Song ${id}`,
    defaultName: `DIVA Performance Song ${id}`,
  };
}

function parseIds(url) {
  return (url.searchParams.get('ids') ?? '')
    .split(',')
    .map(Number)
    .filter(Number.isInteger);
}

async function seedLargeHistory(page) {
  // A returning listener must still get an immediate personalized frame even
  // when the last successful refresh is old or the network is unavailable.
  const seededAt = Date.now() - 48 * 60 * 60 * 1000;
  const cachedSongs = Array.from({ length: 48 }, (_, index) => fixtureSongForId(300_001 + index));
  await page.evaluate(async ({ seededAt: cacheSavedAt, cachedSongs: personalizedSongs }) => {
    localStorage.setItem('diva-history-log-migrated-v1', '1');
    const startupSnapshot = { version: 2, savedAt: cacheSavedAt, songs: personalizedSongs };
    localStorage.setItem('diva-startup-recommendations', JSON.stringify(startupSnapshot));
    localStorage.removeItem('diva-startup-recommendations-backup');
    sessionStorage.removeItem('diva-startup-rotation-v1');
    localStorage.setItem('diva-hidden-songs', JSON.stringify({
      state: {
        hiddenSongs: {
          '2501': { song: { id: 2501, name: 'Hidden startup song' }, hiddenAt: Date.now() },
        },
      },
      version: 0,
    }));
    localStorage.setItem('diva-global-filters', JSON.stringify({
      state: {
        enabled: false,
        minYoutubeViews: 0,
        minNicoViews: 0,
        excludedSongTypes: [],
        vocalistFilters: [],
        vocalistMatchMode: 'Any',
        cooldownHours: 24,
        excludeRatedFromDiscovery: false,
      },
      version: 2,
    }));
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('diva-listening-history', 3);
      request.onupgradeneeded = () => {
        const database = request.result;
        const plays = database.objectStoreNames.contains('plays')
          ? request.transaction.objectStore('plays')
          : database.createObjectStore('plays', { keyPath: 'id', autoIncrement: true });
        if (!plays.indexNames.contains('songId')) plays.createIndex('songId', 's', { unique: false });
        if (!plays.indexNames.contains('playedAt')) plays.createIndex('playedAt', 't', { unique: false });
        const keyedStores = [
          ['stats_pending', 'eventId'],
          ['stats_applied', 'eventId'],
          ['song_stats', 'songId'],
          ['year_stats', 'key'],
          ['month_stats', 'key'],
          ['stats_meta', 'key'],
        ];
        for (const [storeName, keyPath] of keyedStores) {
          if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('plays', 'readwrite');
      const store = transaction.objectStore('plays');
      store.clear();
      const now = Date.now();
      for (let index = 0; index < 300; index += 1) {
        store.add({ s: 300_001 + index, t: now - 48 * 60 * 60 * 1000 - index * 60_000, f: 1 });
      }
      store.add({ s: 2502, t: now - 60_000, f: 1 });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();

    const startupDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open('diva-startup-cache', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('recommendations')) {
          request.result.createObjectStore('recommendations', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = startupDb.transaction('recommendations', 'readwrite');
      transaction.objectStore('recommendations').put({ key: 'home', snapshot: startupSnapshot });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    startupDb.close();
  }, { seededAt, cachedSongs });
  return seededAt;
}

async function installApiFixtures(page, counters) {
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    const path = url.pathname;
    const isBackend = path.startsWith('/backend-api/');
    const isVocaDb = url.hostname === 'vocadb.net';
    if (!isBackend && !isVocaDb) {
      void request.continue();
      return;
    }

    let body = null;
    if (path.endsWith('/api/health') || path.endsWith('/api/ready')) {
      body = { status: path.endsWith('/api/ready') ? 'ready' : 'ok', postgres: true, qdrant: true };
    } else if (path.includes('/api/songs/batch') || path.includes('/api/songs/details')) {
      counters.historyMetadataRequests += 1;
      await new Promise(resolve => setTimeout(resolve, counters.historyMetadataDelayMs));
      body = { items: parseIds(url).map(fixtureSongForId) };
    } else if (path.includes('/api/songs/discovery-eligibility')) {
      body = { items: parseIds(url).map(songId => ({ songId, discoveryEligible: true })) };
    } else if (path.includes('/api/songs/search')) {
      const isStartupPopular = url.searchParams.get('discoveryOnly') === 'true'
        && url.searchParams.get('sort') === 'FavoritedTimes'
        && url.searchParams.get('maxResults') === '12';
      if (isStartupPopular && url.searchParams.get('start') === '0') {
        counters.startupPopularRequests += 1;
        body = { items: [fixtureSong, fixtureSongForId(2502)], totalCount: 3 };
      } else if (isStartupPopular && url.searchParams.get('start') === '12') {
        counters.startupPopularMoreRequests += 1;
        body = { items: [fixtureSongForId(2503)], totalCount: 3 };
      } else {
        body = { items: [fixtureSong, fixtureSongForId(2502), fixtureSongForId(2503)], totalCount: 3 };
      }
    } else if (path.includes('/api/recommend')) {
      body = { items: [] };
    } else if (path.match(/\/api\/songs\/\d+$/)) {
      body = fixtureSong;
    } else if (isVocaDb && path.match(/\/api\/songs$/)) {
      body = { items: [fixtureSong], term: url.searchParams.get('query') ?? '', totalCount: 1 };
    } else if (isVocaDb && path.startsWith('/api/songs/')) {
      body = [fixtureSong];
    } else if (isVocaDb && path.match(/\/api\/artists$/)) {
      body = { items: [{ id: fixtureProducer.id, name: fixtureProducer.name, artistType: fixtureProducer.artistType }], term: url.searchParams.get('query') ?? '', totalCount: 1 };
    }

    if (body) {
      void request.respond({
        status: 200,
        headers: {
          'access-control-allow-origin': '*',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } else {
      void request.respond({ status: 404, headers: { 'content-type': 'application/json' }, body: '{}' });
    }
  });
}

async function waitForMetric(page, name) {
  try {
    await page.waitForFunction(metricName =>
      window.__DIVA_PERFORMANCE__?.getMetrics().some(metric => metric.name === metricName), {}, name,
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      metrics: window.__DIVA_PERFORMANCE__?.getMetrics() ?? [],
      cards: document.querySelectorAll('a[href*="/watch?v="]').length,
    }));
    throw new Error(`${name} was not recorded: ${JSON.stringify(diagnostic)} (${error.message})`);
  }
  return page.evaluate(metricName => {
    const metrics = window.__DIVA_PERFORMANCE__?.getMetrics() ?? [];
    return metrics.filter(metric => metric.name === metricName).at(-1) ?? null;
  }, name);
}

async function waitForCards(page, label) {
  try {
    await page.waitForSelector('a[href*="/watch?v="]');
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      text: document.body.innerText.slice(0, 300),
      metrics: window.__DIVA_PERFORMANCE__?.getMetrics() ?? [],
      cards: document.querySelectorAll('a[href*="/watch?v="]').length,
    }));
    throw new Error(`${label} cards did not render: ${JSON.stringify(diagnostic)} (${error.message})`);
  }
}

async function main() {
  const baseUrl = getBaseUrl();
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  const counters = {
    historyMetadataRequests: 0,
    startupPopularRequests: 0,
    startupPopularMoreRequests: 0,
    historyMetadataDelayMs: HISTORY_METADATA_DELAY_MS,
  };
  await installApiFixtures(page, counters);

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForCards(page, 'home');
    const seededCacheAt = await seedLargeHistory(page);

    counters.historyMetadataRequests = 0;
    counters.startupPopularRequests = 0;
    counters.startupPopularMoreRequests = 0;
    const homeStartedAt = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCards(page, 'home with 300 history entries');
    const firstCardMs = Date.now() - homeStartedAt;
    const firstFrame = await page.evaluate(() => ({
      hasLegacyStartupPage: document.querySelector('#startup-home') !== null
        || document.documentElement.classList.contains('diva-startup-home'),
      hasNormalHeader: document.querySelector('header') !== null,
      hasNormalNavigation: document.querySelector('aside nav') !== null,
      songIds: Array.from(new Set(Array.from(document.querySelectorAll('main a[href*="/watch?v="]'))
        .map(link => new URL(link.href).searchParams.get('v')))).slice(0, 24),
      skeletons: document.querySelectorAll('main .skeleton').length,
    }));
    const firstContent = await waitForMetric(page, 'home.first-content');
    const homeLoad = await waitForMetric(page, 'home.load');
    const homePaint = await waitForMetric(page, 'home.paint');
    const settledFrame = await page.evaluate(() => ({
      songIds: Array.from(new Set(Array.from(document.querySelectorAll('main a[href*="/watch?v="]'))
        .map(link => new URL(link.href).searchParams.get('v')))).slice(0, 24),
      skeletons: document.querySelectorAll('main .skeleton').length,
    }));
    assert(
      !firstFrame.hasLegacyStartupPage && firstFrame.hasNormalHeader && firstFrame.hasNormalNavigation,
      `Startup rendered a second layout before the application: ${JSON.stringify(firstFrame)}`,
    );
    assert(
      firstFrame.songIds.length > 0 && firstFrame.songIds.every(songId => /^300\d{3}$/.test(String(songId))),
      `A default popular list flashed before the personalized cache: ${JSON.stringify(firstFrame)}`,
    );
    assert(
      firstFrame.skeletons === 0,
      `Loading-more skeletons were appended below an already visible grid: ${JSON.stringify(firstFrame)}`,
    );
    assert(
      JSON.stringify(settledFrame.songIds) === JSON.stringify(firstFrame.songIds)
        && settledFrame.skeletons === 0,
      `The visible personalized grid shifted while its refresh ran: ${JSON.stringify({ firstFrame, settledFrame })}`,
    );
    assert(
      firstContent?.detail?.source === 'personalized-cache',
      `First content did not use the personalized startup cache: ${JSON.stringify(firstContent)}`,
    );
    assert(
      counters.startupPopularRequests === 1,
      `Startup popular first page was requested ${counters.startupPopularRequests} times (expected one shared request).`,
    );
    assert(
      counters.startupPopularMoreRequests === 1,
      `Startup popular fill page was requested ${counters.startupPopularMoreRequests} times (expected one shared request).`,
    );
    assert(
      counters.historyMetadataRequests <= 3,
      `History hydration used ${counters.historyMetadataRequests} sequential metadata requests (expected at most 3 parallel chunks).`,
    );
    await page.waitForFunction(() => Array.from(document.querySelectorAll('a[href*="/watch?v="]'))
      .some(link => /[?&]v=300\d{3}/.test(link.getAttribute('href') ?? '')));
    try {
      await page.waitForFunction(previousSavedAt => {
        const cached = JSON.parse(localStorage.getItem('diva-startup-recommendations') || 'null');
        return cached?.savedAt > previousSavedAt
          && cached?.version === 3
          && Array.isArray(cached?.songs)
          && cached.songs.some(song => /^300\d{3}$/.test(String(song.id)));
      }, {}, seededCacheAt);
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        cache: JSON.parse(localStorage.getItem('diva-startup-recommendations') || 'null'),
        links: Array.from(document.querySelectorAll('a[href*="/watch?v="]')).slice(0, 30)
          .map(link => link.getAttribute('href')),
      }));
      throw new Error(`Personalized startup cache was not persisted: ${JSON.stringify(diagnostic)} (${error.message})`);
    }
    try {
      await page.waitForFunction(async previousSavedAt => new Promise(resolve => {
        const request = indexedDB.open('diva-startup-cache', 1);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('recommendations', 'readonly');
          const getRequest = transaction.objectStore('recommendations').get('home');
          getRequest.onsuccess = () => {
            const snapshot = getRequest.result?.snapshot;
            const songs = snapshot?.songs;
            database.close();
            resolve(snapshot?.savedAt > previousSavedAt
              && Array.isArray(songs)
              && songs.some(song => /^300\d{3}$/.test(String(song.id))));
          };
          getRequest.onerror = () => { database.close(); resolve(false); };
        };
        request.onerror = () => resolve(false);
      }), {}, seededCacheAt);
    } catch (error) {
      const diagnostic = await page.evaluate(async () => {
        const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
        const record = await new Promise(resolve => {
          const request = indexedDB.open('diva-startup-cache', 1);
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('recommendations', 'readonly');
            const getRequest = transaction.objectStore('recommendations').get('home');
            getRequest.onsuccess = () => { database.close(); resolve(getRequest.result ?? null); };
            getRequest.onerror = () => { database.close(); resolve({ error: String(getRequest.error) }); };
          };
          request.onerror = () => resolve({ error: String(request.error) });
        });
        return { databases, record, local: JSON.parse(localStorage.getItem('diva-startup-recommendations') || 'null') };
      });
      throw new Error(`IndexedDB startup cache was not persisted: ${JSON.stringify(diagnostic)} (${error.message})`);
    }

    counters.historyMetadataDelayMs = 0;
    await page.evaluate(async () => {
      localStorage.removeItem('diva-startup-recommendations');
      localStorage.removeItem('diva-startup-recommendations-backup');
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('diva-startup-cache', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('recommendations', 'readwrite');
        transaction.objectStore('recommendations').put({
          key: 'home',
          snapshot: { version: 999, savedAt: Date.now(), songs: [] },
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
    });
    const indexedDbReloadStartedAt = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCards(page, 'IndexedDB personalized cache');
    const indexedDbFirstCardMs = Date.now() - indexedDbReloadStartedAt;
    const cachedFirstContent = await waitForMetric(page, 'home.first-content');
    const cachedFrame = await page.evaluate(() => ({
      hasLegacyStartupPage: document.querySelector('#startup-home') !== null,
      songIds: Array.from(new Set(Array.from(document.querySelectorAll('main a[href*="/watch?v="]'))
        .map(link => new URL(link.href).searchParams.get('v')))).slice(0, 24),
      skeletons: document.querySelectorAll('main .skeleton').length,
    }));
    assert(
      cachedFirstContent?.detail?.source === 'personalized-cache'
        && cachedFirstContent.durationMs <= BUDGETS_MS['home.first-card']
        && indexedDbFirstCardMs <= BUDGETS_MS['home.first-card']
        && cachedFrame.songIds.some(songId => /^300\d{3}$/.test(String(songId)))
        && JSON.stringify(cachedFrame.songIds) !== JSON.stringify(firstFrame.songIds)
        && !cachedFrame.hasLegacyStartupPage
        && cachedFrame.skeletons === 0,
      `IndexedDB backup did not render a rotated personalized frame: ${JSON.stringify({ cachedFirstContent, indexedDbFirstCardMs, firstFrame, cachedFrame })}`,
    );
    console.log(`PASS home.personalized-cache: ${Math.round(cachedFirstContent.durationMs)}ms / ${BUDGETS_MS['home.first-card']}ms`);

    // This producer name is present in the SBC/VocaDB fixture and keeps the
    // search paint budget independent of a single localized song title.
    const searchInput = 'form input[type="text"]';
    await page.waitForSelector(searchInput);
    await page.click(searchInput);
    await page.type(searchInput, 'wowaka');
    await page.keyboard.press('Enter');
    await waitForCards(page, 'search');
    const searchPaint = await waitForMetric(page, 'search.paint');

    const metrics = {
      'home.first-card': { durationMs: firstCardMs },
      'home.first-content': firstContent,
      'home.load': homeLoad,
      'home.paint': homePaint,
      'search.paint': searchPaint,
    };
    for (const [name, metric] of Object.entries(metrics)) {
      assert(metric && Number.isFinite(metric.durationMs), `${name} was not recorded.`);
      const budget = BUDGETS_MS[name];
      assert(metric.durationMs <= budget, `${name} exceeded ${budget}ms (${Math.round(metric.durationMs)}ms).`);
      console.log(`PASS ${name}: ${Math.round(metric.durationMs)}ms / ${budget}ms`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`Performance budget test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
