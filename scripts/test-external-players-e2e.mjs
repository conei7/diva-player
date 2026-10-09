import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });

const song = (service, pvId, url) => ({
  id: service === 'SoundCloud' ? 900201 : service === 'NicoNicoDouga' ? 900203 : 900202,
  name: `${service} fixture`,
  artistString: 'Fixture producer',
  createDate: '2026-01-01T00:00:00Z',
  defaultName: `${service} fixture`,
  defaultNameLanguage: 'English',
  favoritedTimes: 0,
  lengthSeconds: 120,
  pvServices: service,
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  pvs: [{ author: '', disabled: false, id: service === 'SoundCloud' ? 9002011 : service === 'NicoNicoDouga' ? 9002031 : 9002021, length: 120, name: 'fixture', pvId, service, pvType: 'Original', url }],
});

const soundCloudSong = song(
  'SoundCloud',
  '103524583 worldoncolorkoyori/feat-5',
  'http://soundcloud.com/worldoncolorkoyori/feat-5',
);
const bilibiliSong = song(
  'Bilibili',
  '45451154',
  'https://www.bilibili.com/video/av45451154',
);
const nicoSong = song(
  'NicoNicoDouga',
  'sm-nico-volume-fixture',
  'https://www.nicovideo.jp/watch/sm-nico-volume-fixture',
);

async function preparePage(fixtureSong, savedVolume = 23) {
  // Each provider case is independent; separate contexts keep its playback
  // ownership and persisted volume from racing with the other fixture pages.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await pinAppLanguage(page);
  await page.evaluateOnNewDocument((currentSong, currentVolume) => {
    const tabId = `external-player-fixture-${currentSong.id}`;
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    localStorage.setItem('diva-playback-owner-v1', JSON.stringify({
      type: 'claim',
      tabId,
      songId: currentSong.id,
      claimedAt: Date.now(),
    }));
    if (currentVolume === null) localStorage.removeItem('diva_volume');
    else localStorage.setItem('diva_volume', JSON.stringify(currentVolume));
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue: [currentSong],
      queueIndex: 0,
      currentSong,
      currentSongId: currentSong.id,
      queueSources: ['manual'],
      currentPlaybackSource: 'manual',
    }));
  }, fixtureSong, savedVolume);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = request.url();
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname.startsWith('/backend-api/') || parsedUrl.hostname === 'vocadb.net') {
      // These player cases use synthetic songs. Their IDs also exist in the
      // live catalog, so metadata/home requests must stay inside this fixture.
      const path = parsedUrl.pathname;
      let body = { items: [], totalCount: 0 };
      if (path.endsWith('/api/ready') || path.endsWith('/api/health')) {
        body = { status: path.endsWith('/api/ready') ? 'ready' : 'ok', dependencies: { postgres: { ok: true }, qdrant: { ok: true } } };
      } else if (parsedUrl.searchParams.get('fields') === 'Albums') {
        body = { albums: [] };
      } else if (path.endsWith('/api/songs/details') || path.endsWith('/api/songs/batch')) {
        body = { items: [fixtureSong] };
      } else if (/\/api\/songs\/\d+$/.test(path)) {
        body = fixtureSong;
      } else if (path.endsWith('/api/songs/views')) {
        body = { [fixtureSong.id]: { youtubeViews: 0, nicoViews: 0 } };
      } else if (path.endsWith('/api/songs/discovery-eligibility')) {
        body = { items: [{ songId: fixtureSong.id, discoveryEligible: true }] };
      } else if (path.includes('/api/recommend/')) {
        body = [];
      }
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      return;
    }
    if (url === 'https://w.soundcloud.com/player/api.js') {
      await request.respond({
        contentType: 'application/javascript',
        body: `
          (() => {
            const Events = {
              READY: 'ready', PLAY: 'play', PAUSE: 'pause', FINISH: 'finish',
              SEEK: 'seek', PLAY_PROGRESS: 'play-progress', ERROR: 'error'
            };
            const Widget = function () {
              const listeners = {};
              let paused = true;
              const widget = {
                bind(name, listener) {
                  listeners[name] = listener;
                  if (name === Events.READY) setTimeout(() => { window.__soundCloudReady = true; listener(); }, 0);
                },
                unbind(name) { delete listeners[name]; },
                play() {
                  window.__soundCloudPlayCalls = (window.__soundCloudPlayCalls || 0) + 1;
                  if ((window.__soundCloudIgnoredStarts || 0) < (window.__soundCloudStartsToIgnore || 0)) {
                    window.__soundCloudIgnoredStarts = (window.__soundCloudIgnoredStarts || 0) + 1;
                    setTimeout(() => listeners[Events.PAUSE]?.(), 0);
                    return;
                  }
                  // Reproduce the transient stale PAUSE observed while a real
                  // SoundCloud Widget play request is settling.
                  setTimeout(() => listeners[Events.PAUSE]?.(), 0);
                  setTimeout(() => {
                    paused = false;
                    window.__soundCloudConfirmedPlaying = true;
                    listeners[Events.PLAY]?.();
                  }, 50);
                },
                pause() {
                  window.__soundCloudPauseCalls = (window.__soundCloudPauseCalls || 0) + 1;
                  paused = true;
                  setTimeout(() => listeners[Events.PAUSE]?.(), 0);
                },
                seekTo(ms) { listeners[Events.SEEK]?.({ currentPosition: ms }); },
                setVolume(value) { window.__soundCloudVolume = value; },
                getDuration(callback) { callback(120000); },
                isPaused(callback) { callback(paused); },
              };
              window.__soundCloudWidget = widget;
              return widget;
            };
            Widget.Events = Events;
            window.SC = { Widget };
          })();
        `,
      });
      return;
    }
    if (url.startsWith('https://w.soundcloud.com/player/')) {
      await request.respond({ contentType: 'text/html', body: '<!doctype html><title>SoundCloud fixture</title>' });
      return;
    }
    if (url.startsWith('https://player.bilibili.com/player.html')) {
      await request.respond({ contentType: 'text/html', body: '<!doctype html><title>Bilibili fixture</title>' });
      return;
    }
    if (url.startsWith('https://embed.nicovideo.jp/watch/')) {
      await request.respond({ contentType: 'text/html', body: `<!doctype html><title>Niconico fixture</title>
        <script>
          window.addEventListener('message', event => {
            if (event.source !== window.parent || event.data?.eventName !== 'volumeChange') return;
            window.__nicoAppliedVolume = event.data.data?.volume;
          });
        </script>` });
      return;
    }
    await request.continue();
  });
  return page;
}

try {
  const soundCloudPage = await preparePage(soundCloudSong);
  await soundCloudPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await soundCloudPage.waitForSelector('[data-testid="soundcloud-player-embed"]', { timeout: 60_000 });
  const soundCloudSrc = new URL(await soundCloudPage.$eval('[data-testid="soundcloud-player-embed"]', iframe => iframe.src));
  if (soundCloudSrc.searchParams.get('url') !== 'https://soundcloud.com/worldoncolorkoyori/feat-5') {
    throw new Error(`Unexpected SoundCloud target: ${soundCloudSrc}`);
  }
  await soundCloudPage.waitForFunction(() => window.__soundCloudReady === true);
  await soundCloudPage.$eval('button[title="再生"]', button => button.click());
  await soundCloudPage.waitForFunction(() => window.__soundCloudPlayCalls > 0);
  await soundCloudPage.waitForSelector('button[title="一時停止"]');
  await new Promise(resolve => setTimeout(resolve, 500));
  const soundCloudState = await soundCloudPage.evaluate(() => ({
    playCalls: window.__soundCloudPlayCalls || 0,
    pauseCalls: window.__soundCloudPauseCalls || 0,
    volume: window.__soundCloudVolume,
  }));
  if (soundCloudState.playCalls !== 1 || soundCloudState.pauseCalls !== 0 || soundCloudState.volume !== 23) {
    throw new Error(`Unstable SoundCloud state: ${JSON.stringify(soundCloudState)}`);
  }
  await soundCloudPage.$eval('button[title="一時停止"]', button => button.click());
  await soundCloudPage.waitForFunction(() => window.__soundCloudPauseCalls > 0);
  await soundCloudPage.waitForSelector('button[title="再生"]');
  console.log('PASS SoundCloud stable playback and inherited volume');

  await soundCloudPage.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    window.__soundCloudStartsToIgnore = 2;
    window.__soundCloudIgnoredStarts = 0;
    window.__soundCloudConfirmedPlaying = false;
    document.querySelector('button[title="再生"]')?.click();
  });
  await soundCloudPage.waitForFunction(() => window.__soundCloudConfirmedPlaying === true, { timeout: 5_000 });
  const soundCloudBackgroundState = await soundCloudPage.evaluate(() => ({
    confirmedPlaying: window.__soundCloudConfirmedPlaying === true,
    ignoredStarts: window.__soundCloudIgnoredStarts || 0,
    playCalls: window.__soundCloudPlayCalls || 0,
    controlTitle: document.querySelector('button[title="再生"], button[title="一時停止"]')?.getAttribute('title'),
    visibilityState: document.visibilityState,
  }));
  if (!soundCloudBackgroundState.confirmedPlaying || soundCloudBackgroundState.visibilityState !== 'hidden') {
    throw new Error(`SoundCloud recovery did not run in the background: ${JSON.stringify(soundCloudBackgroundState)}`);
  }
  console.log(`PASS SoundCloud hidden start retries until PLAY (${soundCloudBackgroundState.playCalls} calls)`);

  const bilibiliPage = await preparePage(bilibiliSong);
  await bilibiliPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await bilibiliPage.waitForSelector('[data-testid="bilibili-player-embed"]', { timeout: 60_000 });
  const bilibiliSrc = new URL(await bilibiliPage.$eval('[data-testid="bilibili-player-embed"]', iframe => iframe.src));
  if (
    bilibiliSrc.searchParams.get('aid') !== '45451154'
    || bilibiliSrc.searchParams.get('danmaku') !== '0'
    || bilibiliSrc.searchParams.get('muted') !== '0'
  ) {
    throw new Error(`Unexpected Bilibili embed: ${bilibiliSrc}`);
  }
  console.log('PASS Bilibili aid embed keeps native player audio enabled');

  const nicoPage = await preparePage(nicoSong);
  await nicoPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await nicoPage.bringToFront();
  await nicoPage.waitForFunction(() => document.visibilityState === 'visible');
  await nicoPage.waitForSelector('iframe[src*="embed.nicovideo.jp/watch/sm-nico-volume-fixture"]', { timeout: 60_000 });
  await nicoPage.waitForFunction(() => {
    const iframe = document.querySelector('iframe[src*="embed.nicovideo.jp/watch/sm-nico-volume-fixture"]');
    return iframe instanceof HTMLIFrameElement && iframe.contentWindow !== null;
  }, { timeout: 15_000 });
  const nicoFrame = nicoPage.frames().find(frame => frame.url().includes('embed.nicovideo.jp/watch/sm-nico-volume-fixture'));
  if (!nicoFrame) throw new Error('Niconico volume fixture frame was not attached');
  // An attached iframe can precede React's player effects. Wait for the app's
  // initial volume command before testing the reverse (native control) path.
  await nicoFrame.waitForFunction(() => window.__nicoAppliedVolume === 0.23, { timeout: 15_000 });
  await nicoPage.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="embed.nicovideo.jp/watch/sm-nico-volume-fixture"]');
    window.__nicoVolumeMessageProbe = [];
    window.addEventListener('message', event => {
      if (event.data?.eventName !== 'playerMetadataChange') return;
      window.__nicoVolumeMessageProbe.push({
        origin: event.origin,
        sourceMatches: event.source === iframe?.contentWindow,
        playerId: event.data.playerId,
        volume: event.data.data?.volume,
      });
    }, true);
  });
  const volumeUpdateDeadline = Date.now() + 5_000;
  while (Date.now() < volumeUpdateDeadline) {
    if (await nicoPage.evaluate(() => localStorage.getItem('diva_volume') === '42')) break;
    // Send from the embedded document so Chromium supplies a real origin and
    // source WindowProxy. A synthetic top-window MessageEvent can lose those
    // properties across browser/runtime versions and silently miss the app's
    // origin/source checks.
    await nicoFrame.evaluate(() => {
      const playerId = new URL(window.location.href).searchParams.get('playerId');
      if (!playerId) return;
      window.parent.postMessage({
        sourceConnectorType: 0,
        playerId,
        eventName: 'playerMetadataChange',
        data: { volume: 0.42 },
      }, '*');
    });
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const savedNicoVolume = await nicoPage.evaluate(() => localStorage.getItem('diva_volume'));
  if (savedNicoVolume !== '42') {
    throw new Error(`Niconico volume event was not persisted: ${JSON.stringify({
      savedVolume: savedNicoVolume,
      iframeUrls: await nicoPage.$$eval('iframe[src*="embed.nicovideo.jp/watch/sm-nico-volume-fixture"]', frames => frames.map(frame => frame.src)),
      receivedEvents: await nicoPage.evaluate(() => window.__nicoVolumeMessageProbe?.slice(-3) ?? []),
    })}`);
  }
  console.log('PASS Niconico native volume changes persist in the shared player setting');
} finally {
  await browser.close();
}
