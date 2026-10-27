import { installSavedLibraryReader } from './saved-library-fixture.mjs';
import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });
const sourceId = '26375614';
const sourceSong = {
  id: 903001,
  name: 'Nico sync fixture',
  defaultName: 'Nico sync fixture',
  defaultNameLanguage: 'English',
  artistString: 'Sync producer',
  createDate: '2026-01-01T00:00:00Z',
  favoritedTimes: 0,
  lengthSeconds: 30,
  pvServices: 'NicoNicoDouga',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
};

try {
  const page = await browser.newPage();
  await pinAppLanguage(page);
  await installSavedLibraryReader(page);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().includes(`/backend-api/api/nico/playlists/mylist/${sourceId}/songs`)) {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sourceKind: 'mylist',
          sourceId,
          title: 'Nico imported fixture',
          videoCount: 2,
          matchedCount: 1,
          unmatchedVideoIds: ['sm-missing'],
          songs: [sourceSong],
          sourceFetchedAt: new Date().toISOString(),
          stale: false,
          truncated: false,
        }),
      });
    } else request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('diva_playlists', JSON.stringify([{ id: 'base', name: '取込先', songs: [], createdAt: Date.now(), updatedAt: Date.now() }]));
    localStorage.setItem('diva_playlistFolders', JSON.stringify([]));
  });
  await page.goto(`${baseUrl.replace(/\/$/, '')}/playlists`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Open the playlist from its library card, then 「このプレイリストにインポート」 in the hero's ⋮.
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="playlist-card"] a')].some(link => link.textContent?.includes('取込先')), { timeout: 60_000 });
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="playlist-card"] a')].find(link => link.textContent?.includes('取込先'))?.click());
  await page.waitForFunction(() => document.querySelector('main section h1')?.textContent === '取込先');
  await page.click('main section button[aria-label="その他の操作"]');
  await page.waitForSelector('[role="menu"]');
  await page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(item => item.textContent?.includes('このプレイリストにインポート'))?.click());
  await page.waitForSelector('[role="dialog"] #playlist-import-url');
  await page.type('#playlist-import-url', `https://www.nicovideo.jp/mylist/${sourceId}`);
  await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent?.trim() === '読み込む')?.click());
  await page.waitForFunction(() => document.body.textContent?.includes('Nico imported fixture') && document.body.textContent?.includes('2本中 1曲が見つかりました'));
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll('[role="dialog"] input[role="switch"]')].find(input => input.closest('label')?.textContent?.includes('元のリストと同期'));
    if (!(toggle instanceof HTMLInputElement)) throw new Error('sync switch not found');
    toggle.click();
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="playlist-import-save"]')?.disabled === false);
  await page.click('[data-testid="playlist-import-save"]');
  await page.waitForFunction(() => document.body.textContent?.includes('ニコニコと同期') && document.body.textContent?.includes('Nico sync fixture'));
  const saved = await page.evaluate(async () => window.__readSavedPlaylists());
  if (!saved.some(playlist => playlist.nicoSync?.sourceId === '26375614' && playlist.songs?.[0]?.id === 903001)) {
    throw new Error('linked NicoNico playlist was not persisted');
  }
  console.log('PASS NicoNico playlist import and linked sync UI');
} finally {
  await browser.close();
}
