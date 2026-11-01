import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });

const fixtureSong = {
  id: 900101,
  name: 'Player controls fixture',
  artistString: 'Fixture producer',
  createDate: '2026-01-01T00:00:00Z',
  defaultName: 'Player controls fixture',
  defaultNameLanguage: 'English',
  favoritedTimes: 0,
  lengthSeconds: 30,
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  pvs: [{ author: '', disabled: false, id: 9001011, length: 30, name: 'fixture', pvId: 'fixture', service: 'Youtube', pvType: 'Original', url: 'https://youtu.be/fixture' }],
};

// The mini player's play / pause toggle (its aria-label tells the state).
const PAUSE_BUTTON = '[data-testid="global-mini-player-toggle"][aria-label="一時停止"]';
const PLAY_BUTTON = '[data-testid="global-mini-player-toggle"][aria-label="再生"]';

// Muted (volume 0): ミュートを解除 is one of the mini player's controls and the song page's first action,
// never drawn on the video (YouTube: nothing in front of any part of the embedded player). This stub
// builds a real <iframe> where the IFrame API would, and records the volume it is given.
const MUTED_YOUTUBE_STUB = `
  window.YT = {
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 },
    Player: function (id, options) {
      const player = this; let state = -1; let videoId = ''; let volume = 50;
      const target = typeof id === 'string' ? document.getElementById(id) : id;
      const iframe = document.createElement('iframe');
      iframe.id = target.id; iframe.setAttribute('width', options.width ?? '640'); iframe.setAttribute('height', options.height ?? '390');
      iframe.src = 'about:blank'; iframe.title = 'YouTube video player';
      target.replaceWith(iframe);
      window.__yt = player;
      player.getIframe = () => iframe;
      player.getVideoData = () => ({ video_id: videoId });
      player.getPlayerState = () => state;
      player.getCurrentTime = () => 0;
      player.getDuration = () => 300;
      player.getVolume = () => volume;
      player.setVolume = value => { volume = value; window.__ytVolume = value; };
      player.isMuted = () => false; player.mute = () => {}; player.unMute = () => {};
      player.seekTo = () => {};
      player.cueVideoById = player.loadVideoById = value => { videoId = typeof value === 'string' ? value : value.videoId; state = 5; };
      const emit = () => options.events.onStateChange({ data: state, target: player });
      player.playVideo = () => { if (state === 1) return; state = 1; emit(); };
      player.pauseVideo = () => { state = 2; emit(); };
      player.stopVideo = () => { state = 0; };
      player.destroy = () => {};
      setTimeout(() => options.events.onReady({ target: player }), 0);
    },
  };
  window.onYouTubeIframeAPIReady();
`;

/** A fresh context whose tab owns playback of the fixture song with the saved volume at 0. */
async function openMutedPage([width, height]) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, isMobile: width < 640, hasTouch: width < 640 });
  await pinAppLanguage(page);
  await page.evaluateOnNewDocument(song => {
    if (window !== window.top || sessionStorage.getItem('muted-fixture-seeded')) return;
    sessionStorage.setItem('muted-fixture-seeded', '1');
    localStorage.setItem('diva_volume', '0');
    const tabId = 'muted-fixture-tab';
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    localStorage.setItem('diva-playback-owner-v1', JSON.stringify({ type: 'claim', tabId, songId: song.id, claimedAt: Date.now() }));
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue: [song], queueIndex: 0, currentSong: song, currentSongId: song.id,
      queueSources: ['manual'], currentPlaybackSource: 'manual',
    }));
  }, fixtureSong);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url() === 'https://www.youtube.com/iframe_api') {
      void request.respond({ contentType: 'application/javascript', body: MUTED_YOUTUBE_STUB });
    } else void request.continue();
  });
  return { context, page };
}

const SHOWN_IFRAME = '[data-testid="global-player"] .global-player-video iframe';

/**
 * Nothing painted in front of the embedded player may overlap it. Rect-based, with every element
 * made hit-testable: tooltips and bubbles ignore the pointer, so elementFromPoint alone misses them.
 */
async function assertNothingOverVideo(page, label) {
  const offenders = await page.evaluate(selector => {
    const iframe = [...document.querySelectorAll(selector)].find(frame => frame.getBoundingClientRect().width > 0);
    if (!iframe) return ['no embedded player'];
    const box = iframe.getBoundingClientRect();
    const style = document.createElement('style');
    style.textContent = '* { pointer-events: auto !important; }';
    document.head.append(style);
    const found = [];
    try {
      for (const element of document.body.querySelectorAll('*')) {
        if (element === iframe || element.contains(iframe) || iframe.contains(element)) continue;
        const area = element.getBoundingClientRect();
        const left = Math.max(area.left, box.left);
        const right = Math.min(area.right, box.right);
        const top = Math.max(area.top, box.top);
        const bottom = Math.min(area.bottom, box.bottom);
        if (right - left < 1 || bottom - top < 1) continue;
        const css = getComputedStyle(element);
        if (css.visibility !== 'visible' || Number(css.opacity) === 0) continue;
        // Invisible hit boxes (the progress line's) paint nothing.
        const paints = !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(css.backgroundColor) || css.backgroundImage !== 'none'
          || css.boxShadow !== 'none' || element instanceof SVGElement || /^(IMG|VIDEO|CANVAS|IFRAME)$/.test(element.tagName)
          || [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        if (!paints) continue;
        const stack = document.elementsFromPoint((left + right) / 2, (top + bottom) / 2);
        const at = stack.indexOf(element);
        const video = stack.indexOf(iframe);
        if (at !== -1 && (video === -1 || at < video)) {
          found.push(`${element.tagName}.${String(element.className?.baseVal ?? element.className).slice(0, 50)} ${element.getAttribute('data-testid') ?? element.getAttribute('aria-label') ?? ''}`);
        }
      }
    } finally {
      style.remove();
    }
    return found;
  }, SHOWN_IFRAME);
  if (offenders.length) throw new Error(`${label}: drawn in front of the embedded player ${JSON.stringify(offenders)}`);
}

try {
  const first = await browser.newPage();
  await pinAppLanguage(first);
  await first.evaluateOnNewDocument((song) => {
    // Puppeteer installs this callback in every new document, including
    // about:blank documents created while YouTube builds its child iframe.
    // Only the application frame may seed the shared origin's storage.
    if (window !== window.top) return;
    const tabId = 'player-controls-fixture-tab';
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    localStorage.setItem('diva-playback-owner-v1', JSON.stringify({
      type: 'claim',
      tabId,
      songId: song.id,
      claimedAt: Date.now(),
    }));
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue: [song],
      queueIndex: 0,
      currentSong: song,
      currentSongId: song.id,
      queueSources: ['manual'],
      currentPlaybackSource: 'manual',
    }));
  }, fixtureSong);
  await first.setRequestInterception(true);
  first.on('request', async request => {
    if (request.url() !== 'https://www.youtube.com/iframe_api') {
      await request.continue();
      return;
    }
    await request.respond({ contentType: 'application/javascript', body: `
      window.YT = {
        PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 },
        Player: function (_, options) {
          const player = this;
          let state = -1;
          let position = 0;
          let videoId = '';
          window.__yt = player;
          window.__ytLoads = 0;
          window.__ytMutes = 0;
          window.__ytStops = 0;
          player.getVideoData = () => ({ video_id: videoId });
          player.getPlayerState = () => state;
          player.getCurrentTime = () => position;
          player.getDuration = () => 300;
          player.getVolume = () => 50;
          player.setVolume = () => {};
          player.mute = () => { window.__ytMutes++; };
          player.unMute = () => {};
          player.seekTo = seconds => { position = seconds; };
          player.cueVideoById = player.loadVideoById = id => {
            videoId = id; position = 0; state = 5; window.__ytLoads++;
          };
          const emit = () => options.events.onStateChange({ data: state, target: player });
          player.playVideo = () => {
            if (state === 1) return; // Real API does not repeat PLAYING for an idempotent play.
            state = 1;
            if (!window.__ytOmitPlaying) emit();
          };
          player.pauseVideo = () => { state = 2; emit(); };
          player.stopVideo = () => { state = 0; window.__ytStops++; };
          player.fail = () => options.events.onError({ data: 100, target: player });
          player.destroy = () => {};
          setTimeout(() => options.events.onReady({ target: player }), 0);
        }
      };
      window.onYouTubeIframeAPIReady();
    ` });
  });
  await first.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await first.waitForSelector('[data-testid="mini-player-close"]', { timeout: 60_000 });
  await first.waitForFunction(() => document.title === 'DIVA Player — ボカロミュージックプレイヤー');
  console.log('PASS Home tab title ignores the restored paused queue');

  await first.reload({ waitUntil: 'domcontentloaded' });
  await first.waitForSelector(PLAY_BUTTON);
  await first.waitForFunction(() => document.title === 'DIVA Player — ボカロミュージックプレイヤー');
  if (!await first.evaluate(() => localStorage.getItem('diva_playerQueue'))) {
    throw new Error('Correcting the reopened Home title must preserve the saved queue');
  }
  console.log('PASS reopened Home keeps the page title and paused queue');

  await first.waitForFunction(() => window.__yt?.getVideoData().video_id === 'fixture');
  await new Promise(resolve => setTimeout(resolve, 1_100));
  // Native iframe play updates the store first; the resulting React effect must
  // not arm another startup timeout while the player is already playing.
  await first.evaluate(() => window.__yt.playVideo());
  await first.waitForSelector(PAUSE_BUTTON);
  if (await first.title() !== 'DIVA Player — ボカロミュージックプレイヤー') {
    throw new Error('Home tab title changed to the playing song instead of the visible page');
  }
  await new Promise(resolve => setTimeout(resolve, 12_500));
  const assertSameVideo = async label => {
    const state = await first.evaluate(() => ({
      loads: window.__ytLoads, mutes: window.__ytMutes, stops: window.__ytStops,
      video: window.__yt.getVideoData().video_id, position: window.__yt.getCurrentTime(),
      playing: window.__yt.getPlayerState() === 1,
    }));
    if (state.loads !== 1 || state.mutes !== 0 || state.stops !== 0 || state.video !== 'fixture' || !state.playing) {
      throw new Error(`${label}: ${JSON.stringify(state)}`);
    }
    console.log(`PASS ${label}`);
  };
  await assertSameVideo('native YouTube play does not rearm startup failure');
  for (const hidden of [false, true]) {
    await first.evaluate(value => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      window.__yt.seekTo(20);
      window.__ytOmitPlaying = true;
    }, hidden);
    for (let i = 0; i < 3; i++) {
      await first.$eval(PAUSE_BUTTON, button => button.click());
      await first.waitForFunction(() => window.__yt.getPlayerState() === 2);
      await first.$eval(PLAY_BUTTON, button => button.click());
      await first.waitForFunction(() => window.__yt.getPlayerState() === 1);
    }
    await new Promise(resolve => setTimeout(resolve, 12_500));
    await assertSameVideo(`YouTube pause/resume preserves PV and audio (hidden=${hidden})`);
    const position = await first.evaluate(() => window.__yt.getCurrentTime());
    if (position !== 20) throw new Error(`Resume reset position to ${position}`);
  }
  await first.$eval(PAUSE_BUTTON, button => button.click());
  await first.waitForFunction(() => window.__yt.getPlayerState() === 2);
  await new Promise(resolve => setTimeout(resolve, 12_500));
  const pausedState = await first.evaluate(() => ({
    state: window.__yt.getPlayerState(), mutes: window.__ytMutes, stops: window.__ytStops,
  }));
  if (pausedState.state !== 2 || pausedState.mutes !== 0 || pausedState.stops !== 0) {
    throw new Error(`Long pause triggered recovery: ${JSON.stringify(pausedState)}`);
  }
  await first.$eval(PLAY_BUTTON, button => button.click());
  await first.waitForFunction(() => window.__yt.getPlayerState() === 1);
  await assertSameVideo('long YouTube pause preserves the same video on resume');
  await first.evaluate(() => window.__yt.fail());
  await first.waitForFunction(() => window.__ytStops === 1);
  console.log('PASS explicit YouTube errors still fail a previously healthy PV');

  await first.$eval('[data-testid="mini-player-close"]', (button) => button.click());
  await first.waitForFunction(() => !document.querySelector('[data-testid="mini-player-close"]'));
  await first.waitForFunction(() => document.title === 'DIVA Player — ボカロミュージックプレイヤー');
  // Player state persistence may finish one task after the React UI disappears,
  // especially while the startup shell and route chunks are initializing.
  // Verify the durable contract without sampling that transient boundary.
  await first.waitForFunction(() => localStorage.getItem('diva_playerQueue') === null);
  // A late YouTube child document must not rerun the top-frame fixture and
  // resurrect the shared-origin queue after the player has been closed.
  await first.evaluate(() => new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.addEventListener('load', () => {
      frame.remove();
      resolve(undefined);
    }, { once: true });
    frame.src = 'about:blank';
    document.body.appendChild(frame);
  }));
  const queueRemainedCleared = await first.evaluate(() => localStorage.getItem('diva_playerQueue') === null);
  if (!queueRemainedCleared) throw new Error('A child document restored the closed player queue.');
  console.log('PASS mini-player close control');

  // 844x390 and 1280x400: the corner layout of short screens (the controls are a strip beside the video).
  for (const size of [[1280, 800], [390, 844], [844, 390], [1280, 400]]) {
    const label = size.join('x');
    const mini = await openMutedPage(size);
    try {
      const { page } = mini;
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForFunction(() => window.__yt?.getVideoData?.().video_id === 'fixture', { timeout: 30_000 });
      await page.evaluate(() => window.__yt.playVideo());
      await page.waitForSelector('.global-mini-player .global-player-video iframe', { timeout: 30_000 });
      await page.waitForSelector('[data-testid="player-mute-badge"]', { visible: true, timeout: 30_000 });
      await assertNothingOverVideo(page, `mini player ${label} muted`);
      const inControls = await page.$eval('[data-testid="player-mute-badge"]', button => Boolean(
        button.closest('[data-testid="mini-player-gesture-surface"]') && !button.closest('.global-player-video'),
      ));
      if (!inControls) throw new Error(`${label}: ミュートを解除 is not among the mini player's controls`);
      if (size[0] >= 1024 || size[1] < 420) {
        // Hover every control: its tooltip opens beside the controls, never over the video.
        const labels = await page.$$eval('[data-testid="mini-player-gesture-surface"] button[aria-label]', buttons => buttons.map(button => button.getAttribute('aria-label')));
        for (const name of labels) {
          await page.hover(`[data-testid="mini-player-gesture-surface"] button[aria-label="${name}"]`);
          // シャッフル with one song explains why it is off: the tooltip starts with the label. Past its fade-in:
          // a tooltip still transparent would pass the check unseen.
          await page.waitForFunction(text => [...document.querySelectorAll('[role="tooltip"]')]
            .some(tip => tip.textContent.startsWith(text) && getComputedStyle(tip).opacity === '1'), { timeout: 5_000 }, name);
          await assertNothingOverVideo(page, `mini player ${label} tooltip ${name}`);
        }
        await page.mouse.move(5, 5);
      }
      await page.focus('[data-testid="player-mute-badge"]');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__yt.getVolume() > 0 && window.__ytVolume > 0, { timeout: 5_000 });
      await page.waitForFunction(() => !document.querySelector('[data-testid="player-mute-badge"]'), { timeout: 5_000 });
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
      if (focused !== 'global-mini-player-toggle') throw new Error(`${label}: focus after ミュートを解除 went to ${focused}`);
      console.log(`PASS muted mini player ${label}: ミュートを解除 in the controls, nothing over the video, unmutes and keeps focus`);
    } finally {
      await mini.context.close();
    }

    const watch = await openMutedPage(size);
    try {
      const { page } = watch;
      await page.goto(new URL(`watch?v=${fixtureSong.id}`, baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForFunction(selector => {
        const container = document.querySelector('[data-testid="global-player"]');
        return container?.style.position === 'absolute' && [...document.querySelectorAll(selector)].some(frame => frame.getBoundingClientRect().width > 0);
      }, { timeout: 30_000 }, SHOWN_IFRAME);
      const pill = await page.waitForFunction(() => {
        const row = document.querySelector('[data-testid="watch-action-bar"]');
        return [...row?.querySelectorAll('button') ?? []].find(button => button.textContent.trim() === 'ミュートを解除');
      }, { timeout: 30_000 });
      if (!await pill.evaluate(button => button === button.closest('[data-testid="watch-action-bar"]').querySelector('button'))) {
        throw new Error(`${label}: ミュートを解除 is not the song page's first action`);
      }
      await assertNothingOverVideo(page, `song page ${label} muted`);
      await pill.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__yt.getVolume() > 0 && window.__ytVolume > 0, { timeout: 5_000 });
      const focus = await page.evaluate(() => ({
        body: document.activeElement === document.body,
        inRow: Boolean(document.activeElement?.closest('[data-testid="watch-action-bar"]')),
        pillGone: ![...document.querySelectorAll('[data-testid="watch-action-bar"] button')].some(button => button.textContent.trim() === 'ミュートを解除'),
      }));
      if (focus.body || !focus.inRow || !focus.pillGone) throw new Error(`${label}: song page unmute left focus ${JSON.stringify(focus)}`);
      await pill.dispose();
      console.log(`PASS muted song page ${label}: ミュートを解除 first in the action row, nothing over the video, unmutes and keeps focus`);
    } finally {
      await watch.context.close();
    }
  }
} finally {
  await browser.close();
}
