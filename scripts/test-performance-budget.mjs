import puppeteer from 'puppeteer';

const PAGE_TIMEOUT_MS = 45_000;
const BUDGETS_MS = {
  'home.first-card': 3_000,
  'home.first-content': 3_000,
  'home.load': 5_000,
  'home.paint': 3_000,
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
  await page.evaluate(async () => {
    localStorage.setItem('diva-history-log-migrated-v1', '1');
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
        store.add({ s: 300_001 + index, t: now - index * 60_000, f: 1 });
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  });
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
      await new Promise(resolve => setTimeout(resolve, 100));
      body = { items: parseIds(url).map(fixtureSongForId) };
    } else if (path.includes('/api/songs/discovery-eligibility')) {
      body = { items: parseIds(url).map(songId => ({ songId, discoveryEligible: true })) };
    } else if (path.includes('/api/songs/search')) {
      body = { items: [fixtureSong], totalCount: 1 };
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
  const counters = { historyMetadataRequests: 0 };
  await installApiFixtures(page, counters);

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForCards(page, 'home');
    await seedLargeHistory(page);

    counters.historyMetadataRequests = 0;
    const homeStartedAt = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCards(page, 'home with 300 history entries');
    const firstCardMs = Date.now() - homeStartedAt;
    const firstContent = await waitForMetric(page, 'home.first-content');
    const homeLoad = await waitForMetric(page, 'home.load');
    const homePaint = await waitForMetric(page, 'home.paint');
    assert(
      counters.historyMetadataRequests <= 3,
      `History hydration used ${counters.historyMetadataRequests} sequential metadata requests (expected at most 3 parallel chunks).`,
    );

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
