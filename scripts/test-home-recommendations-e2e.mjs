import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/diva-player/';
const song = id => ({
  id, name: `Home fixture ${id}`, defaultName: `Home fixture ${id}`, artistString: 'Fixture P',
  songType: 'Original', favoritedTimes: 50, lengthSeconds: 180,
  artists: [
    { artist: { id: 100 + id % 30, name: 'Fixture P', artistType: 'Producer' }, categories: 'Producer' },
    { artist: { id: 1, name: 'Miku', artistType: 'Vocaloid' }, categories: 'Vocalist' },
  ],
  pvs: [{ id, service: 'Youtube', pvId: 'dQw4w9WgXcQ', pvType: 'Original', disabled: false }],
});
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 640 });
  const known = Array.from({ length: 80 }, (_, i) => song(900000 + i));
  await page.evaluateOnNewDocument(songs => {
    localStorage.setItem('diva_uiLanguage', JSON.stringify('en'));
    localStorage.setItem('diva_playlists', JSON.stringify([{ id: 'fixture', name: 'Saved', songs, createdAt: 1, updatedAt: 1 }]));
    localStorage.setItem('diva_ratings', JSON.stringify(Object.fromEntries(songs.map(s => [s.id, 5]))));
    localStorage.setItem('diva-startup-recommendations', JSON.stringify({ version: 3, savedAt: Date.now(), songs }));
  }, known);
  let quotaResponses = 0;
  const recommendationOffsets = [];
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.includes('/backend-api/') && url.hostname !== 'vocadb.net') return void request.continue();
    const start = Number(url.searchParams.get('start') ?? url.searchParams.get('offset') ?? 0);
    const count = Number(url.searchParams.get('maxResults') ?? url.searchParams.get('count') ?? 24);
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);
    let body = { items: [] };
    if (path.endsWith('/health') || path.endsWith('/ready')) body = { status: 'ok', postgres: true, qdrant: true };
    else if (path.endsWith('/discovery-eligibility')) body = { items: ids.map(songId => ({ songId, discoveryEligible: true })) };
    else if (path.endsWith('/batch') || path.endsWith('/details')) body = { items: ids.map(song) };
    else if (path.endsWith('/views')) body = {};
    else if (path.endsWith('/search')) {
      await new Promise(resolve => setTimeout(resolve, 700));
      if (quotaResponses++ === 0) return void request.respond({ status: 429, headers: { 'Retry-After': '1' }, body: '{}' });
      body = { items: Array.from({ length: count }, (_, i) => song(200000 + start + i)), totalCount: 1000 };
    } else if (path.includes('/recommend')) {
      recommendationOffsets.push(start);
      await new Promise(resolve => setTimeout(resolve, 400));
      const items = Array.from({ length: count }, (_, i) => song(300000 + start + i));
      body = { items: items.map(s => ({ songId: s.id, score: 1 })), cards: items };
    }
    void request.respond({ status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('Loading songs'));
  const initial = await page.$$eval('.song-card h3 a[href*="/watch?v="]', links => links.slice(0, 24).map(link => Number(new URL(link.href).searchParams.get('v'))));
  assert(initial.length > 0 && initial.every(id => id >= 900000), `Cached familiar songs must render before the refresh completes: ${JSON.stringify(initial)}`);
  await page.waitForFunction(() => window.__DIVA_PERFORMANCE__?.getMetrics().some(metric => metric.name === 'home.load' && metric.detail?.page === 1), { timeout: 45000 });
  await page.waitForFunction(() => new Set([...document.querySelectorAll('a[href*="/watch?v="]')].map(link => new URL(link.href).searchParams.get('v'))).size > 40, { timeout: 45000 });
  const displayed = await page.$$eval('.song-card h3 a[href*="/watch?v="]', links => links.map(link => Number(new URL(link.href).searchParams.get('v'))));
  assert(displayed.length > 40, 'Cached startup feed must allow more than 40 songs');
  assert(recommendationOffsets.includes(0), 'Personal discovery must run on the first page');
  assert(recommendationOffsets.includes(24), 'Second source window must start at 24');
  assert.deepEqual(displayed.slice(0, initial.length), initial, 'Refreshing must not remove or reorder any visible cached songs');
  assert(displayed.filter(id => id >= 900000 && !initial.includes(id)).length <= 30, 'Fresh pages must limit familiar candidates to half');
  assert(displayed.some(id => id >= 300000 && id < 900000), 'Fresh discovery must append alongside the stable familiar songs');
  assert(quotaResponses >= 2, 'Quota response must recover without losing the feed');
  assert.equal(new Set(displayed).size, displayed.length);
  console.log(`PASS home recommendations: ${displayed.length} cards, stable ${initial.length}-song prefix, first-page discovery, half familiar candidates, visible loading, quota recovery, pagination >40`);

  // A new Home entry (the logo, a reload) opens with songs not on screen in the last five minutes.
  const context = await browser.createBrowserContext();
  const variety = await context.newPage();
  await variety.setViewport({ width: 1440, height: 900 });
  await variety.evaluateOnNewDocument(songs => {
    if (sessionStorage.getItem('fixture-seeded')) return;
    sessionStorage.setItem('fixture-seeded', '1');
    localStorage.setItem('diva_uiLanguage', JSON.stringify('en'));
    localStorage.setItem('diva_playlists', JSON.stringify([{ id: 'fixture', name: 'Saved', songs, createdAt: 1, updatedAt: 1 }]));
    localStorage.setItem('diva_ratings', JSON.stringify(Object.fromEntries(songs.map(s => [s.id, 5]))));
  }, known);
  await variety.setRequestInterception(true);
  variety.on('request', async request => {
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.includes('/backend-api/') && url.hostname !== 'vocadb.net') return void request.continue();
    const start = Number(url.searchParams.get('start') ?? url.searchParams.get('offset') ?? 0);
    const count = Number(url.searchParams.get('maxResults') ?? url.searchParams.get('count') ?? 24);
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);
    let body = { items: [] };
    if (path.endsWith('/health') || path.endsWith('/ready')) body = { status: 'ok', postgres: true, qdrant: true };
    else if (path.endsWith('/discovery-eligibility')) body = { items: ids.map(songId => ({ songId, discoveryEligible: true })) };
    else if (path.endsWith('/batch') || path.endsWith('/details')) body = { items: ids.map(song) };
    else if (path.endsWith('/views')) body = {};
    else if (path.endsWith('/search')) {
      await new Promise(resolve => setTimeout(resolve, 300));
      body = { items: Array.from({ length: count }, (_, i) => song(200000 + start + i)), totalCount: 1000 };
    } else if (path.includes('/recommend')) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const items = Array.from({ length: count }, (_, i) => song(300000 + start + i));
      body = { items: items.map(s => ({ songId: s.id, score: 1 })), cards: items };
    }
    void request.respond({ status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
  const feedIds = () => variety.$$eval('.song-card h3 a[href*="/watch?v="]', links => links.map(link => Number(new URL(link.href).searchParams.get('v'))));
  const shownIds = () => variety.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('diva-recommendation-exposure-v1') || '{}')).map(Number));
  const firstPageLoads = () => variety.evaluate(() => window.__DIVA_PERFORMANCE__?.getMetrics()
    .filter(metric => metric.name === 'home.load' && metric.detail?.page === 0 && !metric.detail?.stale).length ?? 0);
  const waitForShown = async minimum => {
    await variety.waitForFunction(count => Object.keys(JSON.parse(localStorage.getItem('diva-recommendation-exposure-v1') || '{}')).length >= count, { timeout: 20000 }, minimum);
    await new Promise(resolve => setTimeout(resolve, 500));
    return shownIds();
  };

  await variety.goto(base, { waitUntil: 'domcontentloaded' });
  await variety.waitForFunction(() => window.__DIVA_PERFORMANCE__?.getMetrics().some(metric => metric.name === 'home.load' && metric.detail?.page === 0), { timeout: 45000 });
  const firstFeed = (await feedIds()).slice(0, 24);
  const shownBeforeLogo = await waitForShown(8);
  assert(shownBeforeLogo.every(id => firstFeed.includes(id)), 'Only songs of the opened feed were recorded as shown');

  const loadsBeforeLogo = await firstPageLoads();
  await variety.evaluate(() => {
    const logo = [...document.querySelectorAll('a[aria-label^="DIVA Player"]')].find(link => link.offsetParent !== null);
    logo.click();
  });
  await variety.waitForFunction(previous => (window.__DIVA_PERFORMANCE__?.getMetrics()
    .filter(metric => metric.name === 'home.load' && metric.detail?.page === 0 && !metric.detail?.stale).length ?? 0) > previous, { timeout: 45000 }, loadsBeforeLogo);
  const logoFeed = (await feedIds()).slice(0, 24);
  assert.equal(logoFeed.length, 24, 'The logo opens a full first page');
  assert.deepEqual(logoFeed.filter(id => shownBeforeLogo.includes(id)), [], `The logo must open with songs not shown in the last five minutes: ${JSON.stringify({ shownBeforeLogo, logoFeed })}`);

  const shownBeforeReload = await waitForShown(shownBeforeLogo.length + 8);
  await variety.waitForFunction(() => new Promise(resolve => {
    const request = indexedDB.open('diva-listening-history');
    request.onsuccess = () => {
      const db = request.result;
      const names = [...db.objectStoreNames];
      db.close();
      resolve(names.length > 0);
    };
    request.onerror = () => resolve(false);
  }), { timeout: 20000 });
  await new Promise(resolve => setTimeout(resolve, 1000));
  // A full page load of Home, as a reload is (vite preview does not serve the logo's `/diva-player` without a slash).
  await variety.goto(base, { waitUntil: 'domcontentloaded' });
  await variety.waitForFunction(() => window.__DIVA_PERFORMANCE__?.getMetrics().some(metric => metric.name === 'home.first-content'), { timeout: 45000 });
  const reloadFirstContent = await variety.evaluate(() => window.__DIVA_PERFORMANCE__.getMetrics().find(metric => metric.name === 'home.first-content'));
  const reloadFeed = (await feedIds()).slice(0, 24);
  const firstShownIndex = reloadFeed.findIndex(id => shownBeforeReload.includes(id));
  const unseenAfterShown = firstShownIndex >= 0 && reloadFeed.slice(firstShownIndex).some(id => !shownBeforeReload.includes(id));
  assert(reloadFeed.length > 0 && !shownBeforeReload.includes(reloadFeed[0]), `A reload must open with a song not shown in the last five minutes: ${JSON.stringify({ reloadFeed, shownBeforeReload, reloadFirstContent })}`);
  assert(!unseenAfterShown, `Recently shown songs must only follow the unseen ones: ${JSON.stringify({ reloadFeed, shownBeforeReload })}`);
  assert.notDeepEqual(reloadFeed.slice(0, 8), logoFeed.slice(0, 8), 'A reload must change the first row');
  await context.close();
  console.log(`PASS home variety: logo ${logoFeed.length} songs none of ${shownBeforeLogo.length} recently shown, reload (${reloadFirstContent.detail?.source}) leads with unseen songs`);
} finally { await browser.close(); }
