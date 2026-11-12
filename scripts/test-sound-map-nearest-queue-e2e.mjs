// 曲調マップ「近くの曲」→「すべて再生」: after the listed 20 songs the queue goes on in nearest
// order (the 21st, 22nd, … neighbour) instead of switching to the usual recommendations, also after
// a reload. API, songs and the YouTube player are fixtures.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:4173/diva-player/');
const ORIGIN = 950000;
const neighborIds = count => Array.from({ length: count }, (_, index) => ORIGIN + 1 + index);

function songFixture(id) {
  return {
    id,
    name: `近い順 ${id}`,
    artistString: 'Nearest fixture',
    createDate: '2026-01-01T00:00:00Z',
    defaultName: `近い順 ${id}`,
    defaultNameLanguage: 'Japanese',
    favoritedTimes: 0,
    lengthSeconds: 30,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    artists: [],
    pvs: [{
      author: '', disabled: false, id: id * 10, length: 30, name: 'nearest-fixture', pvId: `nearest-${id}`,
      service: 'Youtube', pvType: 'Original', url: `https://youtu.be/nearest-${id}`,
    }],
  };
}

const youtubeApi = `
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
      player.isMuted = () => false;
      player.seekTo = () => {};
      player.getVideoData = () => ({ video_id: '' });
      player.loadVideoById = player.cueVideoById = () => { state = 5; };
      player.playVideo = () => { state = 1; options.events.onStateChange({ data: state, target: player }); };
      player.pauseVideo = () => { state = 2; };
      player.stopVideo = () => { state = 0; };
      player.destroy = () => {};
      setTimeout(() => options.events.onReady({ target: player }), 0);
    },
  };
  window.onYouTubeIframeAPIReady();
`;

async function respondJson(request, body, status = 200) {
  await request.respond({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

const storedQueue = page => page.evaluate(() => JSON.parse(localStorage.getItem('diva_playerQueue') || 'null'));
const storedIds = stored => stored?.songIds ?? stored?.queue?.map(song => song.id) ?? [];

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  const recommendationRequests = [];
  const soundMapRequests = [];
  const groupRequests = [];
  const group = { kind: 'groupSoundMap', songIds: [ORIGIN, ORIGIN - 1, ORIGIN - 2], mapVersion: 'nearest-v1', axisKey: '2:570:457' };
  await pinAppLanguage(page);
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/backend-api/, '/backend-api');
    if (request.url() === 'https://www.youtube.com/iframe_api') {
      await request.respond({ contentType: 'application/javascript', body: youtubeApi });
    } else if (path === '/backend-api/api/ready') {
      await respondJson(request, { status: 'ready' });
    } else if (path === '/backend-api/api/discovery/sound-map/group') {
      const offset = Number(url.searchParams.get('nearbyOffset') ?? 0);
      const limit = Number(url.searchParams.get('nearbyLimit') ?? 20);
      groupRequests.push(Object.fromEntries(url.searchParams));
      const point = songId => ({ songId, name: `近い順 ${songId}`, artistString: 'Nearest fixture', x: (songId - ORIGIN) / 1000, y: 0, similarity: null });
      await respondJson(request, {
        mapVersion: 'nearest-v1', generatedAt: '2026-11-01T00:00:00Z', method: 'group_feature_axes',
        coordinateCount: 600, state: 'ready', axisSelectionVersion: 2, matchingCount: 600,
        groupSongIds: group.songIds, origin: point(ORIGIN),
        // Sampled dots deliberately omit the actual nearest rows: playback must use nearby.
        items: [...group.songIds.map(point), point(ORIGIN + 590)],
        nearby: neighborIds(600).slice(offset, offset + limit).map(point),
        nearbyNextOffset: Math.min(600, offset + limit), nearbyHasMore: offset + limit < 600,
        axes: { x: 570, y: 457, dimensionCount: 1024, minX: 0, maxX: 1, minY: 0, maxY: 1 },
        initialViewport: { centerX: 0, centerY: 0, zoom: 2 },
      });
    } else if (path === '/backend-api/api/discovery/sound-map') {
      const seed = Number(url.searchParams.get('seedSongId'));
      const limit = Number(url.searchParams.get('limit'));
      soundMapRequests.push({ seed, limit });
      if (seed !== ORIGIN) {
        await respondJson(request, { error: 'seed_not_mapped' }, 404);
        return;
      }
      const point = (songId, similarity) => ({ songId, name: `近い順 ${songId}`, artistString: 'Nearest fixture', x: (songId % 17) / 17 - .5, y: (songId % 13) / 13 - .5, similarity });
      await respondJson(request, {
        mapVersion: 'nearest-v1', generatedAt: '2026-11-01T00:00:00Z', method: 'pca', coordinateCount: 70000,
        state: 'ready', origin: point(ORIGIN, null),
        items: [point(ORIGIN, null), ...neighborIds(limit).map((id, index) => point(id, .99 - index / 1000))],
        axes: null,
      });
    } else if (path === '/backend-api/api/songs/batch' || path === '/backend-api/api/songs/details') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);
      await respondJson(request, { items: ids.map(songFixture) });
    } else if (path.startsWith('/backend-api/api/recommend')) {
      recommendationRequests.push(path);
      await respondJson(request, { items: [], cards: [] });
    } else if (path === '/backend-api/api/songs/discovery-eligibility') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number).filter(Number.isInteger);
      await respondJson(request, { items: ids.map(songId => ({ songId, discoveryEligible: true })) });
    } else if (path.startsWith('/backend-api/api/')) {
      await respondJson(request, { items: [] });
    } else if (url.origin !== baseUrl.origin) {
      await request.abort();
    } else {
      await request.continue();
    }
  });

  await page.goto(new URL(`sound-map?seedSongId=${ORIGIN}&layout=pca&mapVersion=nearest-v1`, baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('section[aria-labelledby="sound-map-nearby-heading"] button')]
    .some(button => button.textContent?.trim() === 'すべて再生'), { timeout: 60_000 });
  const listed = await page.$$eval('section[aria-labelledby="sound-map-nearby-heading"] li', rows => rows.length);
  assert.equal(listed, 20, 'the list shows its first 20 rows before 「もっと見る」');
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('section[aria-labelledby="sound-map-nearby-heading"] button')]
      .find(item => item.textContent?.trim() === 'すべて再生');
    button.click();
  });

  // The autoplay refill (low watermark, then the delayed background prefill) appends past the 20.
  try {
    await page.waitForFunction(() => {
      const stored = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
      return (stored?.songIds?.length ?? 0) >= 35;
    }, { timeout: 30_000 });
  } catch (error) {
    throw new Error(`The nearest-order queue did not grow past the listed songs: ${JSON.stringify({ stored: await storedQueue(page), soundMapRequests, recommendationRequests, pageErrors })} (${error.message})`);
  }
  const first = await storedQueue(page);
  const firstIds = storedIds(first);
  assert.deepEqual(firstIds, neighborIds(firstIds.length), 'the queue keeps the nearest order past the 20 listed songs');
  assert.deepEqual(first.queueSources.slice(0, 20), Array(20).fill('discovery'));
  assert.ok(first.queueSources.slice(20).every(source => source === 'auto'), 'songs past the list are autoplay additions');
  assert.deepEqual(first.continuation, { kind: 'soundMap', originSongId: ORIGIN });
  assert.equal(first.queueTitle, '近くの曲');
  assert.deepEqual(recommendationRequests, [], 'the usual recommendations are not requested for this queue');
  assert.ok(soundMapRequests.some(item => item.seed === ORIGIN && item.limit === 200), 'the continuation reads the origin’s 200 nearest songs');
  console.log(`PASS すべて再生 continues past the 20 listed songs in nearest order (${firstIds.length} songs, no recommendation requests)`);

  // After a reload the saved queue near its end goes on from the 41st nearest song.
  const reloadQueue = neighborIds(40).map(songFixture);
  await page.evaluate((queue, origin) => {
    const tabId = 'nearest-queue-fixture-tab';
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    localStorage.setItem('diva-playback-owner-v1', JSON.stringify({ type: 'claim', tabId, songId: queue[38].id, claimedAt: Date.now() }));
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue,
      queueIndex: 38,
      currentSong: queue[38],
      currentSongId: queue[38].id,
      queueSources: queue.map((_, index) => (index < 20 ? 'discovery' : 'auto')),
      currentPlaybackSource: 'auto',
      queueTitle: '近くの曲',
      continuation: { kind: 'soundMap', originSongId: origin },
    }));
  }, reloadQueue, ORIGIN);
  recommendationRequests.length = 0;
  // Not Home: its own feed asks for recommendations. Only autoplay may add songs on this page.
  await page.goto(new URL('history', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  try {
    await page.waitForFunction(() => {
      const stored = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
      return (stored?.songIds?.length ?? stored?.queue?.length ?? 0) > 40;
    }, { timeout: 30_000 });
  } catch (error) {
    throw new Error(`The restored nearest-order queue did not continue: ${JSON.stringify({ stored: await storedQueue(page), recommendationRequests, pageErrors })} (${error.message})`);
  }
  const restored = await storedQueue(page);
  const restoredIds = storedIds(restored);
  assert.deepEqual(restoredIds, neighborIds(restoredIds.length), 'the restored queue goes on with the 41st nearest song');
  assert.deepEqual(restored.continuation, { kind: 'soundMap', originSongId: ORIGIN });
  assert.deepEqual(recommendationRequests, []);
  console.log(`PASS a reloaded nearest-order queue continues from the 41st song (${restoredIds.length} songs)`);

  await page.goto(new URL(`sound-map?layout=group&songIds=${group.songIds.join(',')}`, baseUrl), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.querySelectorAll('section[aria-labelledby="sound-map-nearby-heading"] button')]
    .some(button => button.textContent?.trim() === 'すべて再生'), { timeout: 30_000 });
  await page.evaluate(() => [...document.querySelectorAll('section[aria-labelledby="sound-map-nearby-heading"] button')]
    .find(button => button.textContent?.trim() === 'すべて再生').click());
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('diva_playerQueue') || 'null')?.songIds?.length >= 35, { timeout: 30_000 });
  const grouped = await storedQueue(page);
  assert.deepEqual(storedIds(grouped), neighborIds(storedIds(grouped).length));
  assert.deepEqual(grouped.continuation, group);
  assert.deepEqual(recommendationRequests, []);
  console.log('PASS group すべて再生 uses full-catalogue nearest order past 20, independently of sampled dots');

  await page.evaluate((queue, continuation) => {
    const tabId = 'nearest-queue-fixture-tab';
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    localStorage.setItem('diva-playback-owner-v1', JSON.stringify({ type: 'claim', tabId, songId: queue[238].id, claimedAt: Date.now() }));
    localStorage.setItem('diva_playerQueue', JSON.stringify({ queue, queueIndex: 238, currentSong: queue[238],
      currentSongId: queue[238].id, queueSources: queue.map(() => 'auto'), currentPlaybackSource: 'auto',
      queueTitle: '近くの曲', continuation }));
  }, neighborIds(240).map(songFixture), group);
  await page.goto(new URL('history', baseUrl), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
    return (stored?.songIds?.length ?? stored?.queue?.length ?? 0) > 240;
  }, { timeout: 30_000 });
  const groupRestored = await storedQueue(page);
  assert.deepEqual(storedIds(groupRestored), neighborIds(storedIds(groupRestored).length));
  assert.deepEqual(groupRestored.continuation, group);
  assert.ok(groupRequests.some(query => query.nearbyOffset === '200' && query.nearbyOnly === 'true'
    && query.axisKey === group.axisKey && query.mapVersion === group.mapVersion));
  assert.deepEqual(recommendationRequests, []);
  console.log('PASS reloaded group queue continues beyond 200 with the original map version and axes');

  assert.deepEqual(pageErrors, []);
  console.log('PASS no page errors');
} finally {
  await browser.close();
}
