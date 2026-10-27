import { installSavedLibraryReader } from './saved-library-fixture.mjs';
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4177/diva-player/';
const screenshotDir = process.env.DIVA_PLAYLIST_SCREENSHOTS;
const song = {
  id: 903001, name: '読み込み確認用の曲', defaultName: '読み込み確認用の曲', defaultNameLanguage: 'Japanese', artistString: '確認用プロデューサー',
  createDate: '2026-01-01T00:00:00Z', publishDate: '2024-01-01T00:00:00Z', favoritedTimes: 100, lengthSeconds: 180,
  youtubeViews: 100000, nicoViews: 100000, audioComputed: true, songType: 'Original', status: 'Finished', version: 1,
  artists: [{ categories: ['Vocalist'], artist: { id: 1, name: '初音ミク', artistType: 'Vocaloid' } }],
  pvs: [{ id: 100, pvId: 'sm12345', service: 'NicoNicoDouga', disabled: false, pvType: 'Original' }, { id: 101, pvId: 'fixture', service: 'Youtube', disabled: false, pvType: 'Original' }],
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
/** Clicks the button (or menu item) whose text or aria-label is exactly `text`. */
async function clickText(page, text) {
  const find = value => [...document.querySelectorAll('button, [role="menuitem"]')]
    .find(button => button.textContent?.trim() === value || button.getAttribute('aria-label') === value);
  await page.waitForFunction(find, {}, text);
  await page.evaluate(value => {
    const button = [...document.querySelectorAll('button, [role="menuitem"]')]
      .find(item => item.textContent?.trim() === value || item.getAttribute('aria-label') === value);
    button?.click();
  }, text);
}
async function screenshot(page, name) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: false });
}
async function fixtures(page) {
  await pinAppLanguage(page);
  await installSavedLibraryReader(page);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('diva_playlists', '[]'); localStorage.setItem('diva_playlistFolders', '[]');
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.includes('/api/nico/playlists/')) {
      const id = url.pathname.split('/').at(-2);
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ sourceKind: url.pathname.includes('/series/') ? 'series' : 'mylist', sourceId: id,
        title: id === '12345' ? 'ニコニコから保存したリスト' : '変更後のシリーズ', videoCount: 2, matchedCount: 1,
        unmatchedVideoIds: ['sm99999'], songs: [song], sourceFetchedAt: new Date().toISOString(), stale: false, truncated: false }) });
    } else if (url.pathname.includes('/api/songs/search')) {
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [song], totalCount: 1 }) });
    } else if (url.pathname.includes('/api/ready') || url.pathname.includes('/api/health')) {
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ready' }) });
    } else if (url.hostname === 'vocadb.net') {
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], totalCount: 0 }) });
    } else void request.continue();
  });
}
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });
try {
  for (const width of [1440, 1024, 390]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await fixtures(page);
    await page.goto(new URL('playlists', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[data-testid="playlist-library"]');
    if (width < 1280) {
      // The bottom spacing belongs to <main> (mini player + phone navigation), not to the page.
      const layout = await page.evaluate(() => {
        // A bar fixed to the bottom of the viewport (the phone navigation) needs its own space.
        const bar = [...document.querySelectorAll('nav')].find(item => {
          const box = item.getBoundingClientRect();
          return getComputedStyle(item).position === 'fixed' && box.height > 0 && box.bottom >= innerHeight - 1 && box.top > innerHeight / 2;
        });
        return {
          padding: parseFloat(getComputedStyle(document.querySelector('main')).paddingBottom),
          bottomBar: bar ? bar.getBoundingClientRect().height : 0,
          overflow: getComputedStyle(document.querySelector('[data-testid="playlist-library"]')).overflowY,
          nestedAside: Boolean(document.querySelector('main aside')),
        };
      });
      assert(layout.padding <= layout.bottomBar + 24 && layout.overflow === 'visible' && !layout.nestedAside, `empty library wastes mobile viewport: ${JSON.stringify(layout)}`);
    }
    await screenshot(page, `library-${width}`);
    await clickText(page, '新規作成');
    await page.waitForSelector('[role="menu"]');
    const menuBounds = await page.$eval('[role="menu"]', element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
    assert(menuBounds.left >= 0 && menuBounds.right <= width && menuBounds.top >= 0 && menuBounds.bottom <= 900, `menu clipped at ${width}: ${JSON.stringify(menuBounds)}`);
    await clickText(page, 'URLからインポート');
    await page.waitForSelector('[role="dialog"] #playlist-import-url');
    await page.type('#playlist-import-url', 'https://www.nicovideo.jp/mylist/12345');
    await clickText(page, '読み込む');
    await page.waitForFunction(() => document.body.textContent.includes('2本中 1曲が見つかりました'));
    await screenshot(page, `nico-import-${width}`);
    // Changing the URL must invalidate the old result before it can be saved.
    await page.focus('#playlist-import-url'); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.type('#playlist-import-url', 'https://www.nicovideo.jp/series/54321');
    assert(await page.$eval('[data-testid="playlist-import-save"]', button => button.disabled), 'old URL result remained saveable');
    await clickText(page, '読み込む');
    await page.waitForFunction(() => document.body.textContent.includes('変更後のシリーズ'));
    await page.waitForFunction(() => document.querySelector('[data-testid="playlist-import-save"]')?.disabled === false);
    await page.click('[data-testid="playlist-import-save"]');
    await page.waitForFunction(() => document.querySelector('main section h1')?.textContent === '変更後のシリーズ');
    const imported = await page.evaluate(async () => (await window.__readSavedPlaylists()));
    assert(imported.some(item => item.name === '変更後のシリーズ' && item.songs[0]?.id === song.id && !item.nicoSync), 'one-time import without target did not persist');
    await page.waitForSelector('[data-testid="toast-host"] > div:not([aria-hidden])');
    const toastPlacement = await page.evaluate(() => {
      const rect = document.querySelector('[data-testid="toast-host"]').getBoundingClientRect();
      const guideOffset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--guide-offset'));
      return { left: rect.left, right: rect.right, guideOffset };
    });
    assert(toastPlacement.left >= toastPlacement.guideOffset && toastPlacement.right <= width,
      `Toast covers the guide or leaves the viewport at ${width}: ${JSON.stringify(toastPlacement)}`);
    await screenshot(page, `detail-${width}`);
    if (width === 390) {
      await clickText(page, 'すべて再生');
      await page.waitForSelector('.global-mini-player', { visible: true });
      await page.waitForFunction(() => {
        const player = document.querySelector('.global-mini-player');
        return player && parseFloat(getComputedStyle(document.querySelector('main')).paddingBottom) >= player.getBoundingClientRect().height + 16;
      });
    }
    // Back to the library: the phone layout has its own back button, wider screens use the browser's Back.
    if (width < 640) await page.click('main button[aria-label="プレイリスト一覧に戻る"]');
    else await page.goBack();
    await page.waitForSelector('[data-testid="playlist-library"]');
    await clickText(page, '新規作成');
    await clickText(page, 'スマートプレイリスト');
    // Wide dialogs show 「1曲が一致 · 上位1曲を保存」; phones show 「1曲が一致」 in the footer.
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('1曲が一致'));
    await page.locator('input[placeholder="2020"]').fill('2025');
    await page.locator('input[placeholder="2026"]').fill('2020');
    await page.waitForFunction(() => document.body.textContent.includes('公開年の範囲が正しくありません'));
    assert(await page.$eval('[data-testid="smart-playlist-submit"]', button => button.disabled), 'invalid range can be saved');
    await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent?.includes('ニコニコ中心'))?.click());
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('1曲が一致'));
    const preset = await page.evaluate(() => ({ year: document.querySelector('input[placeholder="2020"]').value, yt: document.querySelector('input[type="number"]').value }));
    // A minimum of 0 views shows as an empty field (placeholder 「指定なし」).
    assert(preset.year === '' && (preset.yt === '' || preset.yt === '0'), `preset retained prior conditions: ${JSON.stringify(preset)}`);
    await screenshot(page, `smart-${width}`);
    await page.waitForFunction(() => document.querySelector('[data-testid="smart-playlist-submit"]')?.disabled === false);
    await page.click('[data-testid="smart-playlist-submit"]');
    await page.waitForFunction(async () => (await window.__readSavedPlaylists()).some(item => item.smartRule?.pvService === 'niconico' && item.songs.length === 1));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow at ${width}`);
    assert(errors.length === 0, `page errors at ${width}: ${errors.join('; ')}`);
    console.log(`PASS ${width}px: library import, source invalidation, saving, smart preset reset, invalid range, preview and persistence`);
    await context.close();
  }
} finally { await browser.close(); }
