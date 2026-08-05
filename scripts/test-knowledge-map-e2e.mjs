import puppeteer from 'puppeteer';

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:4173/diva-player/');
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
let submittedKnownSongIds = null;

const fixture = {
  generatedAt: '2026-08-05T00:00:00Z',
  historySongCount: 2,
  matchedHistorySongCount: 2,
  eligibleSongCount: 1_000,
  youtube: {
    platform: 'youtube',
    totalViews: 1_000,
    knownViews: 550,
    coverageRatio: 0.55,
    totalSongCount: 900,
    knownSongCount: 2,
    knownRemainderViews: 0,
    unknownRemainderViews: 450,
    tiles: [
      { songId: 1501, name: 'Known YouTube Song', artistString: 'DIVA P', views: 250, known: true },
      { songId: 1502, name: 'Rated YouTube Song', artistString: 'DIVA Q', views: 300, known: true },
    ],
  },
  nico: {
    platform: 'nico',
    totalViews: 200,
    knownViews: 100,
    coverageRatio: 0.5,
    totalSongCount: 700,
    knownSongCount: 1,
    knownRemainderViews: 0,
    unknownRemainderViews: 40,
    tiles: [
      { songId: 1501, name: 'Known Nico Song', artistString: 'DIVA P', views: 100, known: true },
      { songId: 1503, name: 'Unknown Nico Song', artistString: 'DIVA R', views: 60, known: false },
    ],
  },
};

function jsonResponse(body) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  };
}

async function seedHistory(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('diva-listening-history', 3);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('plays', 'readwrite');
      transaction.objectStore('plays').add({ s: 1501, t: Date.now(), f: 1 });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    };
  }));
}

async function seedRatings(page) {
  await page.evaluate(() => {
    localStorage.setItem('diva-ratings', JSON.stringify({
      state: { ratings: { 1501: 5, 1502: 1, 1504: 0 } },
      version: 0,
    }));
  });
}

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.includes('/backend-api/')) {
      void request.continue();
      return;
    }
    if (url.pathname.endsWith('/api/discovery/knowledge-map')) {
      submittedKnownSongIds = JSON.parse(request.postData() || '{}').knownSongIds ?? null;
      void request.respond(jsonResponse(fixture));
      return;
    }
    if (url.pathname.endsWith('/api/ready') || url.pathname.endsWith('/api/health')) {
      void request.respond(jsonResponse({ status: 'ready', postgres: true, qdrant: true }));
      return;
    }
    void request.respond({ status: 404, headers: { 'content-type': 'application/json' }, body: '{}' });
  });

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="ボカロP名や曲名で検索"]');
  await seedHistory(page);
  await seedRatings(page);
  await page.goto(new URL('knowledge-map', baseUrl), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="youtube-knowledge-treemap"]');
  if (!Array.isArray(submittedKnownSongIds)
    || !submittedKnownSongIds.includes(1501)
    || !submittedKnownSongIds.includes(1502)
    || submittedKnownSongIds.includes(1504)
    || submittedKnownSongIds.filter(id => id === 1501).length !== 1) {
    throw new Error(`Knowledge map did not submit the distinct local history/rating ids: ${JSON.stringify(submittedKnownSongIds)}`);
  }
  const youtubeText = await page.$eval('[data-testid="knowledge-map-page"]', element => element.textContent ?? '');
  if (!youtubeText.includes('55.0%') || !youtubeText.includes('Known YouTube Song') || !youtubeText.includes('Rated YouTube Song')) {
    throw new Error('YouTube knowledge map summary or tiles are missing.');
  }

  const buttons = await page.$$('button');
  for (const button of buttons) {
    const text = await button.evaluate(element => element.textContent?.trim());
    if (text === 'ニコニコ') {
      await button.click();
      break;
    }
  }
  await page.waitForSelector('[data-testid="nico-knowledge-treemap"]');
  const nicoText = await page.$eval('[data-testid="knowledge-map-page"]', element => element.textContent ?? '');
  if (!nicoText.includes('50.0%') || !nicoText.includes('Known Nico Song')) {
    throw new Error('NicoNico knowledge map summary or tiles are missing.');
  }

  await page.setViewport({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="youtube-knowledge-treemap"]');
  const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  if (width.document > width.viewport + 1 || width.body > width.viewport + 1) {
    throw new Error(`Knowledge map has horizontal overflow: ${JSON.stringify(width)}`);
  }
  console.log('PASS YouTube/NicoNico knowledge map, local history/rating join, and 390px layout');
} finally {
  await browser.close();
}
