import puppeteer from 'puppeteer';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

async function importHistory(page, filePath) {
  const fileChooserPromise = page.waitForFileChooser();
  await page.click('button[title="履歴バックアップを追加"]');
  const fileChooser = await fileChooserPromise;
  await fileChooser.accept([filePath]);
  await page.waitForFunction(() =>
    document.querySelector('[role="status"]')?.textContent?.includes('2 件を追加しました。') === true,
  );
}

async function inspectPage(page) {
  return page.evaluate(() => ({
    title: document.title,
    searchInput: Boolean(document.querySelector('input[placeholder="ボカロP名や曲名で検索"]')),
    cards: document.querySelectorAll('h3').length,
    warningVisible: [...document.querySelectorAll('[role="status"]')]
      .some(element => element.textContent?.includes('SBCのデータサービスに接続できません')),
  }));
}

async function main() {
  const baseUrl = getBaseUrl();
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const tempDir = await mkdtemp(join(tmpdir(), 'diva-player-e2e-'));
  const failures = [];
  page.on('pageerror', error => failures.push(`page error: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') failures.push(`console error: ${message.text()}`);
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
    await page.waitForSelector('h3');
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
    await page.waitForSelector('h1');
    const history = await page.evaluate(() => ({
      heading: document.querySelector('h1')?.textContent?.trim(),
      exportEnabled: !document.querySelector('button[title="履歴をJSONで保存"]')?.hasAttribute('disabled'),
      importEnabled: !document.querySelector('button[title="履歴バックアップを追加"]')?.hasAttribute('disabled'),
      statsVisible: Boolean(document.querySelector('[aria-label="視聴統計"]')),
    }));
    assert(history.heading === '視聴履歴', 'The history page heading was not rendered.');
    assert(history.exportEnabled, 'The history export control is unavailable.');
    assert(history.importEnabled, 'The history import control is unavailable.');
    assert(history.statsVisible, 'The history statistics region was not rendered.');
    console.log('PASS history controls and statistics');

    const fixturePath = join(tempDir, 'history-fixture.json');
    const downloadDir = join(tempDir, 'downloads');
    await mkdir(downloadDir);
    await writeFile(fixturePath, JSON.stringify(createHistoryFixture()), 'utf8');
    await importHistory(page, fixturePath);

    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    await page.click('button[title="履歴をJSONで保存"]');
    const exportedPath = await waitForDownloadedJson(downloadDir);
    const exported = JSON.parse(await readFile(exportedPath, 'utf8'));
    assert(exported.kind === 'diva-player-history', 'The exported history file has an invalid kind.');
    assert(exported.version === 1, 'The exported history file has an invalid version.');
    assert(exported.events.length === 2, 'The exported history file does not contain the imported events.');

    const restoreContext = await browser.createBrowserContext();
    try {
      const restorePage = await restoreContext.newPage();
      restorePage.setDefaultTimeout(PAGE_TIMEOUT_MS);
      await restorePage.goto(`${baseUrl}history`, { waitUntil: 'networkidle2' });
      await restorePage.waitForSelector('h1');
      await importHistory(restorePage, exportedPath);
      await restorePage.waitForFunction(() =>
        document.querySelector('[aria-label="視聴統計"]')?.textContent?.replace(/\s/g, '').includes('開始回数2') === true,
      );
      const restored = await restorePage.evaluate(() => ({
        total: document.querySelector('main')?.textContent?.includes('2 件'),
        starts: document.querySelector('[aria-label="視聴統計"]')?.textContent?.replace(/\s/g, '').includes('開始回数2'),
      }));
      assert(restored.total, 'The restored history count is not 2.');
      assert(restored.starts, 'The restored history statistics were not rebuilt.');
    } finally {
      await restoreContext.close();
    }
    console.log('PASS history backup export/import round trip');

    if (failures.length > 0) throw new Error(failures.join('\n'));
    console.log('SBC browser E2E test passed.');
  } finally {
    await browser.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`SBC browser E2E test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
