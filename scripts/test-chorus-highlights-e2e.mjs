import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

/**
 * サビ発掘: each song starts at its chorus and the next one follows when the chorus ends.
 * The YouTube mock loads videos asynchronously like the real player: a seek made while a video
 * is still loading is lost when the load completes (position back to 0).
 */
const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });

const songs = [
  { id: 905001, chorusStartSeconds: 60, chorusEndSeconds: 66 },
  { id: 905002, chorusStartSeconds: 40, chorusEndSeconds: 46 },
  { id: 905003, chorusStartSeconds: 80, chorusEndSeconds: 86 },
].map(({ id, ...chorus }, index) => ({
  id,
  name: `Chorus fixture ${index + 1}`,
  artistString: 'Chorus fixture producer',
  createDate: '2026-01-01T00:00:00Z',
  defaultName: `Chorus fixture ${index + 1}`,
  defaultNameLanguage: 'English',
  favoritedTimes: 0,
  lengthSeconds: 200,
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  ...chorus,
  pvs: [{
    author: '', disabled: false, id: id * 10, length: 200, name: 'chorus-fixture',
    pvId: `chorus-${index + 1}`, service: 'Youtube', pvType: 'Original', url: `https://youtu.be/chorus-${index + 1}`,
  }],
}));

async function respondJson(request, body) {
  await request.respond({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

const YOUTUBE_MOCK = `
  window.YT = {
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    Player: function (_id, options) {
      const player = this;
      let state = -1;
      let position = 0;
      let videoId = '';
      let loadTimer = 0;
      let playRequested = false;
      window.__yt = player;
      window.__ytSeeks = [];
      const emit = () => options.events.onStateChange({ data: state, target: player });
      player.getVideoData = () => ({ video_id: videoId });
      player.getPlayerState = () => state;
      player.getCurrentTime = () => position;
      player.getDuration = () => 200;
      player.getVolume = () => 50;
      player.setVolume = () => {};
      player.mute = () => {};
      player.unMute = () => {};
      player.getIframe = () => null;
      player.seekTo = seconds => { position = seconds; window.__ytSeeks.push({ videoId, seconds, state }); };
      const load = (id, autoplay) => {
        clearTimeout(loadTimer);
        videoId = id;
        position = 0;
        state = 3;
        playRequested = autoplay;
        // The real player finishes loading later and starts the video from its beginning.
        loadTimer = setTimeout(() => {
          position = 0;
          state = playRequested ? 1 : 5;
          if (state === 1) emit();
        }, 400);
      };
      player.loadVideoById = id => load(id, true);
      player.cueVideoById = id => load(id, false);
      player.playVideo = () => {
        if (state === 3) { playRequested = true; return; }
        if (state === 1) return;
        state = 1;
        emit();
      };
      player.pauseVideo = () => { state = 2; emit(); };
      player.stopVideo = () => { state = 0; };
      player.destroy = () => {};
      // Plays at 10x so a 6 second chorus window ends in well under a second.
      setInterval(() => { if (state === 1) position += 1; }, 100);
      setTimeout(() => options.events.onReady({ target: player }), 0);
    },
  };
  window.onYouTubeIframeAPIReady();
`;

try {
  const page = await browser.newPage();
  const pageErrors = [];
  await pinAppLanguage(page);
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (request.url() === 'https://www.youtube.com/iframe_api') {
      await request.respond({ contentType: 'application/javascript', body: YOUTUBE_MOCK });
    } else if (url.pathname === '/backend-api/api/ready') {
      await respondJson(request, { status: 'ready' });
    } else if (url.pathname === '/backend-api/api/songs/search' && url.searchParams.get('chorusOnly') === 'true') {
      await respondJson(request, { items: songs, totalCount: songs.length });
    } else if (url.pathname === '/backend-api/api/songs/discovery-eligibility') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number).filter(Number.isInteger);
      await respondJson(request, { items: ids.map(songId => ({ songId, discoveryEligible: true })) });
    } else if (url.pathname.startsWith('/backend-api/api/')) {
      await respondJson(request, { items: [] });
    } else {
      await request.continue();
    }
  });

  await page.goto(new URL('chorus-highlights', baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="chorus-highlights-page"]', { timeout: 60_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('button')]
    .some(button => button.textContent?.trim() === '再生' && !button.disabled), { timeout: 30_000 });
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find(button => button.textContent?.trim() === '再生' && !button.disabled)?.click());

  const waitForChorus = async (videoId, start, label) => {
    await page.waitForFunction(id => (
      window.__yt?.getVideoData().video_id === id && window.__yt.getPlayerState() === 1
    ), { timeout: 10_000 }, videoId);
    // At 10x speed a video that started from 0:00 is still far before its chorus here.
    await new Promise(resolve => setTimeout(resolve, 600));
    const state = await page.evaluate(() => ({
      video: window.__yt.getVideoData().video_id,
      position: window.__yt.getCurrentTime(),
      seeks: window.__ytSeeks,
    }));
    if (state.video !== videoId || state.position < start || state.position > start + 12) {
      throw new Error(`${label}: did not start at the chorus (${start}s): ${JSON.stringify(state)}`);
    }
    console.log(`PASS ${label}`);
  };

  await waitForChorus('chorus-1', 60, 'first song starts at its chorus');
  // The chorus window (60–66s) ends and the next song starts at its own chorus.
  await waitForChorus('chorus-2', 40, 'next song follows at the end of the chorus and starts at its chorus');

  for (const [width, height] of [[320, 568], [390, 667], [320, 360]]) {
    await page.setViewport({ width, height });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => [...document.querySelectorAll('main button')]
      .some(button => button.textContent?.trim() === '再生' && !button.disabled));
    await page.evaluate(() => [...document.querySelectorAll('main button')]
      .find(button => button.textContent?.trim() === '再生' && !button.disabled)?.click());
    await page.waitForSelector('main [role="progressbar"]');
    await page.waitForSelector('.global-mini-player');
    await page.waitForFunction(() => window.__yt?.getPlayerState() === 1);
    await page.evaluate(() => window.__yt.pauseVideo());
    // Starting highlights must bring the actions into the usable space above the fixed player.
    await new Promise(resolve => setTimeout(resolve, 250));
    const layout = await page.evaluate(() => {
      const section = document.querySelector('main [role="progressbar"]').closest('section');
      const actions = [...section.querySelectorAll('button')].filter(button =>
        ['保存', 'フルで聴く', 'スキップ'].includes(button.getAttribute('aria-label') || button.textContent.trim()));
      const player = document.querySelector('.global-mini-player').getBoundingClientRect();
      return {
        actions: actions.map(button => { const r = button.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }),
        playerTop: player.top,
        headerHeight: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')),
        width: document.documentElement.scrollWidth,
      };
    });
    if (layout.actions.length !== 3 || layout.width > width + 1
      || layout.actions.some(r => r.top < layout.headerHeight || r.bottom > layout.playerTop || r.left < 0 || r.right > width)) {
      throw new Error(`Chorus actions are covered at ${width}x${height}: ${JSON.stringify(layout)}`);
    }
    if (process.env.DIVA_CHORUS_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.DIVA_CHORUS_SCREENSHOTS}/chorus-${width}x${height}.png` });
    }
    console.log(`PASS chorus actions above the mini player ${width}x${height}`);
  }

  if (pageErrors.length > 0) throw new Error(`Page errors: ${pageErrors.join(' | ')}`);
  console.log('PASS chorus highlights playback');
} finally {
  await browser.close();
}
