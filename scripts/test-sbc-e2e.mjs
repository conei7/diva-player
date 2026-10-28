import puppeteer from 'puppeteer';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const PAGE_TIMEOUT_MS = 60_000;

function getBaseUrl() {
  const argumentIndex = process.argv.indexOf('--base-url');
  const provided = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.SBC_WEB_URL;
  if (!provided) {
    throw new Error('Set SBC_WEB_URL or pass --base-url http://192.168.40.79:8080/diva-player/.');
  }
  const url = new URL(provided);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createHistoryFixture() {
  return {
    kind: 'diva-player-history',
    version: 1,
    exportedAt: '2026-01-02T00:00:00.000Z',
    events: [
      { s: 1501, t: Date.UTC(2026, 0, 1, 0, 0, 0), o: 0, p: 60, d: 120, c: 1, f: 1 },
      { s: 1501, t: Date.UTC(2026, 0, 2, 0, 0, 0), o: 1, p: 10, d: 120, c: 0, f: 1 },
    ],
  };
}

async function waitForDownloadedJson(downloadDir) {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const files = (await readdir(downloadDir)).filter(name => name.endsWith('.json'));
    if (files.length > 0) return join(downloadDir, files[0]);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The history export did not create a JSON file.');
}

// The history page runs at 1280px or wider here, where its actions are in the right column
// (below 1024px they are in the header's ⋮ menu).
async function importHistory(page, filePath, expectedCount = 2) {
  const fileChooserPromise = page.waitForFileChooser();
  await page.click('[data-testid="history-actions"] [data-testid="history-backup-import"]');
  const fileChooser = await fileChooserPromise;
  await fileChooser.accept([filePath]);
  await page.waitForFunction(count =>
    document.querySelector('[data-testid="toast-host"]')?.textContent?.includes(`${count}件を追加しました`) === true,
    {}, expectedCount,
  );
}

async function inspectPage(page) {
  return page.evaluate(() => ({
    title: document.title,
    searchInput: Boolean(document.querySelector('input[placeholder="ボカロP名や曲名で検索"]')),
    cards: document.querySelectorAll('a[href*="/watch?v="]').length,
    warningVisible: [...document.querySelectorAll('[role="status"], [role="alert"]')]
      .some(element => element.textContent?.includes('いまは詳細検索を使えません')),
  }));
}

async function main() {
  const baseUrl = getBaseUrl();
  const browser = await puppeteer.launch({ headless: true, args: ['--lang=ja-JP'] });
  const page = await browser.newPage();
  const reportIndex = process.argv.indexOf('--network-report');
  const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
  if (reportIndex >= 0 && (!reportPath || reportPath.startsWith('--'))) throw new Error('--network-report requires a file path.');
  const network = [];
  const active = new Map();
  const requests = new Map();
  if (reportPath) {
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== new URL(baseUrl).origin || !url.pathname.includes('/api/')) return;
      url.searchParams.sort();
      const key = `${request.method()} ${url.href} ${createHash('sha256').update(request.postData() || '').digest('hex')}`;
      const record = { method: request.method(), url: url.href, started: Date.now(),
        duplicateInFlight: (active.get(key) || 0) > 0 };
      network.push(record); requests.set(request, { record, key });
      active.set(key, (active.get(key) || 0) + 1);
    });
    const complete = request => {
      const pending = requests.get(request);
      if (!pending) return;
      const { record, key } = pending;
      record.ms = Date.now() - record.started;
      record.status = request.response()?.status() ?? null;
      record.failure = request.failure()?.errorText ?? null;
      record.serverTiming = request.response()?.headers()['server-timing'] ?? null;
      active.set(key, active.get(key) - 1); requests.delete(request);
    };
    page.on('requestfinished', complete);
    page.on('requestfailed', complete);
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'diva-player-e2e-'));
  const failures = [];
  page.on('pageerror', error => failures.push(`page error: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') {
      const location = message.location();
      // Thumbnails of deleted videos 404 on either YouTube image host; the UI falls back to the next candidate.
      if (/^https:\/\/(?:i\.ytimg|img\.youtube)\.com\//.test(location.url ?? '') && message.text().includes('404')) return;
      const source = location.url ? ` (${location.url}:${location.lineNumber ?? 0})` : '';
      failures.push(`console error: ${message.text()}${source}`);
    }
  });

  try {
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await page.setViewport({ width: 1440, height: 900 });

    const homeResponse = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    assert(homeResponse?.ok(), `The home page returned HTTP ${homeResponse?.status() ?? 'unknown'}.`);
    try {
      await page.waitForSelector('input[placeholder="ボカロP名や曲名で検索"]');
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        text: document.body.innerText.slice(0, 500),
      }));
      throw new Error(`The global search input did not render: ${JSON.stringify(diagnostic)} (${error.message})`);
    }
    await page.waitForSelector('a[href*="/watch?v="]');
    const home = await inspectPage(page);
    assert(home.title.includes('DIVA Player'), 'The DIVA Player title was not rendered.');
    assert(home.searchInput, 'The global search input was not rendered.');
    assert(home.cards > 0, 'The home page did not render song cards.');
    assert(!home.warningVisible, 'The SBC unavailable warning is visible while the SBC API is healthy.');
    await page.waitForFunction(() => {
      const raw = localStorage.getItem('diva-recommendation-exposure-v1');
      if (!raw) return false;
      try {
        return Object.keys(JSON.parse(raw)).length > 0;
      } catch {
        return false;
      }
    });
    const exposureCount = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('diva-recommendation-exposure-v1') ?? '{}')).length);
    assert(exposureCount > 0, 'Visible recommendation cards did not record exposure history.');
    console.log(`PASS home page (${home.cards} visible song cards, ${exposureCount} exposures)`);

    const selectionContext = await browser.createBrowserContext();
    const selectionPage = await selectionContext.newPage();
    selectionPage.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await selectionPage.setViewport({ width: 1440, height: 900 });
    await selectionPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await selectionPage.waitForSelector('a[href*="/watch?v="]');
    await selectionPage.click('button[aria-label="複数選択モード"]');
    const selectedSongIds = await selectionPage.evaluate(() => {
      const selected = [];
      const seen = new Set();
      for (const link of document.querySelectorAll('a[href*="/watch?v="]')) {
        const id = Number(new URL(link.href).searchParams.get('v'));
        if (!Number.isFinite(id) || seen.has(id)) continue;
        seen.add(id);
        selected.push(id);
        link.click();
        if (selected.length === 2) break;
      }
      return selected;
    });
    assert(selectedSongIds.length === 2, 'The home page did not provide two selectable songs.');
    await selectionPage.waitForFunction(() => document.querySelector('[data-testid="selection-fab"]')?.textContent?.includes('2曲を選択中') === true);

    const addSelectedToQueue = async () => {
      const clicked = await selectionPage.evaluate(() => {
        const bar = document.querySelector('[data-testid="selection-fab"]');
        const button = [...(bar?.querySelectorAll('button') ?? [])]
          .find(element => element.textContent?.includes('キューに追加'));
        button?.click();
        return Boolean(button);
      });
      assert(clicked, 'The bulk queue action was not rendered.');
    };

    await addSelectedToQueue();
    await selectionPage.waitForFunction(expectedIds => {
      const stored = JSON.parse(localStorage.getItem('diva_playerQueue') ?? '{}');
      return JSON.stringify(stored.songIds) === JSON.stringify(expectedIds);
    }, {}, selectedSongIds);
    await selectionPage.waitForFunction(() => {
      const drawer = document.querySelector('[data-testid="queue-drawer"]');
      if (!drawer) return false;
      const rect = drawer.getBoundingClientRect();
      return rect.left < window.innerWidth && rect.right <= window.innerWidth + 1;
    });

    await addSelectedToQueue();
    const duplicatedSelection = await selectionPage.evaluate(() => JSON.parse(localStorage.getItem('diva_playerQueue') ?? '{}').songIds);
    assert(
      JSON.stringify(duplicatedSelection) === JSON.stringify([...selectedSongIds, ...selectedSongIds]),
      'Bulk queue addition did not follow the normal duplicate-preserving queue behavior.',
    );
    console.log('PASS multi-select queue addition (selected songs retained, duplicates preserved)');
    await selectionContext.close();

    await page.goto(`${baseUrl}watch?v=1501`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const raw = localStorage.getItem('diva_playerQueue');
      if (!raw) return false;
      try {
        return (JSON.parse(raw).songIds?.length ?? 0) > 1;
      } catch {
        return false;
      }
    });
    const autoplay = await page.evaluate(() => {
      const queue = JSON.parse(localStorage.getItem('diva_playerQueue') ?? '{}');
      const recommendationState = JSON.parse(localStorage.getItem('diva-queue-recommendations-v1') ?? '{}');
      return {
        queueLength: queue.songIds?.length ?? 0,
        autoCount: (queue.queueSources ?? []).filter(source => source === 'auto').length,
        reasonCount: Object.keys(recommendationState.state?.recommendations ?? {}).length,
      };
    });
    assert(autoplay.queueLength > 1, 'Autoplay did not refill the single-song queue.');
    assert(autoplay.autoCount > 0, 'Autoplay refill did not mark any queue item as auto.');
    assert(autoplay.reasonCount > 0, 'Autoplay refill did not save recommendation reasons.');
    console.log(`PASS autoplay refill (${autoplay.queueLength} queued, ${autoplay.autoCount} auto, ${autoplay.reasonCount} reasons)`);

    await page.goto(`${baseUrl}history`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('main h1');
    await page.waitForSelector('[data-testid="history-actions"] [data-testid="history-backup-import"]');
    const history = await page.evaluate(() => ({
      heading: document.querySelector('main h1')?.textContent?.trim(),
      importEnabled: document.querySelector('[data-testid="history-backup-import"]')?.hasAttribute('disabled') === false,
    }));
    assert(history.heading === '再生履歴', 'The history page heading was not rendered.');
    assert(history.importEnabled, 'The history import control is unavailable.');

    const fixturePath = join(tempDir, 'history-fixture.json');
    const downloadDir = join(tempDir, 'downloads');
    await mkdir(downloadDir);
    await writeFile(fixturePath, JSON.stringify(createHistoryFixture()), 'utf8');
    // Earlier real playback may have already finalized events. Backups must retain them too.
    const previousEvents = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('diva-listening-history');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('plays', 'readonly');
        const events = tx.objectStore('plays').getAll();
        tx.oncomplete = () => { db.close(); resolve(events.result.filter(event => event.f !== 0)); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }));
    await importHistory(page, fixturePath);
    // Backup, CSV and the statistics appear once there is history.
    await page.waitForSelector('[data-testid="history-actions"] [data-testid="history-backup-export"]:not([disabled])');
    await page.waitForSelector('[aria-label="視聴統計"]');
    console.log('PASS history controls and statistics');

    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    await page.click('[data-testid="history-actions"] [data-testid="history-backup-export"]');
    const exportedPath = await waitForDownloadedJson(downloadDir);
    const exported = JSON.parse(await readFile(exportedPath, 'utf8'));
    assert(exported.kind === 'diva-player-history', 'The exported history file has an invalid kind.');
    assert(exported.version === 1, 'The exported history file has an invalid version.');
    const fingerprint = event => [event.s, event.t, event.o ?? 0, event.p ?? '', event.d ?? '', event.c ?? 0].join(':');
    const exportedKeys = new Set(exported.events.map(fingerprint));
    for (const event of [...previousEvents, ...createHistoryFixture().events]) {
      assert(exportedKeys.has(fingerprint(event)), `Export lost a prior or imported history event: ${fingerprint(event)}`);
    }
    assert(exported.events.every(event => event.f === 1), 'The exported history contains an active event.');
    assert(exportedKeys.size === exported.events.length,
      'The exported history contains duplicate playback events.');

    const restoreContext = await browser.createBrowserContext();
    try {
      const restorePage = await restoreContext.newPage();
      restorePage.setDefaultTimeout(PAGE_TIMEOUT_MS);
      // The statistics are in the right column, which needs 1024px or more.
      await restorePage.setViewport({ width: 1280, height: 800 });
      await restorePage.goto(`${baseUrl}history`, { waitUntil: 'networkidle2' });
      await restorePage.waitForSelector('main h1');
      await importHistory(restorePage, exportedPath, exported.events.length);
      await restorePage.waitForFunction(count =>
        document.querySelector('[aria-label="視聴統計"]')?.textContent?.replace(/\s/g, '').includes(`再生開始${count}`) === true,
        {}, exported.events.length,
      );
      const restored = await restorePage.evaluate(async expectedCount => ({
        // Compare every restored event, including real playback finalized earlier in this journey.
        total: await new Promise(resolve => {
          const request = indexedDB.open('diva-listening-history');
          request.onerror = () => resolve(false);
          request.onsuccess = () => {
            const counting = request.result.transaction('plays', 'readonly').objectStore('plays').getAll();
            counting.onerror = () => resolve(false);
            counting.onsuccess = () => {
              request.result.close();
              resolve(counting.result.map(event => [event.s, event.t, event.o ?? 0, event.p ?? '', event.d ?? '', event.c ?? 0].join(':')).sort());
            };
          };
        }),
        starts: document.querySelector('[aria-label="視聴統計"]')?.textContent?.replace(/\s/g, '').includes(`再生開始${expectedCount}`),
      }), exported.events.length);
      assert(JSON.stringify(restored.total) === JSON.stringify([...exportedKeys].sort()), 'Restoring history changed or lost exported events.');
      assert(restored.starts, 'The restored history statistics were not rebuilt.');
    } finally {
      await restoreContext.close();
    }
    console.log(`PASS history backup export/import round trip (${previousEvents.length} prior events, ${exported.events.length} exported and exactly restored)`);

    if (failures.length > 0) throw new Error(failures.join('\n'));
    console.log('SBC browser E2E test passed.');
  } finally {
    await browser.close();
    if (reportPath) {
      const summary = {};
      for (const request of network) {
        const key = request.method + ' ' + new URL(request.url).pathname;
        const group = summary[key] ??= { count: 0, completed: 0, duplicateInFlight: 0, failed: 0, unfinished: 0, maxMs: 0 };
        group.count++;
        if (Number.isFinite(request.ms) && request.status >= 200 && request.status < 400 && !request.failure) group.completed++;
        if (request.duplicateInFlight) group.duplicateInFlight++;
        if (!Number.isFinite(request.ms)) group.unfinished++;
        if (request.failure || request.status >= 400) group.failed++;
        group.maxMs = Math.max(group.maxMs, request.ms ?? 0);
      }
      await writeFile(reportPath, JSON.stringify({ baseUrl, checkedAt: new Date().toISOString(), summary, requests: network }, null, 2), 'utf8');
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`SBC browser E2E test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
