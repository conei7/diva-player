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

    // The top bar's ⋮ offers the same choice, one click away from any page.
    for (const value of ['music', 'standard']) {
      const other = value === 'music' ? 'standard' : 'music';
      await page.click('header button[aria-label="その他の操作"]');
      await page.waitForSelector(`[data-testid="topnav-layout-${value}"]`, { visible: true });
      const checked = await page.$eval(`[data-testid="topnav-layout-${other}"]`, item => item.getAttribute('aria-checked'));
      if (checked !== 'true') throw new Error(`The ⋮ menu must mark the layout on screen (${other}), got ${checked}`);
      await page.click(`[data-testid="topnav-layout-${value}"]`);
      await page.waitForFunction(expected => (expected === 'music')
        === (document.documentElement.dataset.shell === 'music'), { timeout: 15_000 }, value);
      await assertSinglePlayer(page, `switching to ${value} from the top bar`);
    }
    console.log('PASS the top bar ⋮ switches the layout both ways without touching playback');
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
    await page.tap('button[aria-label="メニュー"]');
    await page.waitForSelector('button[aria-label="メニューを閉じる"]', { visible: true });
    for (const [checkedBefore, expected] of [[true, 'standard'], [false, 'music']]) {
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

  await checkHistoryWidthChanges();

  if (pageErrors.length > 0) throw new Error(`Uncaught page errors:\n${pageErrors.join('\n')}`);
  console.log('PASS music layout E2E');
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
  // Opens the top bar's ⋮ and returns the click on the layout's item.
  async function layoutSwitch(page, layout) {
    await page.click('header button[aria-label="その他の操作"]');
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
