import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:5173/diva-player/');
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    // Keep the Japanese selectors stable on CI browsers with an English locale.
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    localStorage.setItem('diva_uiLanguage', JSON.stringify('ja'));
  });
  await page.setViewport({ width: 1280, height: 900 });
  await page.setRequestInterception(true);
  let requests = 0;
  let legacyApi = false;
  let groupRequests = 0;
  let groupFailure = false;
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/api/discovery/sound-map/group')) {
      groupRequests++;
      if (groupRequests === 1) { void request.respond({ status: 202, contentType: 'application/json', body: '{"state":"preparing"}' }); return; }
      if (groupFailure) { void request.respond({ status: 422, contentType: 'application/json', body: '{"error":"group_songs_unavailable","songIds":[9]}' }); return; }
      const ids = url.searchParams.get('songIds').split(',').map(Number);
      const items = Array.from({ length: 896 }, (_, i) => ({ songId: 7 + i, name: `試験曲 ${7 + i}`, artistString: 'Test artist',
        x: i < 40 ? (i % 8 - 4) / 8 : (i * 17 % 61) / 61 - .5,
        y: i < 40 ? (Math.floor(i / 8) - 2) / 8 : (i * 13 % 67) / 67 - .5, similarity: null }));
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
        mapVersion: 'test-v1', generatedAt: '2026-10-30T00:00:00Z', method: 'group_feature_axes', state: 'ready', coordinateCount: 68000, matchingCount: 68000,
        origin: items[0], items, groupSongIds: ids, axes: { x: 17, y: 822, dimensionCount: 1024, minX: -1, maxX: 1, minY: -1, maxY: 1 },
        initialViewport: { centerX: 0, centerY: 0, zoom: 2 },
      }) }); return;
    }
    if (url.pathname.endsWith('/api/songs/search')) {
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [8, 9].map(id => ({ id, name: `試験曲 ${id}`, defaultName: `試験曲 ${id}`, artistString: 'Test artist', songType: 'Original', artists: [], pvs: [] })), totalCount: 2 }) }); return;
    }
    // Point selection must not race live metadata replacing the fixture name.
    // Keep both the map and its card hydration at the same network boundary.
    if (/\/api\/songs\/(?:batch|details|\d+)$/.test(url.pathname)) {
      const song = id => ({ id, name: `試験曲 ${id}`, defaultName: `試験曲 ${id}`, artistString: 'Test artist', songType: 'Original', artists: [], pvs: [] });
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);
      const body = /\/\d+$/.test(url.pathname)
        ? song(Number(url.pathname.split('/').at(-1)))
        : { items: ids.map(song) };
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      return;
    }
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
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '軸を適用' && !button.disabled));
  async function button(label) {
    for (const handle of await page.$$('button')) if ((await handle.evaluate(node => node.textContent?.trim())) === label) return handle;
    throw new Error(`Missing button: ${label}`);
  }
  async function fill(label, value) {
    const handle = await page.waitForSelector(`input[aria-label="${label}"]`);
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
  await page.waitForFunction(() => document.querySelector('[data-testid="sound-map-axis-x"]')?.getAttribute('data-feature-index') === '1023' && document.querySelector('[data-testid="sound-map-axis-y"]')?.getAttribute('data-feature-index') === '0');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '軸をランダムに選ぶ' && !button.disabled));
  await (await button('軸をランダムに選ぶ')).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('axisX') !== '1023' || new URL(location.href).searchParams.get('axisY') !== '0');
  const selectedAxes = [new URL(page.url()).searchParams.get('axisX'), new URL(page.url()).searchParams.get('axisY')];
  assert.notEqual(selectedAxes[0], selectedAxes[1]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sound-map-canvas"] g[role="button"]');
  assert.deepEqual([new URL(page.url()).searchParams.get('axisX'), new URL(page.url()).searchParams.get('axisY')], selectedAxes);
  await page.click('[data-testid="sound-map-layout"] [data-layout="pca"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="sound-map-page"]')?.textContent.includes('X · 特徴'));
  assert.equal(new URL(page.url()).searchParams.get('layout'), 'pca');
  await page.click('[data-testid="sound-map-layout"] [data-layout="features"]');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '軸を適用' && !button.disabled));
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
  await page.setViewport({ width: 1440, height: 1000 });
  await page.click('[data-layout="group"]');
  assert.equal(await (await button('マップを作る')).evaluate(el => el.disabled), true);
  const input = 'input[aria-label="マップに追加する曲を検索"]';
  for (const id of [8, 9]) {
    await page.type(input, '試験');
    await page.waitForFunction(id => [...document.querySelectorAll('button')].some(b => b.textContent?.includes(`試験曲 ${id}`) && b.textContent?.includes('Test artist')), {}, id);
    const handle = await page.evaluateHandle(id => [...document.querySelectorAll('button')].find(b => b.textContent?.includes(`試験曲 ${id}`) && b.textContent?.includes('Test artist')), id);
    await handle.asElement().click(); await handle.dispose();
  }
  assert.equal(await page.$$eval('[data-testid="sound-map-group-songs"] button[aria-label]', els => els.length), 3);
  await (await button('マップを作る')).click();
  await page.waitForSelector('[data-testid="sound-map-canvas"] g[data-origin="true"]');
  assert.equal(groupRequests, 2, 'Cold catalogue polls 202 and stops on readiness');
  assert.equal(await page.$$eval('g[data-origin="true"]', els => els.length), 3);
  assert.equal(await page.$$eval('[data-testid="sound-map-canvas"] g[role="button"]', els => els.length), 896);
  assert.equal(await page.$eval('[data-testid="sound-map-axis-x"]', el => el.dataset.featureIndex), '17');
  assert.equal(await page.$eval('[data-testid="sound-map-axis-y"]', el => el.dataset.featureIndex), '822');
  await page.click('g[data-song-id="18"]');
  await (await button('選択した曲を追加')).click();
  assert.equal(new URL(page.url()).searchParams.get('songIds'), '7,8,9', 'Editing the group does not silently recalculate');
  await (await button('マップを作る')).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('songIds') === '7,8,9,18');
  await page.waitForSelector('[data-testid="sound-map-canvas"]');
  await page.click('button[aria-label="拡大"]');
  await page.waitForFunction(() => Number(new URL(location.href).searchParams.get('zoom')) > 2);
  await page.waitForFunction(() => !document.querySelector('[data-testid="sound-map-canvas"] [role="status"]'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sound-map-canvas"]');
  assert.equal(await page.$$eval('g[data-origin="true"]', els => els.length), 4);
  const canvas = await page.$('[data-testid="sound-map-canvas"] svg');
  const bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 55, bounds.y + bounds.height / 2 + 20, { steps: 6 }); await page.mouse.up();
  await page.waitForFunction(() => Number(new URL(location.href).searchParams.get('centerX')) !== 0);
  if (process.env.DIVA_GROUP_MAP_SCREENSHOTS) await page.screenshot({ path: `${process.env.DIVA_GROUP_MAP_SCREENSHOTS}-desktop.png`, fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile group controls do not overflow');
  assert.equal(await page.$eval('[data-testid="sound-map-canvas"] svg', el => el.style.touchAction), 'none');
  const beforePan = new URL(page.url()).searchParams.get('centerX');
  const mobileBounds = await canvas.boundingBox();
  const cdp = await page.createCDPSession();
  const touch = { x: mobileBounds.x + mobileBounds.width / 2, y: mobileBounds.y + mobileBounds.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touch.x + 30, y: touch.y + 20 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(previous => new URL(location.href).searchParams.get('centerX') !== previous, {}, beforePan);
  await cdp.detach(); await canvas.dispose();
  if (process.env.DIVA_GROUP_MAP_SCREENSHOTS) await page.screenshot({ path: `${process.env.DIVA_GROUP_MAP_SCREENSHOTS}-mobile.png`, fullPage: true });
  groupFailure = true;
  await page.goto(new URL('sound-map?layout=group&songIds=7,8,9', baseUrl), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.textContent.includes('マップで使えない曲があります: 9'));
  groupFailure = false;
  await (await button('再試行')).click();
  await page.waitForSelector('[data-testid="sound-map-canvas"]');
  assert.deepEqual(pageErrors, []);
  console.log('Feature/group axes E2E passed: single-map regression, group search/edit, 202 polling, 3/4 origins, selected-song add, axes, zoom, reload, mobile, unavailable songs and retry.');
} finally { await browser.close(); }
