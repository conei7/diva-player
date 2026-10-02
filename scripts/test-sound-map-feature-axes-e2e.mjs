import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:5173/diva-player/');
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setRequestInterception(true);
  let requests = 0;
  let legacyApi = false;
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.endsWith('/api/discovery/sound-map')) { void request.continue(); return; }
    requests++;
    const x = Number(url.searchParams.get('axisX'));
    const y = Number(url.searchParams.get('axisY'));
    const features = url.searchParams.has('axisX') && !legacyApi;
    const items = Array.from({ length: 21 }, (_, index) => ({
      songId: 7 + index, name: `試験曲 ${7 + index}`, artistString: 'Test artist',
      x: (index - 10) / 10, y: ((index * ((x + y) % 7 + 1)) % 21 - 10) / 10,
      featureX: index / 100, featureY: (20 - index) / 100, similarity: index ? .9 : null,
    }));
    void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
      mapVersion: 'test-v1', generatedAt: '2026-10-02T00:00:00Z', method: features ? 'feature_axes' : 'pca',
      coordinateCount: 66718, state: 'ready', origin: items[0], items,
      axes: features ? { x, y, dimensionCount: 1024, minX: 0, maxX: .2, minY: 0, maxY: .2 } : null,
    }) });
  });
  await page.goto(new URL('sound-map?seedSongId=7', baseUrl), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => new URL(location.href).searchParams.get('layout') === 'features');
  await page.waitForSelector('[data-testid="sound-map-canvas"] g[role="button"]');
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === '軸を適用')?.disabled);
  async function button(label) {
    for (const handle of await page.$$('button')) if ((await handle.evaluate(node => node.textContent?.trim())) === label) return handle;
    throw new Error(`Missing button: ${label}`);
  }
  async function fill(label, value) {
    const handle = await page.$(`input[aria-label="${label}"]`);
    await handle.focus();
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
    await page.keyboard.type(String(value));
  }
  await fill('Xの特徴番号', 1); await fill('Yの特徴番号', 1024);
  await (await button('軸を適用')).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('axisY') === '1023');
  await page.waitForFunction(() => document.querySelector('[data-testid="sound-map-axis-y"]')?.getAttribute('data-feature-index') === '1023');
  assert.equal(new URL(page.url()).searchParams.get('axisX'), '0');
  assert.equal(new URL(page.url()).searchParams.get('axisY'), '1023');
  const beforeSelection = requests;
  await page.click('[data-song-id="9"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="sound-map-selected-title"]')?.textContent === '試験曲 9');
  assert.equal(requests, beforeSelection, 'Selecting a point must not re-fetch vectors');
  await (await button('XとYを入れ替え')).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('axisX') === '1023');
  assert.equal(new URL(page.url()).searchParams.get('axisY'), '0');
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'ランダムな軸')?.disabled);
  await (await button('ランダムな軸')).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('axisX') !== '1023' || new URL(location.href).searchParams.get('axisY') !== '0');
  const selectedAxes = [new URL(page.url()).searchParams.get('axisX'), new URL(page.url()).searchParams.get('axisY')];
  assert.notEqual(selectedAxes[0], selectedAxes[1]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sound-map-canvas"] g[role="button"]');
  assert.deepEqual([new URL(page.url()).searchParams.get('axisX'), new URL(page.url()).searchParams.get('axisY')], selectedAxes);
  await page.select('select[aria-label="配置方法"]', 'pca');
  await page.waitForFunction(() => !document.querySelector('[data-testid="sound-map-page"]')?.textContent.includes('X · 特徴'));
  assert.equal(new URL(page.url()).searchParams.get('layout'), 'pca');
  await page.select('select[aria-label="配置方法"]', 'features');
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === '軸を適用')?.disabled);
  await fill('Xの特徴番号', 17); await fill('Yの特徴番号', 17);
  await (await button('軸を適用')).click();
  assert.equal(await page.$eval('input[name="axisY"]', element => element.validity.valid), false);
  await fill('Xの特徴番号', 18);
  await (await button('軸を適用')).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('axisX') === '17');
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  legacyApi = true;
  await page.goto(new URL('sound-map?seedSongId=7', baseUrl), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => new URL(location.href).searchParams.get('layout') === 'pca');
  await page.waitForSelector('[data-testid="sound-map-canvas"] g[role="button"]');
  assert.equal(await page.$('[data-testid="sound-map-axis-x"]'), null, 'Legacy PCA must not be labelled as feature axes');
  console.log('Feature axes E2E passed: bounds, selection, swap, random, reload, PCA, validation, mobile.');
} finally { await browser.close(); }
