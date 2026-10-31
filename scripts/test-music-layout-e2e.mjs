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

async function preparePage(context, { layout, viewport, playing = true, failMusicChunk = false, volume } = {}) {
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
      response = json({ status: path.endsWith('/api/ready') ? 'ready' : 'ok', postgres: true, qdrant: true });
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

  // Phones held sideways (short): the video sits whole in the corner, the bars end to its left.
  for (const viewport of [{ width: 568, height: 320, isMobile: true, hasTouch: true }, { width: 740, height: 340, hasTouch: true }]) {
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
    console.log(`PASS ${viewport.width}×${viewport.height}: video ${Math.round(card.width)}×${Math.round(card.height)} whole in the corner`);
    await context.close();
  }

  // The song page: its own video fits between the header and the bars on short windows.
  for (const viewport of [{ width: 1000, height: 600 }, { width: 844, height: 390, hasTouch: true }, { width: 568, height: 320, isMobile: true, hasTouch: true }]) {
    const context = await browser.createBrowserContext();
    const page = await preparePage(context, { layout: 'music', viewport });
    await open(page, `watch?v=${songs[0].id}`);
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'music', { timeout: 30_000 });
    await startPlayback(page);
    await page.waitForFunction(() => document.querySelector('[data-testid="global-player"]')?.style.position === 'absolute', { timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(resolve => setTimeout(resolve, 300));
    const watch = await assertVideoVisible(page, `song page video at ${viewport.width}×${viewport.height}`);
    const mobileBars = await page.evaluate(() => Boolean(document.querySelector('[data-testid="music-mini-bar"], .music-bottom-nav')));
    if (viewport.isMobile && mobileBars) throw new Error('Phones show no bottom nav or mini bar on the song page, like the standard layout');
    console.log(`PASS song page at ${viewport.width}×${viewport.height}: video ${Math.round(watch.width)}×${Math.round(watch.height)} clear of the bars`);
    await context.close();
  }

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

  if (pageErrors.length > 0) throw new Error(`Uncaught page errors:\n${pageErrors.join('\n')}`);
  console.log('PASS music layout E2E');
} finally {
  await browser.close();
}
