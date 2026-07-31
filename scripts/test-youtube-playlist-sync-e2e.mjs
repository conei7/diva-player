import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const playlistId = 'PL1234567890';
const sourceSong = {
  id: 902001,
  name: 'YouTube sync fixture',
  defaultName: 'YouTube sync fixture',
  defaultNameLanguage: 'English',
  artistString: 'Sync producer',
  createDate: '2026-01-01T00:00:00Z',
  favoritedTimes: 0,
  lengthSeconds: 30,
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  pvs: [{ author: '', disabled: false, id: 9020011, length: 30, name: 'fixture', pvId: 'sync-fixture', service: 'Youtube', pvType: 'Original', url: 'https://youtu.be/sync-fixture' }],
};
const linkedPlaylist = {
  id: 'playlist-youtube-sync-fixture',
  name: 'YouTube sync fixture playlist',
  songs: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  youtubeSync: {
    playlistId,
    sourceUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
    enabled: true,
    intervalHours: 24,
    nextSyncAt: 0,
    lastStatus: 'never',
  },
};

try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().includes(`/backend-api/api/youtube/playlists/${playlistId}/songs`)) {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          playlistId,
          title: linkedPlaylist.name,
          videoCount: 1,
          matchedCount: 1,
          unmatchedVideoIds: [],
          songs: [sourceSong],
          sourceFetchedAt: new Date().toISOString(),
          stale: false,
          truncated: false,
        }),
      });
    } else {
      request.continue();
    }
  });
  await page.evaluateOnNewDocument(playlist => {
    localStorage.setItem('diva_playlists', JSON.stringify([playlist]));
    localStorage.setItem('diva_playlistFolders', JSON.stringify([]));
  }, linkedPlaylist);
  await page.goto(`${baseUrl.replace(/\/$/, '')}/playlists`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('button', { timeout: 60_000 });
  await page.waitForFunction(name => [...document.querySelectorAll('button')].some(button => button.textContent?.includes(name)), { timeout: 60_000 }, linkedPlaylist.name);
  await page.evaluate(name => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes(name));
    if (!button) throw new Error('linked playlist button not found');
    button.click();
  }, linkedPlaylist.name);
  await page.waitForFunction(() => document.body.textContent?.includes('YouTube') && document.body.textContent?.includes('同期'));
  const songCount = await page.$eval('body', body => body.textContent?.includes('YouTube sync fixture') ?? false);
  if (!songCount) throw new Error('synced song was not rendered');
  console.log('PASS YouTube playlist auto-sync renders matched songs');
  const syncButton = await page.$('button');
  if (!syncButton) throw new Error('playlist controls not rendered');
} finally {
  await browser.close();
}
