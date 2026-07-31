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
              const widget = {
                bind(name, listener) {
                  listeners[name] = listener;
                  if (name === Events.READY) setTimeout(() => { window.__soundCloudReady = true; listener(); }, 0);
                },
                unbind(name) { delete listeners[name]; },
                play() { window.__soundCloudPlayCalls = (window.__soundCloudPlayCalls || 0) + 1; setTimeout(() => listeners[Events.PLAY]?.(), 0); },
                pause() { window.__soundCloudPauseCalls = (window.__soundCloudPauseCalls || 0) + 1; setTimeout(() => listeners[Events.PAUSE]?.(), 0); },
                seekTo(ms) { listeners[Events.SEEK]?.({ currentPosition: ms }); },
                setVolume(value) { window.__soundCloudVolume = value; },
                getDuration(callback) { callback(120000); },
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
  await soundCloudPage.click('button[title="再生"]');
  await soundCloudPage.waitForFunction(() => window.__soundCloudPlayCalls > 0);
  await soundCloudPage.waitForSelector('button[title="一時停止"]');
  await soundCloudPage.click('button[title="一時停止"]');
  await soundCloudPage.waitForFunction(() => window.__soundCloudPauseCalls > 0);
  console.log('PASS SoundCloud embed and Widget API controls');

  const bilibiliPage = await preparePage(bilibiliSong);
  await bilibiliPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await bilibiliPage.waitForSelector('[data-testid="bilibili-player-embed"]', { timeout: 60_000 });
  const bilibiliSrc = new URL(await bilibiliPage.$eval('[data-testid="bilibili-player-embed"]', iframe => iframe.src));
  if (bilibiliSrc.searchParams.get('aid') !== '45451154' || bilibiliSrc.searchParams.get('danmaku') !== '0') {
    throw new Error(`Unexpected Bilibili embed: ${bilibiliSrc}`);
  }
  console.log('PASS Bilibili aid embed');
} finally {
  await browser.close();
}
