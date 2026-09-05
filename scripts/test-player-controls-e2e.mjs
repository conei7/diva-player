import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

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

try {
  const first = await browser.newPage();
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
  await first.waitForFunction(() => document.title === 'Player controls fixture — Fixture producer | DIVA Player');
  console.log('PASS dynamic browser tab title');

  await first.waitForFunction(() => window.__yt?.getVideoData().video_id === 'fixture');
  await new Promise(resolve => setTimeout(resolve, 1_100));
  // Native iframe play updates the store first; the resulting React effect must
  // not arm another startup timeout while the player is already playing.
  await first.evaluate(() => window.__yt.playVideo());
  await first.waitForSelector('button[title="一時停止"]');
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
      await first.$eval('button[title="一時停止"]', button => button.click());
      await first.waitForFunction(() => window.__yt.getPlayerState() === 2);
      await first.$eval('button[title="再生"]', button => button.click());
      await first.waitForFunction(() => window.__yt.getPlayerState() === 1);
    }
    await new Promise(resolve => setTimeout(resolve, 12_500));
    await assertSameVideo(`YouTube pause/resume preserves PV and audio (hidden=${hidden})`);
    const position = await first.evaluate(() => window.__yt.getCurrentTime());
    if (position !== 20) throw new Error(`Resume reset position to ${position}`);
  }
  await first.$eval('button[title="一時停止"]', button => button.click());
  await first.waitForFunction(() => window.__yt.getPlayerState() === 2);
  await new Promise(resolve => setTimeout(resolve, 12_500));
  const pausedState = await first.evaluate(() => ({
    state: window.__yt.getPlayerState(), mutes: window.__ytMutes, stops: window.__ytStops,
  }));
  if (pausedState.state !== 2 || pausedState.mutes !== 0 || pausedState.stops !== 0) {
    throw new Error(`Long pause triggered recovery: ${JSON.stringify(pausedState)}`);
  }
  await first.$eval('button[title="再生"]', button => button.click());
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
} finally {
  await browser.close();
}
