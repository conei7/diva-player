import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

const songs = [
  {
    id: 900001,
    name: 'Background recovery fixture 1',
    artistString: 'Fixture producer',
    createDate: '2026-01-01T00:00:00Z',
    defaultName: 'Background recovery fixture 1',
    defaultNameLanguage: 'English',
    favoritedTimes: 0,
    lengthSeconds: 3,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    pvs: [{ author: '', disabled: false, id: 9000011, length: 3, name: 'fixture-1', pvId: 'fixture-1', service: 'Youtube', pvType: 'Original', url: 'https://youtu.be/fixture-1' }],
  },
  {
    id: 900002,
    name: 'Background recovery fixture 2',
    artistString: 'Fixture producer',
    createDate: '2026-01-01T00:00:00Z',
    defaultName: 'Background recovery fixture 2',
    defaultNameLanguage: 'English',
    favoritedTimes: 0,
    lengthSeconds: 30,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    pvs: [{ author: '', disabled: false, id: 9000021, length: 30, name: 'fixture-2', pvId: 'fixture-2', service: 'Youtube', pvType: 'Original', url: 'https://youtu.be/fixture-2' }],
  },
];

try {
  const playerPage = await browser.newPage();
  playerPage.on('pageerror', (error) => console.error('PAGE ERROR', error.message));
  await playerPage.evaluateOnNewDocument((queue) => {
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue,
      queueIndex: 0,
      currentSong: queue[0],
      currentSongId: queue[0].id,
      queueSources: ['manual', 'manual'],
      currentPlaybackSource: 'manual',
    }));
  }, songs);

  await playerPage.setRequestInterception(true);
  playerPage.on('request', async (request) => {
    if (request.url() !== 'https://www.youtube.com/iframe_api') {
      await request.continue();
      return;
    }
    await request.respond({
      contentType: 'application/javascript',
      body: `
        window.YT = {
          PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
          Player: function (_id, options) {
            const player = this;
            let state = -1;
            let startedAt = 0;
            let elapsed = 0;
            player.getCurrentTime = () => state === 1 ? elapsed + (Date.now() - startedAt) / 1000 : elapsed;
            player.getDuration = () => options.videoId === 'fixture-1' ? 3 : 30;
            player.getPlayerState = () => state;
            player.getVolume = () => 50;
            player.setVolume = () => {};
            player.unMute = () => {};
            player.seekTo = (seconds) => { elapsed = seconds; startedAt = Date.now(); };
            player.playVideo = () => {
              if (state !== 1) startedAt = Date.now();
              state = 1;
              window.__backgroundPlaybackStarted = true;
              options.events.onStateChange({ data: state, target: player });
            };
            player.pauseVideo = () => { elapsed = player.getCurrentTime(); state = 2; };
            player.stopVideo = () => { state = 0; };
            const pauseForBackground = () => {
              if (!document.hidden || state !== 1) return;
              elapsed = player.getCurrentTime();
              state = 2;
              window.__backgroundPauseCount = (window.__backgroundPauseCount || 0) + 1;
              options.events.onStateChange({ data: state, target: player });
            };
            document.addEventListener('visibilitychange', pauseForBackground);
            player.destroy = () => document.removeEventListener('visibilitychange', pauseForBackground);
            setTimeout(() => options.events.onReady({ target: player }), 0);
          },
        };
        window.onYouTubeIframeAPIReady();
      `,
    });
  });

  await playerPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await playerPage.waitForFunction(() => {
    const queue = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
    return queue?.currentSongId === 900001 && document.querySelector('#yt-player-embed');
  });
  await playerPage.keyboard.press('Space');
  await playerPage.waitForFunction(() => window.__backgroundPlaybackStarted === true);
  await playerPage.waitForFunction(() => {
    const queue = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
    return queue?.currentSongId === 900001;
  });

  const otherPage = await browser.newPage();
  await otherPage.goto('about:blank');
  await otherPage.bringToFront();
  await new Promise((resolve) => setTimeout(resolve, 6_000));

  const result = await playerPage.evaluate(() => {
    const queue = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
    return {
      backgroundPauseCount: window.__backgroundPauseCount || 0,
      currentSongId: queue?.currentSongId,
      visibilityState: document.visibilityState,
    };
  });
  if (result.backgroundPauseCount < 1) {
    throw new Error(`The fixture did not reproduce a background pause: ${JSON.stringify(result)}`);
  }
  if (result.currentSongId !== 900002) {
    throw new Error(`Background end recovery did not advance the queue: ${JSON.stringify(result)}`);
  }
  console.log(`PASS background playback recovery (${result.visibilityState})`);
} finally {
  await browser.close();
}
