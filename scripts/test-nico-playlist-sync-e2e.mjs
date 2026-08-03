import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
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
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('取込先')), { timeout: 60_000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('取込先'))?.click());
  await page.waitForSelector('button[title="その他の操作"]');
  await page.$$eval('button[title="その他の操作"]', buttons => buttons.at(-1)?.click());
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('ニコニコからインポート')));
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('ニコニコからインポート'))?.click());
  await page.waitForSelector('input[placeholder*="nicovideo.jp/mylist"]');
  await page.type('input[placeholder*="nicovideo.jp/mylist"]', `https://www.nicovideo.jp/mylist/${sourceId}`);
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '取得')?.click());
  await page.waitForFunction(() => document.body.textContent?.includes('Nico imported fixture') && document.body.textContent?.includes('2本中 1曲を照合'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('自動同期としてリンク'))?.click());
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('同期プレイリストを作成'))?.click());
  await page.waitForFunction(() => document.body.textContent?.includes('ニコニコ自動同期') && document.body.textContent?.includes('Nico sync fixture'));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('diva_playlists') || '[]'));
  if (!saved.some(playlist => playlist.nicoSync?.sourceId === '26375614' && playlist.songs?.[0]?.id === 903001)) {
    throw new Error('linked NicoNico playlist was not persisted');
  }
  console.log('PASS NicoNico playlist import and linked sync UI');
} finally {
  await browser.close();
}
