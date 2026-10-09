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
async function clickText(page, text) {
  await page.waitForFunction(value => [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === value || button.textContent?.replace(/↓$/, '').trim() === value), {}, text);
  await page.evaluate(value => [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === value || button.textContent?.replace(/↓$/, '').trim() === value)?.click(), text);
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
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await fixtures(page);
    await page.goto(new URL('playlists', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('aside[aria-label="プレイリストライブラリ"]');
    if (width < 1280) {
      const layout = await page.evaluate(() => ({
        padding: parseFloat(getComputedStyle(document.querySelector('.playlist-page')).paddingBottom),
        overflow: getComputedStyle(document.querySelector('[data-testid="playlist-library-content"]')).overflowY,
        border: getComputedStyle(document.querySelector('aside[aria-label="プレイリストライブラリ"]')).borderTopWidth,
      }));
      assert(layout.padding <= 24 && layout.overflow === 'visible' && layout.border === '0px', `empty library wastes mobile viewport: ${JSON.stringify(layout)}`);
    }
    await screenshot(page, `library-${width}`);
    await clickText(page, '外部から読み込む');
    const menuBounds = await page.$eval('[role="menu"]', element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
    assert(menuBounds.left >= 0 && menuBounds.right <= width && menuBounds.top >= 0 && menuBounds.bottom <= 900, `menu clipped at ${width}: ${JSON.stringify(menuBounds)}`);
    await clickText(page, 'ニコニコからインポート');
    await page.waitForSelector('[role="dialog"]');
    await page.type('#nico-source-url', 'https://www.nicovideo.jp/mylist/12345');
    await clickText(page, '取得');
    await page.waitForFunction(() => document.body.textContent.includes('2本中 1曲を照合'));
    await screenshot(page, `nico-import-${width}`);
    // Changing the URL must invalidate the old result before it can be saved.
    await page.focus('#nico-source-url'); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.type('#nico-source-url', 'https://www.nicovideo.jp/series/54321');
    assert(!await page.$eval('[role="dialog"]', element => element.textContent.includes('1曲を保存')), 'old URL result remained saveable');
    await clickText(page, '取得');
    await page.waitForFunction(() => document.body.textContent.includes('変更後のシリーズ'));
    await clickText(page, '1曲を保存');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === '変更後のシリーズ');
    const imported = await page.evaluate(() => JSON.parse(localStorage.getItem('diva_playlists')));
    assert(imported.some(item => item.name === '変更後のシリーズ' && item.songs[0]?.id === song.id && !item.nicoSync), 'one-time import without target did not persist');
    await screenshot(page, `detail-${width}`);
    if (width === 390) {
      await clickText(page, '再生');
      await page.waitForSelector('.global-mini-player', { visible: true });
      await page.waitForFunction(() => {
        const player = document.querySelector('.global-mini-player');
        return player && parseFloat(getComputedStyle(document.querySelector('.playlist-page')).paddingBottom) >= player.getBoundingClientRect().height + 16;
      });
    }
    if (width < 1280) await clickText(page, '← ライブラリ');
    await clickText(page, '条件で自動作成');
    await page.waitForFunction(() => document.body.textContent.includes('総一致 1曲 / 保存予定 1曲'));
    await page.locator('input[placeholder="2020"]').fill('2025');
    await page.locator('input[placeholder="2026"]').fill('2020');
    await page.waitForFunction(() => document.body.textContent.includes('公開年の開始は終了以前にしてください。'));
    assert(await page.$eval('[role="dialog"] .btn-primary', button => button.disabled), 'invalid range can be saved');
    await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent?.includes('ニコニコ中心'))?.click());
    await page.waitForFunction(() => document.body.textContent.includes('総一致 1曲 / 保存予定 1曲'));
    const preset = await page.evaluate(() => ({ year: document.querySelector('input[placeholder="2020"]').value, yt: document.querySelector('input[type="number"]').value }));
    assert(preset.year === '' && preset.yt === '0', `preset retained prior conditions: ${JSON.stringify(preset)}`);
    await screenshot(page, `smart-${width}`);
    await clickText(page, '条件を保存して作成');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('diva_playlists')).some(item => item.smartRule?.pvService === 'niconico' && item.songs.length === 1));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow at ${width}`);
    assert(errors.length === 0, `page errors at ${width}: ${errors.join('; ')}`);
    console.log(`PASS ${width}px: library import, source invalidation, saving, smart preset reset, invalid range, preview and persistence`);
    await page.close();
  }
} finally { await browser.close(); }
