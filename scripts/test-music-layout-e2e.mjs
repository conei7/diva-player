import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

// The opt-in music layout (設定 > 見た目 > レイアウト > ミュージック): its frame, the video's place
// (≥200×200, nothing over it), the player bar, phones, Home shelves, the playlist track table, and
// that the standard layout and the single YouTube player are untouched by switching.
const base = new URL(process.argv.slice(2).find(value => /^https?:/.test(value)) || 'http://127.0.0.1:4173/diva-player/');
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP', '--touch-events=enabled'] });

const song = (id, name, videoId, lengthSeconds = 200) => ({
  id,
  name,
  defaultName: name,
  defaultNameLanguage: 'Japanese',
  artistString: 'Music fixture P feat. 初音ミク',
  createDate: '2026-01-01T00:00:00Z',
  publishDate: '2025-06-01T00:00:00Z',
  favoritedTimes: 10,
  lengthSeconds,
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  youtubeViews: 123456,
  // Home and the shelves only show songs with a voice synthesizer vocalist (isVoiceSynthSong).
  artists: [
    { name: 'Music fixture P', categories: 'Producer', isSupport: false, artist: { id: 1, name: 'Music fixture P', artistType: 'Producer' } },
    { name: '初音ミク', categories: 'Vocalist', isSupport: false, artist: { id: 1, name: '初音ミク', artistType: 'Vocaloid' } },
  ],
  pvs: [{ author: '', disabled: false, id: id * 10, length: lengthSeconds, name, pvId: videoId, service: 'Youtube', pvType: 'Original', url: `https://youtu.be/${videoId}` }],
});
const songs = [
  song(970001, 'Music layout first', 'musicfirst1'),
  song(970002, 'Music layout second', 'musicsecnd2'),
  song(970003, 'Music layout third', 'musicthird3'),
];
const homeSongs = Array.from({ length: 24 }, (_, index) => song(971000 + index, `Shelf song ${index + 1}`, `shelfsong${String(index).padStart(2, '0')}`));
const allSongs = [...songs, ...homeSongs];
const playlistId = 'music-e2e-playlist';
const pageErrors = [];
// The cases of short windows (runCase) run to the end and report every failure together.
const caseFailures = [];

const json = body => ({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(body) });

const YOUTUBE_STUB = `
  window.__ytConstructs = (window.__ytConstructs || 0);
  window.YT = {
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 },
    Player: function (_, options) {
      const player = this;
      let state = -1;
      let position = 0;
      let videoId = '';
      let volume = 50;
      window.__ytConstructs += 1;
      window.__yt = player;
      window.__ytLoads = 0;
      window.__ytDestroys = 0;
      player.getVideoData = () => ({ video_id: videoId });
      player.getPlayerState = () => state;
      player.getCurrentTime = () => position;
      player.getDuration = () => 200;
      player.getVolume = () => volume;
      player.setVolume = value => { volume = value; window.__ytVolume = value; };
      player.isMuted = () => false;
      player.mute = () => {};
      player.unMute = () => {};
      player.seekTo = seconds => { position = seconds; };
      player.cueVideoById = player.loadVideoById = id => {
        videoId = typeof id === 'string' ? id : id.videoId; position = 0; state = 5; window.__ytLoads++;
      };
      const emit = () => options.events.onStateChange({ data: state, target: player });
      player.playVideo = () => { if (state === 1) return; state = 1; emit(); };
      player.pauseVideo = () => { state = 2; emit(); };
      player.stopVideo = () => { state = 0; };
      player.destroy = () => { window.__ytDestroys++; };
      setTimeout(() => options.events.onReady({ target: player }), 0);
    },
  };
  window.onYouTubeIframeAPIReady();
`;

// The sound map's response, like src/api/soundMapDemo.ts: the starting song and 28 near it.
function soundMapFixture(seedSongId) {
  const origin = { songId: seedSongId, name: `デモ曲 ${seedSongId}`, artistString: 'Demo Producer', x: 0, y: 0, similarity: null };
  const items = [origin];
  for (let index = 1; index <= 28; index++) {
    const angle = index * 2.399963229728653;
    const radius = 0.12 + (index % 7) * 0.1;
    items.push({
      songId: seedSongId + index,
      name: `近傍デモ曲 ${seedSongId + index}`,
      artistString: 'Demo Producer',
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      similarity: Math.max(0.51, 0.99 - index * 0.014),
    });
  }
  return { mapVersion: 'demo-v1', generatedAt: '2026-09-12T00:00:00Z', method: 'demo', coordinateCount: items.length, state: 'ready', origin, items };
}

async function preparePage(context, { layout, viewport, playing = true, failMusicChunk = false, volume, backendDown = false } = {}) {
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`${page.url()}: ${error.message}`));
  if (viewport) await page.setViewport(viewport);
  await pinAppLanguage(page, 'ja');
  await page.evaluateOnNewDocument((seed) => {
    if (window !== window.top) return;
    if (sessionStorage.getItem('music-e2e-seeded')) return;
    sessionStorage.setItem('music-e2e-seeded', '1');
    if (seed.layout) localStorage.setItem('diva_uiLayout', JSON.stringify(seed.layout));
    if (typeof seed.volume === 'number') localStorage.setItem('diva_volume', JSON.stringify(seed.volume));
    localStorage.setItem('diva-global-filters', JSON.stringify({ version: 2, state: { enabled: false } }));
    const tabId = 'music-layout-e2e-tab';
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    if (seed.playing) {
      localStorage.setItem('diva-playback-owner-v1', JSON.stringify({ type: 'claim', tabId, songId: seed.songs[0].id, claimedAt: Date.now() }));
    }
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue: seed.songs,
      queueIndex: 0,
      currentSong: seed.songs[0],
      currentSongId: seed.songs[0].id,
      queueSources: seed.songs.map(() => 'manual'),
      currentPlaybackSource: 'manual',
    }));
    const now = Date.now();
    localStorage.setItem('diva_playlists', JSON.stringify([{
      id: seed.playlistId,
      name: 'ミュージック E2E リスト',
      songs: seed.songs,
      createdAt: now,
      updatedAt: now,
    }]));
  }, { layout, playing, songs, playlistId, volume });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    const path = url.pathname;
    if (url.href === 'https://www.youtube.com/iframe_api') {
      void request.respond({ status: 200, contentType: 'application/javascript', body: YOUTUBE_STUB });
      return;
    }
    if (failMusicChunk && /\/MusicShell-[\w-]+\.js$/.test(path)) {
      void request.abort('failed');
      return;
    }
    const isBackend = path.includes('/backend-api/');
    const isVocaDb = url.hostname === 'vocadb.net';
    if (!isBackend && !isVocaDb) {
      if (/^(?:www\.)?(?:youtube\.com|img\.youtube\.com|i\.ytimg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) {
        void request.respond({ status: 204, body: '' });
        return;
      }
      void request.continue();
      return;
    }
    let response = null;
    if (path.endsWith('/api/health') || path.endsWith('/api/ready')) {
      // backendDown: the server band under the top bar (BackendStatusNotice)
      response = backendDown
        ? { status: 503, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '{}' }
        : json({ status: path.endsWith('/api/ready') ? 'ready' : 'ok', postgres: true, qdrant: true });
    } else if (path.includes('/api/discovery/sound-map')) {
      response = json(soundMapFixture(Number(url.searchParams.get('seedSongId')) || 123));
    } else if (path.includes('/api/songs/discovery-eligibility')) {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);
      response = json({ items: ids.map(songId => ({ songId, discoveryEligible: true })) });
    } else if (path.endsWith('/api/songs/views')) {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      response = json(Object.fromEntries(ids.map(id => [id, { youtubeViews: 1234, nicoViews: 0 }])));
    } else if (path.includes('/api/songs/trending') || path.includes('/api/songs/search')) {
      response = json({ items: homeSongs, totalCount: homeSongs.length });
    } else if (path.includes('/api/songs/batch')) {
      response = json({ items: allSongs });
    } else if (path.includes('/api/recommend')) {
      response = json({ items: homeSongs.slice(0, 12).map(item => ({ songId: item.id, score: 1 })), cards: homeSongs.slice(0, 12) });
    } else if (path.match(/\/api\/songs\/\d+$/)) {
      const id = Number(path.split('/').pop());
      response = json(allSongs.find(item => item.id === id) ?? songs[0]);
    }
    void request.respond(response ?? { status: 404, headers: { 'content-type': 'application/json' }, body: '{}' });
  });
  return page;
}

const open = (page, path = '') => page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });

async function startPlayback(page) {
  await page.waitForFunction(() => window.__yt?.getVideoData?.().video_id, { timeout: 30_000 });
  await page.evaluate(() => window.__yt.playVideo());
  await page.waitForFunction(() => window.__yt.getPlayerState() === 1);
}

async function assertSinglePlayer(page, label) {
  const state = await page.evaluate(() => ({
    constructs: window.__ytConstructs, loads: window.__ytLoads, destroys: window.__ytDestroys,
    playing: window.__yt?.getPlayerState() === 1,
  }));
  if (state.constructs !== 1 || state.loads !== 1 || state.destroys !== 0 || !state.playing) {
    throw new Error(`${label}: the YouTube player was recreated, reloaded or paused ${JSON.stringify(state)}`);
  }
}

/** The video box is ≥200×200, inside the viewport, not parked, and nothing else is drawn over it. */
async function assertVideoVisible(page, label) {
  const result = await page.evaluate(() => {
    const container = document.querySelector('[data-testid="global-player"]');
    const video = container?.querySelector('.global-player-video');
    if (!container || !video) return { error: 'no player' };
    const rect = video.getBoundingClientRect();
    const points = [[0.5, 0.5], [0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]].map(([x, y]) => {
      const element = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
      return Boolean(element && container.contains(element));
    });
    return {
      width: rect.width,
      height: rect.height,
      inside: rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5,
      parked: container.style.top === '-9999px',
      hidden: container.getAttribute('aria-hidden') === 'true',
      unobstructed: points.every(Boolean),
      className: container.className,
    };
  });
  if (result.error || result.width < 200 || result.height < 200 || !result.inside || result.parked || result.hidden || !result.unobstructed) {
    throw new Error(`${label}: video must be visible ≥200×200 and unobstructed ${JSON.stringify(result)}`);
  }
  return result;
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`${label}: horizontal overflow ${overflow}px`);
}

/**
 * Stricter than assertVideoVisible: an 11×11 grid 4px inside the video (clear of its rounded corners)
 * where every point on screen must reach the player, and no fixed bar's box over the video's box (a
 * grid misses overlaps thinner than its rows, like a bar 4px over the bottom of the song page's video).
 */
function videoState(page) {
  return page.evaluate(() => {
    const container = document.querySelector('[data-testid="global-player"]');
    const video = container?.querySelector('.global-player-video');
    if (!container || !video) return { error: 'no player' };
    const rect = video.getBoundingClientRect();
    let blocked = 0;
    let offscreen = 0;
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 10; j++) {
        const x = rect.left + 4 + (rect.width - 8) * i / 10;
        const y = rect.top + 4 + (rect.height - 8) * j / 10;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
          offscreen++;
          continue;
        }
        const hit = document.elementFromPoint(x, y);
        if (!hit || !container.contains(hit)) blocked++;
      }
    }
    const round = value => Math.round(value * 10) / 10;
    const over = [...document.querySelectorAll(['header', '.music-player-bar', '.music-mini-bar', '.music-bottom-nav',
      '[data-testid="watch-scrolled-controls"]', '[data-testid="selection-fab"]', '[data-testid="toast-host"] > div:not([aria-hidden])'].join(', '))]
      .map(element => ({ name: element.dataset.testid || (element.tagName === 'HEADER' ? 'header' : element.className.split(' ')[0]), box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0
        && Math.min(box.right, rect.right) - Math.max(box.left, rect.left) > 0.5
        && Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top) > 0.5)
      .map(({ name, box }) => `${name} ${round(Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top))}px`);
    return {
      width: round(rect.width),
      height: round(rect.height),
      left: round(rect.left),
      top: round(rect.top),
      right: round(rect.right),
      bottom: round(rect.bottom),
      inside: rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5,
      blocked,
      offscreen,
      over,
      bar: Boolean(document.querySelector('[data-testid="music-player-bar"]')),
      musicBottom: document.documentElement.dataset.musicBottom ?? null,
    };
  });
}
/** ≥200×200, wholly in the window, every point reaching the player and no bar over it. */
const videoClear = state => !state.error && state.width >= 199.5 && state.height >= 199.5 && state.inside
  && state.blocked === 0 && state.over.length === 0;
/** The same, except that it may run past the window's bottom edge (the page scrolls). */
const videoUncovered = state => !state.error && state.width >= 199.5 && state.height >= 199.5
  && state.blocked === 0 && state.over.length === 0;

/** The visible toast (after its entrance) and whether it covers the video or a mini bar control. */
function toastState(page) {
  return page.evaluate(() => {
    const toast = [...document.querySelectorAll('[data-testid="toast-host"] > div:not([aria-hidden])')]
      .map(element => element.getBoundingClientRect()).find(box => box.height > 0);
    if (!toast) return null;
    const overlaps = box => Boolean(box) && box.width > 1
      && Math.min(box.right, toast.right) - Math.max(box.left, toast.left) > 0.5
      && Math.min(box.bottom, toast.bottom) - Math.max(box.top, toast.top) > 0.5;
    const video = document.querySelector('[data-testid="global-player"] .global-player-video')?.getBoundingClientRect();
    return {
      top: Math.round(toast.top),
      bottom: Math.round(toast.bottom),
      overVideo: overlaps(video),
      overControls: [...document.querySelectorAll('.music-mini-bar :is(button, [role="link"])')]
        .filter(control => overlaps(control.getBoundingClientRect()))
        .map(control => control.dataset.testid || control.getAttribute('aria-label')),
    };
  });
}

/** Presses M (nothing focused) and waits for its toast to finish sliding in. */
async function muteWithKey(page, text) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('m');
  await page.waitForFunction(expected => document.querySelector('[data-testid="toast-host"]')?.textContent.includes(expected),
    { timeout: 10_000 }, text);
  await new Promise(resolve => setTimeout(resolve, 500));
}

/** The music mini bar beside or under the video: each control reached at its centre and clear of the video. */
function miniBarState(page) {
  return page.evaluate(() => {
    const box = element => element.getBoundingClientRect();
    const shown = element => Boolean(element && element.getClientRects().length > 0 && box(element).width > 0);
    const video = box(document.querySelector('[data-testid="global-player"] .global-player-video'));
    const intersects = rect => Math.min(rect.right, video.right) - Math.max(rect.left, video.left) > 0.5
      && Math.min(rect.bottom, video.bottom) - Math.max(rect.top, video.top) > 0.5;
    const bar = document.querySelector('[data-testid="music-mini-bar"]');
    const barBox = box(bar);
    const controls = [...bar.querySelectorAll('button, [role="link"]')].filter(shown).map(control => {
      const rect = box(control);
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        name: control.dataset.testid || control.getAttribute('aria-label'),
        width: Math.round(rect.width),
        reached: Boolean(hit && control.contains(hit)),
        overVideo: intersects(rect),
      };
    });
    return {
      controls,
      missed: controls.filter(control => !control.reached || control.overVideo).map(control => control.name),
      title: controls.find(control => control.name === 'music-mini-open')?.width ?? 0,
      overflow: bar.scrollWidth - bar.clientWidth,
      // The 2px progress line reaches 1px above the bar.
      gap: Math.round((barBox.top - video.bottom) * 10) / 10,
      fullWidth: barBox.left <= 0.5 && barBox.right >= innerWidth - 0.5 && Math.abs(barBox.bottom - innerHeight) <= 0.5,
      underHeader: video.top < box(document.querySelector('header')).bottom - 0.5,
      nav: shown(document.querySelector('.music-bottom-nav')),
      menu: shown(document.querySelector('header button[aria-label="メニュー"]')),
    };
  });
}

async function switchLayoutInSettings(page, value) {
  await page.click('button[aria-label="設定"]');
  await page.waitForSelector('[role="dialog"][aria-label="設定"]');
  await page.click('#settings-tab-playback');
  await page.waitForSelector('[data-testid="settings-ui-layout"]');
  await page.select('[data-testid="settings-ui-layout"]', value);
  await page.waitForFunction(expected => (expected === 'music')
    === (document.documentElement.dataset.shell === 'music'), { timeout: 15_000 }, value);
  if (!await page.$('[role="dialog"][aria-label="設定"] #settings-panel-playback')) {
    throw new Error('Switching the layout must keep the settings dialog open on the same tab');
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="設定"]'));
}

try {
  if (process.argv.includes('--maintenance-only')) {
    await checkRemainingOverlaps();
    if (caseFailures.length) throw new Error(caseFailures.join('\n'));
  } else {
  // A. The standard layout is the default and never downloads the music frame.
  {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { viewport: { width: 1280, height: 900 } });
    const scripts = [];
    page.on('request', request => { if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname); });
    await open(page);
    await page.waitForSelector('main');
    await page.waitForSelector('aside nav');
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const state = await page.evaluate(() => ({
      shell: document.documentElement.dataset.shell ?? null,
      preference: document.documentElement.dataset.uiLayout ?? null,
      musicNodes: document.querySelectorAll('[data-testid^="music-"]').length,
      header: Boolean(document.querySelector('header')),
    }));
    if (state.shell !== null || state.musicNodes !== 0 || !state.header || state.preference !== 'standard') {
      throw new Error(`The standard layout must stay the default: ${JSON.stringify(state)}`);
    }
    if (scripts.some(path => /\/MusicShell-[\w-]+\.js$/.test(path))) throw new Error('The standard layout downloaded the music frame');
    console.log('PASS standard layout is the default and does not load the music frame');

    // B. Switching while YouTube plays keeps the page, the dialog and the single player.
    await startPlayback(page);
    await switchLayoutInSettings(page, 'music');
    await page.waitForSelector('[data-testid="music-library"]');
    await page.waitForSelector('[data-testid="music-player-bar"]');
    const saved = await page.evaluate(() => localStorage.getItem('diva_uiLayout'));
    if (saved !== '"music"') throw new Error(`The music layout must be saved as JSON, got ${saved}`);
    await assertSinglePlayer(page, 'switching to the music layout');
    const strayGuides = await page.evaluate(() => [...document.querySelectorAll('aside nav')]
      .filter(nav => !nav.closest('[data-testid="music-library"]')).length);
    if (strayGuides !== 0) throw new Error(`The music library must replace the standard guide (${strayGuides} other guides)`);
    await page.waitForSelector('[data-testid="global-player"].music-docked-player');
    await assertVideoVisible(page, 'docked video right after switching to music');
    console.log('PASS switching to music keeps settings open and the YouTube player playing, docked in the panel');

    await switchLayoutInSettings(page, 'standard');
    await page.waitForSelector('aside nav');
    if (await page.$('[data-testid^="music-"]')) throw new Error('Music parts stayed after switching back');
    await assertSinglePlayer(page, 'switching back to the standard layout');
    await assertVideoVisible(page, 'standard mini player after switching back');
    console.log('PASS switching back restores the standard frame without touching playback');

    // The top bar's layout switch offers the same choice, one click away from any page.
    for (const value of ['music', 'standard']) {
      const other = value === 'music' ? 'standard' : 'music';
      await page.waitForSelector(`[data-testid="topnav-layout-${value}"]`, { visible: true });
      const pressed = await page.$eval(`[data-testid="topnav-layout-${other}"]`, item => item.getAttribute('aria-pressed'));
      if (pressed !== 'true') throw new Error(`The top bar switch must mark the layout on screen (${other}), got ${pressed}`);
      await page.click(`[data-testid="topnav-layout-${value}"]`);
      await page.waitForFunction(expected => (expected === 'music')
        === (document.documentElement.dataset.shell === 'music'), { timeout: 15_000 }, value);
      await assertSinglePlayer(page, `switching to ${value} from the top bar`);
    }
    console.log('PASS the top bar switch changes the layout both ways without touching playback');

    // The top bar's ☀/☾ swaps the theme in one click, and ⋮ offers 端末の設定に合わせる again.
    const theme = () => page.evaluate(() => ({
      shown: document.documentElement.dataset.theme,
      saved: localStorage.getItem('diva_themeMode'),
      target: document.querySelector('[data-testid="topnav-theme-toggle"]')?.dataset.themeTarget ?? null,
    }));
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.waitForSelector('[data-testid="topnav-theme-toggle"]', { visible: true });
    for (const expected of ['light', 'dark']) {
      const before = await theme();
      if (before.target !== expected || before.shown === expected) throw new Error(`☀/☾ must offer ${expected}: ${JSON.stringify(before)}`);
      await page.click('[data-testid="topnav-theme-toggle"]');
      await page.waitForFunction(value => document.documentElement.dataset.theme === value
        && document.querySelector('[data-testid="topnav-theme-toggle"]')?.dataset.themeTarget !== value, { timeout: 5_000 }, expected);
      const after = await theme();
      if (after.saved !== JSON.stringify(expected)) throw new Error(`☀/☾ must save ${expected}: ${JSON.stringify(after)}`);
      await assertSinglePlayer(page, `switching to the ${expected} theme from the top bar`);
    }
    const chooseThemeInMoreMenu = async label => {
      await page.click('header button[aria-label="その他の操作"]');
      await page.waitForSelector('[role="menu"] [role="menuitemradio"]', { visible: true });
      const items = await page.$$('[role="menu"] [role="menuitemradio"]');
      const texts = await Promise.all(items.map(item => item.evaluate(node => node.textContent.trim())));
      const index = texts.indexOf(label);
      if (index < 0) throw new Error(`⋮ must offer the theme ${label}: ${JSON.stringify(texts)}`);
      await items[index].click();
      await page.waitForFunction(() => !document.querySelector('[role="menu"]'), { timeout: 5_000 });
    };
    await chooseThemeInMoreMenu('ライト');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', { timeout: 5_000 });
    await chooseThemeInMoreMenu('端末の設定に合わせる');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark'
      && localStorage.getItem('diva_themeMode') === '"system"', { timeout: 5_000 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light'
      && document.querySelector('[data-testid="topnav-theme-toggle"]')?.dataset.themeTarget === 'dark', { timeout: 5_000 });
    await page.click('[data-testid="topnav-theme-toggle"]');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark'
      && localStorage.getItem('diva_themeMode') === '"dark"', { timeout: 5_000 });
    await page.reload();
    await page.waitForSelector('main');
    const reloaded = await theme();
    if (reloaded.shown !== 'dark') throw new Error(`A theme chosen with ☀/☾ must survive a reload: ${JSON.stringify(reloaded)}`);
    await page.emulateMediaFeatures([]);
    console.log('PASS the top bar ☀/☾ swaps the theme in one click and ⋮ returns it to the device setting');
    await context.close();
  }

  // C/D. Desktop: library, 再生中 panel with the docked video, the bar's controls.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 1280, height: 800 }]) {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport });
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForSelector('[data-testid="music-now-playing"] [data-testid="music-video-slot"]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="global-player"].music-docked-player');
    const docked = await assertVideoVisible(page, `docked video at ${viewport.width}px`);
    const alignment = await page.evaluate(() => {
      const slot = document.querySelector('[data-testid="music-video-slot"]').getBoundingClientRect();
      const video = document.querySelector('[data-testid="global-player"]').getBoundingClientRect();
      return Math.max(Math.abs(slot.left - video.left), Math.abs(slot.top - video.top), Math.abs(slot.width - video.width));
    });
    if (alignment > 2) throw new Error(`The docked video must cover the panel's slot (off by ${alignment}px)`);
    const frame = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();
      return {
        library: rect('[data-testid="music-library"]'),
        panel: rect('[data-testid="music-now-playing"]'),
        bar: rect('[data-testid="music-player-bar"]'),
        main: rect('main'),
        mains: document.querySelectorAll('main').length,
        settingsButtons: document.querySelectorAll('button[aria-label="設定"]').length,
        width: innerWidth,
        height: innerHeight,
      };
    });
    if (frame.mains !== 1 || frame.settingsButtons !== 1) throw new Error(`Exactly one main and one 設定 button: ${JSON.stringify(frame)}`);
    if (!(frame.library.left >= 0 && frame.library.right <= frame.main.left + 1)) throw new Error(`Library must sit left of the page ${JSON.stringify(frame)}`);
    if (!(frame.panel.right <= frame.width + 0.5 && frame.panel.left >= frame.main.right - 1)) throw new Error(`再生中 panel must sit right of the page ${JSON.stringify(frame)}`);
    if (!(Math.abs(frame.bar.bottom - frame.height) <= 1 && frame.bar.left <= 1 && frame.bar.right >= frame.width - 1)) throw new Error(`The player bar must span the bottom ${JSON.stringify(frame)}`);
    await assertNoHorizontalOverflow(page, `music layout at ${viewport.width}px`);
    await page.evaluate(() => window.scrollTo(0, 600));
    await new Promise(resolve => setTimeout(resolve, 200));
    const afterScroll = await page.evaluate(() => document.querySelector('[data-testid="global-player"] .global-player-video').getBoundingClientRect().top);
    if (Math.abs(afterScroll - (await page.evaluate(() => document.querySelector('[data-testid="music-video-slot"]').getBoundingClientRect().top))) > 2) {
      throw new Error('The docked video must stay on the panel slot while the page scrolls');
    }
    console.log(`PASS ${viewport.width}px: library, page, 再生中 panel and bar; video ${Math.round(docked.width)}×${Math.round(docked.height)} on the slot`);

    if (viewport.width === 1440) {
      // The bar's play / pause drives the one player.
      await page.click('[data-testid="music-play-toggle"]');
      await page.waitForFunction(() => window.__yt.getPlayerState() === 2);
      await page.waitForSelector('[data-testid="music-play-toggle"][aria-label="再生"]');
      await page.click('[data-testid="music-play-toggle"]');
      await page.waitForFunction(() => window.__yt.getPlayerState() === 1);
      await page.waitForSelector('[data-testid="music-play-toggle"][aria-label="一時停止"]');
      console.log('PASS bar play/pause controls the player');

      await page.click('[data-testid="music-player-bar"] button[aria-label="次の曲"]');
      await page.waitForFunction(id => JSON.parse(localStorage.getItem('diva_playerQueue') || '{}').currentSongId === id, {}, songs[1].id);
      console.log('PASS bar next moves the queue');

      const volume = await page.$('[data-testid="music-player-bar"] input[type="range"]');
      if (!volume) throw new Error('The player bar needs a volume slider');
      await volume.focus();
      for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(() => Number(localStorage.getItem('diva_volume')) < 50);
      console.log('PASS volume slider changes the saved volume');

      // Closing the 再生中 panel moves the video above the bar; it stays visible.
      const panelToggle = await page.$('[data-testid="music-player-bar"] button[aria-pressed][aria-label*="再生中"]');
      if (!panelToggle) throw new Error('The player bar needs a 再生中 panel toggle');
      await panelToggle.click();
      await page.waitForFunction(() => !document.querySelector('[data-testid="music-now-playing"]'));
      await page.waitForSelector('[data-testid="global-player"].global-mini-player');
      const mini = await assertVideoVisible(page, 'video with the 再生中 panel closed');
      const barTop = await page.evaluate(() => document.querySelector('[data-testid="music-player-bar"]').getBoundingClientRect().top);
      const miniBottom = await page.evaluate(() => document.querySelector('[data-testid="global-player"]').getBoundingClientRect().bottom);
      if (miniBottom > barTop + 0.5) throw new Error(`The video card must sit above the player bar (${miniBottom} > ${barTop})`);
      await (await page.$('[data-testid="music-player-bar"] button[aria-pressed][aria-label*="再生中"]')).click();
      await page.waitForSelector('[data-testid="global-player"].music-docked-player');
      console.log(`PASS closing the 再生中 panel keeps the video visible (${Math.round(mini.width)}×${Math.round(mini.height)})`);

      // Home shelves of square cards above the existing feed.
      const shelves = await page.$$eval('main [data-testid="music-shelf"]', sections => sections.map(section => ({
        heading: section.querySelector('h2')?.textContent?.trim() ?? '',
        squares: [...section.querySelectorAll('.aspect-square')].slice(0, 3).map(element => {
          const rect = element.getBoundingClientRect();
          return Math.abs(rect.width - rect.height);
        }),
      })));
      if (shelves.length === 0 || shelves.some(shelf => !shelf.heading) || shelves.some(shelf => shelf.squares.some(diff => diff > 1))) {
        throw new Error(`Home must show headed shelves of square cards: ${JSON.stringify(shelves)}`);
      }
      await page.waitForSelector('main .song-card', { timeout: 15_000 });
      console.log(`PASS Home shows ${shelves.length} shelves above the existing feed`);

      // 週間ランキング's すべて表示 selects the feed's ランキング chip and brings the chip bar up under the
      // top bar (the shelves scroll away), with focus on the chip; pressed again, nothing reloads.
      const seeAll = 'main [data-testid="music-shelf"][data-shelf="weekly"] [data-testid="music-shelf-see-all"]';
      const rankingChipFocused = () => page.waitForFunction(() => {
        const chip = document.activeElement;
        return chip?.closest('main [role="toolbar"][aria-label="カテゴリ"]')
          && chip.getAttribute('aria-pressed') === 'true' && chip.textContent.trim() === 'ランキング';
      }, { timeout: 5_000 });
      const chipBarPlacement = () => page.evaluate(() => {
        const bar = document.querySelector('main [role="toolbar"][aria-label="カテゴリ"]').closest('.sticky');
        const top = bar.getBoundingClientRect().top;
        return {
          top,
          stickyTop: Number.parseFloat(getComputedStyle(bar).top),
          headerBottom: document.querySelector('header').getBoundingClientRect().bottom,
          shelvesBottom: document.querySelector('main [data-testid="music-shelf"][data-shelf="weekly"]').getBoundingClientRect().bottom,
          scrollY: window.scrollY,
        };
      });
      const assertChipBarAtTop = placement => {
        if (Math.abs(placement.top - placement.stickyTop) > 1 || placement.top < placement.headerBottom - 1
          || placement.shelvesBottom > placement.top + 1 || placement.scrollY <= 0) {
          throw new Error(`すべて表示 must bring the chip bar right under the top bar: ${JSON.stringify(placement)}`);
        }
      };
      // First pages of the ランキング feed (an appended page has page 1+).
      const countRankingLoads = () => window.__DIVA_PERFORMANCE__.getMetrics()
        .filter(metric => metric.name === 'home.load' && metric.detail?.category === 'ranking' && metric.detail?.page === 0).length;
      const rankingLoads = () => page.evaluate(countRankingLoads);
      await page.evaluate(() => window.scrollTo(0, 0));
      // The shelves load on their own: the feed below may have arrived first.
      await page.waitForSelector(seeAll, { timeout: 15_000 });
      const shelfFirst = await page.$eval('main [data-shelf="weekly"] [data-testid="music-shelf-card"] h3', title => title.textContent.trim());
      // Count from here: the buffer keeps only the latest 100 metrics of everything this page did so far.
      await page.evaluate(() => window.__DIVA_PERFORMANCE__.clear());
      await page.click(seeAll);
      await rankingChipFocused();
      assertChipBarAtTop(await chipBarPlacement());
      await page.waitForFunction(countRankingLoads, { timeout: 15_000 });
      await page.waitForFunction(first => document.querySelector('main .song-card h3')?.textContent.trim() === first, { timeout: 15_000 }, shelfFirst)
        .catch(async () => {
          const feedFirst = await page.evaluate(() => document.querySelector('main .song-card h3')?.textContent.trim() ?? null);
          throw new Error(`The ランキング feed must start with the shelf's first song (${feedFirst} ≠ ${shelfFirst})`);
        });
      assertChipBarAtTop(await chipBarPlacement());
      const loadsBefore = await rankingLoads();
      if (loadsBefore !== 1) throw new Error(`すべて表示 must load the ランキング feed once, got ${loadsBefore}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => document.activeElement?.blur());
      await page.click(seeAll);
      await rankingChipFocused();
      assertChipBarAtTop(await chipBarPlacement());
      await new Promise(resolve => setTimeout(resolve, 500));
      if (await rankingLoads() !== loadsBefore) throw new Error('すべて表示 for the chip already shown must not reload the feed');
      console.log('PASS 週間ランキング すべて表示 selects ランキング with the chip bar under the top bar, and keeps the feed when pressed again');

      // Playlists as a track table.
      await open(page, `playlists?list=${playlistId}`);
      await page.waitForSelector('[data-testid="music-track-row"]', { timeout: 20_000 });
      const table = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-testid="music-track-row"]').length,
        headers: [...document.querySelectorAll('[role="columnheader"]')].map(cell => cell.textContent.trim()).filter(Boolean),
        defaultRows: document.querySelectorAll('[data-testid="playlist-song-row"]').length,
      }));
      if (table.rows !== songs.length || table.defaultRows !== 0 || !table.headers.some(text => text.includes('タイトル'))) {
        throw new Error(`The playlist must render as a track table: ${JSON.stringify(table)}`);
      }
      console.log(`PASS playlist renders as a track table (${table.headers.join(' | ')})`);

      // The song page keeps the video in the page; the 再生中 panel steps aside.
      await open(page, `watch?v=${songs[0].id}`);
      await page.waitForSelector('[data-testid="watch-video-column"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="music-now-playing"]'));
      await page.waitForSelector('[data-testid="music-player-bar"]');
      console.log('PASS song page keeps its own video frame with the bar below');
    }
    await context.close();
  }

  // Tablet width: library rail, no 再生中 panel, the video card above the bar.
  {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport: { width: 800, height: 900 } });
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForSelector('[data-testid="global-player"].global-mini-player');
    await assertVideoVisible(page, 'video card at 800px');
    if (await page.$('[data-testid="music-now-playing"]')) throw new Error('No 再生中 panel below 1024px');
    if (await page.evaluate(() => document.documentElement.dataset.musicLibrary) !== 'rail') throw new Error('The library is a rail below 1280px');
    await assertNoHorizontalOverflow(page, 'music layout at 800px');
    console.log('PASS 800px: library rail and the video card above the bar');
    await context.close();
  }

  // Phones: bottom nav, mini bar, a ≥200px video card above it.
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }, { width: 320, height: 568 }]) {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport: { ...viewport, isMobile: true, hasTouch: true } });
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForSelector('[data-testid="music-mini-bar"]');
    await page.waitForSelector('nav[aria-label="メイン"]');
    await page.waitForSelector('[data-testid="global-player"].global-mini-player');
    const card = await assertVideoVisible(page, `phone video card at ${viewport.width}px`);
    const stack = await page.evaluate(() => ({
      card: document.querySelector('[data-testid="global-player"]').getBoundingClientRect().bottom,
      bar: document.querySelector('[data-testid="music-mini-bar"]').getBoundingClientRect().toJSON(),
      // The bottom nav (the drawer's guide uses the same label): the lowest one on screen.
      nav: Math.max(...[...document.querySelectorAll('nav[aria-label="メイン"]')].map(nav => nav.getBoundingClientRect().top)),
      library: Boolean(document.querySelector('[data-testid="music-library"]')),
      playerBar: getComputedStyle(document.querySelector('[data-testid="music-player-bar"]') ?? document.body).display,
    }));
    if (stack.card > stack.bar.top + 0.5 || stack.bar.bottom > stack.nav + 0.5 || stack.library) {
      throw new Error(`Phones stack the video card, the mini bar and the bottom nav: ${JSON.stringify(stack)}`);
    }
    await page.tap('[data-testid="music-mini-play-toggle"]');
    await page.waitForFunction(() => window.__yt.getPlayerState() === 2);
    await page.tap('[data-testid="music-mini-play-toggle"]');
    await page.waitForFunction(() => window.__yt.getPlayerState() === 1);
    await assertNoHorizontalOverflow(page, `phone at ${viewport.width}px`);
    console.log(`PASS ${viewport.width}×${viewport.height}: video ${Math.round(card.width)}×${Math.round(card.height)}, mini bar and bottom nav`);
    await context.close();
  }

  // Phones: the drawer's switch changes the layout in one tap, both ways.
  {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    // The bottom nav's ≡ (the top bar's stays hidden here; it shows only under 560×420 with a song loaded).
    await page.tap('nav button[aria-label="メニュー"]');
    await page.waitForSelector('button[aria-label="メニューを閉じる"]', { visible: true });
    // The phone rows load after the first paint (and when the drawer opens).
    await page.waitForSelector('#drawer-music-layout', { timeout: 15_000 });
    for (const [checkedBefore, expected] of [[true, 'standard'], [false, 'music']]) {
      // The close button counts as visible while the drawer is still sliding in (0.2s) with the switch
      // off screen; tap once it has arrived.
      await page.waitForFunction(() => Math.abs(document.querySelector('aside[role="dialog"]')?.getBoundingClientRect().left ?? -1) <= 1,
        { timeout: 5_000 });
      const checked = await page.$eval('#drawer-music-layout', input => input.checked);
      if (checked !== checkedBefore) throw new Error(`The drawer switch must show the layout on screen (music: ${checkedBefore}), got ${checked}`);
      await page.tap('label:has(#drawer-music-layout)');
      await page.waitForFunction(value => (value === 'music')
        === (document.documentElement.dataset.shell === 'music'), { timeout: 15_000 }, expected);
      await page.waitForSelector('button[aria-label="メニューを閉じる"]', { visible: true });
      await assertSinglePlayer(page, `switching to ${expected} from the phone drawer`);
    }
    await assertNoHorizontalOverflow(page, 'phone drawer layout switch');
    console.log('PASS the phone drawer switches the layout both ways in one tap');

    // Its ダークモード row swaps the theme in one tap too (the default theme is dark).
    for (const [checkedBefore, expected] of [[true, 'light'], [false, 'dark']]) {
      await page.waitForFunction(() => Math.abs(document.querySelector('aside[role="dialog"]')?.getBoundingClientRect().left ?? -1) <= 1,
        { timeout: 5_000 });
      const checked = await page.$eval('#drawer-dark-theme', input => input.checked);
      if (checked !== checkedBefore) throw new Error(`The drawer's ダークモード must show the theme on screen (dark: ${checkedBefore}), got ${checked}`);
      await page.tap('label:has(#drawer-dark-theme)');
      await page.waitForFunction(value => document.documentElement.dataset.theme === value
        && localStorage.getItem('diva_themeMode') === JSON.stringify(value), { timeout: 5_000 }, expected);
    }
    await assertSinglePlayer(page, 'switching the theme from the phone drawer');
    console.log('PASS the phone drawer switches the theme both ways in one tap');
    await context.close();
  }

  // Phones: muted playback can be unmuted from the mini bar, and ✕ closes the player.
  {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, volume: 0 });
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForSelector('[data-testid="music-mini-unmute"]');
    await page.tap('[data-testid="music-mini-unmute"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="music-mini-unmute"]'));
    await page.waitForFunction(() => window.__ytVolume > 0, { timeout: 5_000 });
    await page.tap('[data-testid="music-mini-close"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="music-mini-bar"]'));
    if (await page.evaluate(() => localStorage.getItem('diva_playerQueue'))) throw new Error('✕ must close the player and its queue');
    console.log('PASS phone mini bar unmutes muted playback and closes the player');
    await context.close();
  }

  // Phones held sideways (short): the video sits whole in the corner, the bars end to its left, and
  // every control of the bars stays clear of it (the player bar drops its optional parts, and below
  // 800px puts the title over キュー / ミュート / ⋮ so it keeps room).
  for (const viewport of [
    { width: 568, height: 320, isMobile: true, hasTouch: true },
    { width: 640, height: 360, isMobile: true, hasTouch: true },
    { width: 667, height: 375, isMobile: true, hasTouch: true },
    { width: 740, height: 340, hasTouch: true },
    { width: 844, height: 390, isMobile: true, hasTouch: true },
  ]) {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport });
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForSelector('[data-testid="global-player"].global-mini-player');
    const card = await assertVideoVisible(page, `short screen video at ${viewport.width}×${viewport.height}`);
    const overlap = await page.evaluate(() => {
      const video = document.querySelector('[data-testid="global-player"]').getBoundingClientRect();
      const header = document.querySelector('header').getBoundingClientRect();
      const bars = [...document.querySelectorAll('.music-player-bar, .music-mini-bar, .music-bottom-nav')]
        .map(element => element.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0);
      return {
        underHeader: video.top < header.bottom - 0.5,
        barsOverVideo: bars.some(rect => rect.right > video.left + 0.5 && rect.bottom > video.top + 0.5),
      };
    });
    if (overlap.underHeader || overlap.barsOverVideo) throw new Error(`Short screens keep the video clear of the header and bars ${JSON.stringify(overlap)}`);
    await assertNoHorizontalOverflow(page, `short screen ${viewport.width}×${viewport.height}`);
    // The bars' rects can end left of the video while their contents overflow under it (the fixed bar
    // does not clip): a tap at each control's centre must reach that control, not the embed.
    const measureBars = () => page.evaluate(() => {
      const reached = element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(hit && element.contains(hit));
      };
      const bars = [...document.querySelectorAll('.music-player-bar, .music-mini-bar, .music-bottom-nav')];
      const controls = bars.flatMap(bar => [...bar.querySelectorAll('button, a[href], [role="link"]')])
        .filter(control => {
          const rect = control.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map(control => ({
          name: control.dataset.testid || control.getAttribute('aria-label') || control.textContent.trim(),
          reached: reached(control),
        }));
      const bar = document.querySelector('[data-testid="music-player-bar"]');
      const barShown = Boolean(bar && bar.getBoundingClientRect().width > 0);
      if (!barShown) return { controls, barShown };
      // The title is the bar's only link to the song page there (the artwork is optional).
      const title = bar.querySelector('a[href*="watch"]:not([aria-hidden])');
      const titleBox = title?.getBoundingClientRect();
      const extras = bar.querySelector('[data-bar-extras]');
      const artist = bar.querySelector('[data-bar-artist]');
      const remaining = artist && [...artist.querySelectorAll('span')].find(span => span.textContent.includes('残り'));
      const remainingBox = remaining?.getBoundingClientRect();
      // Nor does it clip vertically: each of its parts must sit within its 72px.
      const box = bar.getBoundingClientRect();
      const style = getComputedStyle(bar);
      const top = box.top + Number.parseFloat(style.paddingTop);
      const bottom = box.bottom - Number.parseFloat(style.paddingBottom);
      return {
        controls,
        barShown,
        barOverflow: bar.scrollWidth - bar.clientWidth,
        line: bar.querySelector('[role="slider"]')?.getBoundingClientRect().width ?? 0,
        title: Math.round(titleBox?.width ?? 0),
        titleHeight: Math.round(titleBox?.height ?? 0),
        titleGap: titleBox && extras ? Math.round(extras.getBoundingClientRect().top - titleBox.bottom) : null,
        titleReached: Boolean(title && reached(title)),
        columns: style.gridTemplateColumns.split(' ').length,
        artist: Math.round(artist?.getBoundingClientRect().height ?? 0),
        // The <p> clips: its 残り must end inside it.
        remaining: Boolean(remainingBox && remainingBox.width > 0
          && remainingBox.right <= artist.getBoundingClientRect().right + 0.5),
        partsOutside: [...bar.children].map(child => child.getBoundingClientRect())
          .filter(rect => rect.height > 0 && (rect.top < top - 0.5 || rect.bottom > bottom + 0.5))
          .map(rect => `${Math.round(rect.top - top)}..${Math.round(rect.bottom - top)} of ${Math.round(bottom - top)}`),
      };
    });
    const assertBars = (reach, timer = false) => {
      const when = timer ? ' with a sleep timer' : '';
      const missed = reach.controls.filter(control => !control.reached).map(control => control.name);
      if (reach.controls.length === 0 || missed.length > 0) {
        throw new Error(`Short screen ${viewport.width}×${viewport.height}${when}: controls under the video ${JSON.stringify(missed)} of ${reach.controls.length}`);
      }
      if (!reach.barShown) return;
      const required = ['music-play-toggle', 'music-player-queue', 'music-mute-toggle', 'music-player-more'];
      const shown = new Set(reach.controls.map(control => control.name));
      const absent = required.filter(name => !shown.has(name));
      // One row beside 前 / 再生 / 次 and キュー / ミュート / ⋮ left the title 0px at 640×360, 27px at 667×375.
      if (absent.length > 0 || reach.barOverflow > 1 || reach.line < 100 || reach.title < 96 || !reach.titleReached
        || reach.partsOutside.length > 0) {
        throw new Error(`The short-screen bar${when} keeps the title, play, queue, mute, ⋮ and the progress line inside it ${JSON.stringify({ absent, ...reach, controls: undefined })}`);
      }
      // The 800px cut-off: below it two rows, a 24px title 6px over キュー / ミュート / ⋮ and no artist line
      // (nor the timer's 残り in it); from it the one row of three columns keeps the artist line and 残り.
      const twoRows = viewport.width < 800;
      if (twoRows
        ? reach.columns !== 2 || reach.artist > 0 || reach.titleHeight < 24 || reach.titleGap < 6
        : reach.columns !== 3 || reach.artist === 0 || (timer && !reach.remaining)) {
        throw new Error(`Short screen ${viewport.width}×${viewport.height}${when}: ${twoRows
          ? 'below 800px the bar has two rows, a 24px title 6px over キュー / ミュート / ⋮ and no artist line'
          : `from 800px the bar keeps one row of three with the artist line${timer ? ' and 残り' : ''}`} ${JSON.stringify({ ...reach, controls: undefined })}`);
      }
    };
    const reach = await measureBars();
    assertBars(reach);
    if (reach.barShown) {
      // The bar's progress line seeks on touch too (the standard mini player's is display-only there).
      const seekLine = await page.waitForSelector('[data-testid="music-player-bar"] [role="slider"][tabindex="0"]', { timeout: 10_000 });
      const seekPoint = await seekLine.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width * 0.75, y: rect.top + rect.height / 2 };
      });
      await page.touchscreen.tap(seekPoint.x, seekPoint.y);
      await page.waitForFunction(() => Math.abs(window.__yt.getCurrentTime() - 150) < 10, { timeout: 5_000 });

      // A running sleep timer adds its 残り to the artist line: the bar still holds all its parts.
      await page.tap('[data-testid="music-player-more"]');
      await page.waitForSelector('[role="menu"] [role="menuitemradio"]', { visible: true });
      await new Promise(resolve => setTimeout(resolve, 300));
      const timer = await page.evaluate(() => {
        const item = [...document.querySelectorAll('[role="menu"] [role="menuitemradio"]')]
          .find(element => element.textContent.trim() === '15分');
        if (!item) return null;
        item.scrollIntoView({ block: 'nearest' });
        const rect = item.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, reached: Boolean(hit && item.contains(hit)) };
      });
      if (!timer?.reached) throw new Error(`The bar's ⋮ must offer a reachable 15分 sleep timer ${JSON.stringify(timer)}`);
      await page.touchscreen.tap(timer.x, timer.y);
      await page.waitForFunction(() => !document.querySelector('[role="menu"]')
        && document.querySelector('[data-testid="music-player-bar"]').textContent.includes('残り'), { timeout: 5_000 });
      assertBars(await measureBars(), true);

      // プレイヤーを閉じる lives in the bar's ⋮ only.
      await page.tap('[data-testid="music-player-more"]');
      await page.waitForSelector('[role="menu"] [role="menuitem"]', { visible: true });
      // Let the menu's opening scale settle before measuring where to tap.
      await new Promise(resolve => setTimeout(resolve, 300));
      const close = await page.evaluate(() => {
        const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
          .find(element => element.textContent.trim() === 'プレイヤーを閉じる');
        if (!item) return null;
        item.scrollIntoView({ block: 'nearest' });
        const rect = item.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, reached: Boolean(hit && item.contains(hit)) };
      });
      if (!close?.reached) throw new Error(`The bar's ⋮ must offer a reachable プレイヤーを閉じる ${JSON.stringify(close)}`);
      await page.touchscreen.tap(close.x, close.y);
      // The bar stays in place with nothing loaded.
      await page.waitForFunction(() => document.querySelector('[data-testid="music-play-toggle"]')?.disabled === true, { timeout: 5_000 });
    }
    console.log(`PASS ${viewport.width}×${viewport.height}: video ${Math.round(card.width)}×${Math.round(card.height)} whole in the corner, ${reach.controls.length} controls clear of it${reach.barShown ? `, ${reach.title}px title in ${reach.columns === 2 ? 'two rows' : 'one row'}, touch seeks, fits a sleep timer, ⋮ closes the player` : ''}`);
    await context.close();
  }

  await checkNarrowShortWindows();

  // The song page: its own video fits between the header and the bars on short windows (nothing over it,
  // not even a few pixels of a bar).
  for (const viewport of [{ width: 1000, height: 600 }, { width: 844, height: 390, hasTouch: true }, { width: 568, height: 320, isMobile: true, hasTouch: true }]) {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport });
    await open(page, `watch?v=${songs[0].id}`);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForFunction(() => document.querySelector('[data-testid="global-player"]')?.style.position === 'absolute', { timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(resolve => setTimeout(resolve, 300));
    const watch = await videoState(page);
    if (!videoClear(watch)) throw new Error(`Song page video at ${viewport.width}×${viewport.height} must be whole, ≥200×200 and clear ${JSON.stringify(watch)}`);
    const mobileBars = await page.evaluate(() => Boolean(document.querySelector('[data-testid="music-mini-bar"], .music-bottom-nav')));
    if (viewport.isMobile && mobileBars) throw new Error('Phones show no bottom nav or mini bar on the song page, like the standard layout');
    console.log(`PASS song page at ${viewport.width}×${viewport.height}: video ${Math.round(watch.width)}×${Math.round(watch.height)} clear of the bars`);
    await context.close();
  }

  await checkShortSongPages();

  // Short desktop window: the docked video stays inside the panel, above the bar.
  {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport: { width: 1440, height: 380 } });
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForSelector('[data-testid="global-player"].music-docked-player');
    await assertVideoVisible(page, 'docked video in a 380px tall window');
    console.log('PASS short desktop window keeps the docked video above the bar');
    await context.close();
  }

  // Another tab plays (or a restored paused queue): the panel offers to play here, then docks the video.
  {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport: { width: 1440, height: 900 }, playing: false });
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="music-now-playing-resume"]', { timeout: 20_000 });
    if (await page.$('[data-testid="global-player"].music-docked-player')) throw new Error('A paused restored queue must not dock a video yet');
    await page.waitForFunction(() => window.__yt?.getVideoData?.().video_id);
    await page.click('[data-testid="music-now-playing-resume"]');
    await page.waitForSelector('[data-testid="global-player"].music-docked-player', { timeout: 15_000 });
    await assertVideoVisible(page, 'docked video after playing a restored queue from the panel');
    console.log('PASS the panel resumes a restored queue here and docks its video');
    await context.close();
  }

  // A failed music chunk falls back to the standard frame for this session.
  {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport: { width: 1280, height: 800 }, failMusicChunk: true });
    page.on('console', () => undefined);
    await open(page);
    await page.waitForSelector('aside nav', { timeout: 30_000 });
    const state = await page.evaluate(() => ({ shell: document.documentElement.dataset.shell ?? null, saved: localStorage.getItem('diva_uiLayout') }));
    if (state.shell !== null || state.saved !== '"music"') throw new Error(`A failed music chunk must show the standard layout without changing the saved choice ${JSON.stringify(state)}`);
    await page.click('button[aria-label="設定"]');
    await page.waitForSelector('#settings-tab-playback');
    await page.click('#settings-tab-playback');
    await page.waitForSelector('[data-testid="settings-ui-layout"]');
    const shown = await page.$eval('[data-testid="settings-ui-layout"]', select => select.value);
    if (shown !== 'standard') throw new Error(`Settings must show the layout on screen (standard), got ${shown}`);
    console.log('PASS a failed music chunk shows the standard layout and keeps the choice');
    await context.close();
  }

  await checkHistoryWidthChanges();
  await checkRemainingOverlaps();

  if (caseFailures.length > 0) throw new Error(`${caseFailures.length} short-window case(s) failed:\n${caseFailures.join('\n')}`);
  if (pageErrors.length > 0) throw new Error(`Uncaught page errors:\n${pageErrors.join('\n')}`);
  console.log('PASS music layout E2E');
  }
} finally {
  await browser.close();
}

// History in the music layout follows the width the page really has (useElementWidth). Opening or
// closing the 再生中 panel and switching the layout change that width without an event React sees,
// so the new layout must still be rendered before the frame is painted. Called at the end of the
// run above (a function declaration, so it is defined by then).
async function checkHistoryWidthChanges() {
  const viewport = { width: 1440, height: 900 };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  // 12 plays (stored the way test-navigation-e2e seeds them), so the page scrolls in every variant.
  async function openHistory(page) {
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await page.waitForFunction(async () => (await indexedDB.databases()).some(database => database.name === 'diva-listening-history'),
      { polling: 100, timeout: 20_000 });
    await page.evaluate(async ids => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('diva-listening-history', 3);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = database.transaction('plays', 'readwrite');
        const store = tx.objectStore('plays');
        store.clear();
        const now = Date.now();
        ids.forEach((s, index) => store.add({ s, t: now - index * 3_600_000, f: 0 }));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      database.close();
    }, homeSongs.slice(0, 12).map(item => item.id));
    await open(page, 'history');
    await page.waitForFunction(() => document.querySelector('main [class*="w-[246px]"], main [class*="w-[168px]"]')
      && !document.querySelector('main [aria-busy="true"]'), { timeout: 20_000 });
    await wait(500);
  }

  const togglePanel = page => page.click('[data-testid="music-now-playing-toggle"]');
  // Waits for the top bar's layout switch and returns the click on the layout's button.
  async function layoutSwitch(page, layout) {
    await page.waitForSelector(`[data-testid="topnav-layout-${layout}"]`, { visible: true });
    return async () => {
      await page.click(`[data-testid="topnav-layout-${layout}"]`);
      await page.waitForFunction(music => (document.documentElement.dataset.shell === 'music') === music,
        { timeout: 15_000 }, layout === 'music');
    };
  }

  // Every painted frame: a ResizeObserver created during the frame (so newer than the app's, and
  // called after it) records the page at the end of the frame's ResizeObserver delivery. Only
  // microtasks run between that and the paint. Once a change has settled, every frame that already
  // had the final width must also have had the final layout (the right column, the rows' size).
  {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport });
    await openHistory(page);
    await page.evaluate(() => {
      const frames = window.__historyFrames = [];
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.append(probe);
      let observer = null;
      const sample = () => {
        // The content's box (the parent of its backup file input) is the width the page measures.
        const content = document.querySelector('main input[type="file"][accept="application/json,.json"]')?.parentElement;
        frames.push({
          width: Math.round((content?.getBoundingClientRect().width ?? 0) * 10) / 10,
          rail: Boolean(document.querySelector('main [data-testid="history-actions"]')),
          rows: document.querySelector('main [class*="w-[246px]"]') ? 'lg' : document.querySelector('main [class*="w-[168px]"]') ? 'md' : null,
        });
      };
      const frame = () => {
        observer?.disconnect();
        observer = new ResizeObserver(sample);
        // A size it has not reported, so it is called in this frame.
        probe.style.width = probe.style.width === '1px' ? '2px' : '1px';
        observer.observe(probe);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await wait(300);
    const measure = async (label, act) => {
      await page.evaluate(() => { window.__historyFrames.length = 0; });
      await act();
      await wait(600);
      const frames = await page.evaluate(() => window.__historyFrames.splice(0));
      const before = frames[0];
      const settled = frames.at(-1);
      if (frames.length < 10 || !before || !settled || settled.width === 0) throw new Error(`${label}: History frames were not sampled ${JSON.stringify(frames)}`);
      if (Math.abs(settled.width - before.width) < 1) throw new Error(`${label}: the page width did not change ${JSON.stringify({ before, settled })}`);
      const stale = frames.filter(frame => Math.abs(frame.width - settled.width) < 0.5
        && (frame.rail !== settled.rail || frame.rows !== settled.rows));
      if (stale.length > 0) {
        throw new Error(`${label}: History painted ${stale.length} frame(s) at the new width in the previous width's layout ${JSON.stringify({ before, settled, stale })}`);
      }
      return settled;
    };
    const first = await measure('History: 再生中 panel toggled', () => togglePanel(page));
    const second = await measure('History: 再生中 panel toggled back', () => togglePanel(page));
    if (first.rail === second.rail) throw new Error(`History at 1440px must switch its right column with the 再生中 panel ${JSON.stringify({ first, second })}`);
    await measure('History: music → standard', await layoutSwitch(page, 'standard'));
    await measure('History: standard → music', await layoutSwitch(page, 'music'));
    console.log(`PASS History at 1440×900 paints no frame in the previous width's layout (panel ${first.width}px ↔ ${second.width}px, both layout switches)`);
    await context.close();
  }

  // The same changes without the sampler, which would hide it: rendered inside the ResizeObserver
  // callback, a layout switch that resized the measured element would leave its notification for
  // the next frame and fire "ResizeObserver loop completed with undelivered notifications". Not a
  // general rule, so pinned to 1440×900 with 12 plays: where a switch also shows or hides the
  // window's scrollbar (a short history at some heights) it can still fire, benignly (see
  // useElementWidth).
  {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport });
    await page.evaluateOnNewDocument(() => {
      if (window !== window.top) return;
      window.__windowErrors = [];
      window.addEventListener('error', event => window.__windowErrors.push(String(event.message)));
    });
    await openHistory(page);
    for (let toggle = 0; toggle < 2; toggle++) {
      await togglePanel(page);
      await wait(600);
    }
    for (const layout of ['standard', 'music']) {
      await (await layoutSwitch(page, layout))();
      await wait(600);
    }
    const loopErrors = await page.evaluate(() => window.__windowErrors.filter(message => message.includes('ResizeObserver loop')));
    if (loopErrors.length > 0) throw new Error(`History width changes must not end a frame with a ResizeObserver loop error ${JSON.stringify(loopErrors)}`);
    console.log('PASS History width changes leave no ResizeObserver loop error');
    await context.close();
  }
}

/** A new browser context for one case: a failure is recorded (caseFailures) and the next case runs. */
async function runCase(label, run) {
  const context = await browser.createBrowserContext();
  try {
    await run(context);
  } catch (error) {
    caseFailures.push(`${label}: ${error.message}`);
    console.log(`FAIL ${label}: ${error.message}`);
  } finally {
    await context.close().catch(() => undefined);
  }
}

// The music layout under 560px wide and 420px tall (split screen, small windows): beside the corner video
// no room is left for the bars (320×360 drew the mini bar's ▶ / ✕ on it), so while a song is loaded the
// mini bar runs along the bottom, the video sits whole above it and the bottom nav steps aside for the
// top bar's ≡ (index.css area:music). Also the cases next to it: the selection bar, toasts, the muted
// mini bar beside the corner video from 560px, and the sound map's selection bar.
async function checkNarrowShortWindows() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const phone = (width, height) => ({ width, height, isMobile: true, hasTouch: true });
  const playOn = async (context, viewport, { path = '', ...options } = {}) => {
    const page = await preparePage(context, { layout: 'music', viewport, ...options });
    await open(page, path);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForSelector('[data-testid="global-player"].global-mini-player');
    // From 640px the player bar instead of the mini bar.
    await page.waitForSelector(viewport.width < 640 ? '[data-testid="music-mini-bar"]' : '[data-testid="music-player-bar"]');
    await wait(300);
    return page;
  };
  const selectionBarBottom = page => page.evaluate(() => document.querySelector('[data-testid="selection-fab"]').getBoundingClientRect().bottom);
  const startSelecting = async page => {
    await page.tap('[data-selection-toggle]');
    await page.waitForSelector('[data-testid="selection-fab"]', { timeout: 10_000 });
    await wait(400);
  };

  for (const viewport of [phone(320, 360), phone(360, 400), phone(414, 400), { width: 480, height: 400, hasTouch: true }, { width: 559, height: 400, hasTouch: true }]) {
    const size = `${viewport.width}×${viewport.height}`;
    await runCase(`narrow short ${size}`, async context => {
      const page = await playOn(context, viewport);
      const video = await videoState(page);
      const bar = await miniBarState(page);
      if (!videoClear(video) || bar.underHeader || bar.gap < 1 || !bar.fullWidth || bar.overflow > 0 || bar.missed.length > 0
        || bar.controls.length < 4 || bar.title < 96 || bar.nav || !bar.menu) {
        throw new Error(`the video whole above a full-width mini bar with every control clear, ≡ instead of the bottom nav ${JSON.stringify({ video, ...bar })}`);
      }
      // M: the toast stays on screen and off the video; with ミュートを解除 the five controls still fit.
      await muteWithKey(page, 'ミュートしました');
      await page.waitForSelector('[data-testid="music-mini-unmute"]');
      const toast = await toastState(page);
      const muted = await miniBarState(page);
      if (!toast || toast.top < 0 || toast.overVideo || toast.overControls.length > 0
        || muted.controls.length < 5 || muted.missed.length > 0 || muted.overflow > 0) {
        throw new Error(`muted: the toast on screen and off the video, five controls clear ${JSON.stringify({ toast, ...muted })}`);
      }
      await page.tap('[data-testid="music-mini-unmute"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="music-mini-unmute"]'), { timeout: 5_000 });
      await page.tap('[data-testid="music-mini-play-toggle"]');
      await page.waitForFunction(() => window.__yt.getPlayerState() === 2, { timeout: 5_000 });
      await page.tap('[data-testid="music-mini-play-toggle"]');
      await page.waitForFunction(() => window.__yt.getPlayerState() === 1, { timeout: 5_000 });
      await assertNoHorizontalOverflow(page, `narrow short ${size}`);

      // ≡ opens the drawer with every destination; Esc closes it and gives focus back to ≡.
      await page.tap('header button[aria-label="メニュー"]');
      await page.waitForSelector('aside[role="dialog"] button[aria-label="メニューを閉じる"]', { visible: true, timeout: 5_000 });
      await page.waitForFunction(() => Math.abs(document.querySelector('aside[role="dialog"]').getBoundingClientRect().left) <= 1, { timeout: 5_000 });
      const links = await page.$$eval('aside[role="dialog"] a[href]', anchors => anchors.map(anchor => new URL(anchor.href).pathname));
      const missing = ['/chorus-highlights', '/playlists', '/history'].filter(path => !links.some(link => link.endsWith(path)));
      if (missing.length > 0) throw new Error(`the drawer must list every destination, missing ${missing.join(', ')}`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('aside[role="dialog"]')
        && document.querySelector('aside[aria-label="メニュー"]').getBoundingClientRect().right <= 1, { timeout: 5_000 });
      const focus = await page.evaluate(() => document.activeElement?.matches('header button[aria-label="メニュー"]') ?? false);
      if (!focus) throw new Error(`Esc must give focus back to ≡, got ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))}`);

      // ✕ closes the player: the bottom nav comes back with its five names, and ≡ goes.
      await page.tap('[data-testid="music-mini-close"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="music-mini-bar"]'), { timeout: 5_000 });
      const closed = await page.evaluate(() => {
        const nav = document.querySelector('.music-bottom-nav');
        const menu = document.querySelector('header button[aria-label="メニュー"]');
        return {
          nav: Boolean(nav && Math.abs(nav.getBoundingClientRect().width - innerWidth) <= 0.5),
          // Four link names and ≡'s (aria-hidden: the button has its own label).
          names: nav ? [...nav.querySelectorAll('li span')].filter(span => span.textContent.trim() && span.getBoundingClientRect().width > 2).length : 0,
          menu: Boolean(menu && menu.getClientRects().length > 0),
        };
      });
      if (!closed.nav || closed.names !== 5 || closed.menu) throw new Error(`✕ must bring the bottom nav back with its names and hide ≡ ${JSON.stringify(closed)}`);
      console.log(`PASS narrow short ${size}: video ${video.width}×${video.height} whole above the full-width mini bar (${bar.title}px title), ≡ and the drawer instead of the bottom nav, the toast on screen`);
    });
  }

  // Heights where header + 200 + the mini bar only just fit (306px), and below (the video takes the room left).
  for (const { viewport, minHeight } of [
    { viewport: phone(400, 340), minHeight: 199.5 },
    { viewport: phone(360, 306), minHeight: 199.5 },
    { viewport: phone(360, 300), minHeight: 190 },
  ]) {
    const size = `${viewport.width}×${viewport.height}`;
    await runCase(`narrow short ${size}`, async context => {
      const page = await playOn(context, viewport);
      const video = await videoState(page);
      const bar = await miniBarState(page);
      if (video.error || video.height < minHeight || video.width < 199.5 || !video.inside || video.blocked > 0 || video.over.length > 0
        || bar.underHeader || bar.gap < 1 || bar.missed.length > 0) {
        throw new Error(`the video ≥${minHeight}px tall between the header and the mini bar, nothing over it ${JSON.stringify({ video, ...bar })}`);
      }
      await muteWithKey(page, 'ミュートしました');
      const toast = await toastState(page);
      if (!toast || toast.top < 0 || toast.overVideo) throw new Error(`the toast must stay on screen and off the video ${JSON.stringify(toast)}`);
      console.log(`PASS narrow short ${size}: video ${video.width}×${video.height} between the header and the mini bar, toast ${toast.top}..${toast.bottom}`);
    });
  }

  // The selection bar (z-index 48, over the video's 45) pushes the video down; under 362px tall it shrinks instead.
  for (const { viewport, minHeight } of [
    { viewport: phone(360, 400), minHeight: 199.5 },
    { viewport: phone(320, 360), minHeight: 175 },
    { viewport: phone(400, 340), minHeight: 175 },
  ]) {
    const size = `${viewport.width}×${viewport.height}`;
    await runCase(`narrow short ${size} while selecting`, async context => {
      const page = await playOn(context, viewport);
      await startSelecting(page);
      const video = await videoState(page);
      const barBottom = await selectionBarBottom(page);
      const bar = await miniBarState(page);
      if (video.error || video.top < barBottom - 0.5 || video.height < minHeight || video.blocked > 0 || video.over.length > 0 || bar.gap < 1) {
        throw new Error(`the video under the selection bar (${barBottom}) and above the mini bar, ≥${minHeight}px tall ${JSON.stringify({ video, gap: bar.gap })}`);
      }
      console.log(`PASS narrow short ${size} while selecting: video ${video.width}×${video.height} from ${video.top}, under the selection bar`);
    });
  }

  // Phones from 420px tall stack the video (up to 240px) on the mini bar: never as far up as the selection bar.
  for (const viewport of [phone(400, 420), phone(600, 430), phone(639, 420), phone(390, 844)]) {
    const size = `${viewport.width}×${viewport.height}`;
    await runCase(`phone ${size} while selecting`, async context => {
      const page = await playOn(context, viewport);
      await startSelecting(page);
      const video = await videoState(page);
      const barBottom = await selectionBarBottom(page);
      // 390×844 has room: the width's 16:9 as before.
      const expected = viewport.height > 800 ? (viewport.width - 16) * 9 / 16 : null;
      if (!videoClear(video) || video.top < barBottom - 0.5 || (expected !== null && Math.abs(video.height - expected) > 0.5)) {
        throw new Error(`the stacked video must stay under the selection bar (${barBottom}) ${JSON.stringify({ video, expected })}`);
      }
      console.log(`PASS phone ${size} while selecting: video ${video.width}×${video.height} from ${video.top}, under the selection bar`);
    });
  }

  // From 560px the video stays in the corner at 356×200, the mini bar beside it. Muted, its four buttons
  // step down to 40px where they would not fit (560-575px) and none reaches the video.
  for (const viewport of [phone(560, 400), phone(575, 400), phone(576, 400), phone(568, 320), phone(600, 400)]) {
    const size = `${viewport.width}×${viewport.height}`;
    await runCase(`corner ${size} muted`, async context => {
      const page = await playOn(context, viewport, { volume: 0 });
      await page.waitForSelector('[data-testid="music-mini-unmute"]');
      const video = await videoState(page);
      const bar = await miniBarState(page);
      const buttons = bar.controls.filter(control => control.name !== 'music-mini-open');
      const size44 = viewport.width >= 576;
      if (!videoClear(video) || Math.abs(video.height - 200) > 0.5 || buttons.length !== 4 || bar.missed.length > 0 || bar.overflow > 0
        || buttons.some(control => control.width !== (size44 ? 44 : 40))) {
        throw new Error(`the corner video 200px tall, four ${size44 ? 44 : 40}px buttons beside it ${JSON.stringify({ video, ...bar })}`);
      }
      console.log(`PASS corner ${size} muted: video ${video.width}×${video.height}, four ${buttons[0].width}px buttons clear of it`);
    });
  }

  // The corner video is 200px tall under the top bar and the selection bar; only where they leave less
  // (under 312px tall while selecting, 320px from 640px wide; 256 / 264px without) it takes the room left
  // instead of going under them (568×300 had the selection bar 12px over it, 667×240 the top bar 24px).
  for (const { viewport, select } of [
    { viewport: phone(568, 300), select: true },
    { viewport: { width: 780, height: 300, hasTouch: true }, select: true },
    { viewport: phone(667, 240), select: false },
  ]) {
    const size = `${viewport.width}×${viewport.height}`;
    await runCase(`corner ${size}${select ? ' while selecting' : ''}`, async context => {
      const page = await playOn(context, viewport);
      if (select) await startSelecting(page);
      const video = await videoState(page);
      const above = select
        ? await selectionBarBottom(page)
        : await page.evaluate(() => document.querySelector('header').getBoundingClientRect().bottom);
      if (video.error || video.top < above - 0.5 || video.height < 175 || video.width < 355.5 || !video.inside
        || video.blocked > 0 || video.over.length > 0) {
        throw new Error(`the corner video under the ${select ? 'selection bar' : 'top bar'} (${above}), ≥175px tall, nothing over it ${JSON.stringify(video)}`);
      }
      await muteWithKey(page, 'ミュートしました');
      const toast = await toastState(page);
      if (!toast || toast.top < 0 || toast.overVideo) throw new Error(`the toast must stay on screen and off the video ${JSON.stringify(toast)}`);
      console.log(`PASS corner ${size}${select ? ' while selecting' : ''}: video ${video.width}×${video.height} from ${video.top}, under the ${select ? 'selection bar' : 'top bar'}, toast ${toast.top}..${toast.bottom}`);
    });
  }

  // A restored paused queue: the mini bar is at the bottom from the start, so ▶ does not move when the video appears.
  await runCase('narrow short 360×400 restored paused queue', async context => {
    const page = await preparePage(context, { layout: 'music', viewport: phone(360, 400), playing: false });
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="music-mini-play-toggle"]');
    await page.waitForFunction(() => window.__yt?.getVideoData?.().video_id, { timeout: 30_000 });
    await wait(500);
    const place = () => page.evaluate(() => {
      const shown = element => Boolean(element && element.getClientRects().length > 0);
      return {
        play: document.querySelector('[data-testid="music-mini-play-toggle"]').getBoundingClientRect().top,
        barBottom: document.querySelector('[data-testid="music-mini-bar"]').getBoundingClientRect().bottom,
        video: Boolean(document.querySelector('[data-testid="global-player"].global-mini-player')),
        nav: shown(document.querySelector('.music-bottom-nav')),
        menu: shown(document.querySelector('header button[aria-label="メニュー"]')),
      };
    });
    const before = await place();
    if (before.video || before.nav || !before.menu || Math.abs(before.barBottom - 400) > 0.5) {
      throw new Error(`a restored queue shows the mini bar at the bottom and ≡ instead of the bottom nav ${JSON.stringify(before)}`);
    }
    await page.tap('[data-testid="music-mini-play-toggle"]');
    await page.waitForSelector('[data-testid="global-player"].global-mini-player', { timeout: 15_000 });
    await wait(600);
    const after = await place();
    if (Math.abs(after.play - before.play) > 0.5) throw new Error(`▶ moved under the finger when the video appeared ${JSON.stringify({ before, after })}`);
    await assertVideoVisible(page, 'video after playing a restored queue at 360×400');
    console.log(`PASS narrow short 360×400 restored paused queue: ▶ stays at ${Math.round(before.play)} when the video appears`);
  });

  // The sound map's selection bar sits above the video card: it stops right under the top bar instead of
  // going under it, its buttons stay reachable, and toasts stay on screen and off the video. A phone from
  // 420px tall makes room for it above the stacked video (639×420 had the bar under the top bar). Under
  // 560px wide and about 354px tall the video shrinks rather than covering the bar's buttons (320×340 had
  // all three under the 200px video).
  for (const { viewport, minHeight } of [
    { viewport: phone(320, 360), minHeight: 199.5 },
    { viewport: phone(360, 400), minHeight: 199.5 },
    { viewport: phone(639, 420), minHeight: 199.5 },
    { viewport: phone(320, 340), minHeight: 160 },
    { viewport: phone(480, 320), minHeight: 160 },
  ]) {
    const size = `${viewport.width}×${viewport.height}`;
    await runCase(`sound map ${size}`, async context => {
      const page = await playOn(context, viewport, { path: 'sound-map?seedSongId=123' });
      await page.waitForSelector('[data-testid="sound-map-canvas"] g[role="button"][tabindex="0"]', { timeout: 30_000 });
      // Most of the map is under the video on so short a screen: a dot is picked with the keyboard.
      await page.evaluate(() => document.querySelector('[data-testid="sound-map-canvas"] g[role="button"][tabindex="0"]').focus());
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await page.waitForSelector('section[aria-labelledby="sound-map-selected-title"]', { timeout: 10_000 });
      await wait(400);
      const bar = await page.evaluate(() => {
        const section = document.querySelector('section[aria-labelledby="sound-map-selected-title"]');
        const buttons = [...section.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0);
        return {
          top: Math.round(section.getBoundingClientRect().top),
          headerBottom: document.querySelector('header').getBoundingClientRect().bottom,
          buttons: buttons.length,
          missed: buttons.filter(button => {
            const rect = button.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return !hit || !button.contains(hit);
          }).map(button => button.getAttribute('aria-label') || button.textContent.trim()),
        };
      });
      const video = await videoState(page);
      if (bar.top < bar.headerBottom - 0.5 || bar.buttons < 3 || bar.missed.length > 0 || video.error || video.height < minHeight
        || video.width < 199.5 || !video.inside || video.blocked > 0 || video.over.length > 0) {
        throw new Error(`the selection bar under the top bar with its buttons reachable, the video ≥${minHeight}px tall and clear ${JSON.stringify({ bar, video })}`);
      }
      await muteWithKey(page, 'ミュートしました');
      const toast = await toastState(page);
      if (!toast || toast.top < 0 || toast.overVideo) throw new Error(`the toast must stay on screen and off the video ${JSON.stringify(toast)}`);
      console.log(`PASS sound map ${size}: the selection bar from ${bar.top} with ${bar.buttons} reachable buttons, the video ${video.width}×${video.height} clear, toast ${toast.top}..${toast.bottom}`);
    });
  }
}

// The music layout's song page under 420px tall: the 72px player bar would cover the bottom of the video
// (at least 200px tall under the top bar; 4px at 740×340, 44px at 780×300), so it is left out and the
// page's own controls take over, as in the standard layout: ミュートを解除 in the action row and, once the
// video has scrolled off, the bottom row. Also the server band, which pushes the video down at any height.
async function checkShortSongPages() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const openSongPage = async (context, viewport, options = {}) => {
    const page = await preparePage(context, { layout: 'music', viewport, ...options });
    await open(page, `watch?v=${songs[0].id}`);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForFunction(() => document.querySelector('[data-testid="global-player"]')?.style.position === 'absolute', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="watch-action-bar"]', { timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(300);
    return page;
  };
  const toggleSelection = async (page, on) => {
    await page.click('button[aria-label="複数選択モード"]');
    await page.waitForFunction(shown => Boolean(document.querySelector('[data-testid="selection-fab"]')) === shown, { timeout: 10_000 }, on);
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(400);
  };
  const scrolledRow = async page => {
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForSelector('[data-testid="watch-scrolled-controls"]', { timeout: 5_000 });
    await wait(400);
    return page.evaluate(() => {
      const row = document.querySelector('[data-testid="watch-scrolled-controls"]').getBoundingClientRect();
      const library = document.querySelector('[data-testid="music-library"]')?.getBoundingClientRect() ?? null;
      const buttons = [...document.querySelectorAll('[data-testid="watch-scrolled-controls"] button')];
      return {
        left: Math.round(row.left),
        top: row.top,
        bottom: Math.round(row.bottom),
        libraryRight: library ? Math.round(library.right) : null,
        libraryBottom: library ? Math.round(library.bottom * 10) / 10 : null,
        buttons: buttons.length,
        missed: buttons.filter(button => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return !hit || !button.contains(hit);
        }).map(button => button.getAttribute('aria-label') || 'song'),
      };
    });
  };

  for (const viewport of [
    { width: 640, height: 360, isMobile: true, hasTouch: true },
    { width: 740, height: 340, hasTouch: true },
    { width: 780, height: 300 },
    { width: 844, height: 390, isMobile: true, hasTouch: true },
    { width: 1024, height: 400 },
    { width: 1280, height: 360 },
  ]) {
    const size = `${viewport.width}×${viewport.height}`;
    await runCase(`short song page ${size}`, async context => {
      const page = await openSongPage(context, viewport);
      const top = await videoState(page);
      if (!videoClear(top) || top.bar || top.musicBottom !== 'none') {
        throw new Error(`no player bar under the video, the video whole and clear ${JSON.stringify(top)}`);
      }
      // The selection bar pushes the video down: from 330px tall still whole; lower, it may run past the
      // window's bottom edge but nothing is drawn over it.
      await toggleSelection(page, true);
      const selecting = await videoState(page);
      if (!(viewport.height >= 330 ? videoClear(selecting) : videoUncovered(selecting))) {
        throw new Error(`with the selection bar nothing over the video ${JSON.stringify(selecting)}`);
      }
      await toggleSelection(page, false);
      // Once the video has scrolled off, the bottom row: right of the library, its three controls reachable.
      // With no bar, the library ends 8px above the window's bottom edge.
      const row = await scrolledRow(page);
      if (row.buttons !== 3 || row.missed.length > 0 || (row.libraryRight !== null && row.left < row.libraryRight)
        || (row.libraryBottom !== null && Math.abs(row.libraryBottom - (viewport.height - 8)) > 0.5)
        || Math.abs(row.bottom - viewport.height) > 1) {
        throw new Error(`the bottom row right of the library (which ends 8px above the bottom) with its controls reachable ${JSON.stringify(row)}`);
      }
      // Toasts go above the row (from 1024px too, where they sit bottom-left).
      await muteWithKey(page, 'ミュートしました');
      const toast = await toastState(page);
      if (!toast || toast.bottom > row.top + 0.5) throw new Error(`the toast must sit above the bottom row ${JSON.stringify({ toast, rowTop: row.top })}`);
      await page.keyboard.press('m');
      await page.click('[data-testid="watch-scrolled-controls"] button[aria-label="一時停止"]');
      await page.waitForFunction(() => window.__yt.getPlayerState() === 2, { timeout: 5_000 });
      console.log(`PASS short song page ${size}: video ${top.width}×${top.height} with no bar under it (${selecting.width}×${selecting.height} while selecting), the bottom row from ${row.left}px pauses, toasts above it`);
    });
  }

  // 420px tall is where the bar comes back: it fits there even with the selection bar.
  for (const { viewport, bar } of [
    { viewport: { width: 960, height: 419 }, bar: false },
    { viewport: { width: 960, height: 420 }, bar: true },
    { viewport: { width: 1300, height: 420 }, bar: true },
  ]) {
    const size = `${viewport.width}×${viewport.height}`;
    await runCase(`song page ${size}`, async context => {
      const page = await openSongPage(context, viewport);
      const top = await videoState(page);
      await toggleSelection(page, true);
      const selecting = await videoState(page);
      if (top.bar !== bar || !videoClear(top) || !videoClear(selecting)) {
        throw new Error(`${bar ? 'the bar' : 'no bar'}, the video clear with and without the selection bar ${JSON.stringify({ top, selecting })}`);
      }
      console.log(`PASS song page ${size}: ${bar ? 'the bar' : 'no bar'}, video ${top.width}×${top.height} (${selecting.width}×${selecting.height} while selecting) clear`);
    });
  }

  // Resizing across 420px: the bar goes and comes back with the video clear, and focus never falls to <body>.
  await runCase('song page 900×600 ↔ 900×380', async context => {
    const page = await openSongPage(context, { width: 900, height: 600 });
    const tall = await videoState(page);
    if (!videoClear(tall) || !tall.bar || tall.musicBottom !== null) throw new Error(`900×600 keeps the bar, the video clear ${JSON.stringify(tall)}`);
    await page.focus('[data-testid="music-play-toggle"]');
    await page.setViewport({ width: 900, height: 380 });
    await wait(150);
    const short = await videoState(page);
    const active = () => page.evaluate(() => (document.activeElement?.id || document.activeElement?.closest('[data-testid]')?.dataset.testid || document.activeElement?.tagName) ?? null);
    const shortFocus = await active();
    if (!videoClear(short) || short.bar || short.musicBottom !== 'none' || shortFocus !== 'main-content') {
      throw new Error(`900×380: no bar, the video clear, focus from the bar's ▶ on the page ${JSON.stringify({ short, shortFocus })}`);
    }
    const row = await scrolledRow(page);
    if (row.buttons !== 3) throw new Error(`900×380: the bottom row once the video has scrolled off ${JSON.stringify(row)}`);
    await page.focus('[data-testid="watch-scrolled-controls"] button[aria-label="一時停止"]');
    await page.setViewport({ width: 900, height: 600 });
    await wait(150);
    const back = await page.evaluate(() => ({
      bar: Boolean(document.querySelector('[data-testid="music-player-bar"]')),
      row: Boolean(document.querySelector('[data-testid="watch-scrolled-controls"]')),
      underVideo: Boolean(document.activeElement?.closest('[data-testid="watch-video-column"]')),
    }));
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(300);
    const again = await videoState(page);
    if (!back.bar || back.row || !back.underVideo || !videoClear(again)) {
      throw new Error(`back at 900×600: the bar instead of the row, focus under the video, the video clear ${JSON.stringify({ back, again })}`);
    }
    console.log(`PASS song page 900×600 ↔ 900×380: video ${tall.width}×${tall.height} / ${short.width}×${short.height}, the bar goes and comes back, focus kept on the page`);
  });

  // Enter on the bar's title opens a song page without the bar: focus goes to the page, not <body>.
  await runCase('740×340 the bar title to the song page', async context => {
    const page = await preparePage(context, { layout: 'music', viewport: { width: 740, height: 340 } });
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForSelector('[data-testid="global-player"].global-mini-player');
    const title = '[data-testid="music-player-bar"] [data-bar-song] a[href*="watch"]:not([aria-hidden])';
    await page.waitForSelector(title);
    await page.focus(title);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.pathname.endsWith('/watch')
      && !document.querySelector('[data-testid="music-player-bar"]'), { timeout: 10_000 });
    await wait(300);
    const focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
    if (focused !== 'main-content') throw new Error(`focus must move to the page when the bar goes away, got ${focused}`);
    console.log('PASS 740×340: Enter on the bar title opens the song page with focus on the page');
  });

  // The server band (40px under the top bar) pushes the song page's video down: it still clears the bar.
  for (const viewport of [{ width: 1000, height: 500 }, { width: 1920, height: 700 }, { width: 740, height: 340, hasTouch: true }]) {
    const size = `${viewport.width}×${viewport.height}`;
    await runCase(`song page ${size} with the server band`, async context => {
      const page = await openSongPage(context, viewport, { backendDown: true });
      await page.waitForSelector('[data-testid="backend-status-notice"]', { timeout: 30_000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await wait(400);
      const state = await videoState(page);
      if (!videoClear(state) || state.bar !== viewport.height >= 420) {
        throw new Error(`with the server band the video must stay whole and clear of the bar ${JSON.stringify(state)}`);
      }
      console.log(`PASS song page ${size} with the server band: video ${state.width}×${state.height} from ${state.top}, ${state.bar ? 'above the bar' : 'no bar'}`);
    });
  }

  // Muted: without the bar the action row offers ミュートを解除 (phones too); with the bar, its mute button.
  for (const viewport of [{ width: 740, height: 340, hasTouch: true }, { width: 1280, height: 360 }, { width: 390, height: 844, isMobile: true, hasTouch: true }, { width: 1000, height: 600 }]) {
    const size = `${viewport.width}×${viewport.height}`;
    const withBar = viewport.width >= 640 && viewport.height >= 420;
    await runCase(`muted song page ${size}`, async context => {
      const page = await openSongPage(context, viewport, { volume: 0 });
      const pill = '[data-testid="watch-action-bar"] button';
      const state = await page.evaluate(selector => ({
        pill: [...document.querySelectorAll(selector)].some(button => button.textContent.includes('ミュートを解除')),
        barMute: document.querySelector('[data-testid="music-mute-toggle"]')?.getAttribute('aria-label') ?? null,
      }), pill);
      if (withBar ? state.pill || state.barMute !== 'ミュートを解除' : !state.pill || state.barMute !== null) {
        throw new Error(`${withBar ? 'the bar\'s mute button says ミュートを解除 (no pill)' : 'ミュートを解除 in the action row'} ${JSON.stringify(state)}`);
      }
      if (!withBar) {
        await page.evaluate(selector => [...document.querySelectorAll(selector)].find(button => button.textContent.includes('ミュートを解除')).click(), pill);
        await page.waitForFunction(() => window.__ytVolume > 0, { timeout: 5_000 });
      }
      console.log(`PASS muted song page ${size}: ${withBar ? 'the bar\'s ミュートを解除' : 'ミュートを解除 in the action row unmutes'}`);
    });
  }

  // From 420px tall the song page keeps the bar and has no bottom row.
  await runCase('song page 1000×600 keeps the bar', async context => {
    const page = await openSongPage(context, { width: 1000, height: 600 });
    const state = await videoState(page);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await wait(600);
    const row = await page.evaluate(() => Boolean(document.querySelector('[data-testid="watch-scrolled-controls"]')));
    if (!videoClear(state) || !state.bar || state.musicBottom !== null || row) throw new Error(`the bar kept, the video clear, no bottom row ${JSON.stringify({ state, row })}`);
    console.log('PASS song page 1000×600 keeps the bar and no bottom row');
  });

  // Leaving a short song page brings the bar back, ending left of the corner video.
  await runCase('740×340 leaving the song page', async context => {
    const page = await openSongPage(context, { width: 740, height: 340, hasTouch: true });
    await page.evaluate(homeUrl => {
      const normalizePath = path => path.replace(/\/+$/, '') || '/';
      const home = new URL(homeUrl);
      const link = [...document.querySelectorAll('[data-testid="music-library"] a[href]')]
        .find(link => {
          const target = new URL(link.href);
          return target.origin === home.origin && normalizePath(target.pathname) === normalizePath(home.pathname);
        });
      if (!link) throw new Error(`Home link missing for ${home.href}`);
      link.click();
    }, base.href);
    await page.waitForSelector('[data-testid="global-player"].global-mini-player', { timeout: 10_000 });
    await page.waitForSelector('[data-testid="music-player-bar"]', { timeout: 10_000 });
    await wait(400);
    const back = await page.evaluate(() => ({
      musicBottom: document.documentElement.dataset.musicBottom ?? null,
      barRight: document.querySelector('[data-testid="music-player-bar"]').getBoundingClientRect().right,
      videoLeft: document.querySelector('[data-testid="global-player"]').getBoundingClientRect().left,
    }));
    if (back.musicBottom !== null || back.barRight > back.videoLeft + 0.5) throw new Error(`the bar back, left of the corner video ${JSON.stringify(back)}`);
    await assertVideoVisible(page, 'the corner video after leaving the short song page');
    console.log('PASS 740×340: leaving the song page brings the bar back left of the corner video');
  });

  // 1280×400: Home with the 再生中 panel, the song page (no bar), and back: the panel and its toggle return.
  await runCase('1280×400 再生中 panel round trip', async context => {
    const page = await preparePage(context, { layout: 'music', viewport: { width: 1280, height: 400 } });
    await open(page);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForSelector('[data-testid="global-player"].music-docked-player', { timeout: 15_000 });
    await page.evaluate(id => {
      history.pushState({}, '', `${location.pathname.replace(/\/$/, '')}/watch?v=${id}`);
      dispatchEvent(new PopStateEvent('popstate'));
    }, songs[0].id);
    await page.waitForFunction(() => document.querySelector('[data-testid="global-player"]')?.style.position === 'absolute'
      && !document.querySelector('[data-testid="music-player-bar"]'), { timeout: 20_000 });
    await page.goBack();
    await page.waitForSelector('[data-testid="global-player"].music-docked-player', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="music-now-playing"]');
    const toggle = await page.$eval('[data-testid="music-now-playing-toggle"]', button => ({ disabled: button.disabled, pressed: button.getAttribute('aria-pressed') }));
    if (toggle.disabled || toggle.pressed !== 'true') throw new Error(`the 再生中 toggle must be back on ${JSON.stringify(toggle)}`);
    await assertVideoVisible(page, 'the docked video after the song page');
    console.log('PASS 1280×400: the 再生中 panel, its video and its toggle come back after the song page');
  });
}

async function checkRemainingOverlaps() {
  const settle = () => new Promise(resolve => setTimeout(resolve, 400));
  for (const layout of ['standard', 'music']) {
    for (const viewport of [{ width: 1000, height: 500 }, { width: 1920, height: 700 }]) {
      await runCase(`${layout} song-page toast ${viewport.width}×${viewport.height}`, async context => {
        const page = await preparePage(context, { layout, viewport });
        await open(page, `watch?v=${songs[0].id}`);
        await startPlayback(page);
        await page.waitForFunction(() => document.querySelector('[data-testid="global-player"]')?.style.position === 'absolute');
        await page.keyboard.press('m');
        await page.waitForSelector('[data-testid="toast-host"] > div:not([aria-hidden])');
        await settle();
        const toast = await toastState(page);
        if (!toast || toast.top < 0 || toast.bottom > viewport.height || toast.overVideo) throw new Error(`toast overlaps song-page video ${JSON.stringify(toast)}`);
        console.log(`PASS ${layout} ${viewport.width}×${viewport.height} song-page toast stays clear of video`);
      });
    }
  }
  for (const viewport of [{ width: 568, height: 300 }, { width: 667, height: 240 }]) {
    await runCase(`standard corner ${viewport.width}×${viewport.height}`, async context => {
      const page = await preparePage(context, { layout: 'standard', viewport });
      await open(page);
      await startPlayback(page);
      await page.waitForSelector('.global-mini-player');
      await page.click('[data-selection-toggle]');
      await page.waitForSelector('[data-testid="selection-fab"]');
      await settle();
      const state = await videoState(page);
      if (state.error || state.width < 199.5 || state.height < 100 || !state.inside || state.blocked || state.over.length) throw new Error(`standard corner under selection/header ${JSON.stringify(state)}`);
      console.log(`PASS standard corner ${viewport.width}×${viewport.height} clears selection/header`);
    });
  }
  for (const viewport of [{ width: 1280, height: 300 }, { width: 1440, height: 280 }, { width: 1280, height: 420 }]) {
    await runCase(`docked panel ${viewport.width}×${viewport.height}`, async context => {
      const page = await preparePage(context, { layout: 'music', viewport });
      await open(page);
      await startPlayback(page);
      await page.waitForSelector('.music-docked-player');
      await settle();
      const state = await videoState(page);
      const slot = await page.$eval('.music-video-slot', element => ({ width: element.clientWidth, height: element.clientHeight }));
      if (state.error || state.width < 199.5 || state.height < 100 || !state.inside || state.blocked || state.over.length || Math.abs(state.height - slot.height) > 1 || Math.abs(state.width - slot.width) > 1) throw new Error(`panel and video must match above transport ${JSON.stringify({ state, slot })}`);
      console.log(`PASS docked ${viewport.width}×${viewport.height} video matches slot above transport`);
    });
  }
  await runCase('standard phone sound-map selection and toast', async context => {
    const page = await preparePage(context, { layout: 'standard', viewport: { width: 390, height: 340, isMobile: true, hasTouch: true } });
    await open(page, 'sound-map?seedSongId=123');
    await startPlayback(page);
    const dot = '[data-testid="sound-map-canvas"] g[role="button"][tabindex="0"]';
    await page.waitForSelector(dot);
    await page.evaluate(selector => document.querySelector(selector).focus(), dot);
    await page.keyboard.press('Enter');
    await page.waitForSelector('section[aria-labelledby="sound-map-selected-title"]');
    await muteWithKey(page, 'ミュートしました');
    const state = await page.evaluate(() => {
      const bar = document.querySelector('section[aria-labelledby="sound-map-selected-title"]');
      const rect = bar.getBoundingClientRect();
      const header = document.querySelector('header').getBoundingClientRect();
      const buttons = [...bar.querySelectorAll('button')].filter(button => !button.disabled).map(button => {
        const b = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
      });
      return { top: rect.top, headerBottom: header.bottom, buttons };
    });
    const toast = await toastState(page);
    if (state.top < state.headerBottom - .5 || state.buttons.some(value => !value) || !toast || toast.top < 0 || toast.overVideo) throw new Error(`sound-map selection/notification must stay reachable ${JSON.stringify({ state, toast })}`);
    console.log('PASS standard phone sound-map selection buttons reachable and toast on screen');
  });
}
