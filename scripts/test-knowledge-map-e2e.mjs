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
  try {
    await page.evaluate(() => new Promise((resolve, reject) => {
      const timeoutMs = 15_000;
      let database = null;
      let transaction = null;
      let settled = false;

      const errorMessage = error => error instanceof Error
        ? error.message
        : String(error ?? 'unknown IndexedDB error');
      const finish = (error = null, abort = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (abort && transaction) {
          try {
            transaction.abort();
          } catch {
            // The transaction may already have aborted because of the write error.
          }
        }
        database?.close();
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        finish(new Error(`Timed out after ${timeoutMs} ms while seeding diva-listening-history`), true);
      }, timeoutMs);

      let request;
      try {
        request = indexedDB.open('diva-listening-history', 3);
      } catch (error) {
        finish(new Error(`Could not open diva-listening-history: ${errorMessage(error)}`));
        return;
      }

      request.onblocked = () => {
        finish(new Error('Opening diva-listening-history was blocked by another connection'));
      };
      request.onerror = () => {
        finish(new Error(`Could not open diva-listening-history: ${errorMessage(request.error)}`));
      };
      request.onupgradeneeded = () => {
        try {
          const db = request.result;
          const plays = db.objectStoreNames.contains('plays')
            ? request.transaction.objectStore('plays')
            : db.createObjectStore('plays', { keyPath: 'id', autoIncrement: true });
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
            if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath });
          }
        } catch (error) {
          try {
            request.transaction?.abort();
          } catch {
            // Preserve the schema error below if the upgrade already aborted.
          }
          finish(new Error(`Could not create diva-listening-history v3 schema: ${errorMessage(error)}`));
        }
      };
      request.onsuccess = () => {
        database = request.result;
        try {
          transaction = database.transaction('plays', 'readwrite');
          transaction.oncomplete = () => finish();
          transaction.onerror = () => {
            finish(new Error(`Could not write knowledge-map history fixture: ${errorMessage(transaction.error)}`));
          };
          transaction.onabort = () => {
            finish(new Error(`Knowledge-map history fixture transaction aborted: ${errorMessage(transaction.error)}`));
          };
          const addRequest = transaction.objectStore('plays').add({ s: 1501, t: Date.now(), f: 1 });
          addRequest.onerror = () => {
            finish(new Error(`Could not add knowledge-map history fixture: ${errorMessage(addRequest.error)}`), true);
          };
        } catch (error) {
          finish(new Error(`Could not start knowledge-map history fixture transaction: ${errorMessage(error)}`), true);
        }
      };
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Knowledge-map IndexedDB seed failed: ${message}`, { cause: error });
  }
}

async function seedRatings(page) {
  await page.evaluate(() => {
    localStorage.setItem('diva-ratings', JSON.stringify({
      state: { ratings: { 1501: 5, 1502: 1, 1504: 0 } },
      version: 0,
    }));
  });
}

async function clickButtonByText(page, label) {
  const buttons = await page.$$('button');
  for (const button of buttons) {
    const text = await button.evaluate(element => element.textContent?.trim());
    if (text === label) {
      await button.click();
      return;
    }
  }
  throw new Error(`Button not found: ${label}`);
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

  await clickButtonByText(page, '知っている曲');
  const knownMapText = await page.$eval('[data-testid="youtube-knowledge-treemap"]', element => element.textContent ?? '');
  if (!knownMapText.includes('Known YouTube Song') || !knownMapText.includes('Rated YouTube Song') || knownMapText.includes('その他の未再生曲')) {
    throw new Error(`Known-song filter returned unexpected tiles: ${knownMapText}`);
  }
  const knownSongTile = await page.$('[data-testid="youtube-knowledge-treemap"] a[aria-label*="Known YouTube Song"]');
  if (!knownSongTile) throw new Error('Known-song filter did not render the expected linked song tile.');
  await knownSongTile.hover();
  await page.waitForSelector('[data-testid="knowledge-map-tooltip"]');
  const tooltipText = await page.$eval('[data-testid="knowledge-map-tooltip"]', element => element.textContent ?? '');
  if (!tooltipText.includes('Known YouTube Song') || !tooltipText.includes('知っている')) {
    throw new Error(`Knowledge map tooltip is missing song details: ${tooltipText}`);
  }

  await clickButtonByText(page, 'まだ知らない曲');
  const unknownMapText = await page.$eval('[data-testid="youtube-knowledge-treemap"]', element => element.textContent ?? '');
  if (!unknownMapText.includes('その他の未再生曲') || unknownMapText.includes('Known YouTube Song')) {
    throw new Error(`Unknown-song filter returned unexpected tiles: ${unknownMapText}`);
  }
  await clickButtonByText(page, '全体');

  await clickButtonByText(page, 'ニコニコ');
  await page.waitForSelector('[data-testid="nico-knowledge-treemap"]');
  const nicoText = await page.$eval('[data-testid="knowledge-map-page"]', element => element.textContent ?? '');
  if (!nicoText.includes('50.0%') || !nicoText.includes('Known Nico Song')) {
    throw new Error('NicoNico knowledge map summary or tiles are missing.');
  }

  await page.setViewport({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="youtube-knowledge-treemap"]');
  await clickButtonByText(page, 'まだ知らない曲');
  const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  if (width.document > width.viewport + 1 || width.body > width.viewport + 1) {
    throw new Error(`Knowledge map has horizontal overflow: ${JSON.stringify(width)}`);
  }
  const mobileLayout = await page.evaluate(() => {
    const viewport = innerWidth;
    const rankings = [...document.querySelectorAll('[data-testid="knowledge-map-ranking"]')].map(element => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      };
    });
    const platformGroup = document.querySelector('[role="group"][aria-label="再生数のサービス"]')?.getBoundingClientRect();
    return {
      viewport,
      rankings,
      platformWidth: platformGroup?.width ?? 0,
    };
  });
  if (mobileLayout.rankings.length !== 2
    || mobileLayout.rankings.some(ranking => ranking.left < 0
      || ranking.right > mobileLayout.viewport + 1
      || ranking.scrollWidth > ranking.clientWidth + 1)) {
    throw new Error(`Knowledge map rankings are clipped on mobile: ${JSON.stringify(mobileLayout)}`);
  }
  if (mobileLayout.platformWidth < mobileLayout.viewport - 40) {
    throw new Error(`Knowledge map platform switch is too narrow on mobile: ${JSON.stringify(mobileLayout)}`);
  }
  console.log('PASS YouTube/NicoNico knowledge map, known/unknown filtering, tooltip, local history/rating join, and 390px layout');
} finally {
  await browser.close();
}
