import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });
const songs = Array.from({ length: 55 }, (_, index) => ({
  id: 902000 + index,
  name: `Queue window fixture ${index}`,
  artistString: 'Queue fixture producer',
  createDate: '2026-01-01T00:00:00Z',
  defaultName: `Queue window fixture ${index}`,
  defaultNameLanguage: 'English',
  favoritedTimes: 0,
  lengthSeconds: 30,
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  pvs: [{
    author: '', disabled: false, id: 9020001 + index, length: 30,
    name: 'queue-window-fixture', pvId: `queue-window-${index}`,
    service: 'Youtube', pvType: 'Original', url: `https://youtu.be/queue-window-${index}`,
  }],
}));
const recommendedSongs = Array.from({ length: 60 }, (_, index) => ({
  ...songs[0],
  id: 903000 + index,
  name: `Auto queue fixture ${index}`,
  defaultName: `Auto queue fixture ${index}`,
  artists: [{
    artist: { id: 904000 + index, artistType: 'Vocaloid', name: `Fixture Vocalist ${index}` },
    categories: 'Vocalist', effectiveRoles: 'Vocalist', id: 904000 + index,
    isCustomName: false, isSupport: false, name: `Fixture Vocalist ${index}`, roles: 'Vocalist',
  }],
  youtubeViews: 100,
  nicoViews: 20,
  pvs: [{
    ...songs[0].pvs[0],
    id: 9030001 + index,
    pvId: `auto-queue-${index}`,
    url: `https://youtu.be/auto-queue-${index}`,
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

try {
  const page = await browser.newPage();
  const apiRequests = [];
  const pageErrors = [];
  await pinAppLanguage(page);
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/backend-api/api/')) apiRequests.push(`${request.method()} ${url.pathname}`);
  });
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (request.url() === 'https://www.youtube.com/iframe_api') {
      await request.respond({
        contentType: 'application/javascript',
        body: `
          window.YT = {
            PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
            Player: function (_id, options) {
              const player = this;
              let state = 5;
              player.getCurrentTime = () => 0;
              player.getDuration = () => 30;
              player.getPlayerState = () => state;
              player.getVolume = () => 50;
              player.setVolume = () => {};
              player.mute = () => {};
              player.unMute = () => {};
              player.seekTo = () => {};
              player.loadVideoById = player.cueVideoById = () => { state = 5; };
              player.playVideo = () => { state = 1; options.events.onStateChange({ data: state, target: player }); };
              player.pauseVideo = () => { state = 2; };
              player.stopVideo = () => { state = 0; };
              player.destroy = () => {};
              setTimeout(() => options.events.onReady({ target: player }), 0);
            },
          };
          window.onYouTubeIframeAPIReady();
        `,
      });
    } else if (url.pathname === '/backend-api/api/ready') {
      await respondJson(request, { status: 'ready' });
    } else if (url.pathname === '/backend-api/api/recommend/multi') {
      await respondJson(request, {
        error: null,
        items: recommendedSongs.map(song => ({
          songId: song.id, name: song.name, artist: song.artistString, score: 1, reason: 'fixture',
        })),
      });
    } else if (url.pathname === '/backend-api/api/recommend/similar') {
      await respondJson(request, { items: [], cards: recommendedSongs });
    } else if (url.pathname === '/backend-api/api/recommend/producer') {
      await respondJson(request, { items: [], cards: [] });
    } else if (url.pathname === '/backend-api/api/songs/batch') {
      const ids = new Set((url.searchParams.get('ids') ?? '').split(',').map(Number));
      await respondJson(request, { items: recommendedSongs.filter(song => ids.has(song.id)) });
    } else if (url.pathname === '/backend-api/api/songs/discovery-eligibility') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number).filter(Number.isInteger);
      await respondJson(request, { items: ids.map(songId => ({ songId, discoveryEligible: true })) });
    } else if (url.pathname === '/backend-api/api/songs/views') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      await respondJson(request, Object.fromEntries(ids.map(id => [id, { youtubeViews: 100, nicoViews: 20 }])));
    } else if (url.pathname.startsWith('/backend-api/api/')) {
      await respondJson(request, { items: [] });
    } else {
      await request.continue();
    }
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate(queue => {
    const tabId = 'queue-window-fixture-tab';
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    localStorage.setItem('diva-playback-owner-v1', JSON.stringify({
      type: 'claim', tabId, songId: queue[30].id, claimedAt: Date.now(),
    }));
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue,
      queueIndex: 30,
      currentSong: queue[30],
      currentSongId: queue[30].id,
      queueSources: queue.map(() => 'manual'),
      currentPlaybackSource: 'manual',
      queueTitle: 'ミックスリスト',
    }));
  }, songs);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="mini-player-queue"]', { visible: true, timeout: 60_000 });
  await page.click('[data-testid="mini-player-queue"]');
  await page.waitForSelector('[data-testid="queue-drawer"]', { visible: true, timeout: 15_000 });
  try {
    await page.waitForFunction(() => {
      const drawer = document.querySelector('[data-testid="queue-drawer"]');
      const rows = drawer?.querySelectorAll('li');
      return !!rows && rows.length === 40;
    }, { timeout: 30_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      queueLength: JSON.parse(localStorage.getItem('diva_playerQueue') || 'null')?.songIds?.length
        ?? JSON.parse(localStorage.getItem('diva_playerQueue') || 'null')?.queue?.length,
      queueIndex: JSON.parse(localStorage.getItem('diva_playerQueue') || 'null')?.queueIndex,
      rowCount: document.querySelectorAll('[data-testid="queue-drawer"] li').length,
      drawerText: document.querySelector('[data-testid="queue-drawer"]')?.textContent?.slice(0, 300),
    }));
    throw new Error(`Background prefill did not reach forty rows: ${JSON.stringify({ diagnostic, apiRequests, pageErrors })} (${error.message})`);
  }

  const visibleNames = await page.$$eval('[data-testid="queue-drawer"] li', rows => rows.map(row => row.textContent ?? ''));
  if (visibleNames.length !== 40) throw new Error(`Background prefill did not reach forty visible songs: ${visibleNames.length}`);
  if (!visibleNames[0].includes('Queue window fixture 20')) {
    throw new Error(`Expected the oldest visible song to be 20: ${visibleNames[0]}`);
  }
  if (visibleNames.some(name => name.includes('Queue window fixture 19'))) {
    throw new Error('A song older than the ten-song playback history remained visible.');
  }
  if (!visibleNames.some(name => name.includes('Queue window fixture 30'))) {
    throw new Error('The current song was missing from the queue display.');
  }
  console.log('PASS delayed prefill expands the initial queue window to forty songs');
  console.log('PASS queue drawer keeps only ten previous songs while retaining the current song');

  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid="queue-drawer"] li')]
      .find(item => item.textContent?.includes('Queue window fixture 25'));
    const button = row?.querySelector('[role="button"]');
    if (!(button instanceof HTMLElement)) throw new Error('The fixture song row is not actionable.');
    button.click();
  });
  await page.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
    return stored?.queueIndex === 25;
  }, { timeout: 10_000 });
  console.log('PASS selecting a visible historical row uses its original queue index');
} finally {
  await browser.close();
}
