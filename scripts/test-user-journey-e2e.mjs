import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const base = new URL(process.argv[2] || 'http://127.0.0.1:4173/diva-player/');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const pageErrors = [];
const songs = [1, 2].map(number => ({
  id: 990100 + number, name: `Journey song ${number}`, defaultName: `Journey song ${number}`,
  defaultNameLanguage: 'English', artistString: 'Journey producer', createDate: '2026-01-01T00:00:00Z',
  publishDate: '2025-01-01T00:00:00Z', favoritedTimes: 100, lengthSeconds: 180,
  pvServices: 'Youtube', songType: 'Original', status: 'Finished', version: 1,
  youtubeViews: 100000, nicoViews: 50000,
  pvs: [{ id: number, pvId: `journey-${number}`, service: 'Youtube', pvType: 'Original', disabled: false }],
}));

async function fixtures(page) {
  page.on('pageerror', error => pageErrors.push(error.message));
  const remote = { songs: [songs[0]], fail: false };
  await pinAppLanguage(page);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('diva-global-filters', JSON.stringify({ version: 2, state: { enabled: false } }));
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.href === 'https://www.youtube.com/iframe_api') {
      void request.respond({ contentType: 'application/javascript', body: `
        window.YT = { PlayerState: { UNSTARTED:-1, ENDED:0, PLAYING:1, PAUSED:2, CUED:5 },
          Player: function (_, options) {
            const player = this; let state=-1, id='', position=0;
            window.__journeyPlayer=player;
            player.getVideoData=()=>({video_id:id}); player.getPlayerState=()=>state;
            player.getCurrentTime=()=>position; player.getDuration=()=>180;
            player.getVolume=()=>50; player.setVolume=player.mute=player.unMute=player.destroy=()=>{};
            player.seekTo=value=>{position=value;};
            player.loadVideoById=player.cueVideoById=value=>{id=value;position=0;state=5;};
            player.playVideo=()=>{if(state===1)return;state=1;options.events.onStateChange({data:state,target:player});};
            player.pauseVideo=()=>{state=2;options.events.onStateChange({data:state,target:player});};
            player.stopVideo=()=>{state=0;};
            setTimeout(()=>options.events.onReady({target:player}),0);
          }
        }; window.onYouTubeIframeAPIReady();` });
      return;
    }
    if (!url.pathname.startsWith('/backend-api/') && url.hostname !== 'vocadb.net') {
      void request.continue(); return;
    }
    let body = { items: [], totalCount: 0 };
    if (url.pathname.includes('/api/nico/playlists/')) {
      if (remote.fail) { void request.respond({ status: 503, body: 'fixture temporary failure' }); return; }
      body = { sourceKind: 'mylist', sourceId: '12345', title: 'Journey external',
        songs: remote.songs, videoCount: remote.songs.length, matchedCount: remote.songs.length,
        unmatchedVideoIds: [], sourceFetchedAt: new Date().toISOString(), stale: false, truncated: false };
    } else if (/\/api\/(health|ready)$/.test(url.pathname)) body = { status: 'ok', postgres: true, qdrant: true };
    else if (/\/api\/songs\/\d+$/.test(url.pathname)) body = songs.find(song => url.pathname.endsWith(`/${song.id}`)) ?? songs[0];
    else if (url.pathname.endsWith('/api/songs/views')) body = Object.fromEntries(songs.map(song => [song.id, { youtubeViews: song.youtubeViews, nicoViews: song.nicoViews }]));
    else if (url.pathname.includes('/api/songs/search') || url.pathname.endsWith('/api/songs')) body = { items: songs, totalCount: songs.length };
    else if (url.pathname.includes('/api/recommend')) body = { items: songs.map(song => ({ songId: song.id, score: 1 })), cards: songs };
    void request.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  return remote;
}

async function clickText(page, scope, text) {
  const predicate = (selector, value, click) => {
    const button = [...document.querySelectorAll(`${selector} button`)].find(element => element.textContent.trim() === value || element.getAttribute('aria-label') === value);
    if (click) button?.click();
    return Boolean(button);
  };
  try {
    await page.waitForFunction(predicate, { timeout: 10000 }, scope, text, false);
  } catch {
    const buttons = await page.$$eval(`${scope} button`, elements => elements.map(button => ({ text: button.textContent.trim(), label: button.getAttribute('aria-label') })));
    throw new Error(`Missing journey action ${scope} / ${text}: ${JSON.stringify(buttons)}`);
  }
  await page.evaluate(predicate, scope, text, true);
}

async function saveNewPlaylist(page, name) {
  await page.click('[data-testid="watch-action-bar"] button[aria-label="プレイリストに保存"]');
  await clickText(page, '[data-testid="save-to-playlist-dialog"]', '新しいプレイリストを作成');
  await page.type('[data-testid="save-to-playlist-dialog"] input', name);
  await clickText(page, '[data-testid="save-to-playlist-dialog"]', '作成');
  await page.waitForFunction(() => !document.querySelector('[data-testid="save-to-playlist-dialog"]'));
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const first = await browser.newPage();
  await first.setViewport({ width: 1440, height: 900 });
  const remote = await fixtures(first);
  await first.goto(base.href, { waitUntil: 'domcontentloaded' });
  await first.waitForSelector('input[name="search_query"]');
  await first.type('input[name="search_query"]', 'Journey');
  await first.keyboard.press('Enter');
  await first.waitForSelector('main a[href*="watch?v=990101"]');
  await first.click('main a[href*="watch?v=990101"]');
  await first.waitForSelector('[data-testid="watch-action-bar"]');
  await first.waitForFunction(() => window.__journeyPlayer?.getPlayerState() === 1);
  console.log('PASS search result starts playback');

  // Both tabs are open before either changes saved user data.
  const second = await browser.newPage();
  await second.setViewport({ width: 1440, height: 900 });
  await fixtures(second);
  await second.goto(new URL('watch?v=990102&autoplay=0', base).href, { waitUntil: 'domcontentloaded' });
  await second.waitForSelector('[data-testid="watch-action-bar"]');
  await first.bringToFront();
  await first.click('[data-testid="watch-action-bar"] button[aria-label="星4つ"]');
  await saveNewPlaylist(first, 'Journey saved A');
  await second.bringToFront();
  await second.click('[data-testid="watch-action-bar"] button[aria-label="星5つ"]');
  await saveNewPlaylist(second, 'Journey saved B');
  const saved = await second.evaluate(() => ({
    ratings: JSON.parse(localStorage.getItem('diva-ratings')).state.ratings,
    playlists: JSON.parse(localStorage.getItem('diva_playlists')),
  }));
  assert(saved.ratings['990101'] === 4 && saved.ratings['990102'] === 5
    && ['Journey saved A', 'Journey saved B'].every(name => saved.playlists.some(item => item.name === name)),
  `Edits in an already-open tab lost earlier saved data: ${JSON.stringify(saved)}`);
  console.log('PASS independent saves in two open tabs retain both ratings and playlists');

  await first.bringToFront();
  await first.reload({ waitUntil: 'domcontentloaded' });
  await first.waitForSelector('[data-testid="watch-action-bar"] button[aria-label="星4つ"][aria-pressed="true"]');
  await first.goto(new URL('playlists', base).href, { waitUntil: 'domcontentloaded' });
  await first.waitForFunction(() => ['Journey saved A', 'Journey saved B'].every(name => document.querySelector('main')?.textContent.includes(name)));
  await first.goto(new URL('history', base).href, { waitUntil: 'domcontentloaded' });
  await first.waitForSelector('main a[href*="watch?v=990101"]');
  console.log('PASS reload and library/history navigation preserve saved data');

  await first.goto(new URL('playlists', base).href, { waitUntil: 'domcontentloaded' });
  await clickText(first, 'main', '新規作成');
  await clickText(first, 'body', 'URLからインポート');
  await first.type('#playlist-import-url', 'https://www.nicovideo.jp/mylist/12345');
  await clickText(first, '[role="dialog"]', '読み込む');
  await first.waitForSelector('[role="dialog"] input[role="switch"]');
  await first.click('[role="dialog"] input[role="switch"]');
  await first.waitForFunction(() => !document.querySelector('[data-testid="playlist-import-save"]')?.disabled);
  await first.click('[data-testid="playlist-import-save"]');
  await first.waitForSelector('main button[aria-label="今すぐ同期"]');
  remote.songs = [...songs];
  await first.click('main button[aria-label="今すぐ同期"]');
  await first.waitForFunction(() => JSON.parse(localStorage.getItem('diva_playlists')).find(item => item.name === 'Journey external')?.songs.length === 2);
  remote.fail = true;
  await first.click('main button[aria-label="今すぐ同期"]');
  await first.waitForFunction(() => JSON.parse(localStorage.getItem('diva_playlists')).find(item => item.name === 'Journey external')?.nicoSync.lastStatus === 'error');
  const retained = await first.evaluate(() => JSON.parse(localStorage.getItem('diva_playlists')).find(item => item.name === 'Journey external').songs.map(song => song.id));
  assert(retained.join() === '990101,990102', 'A temporary sync failure erased the saved songs');
  console.log('PASS external playlist updates and a failed refresh preserve local saved songs');

  // Return through the SPA navigation before going offline; a document navigation
  // would itself require a network connection (the app is not an offline PWA).
  await first.evaluate(path => {
    const link = [...document.querySelectorAll('a')].find(item => item.getAttribute('href') === path);
    if (!link) throw new Error('Playlist navigation link missing');
    link.click();
  }, new URL('playlists', base).pathname);
  await first.waitForSelector('main [data-testid="playlist-library"]', { visible: true });
  await first.setOfflineMode(true);
  await clickText(first, 'main', '新規作成');
  await clickText(first, 'body', '新しいプレイリスト');
  await first.type('[role="dialog"] input[placeholder="タイトルを入力"]', 'Journey offline');
  await first.click('[role="dialog"] button[aria-label="プレイリストを作成"]');
  await first.waitForFunction(() => JSON.parse(localStorage.getItem('diva_playlists')).some(item => item.name === 'Journey offline'));
  await first.setOfflineMode(false);
  await first.reload({ waitUntil: 'domcontentloaded' });
  await first.waitForSelector('button[aria-label="設定"]');
  await first.evaluate(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = blob => { window.__journeyBackup = blob; return original.call(URL, blob); };
  });
  await first.click('button[aria-label="設定"]');
  await first.waitForSelector('#settings-tab-data');
  await first.click('#settings-tab-data');
  await clickText(first, '[role="dialog"][aria-label="設定"]', 'バックアップを保存');
  await first.waitForFunction(() => window.__journeyBackup instanceof Blob);
  const backup = JSON.parse(await first.evaluate(() => window.__journeyBackup.text()));
  assert(backup.sections.ratings['990101'] === 4 && backup.sections.ratings['990102'] === 5
    && ['Journey saved A', 'Journey saved B', 'Journey external', 'Journey offline'].every(name => backup.sections.playlists.playlists.some(item => item.name === name))
    && backup.sections.history.events.some(event => event.s === 990101),
  `The exported backup did not contain all data retained by the complete journey: ${JSON.stringify({ ratings: backup.sections.ratings, playlists: backup.sections.playlists.playlists.map(item => item.name), history: backup.sections.history.events })}`);
  console.log('PASS offline save, reload and complete backup retain ratings, playlists, sync contents and listening history');
  assert(pageErrors.length === 0, `Uncaught errors during the user journey: ${pageErrors.join('; ')}`);
} finally { await browser.close(); }
