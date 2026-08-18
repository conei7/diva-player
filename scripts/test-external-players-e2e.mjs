import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

const song = (service, pvId, url) => ({
  id: service === 'SoundCloud' ? 900201 : 900202,
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
  pvs: [{ author: '', disabled: false, id: service === 'SoundCloud' ? 9002011 : 9002021, length: 120, name: 'fixture', pvId, service, pvType: 'Original', url }],
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

async function preparePage(fixtureSong) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(currentSong => {
    const tabId = `external-player-fixture-${currentSong.id}`;
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    localStorage.setItem('diva-playback-owner-v1', JSON.stringify({
      type: 'claim',
      tabId,
      songId: currentSong.id,
      claimedAt: Date.now(),
    }));
    localStorage.setItem('diva_volume', JSON.stringify(23));
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue: [currentSong],
      queueIndex: 0,
      currentSong,
      currentSongId: currentSong.id,
      queueSources: ['manual'],
      currentPlaybackSource: 'manual',
    }));
  }, fixtureSong);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = request.url();
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
} finally {
  await browser.close();
}
