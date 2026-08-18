import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

const songs = [
  {
    id: 167789,
    name: 'コバルトメモリーズ',
    artistString: 'はるまきごはん feat. 初音ミク',
    createDate: '2017-09-16T14:47:17Z',
    defaultName: 'コバルトメモリーズ',
    defaultNameLanguage: 'Japanese',
    favoritedTimes: 0,
    lengthSeconds: 3,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    pvs: [
      { author: 'はるまきごはん', disabled: false, id: 243038, length: 3, name: 'コバルトメモリーズ / 初音ミク アニメMV', pvId: 'sm31936023', service: 'NicoNicoDouga', pvType: 'Original', url: 'https://www.nicovideo.jp/watch/sm31936023' },
      { author: 'はるまきごはん', disabled: false, id: 243059, length: 3, name: 'コバルトメモリーズ / はるまきごはん feat.初音ミク アニメMV', pvId: '0X_pI_SCDK8', service: 'Youtube', pvType: 'Original', url: 'https://youtu.be/0X_pI_SCDK8' },
    ],
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
    pvs: [
      { author: '', disabled: false, id: 9000021, length: 30, name: 'fixture-2', pvId: 'fixture-2', service: 'Youtube', pvType: 'Original', url: 'https://youtu.be/fixture-2' },
      { author: '', disabled: false, id: 9000022, length: 30, name: 'fixture-2-nico', pvId: 'sm900002', service: 'NicoNicoDouga', pvType: 'Original', url: 'https://www.nicovideo.jp/watch/sm900002' },
    ],
  },
];

try {
  const playerPage = await browser.newPage();
  playerPage.on('pageerror', (error) => console.error('PAGE ERROR', error.message));
  await playerPage.evaluateOnNewDocument((queue) => {
    // A pre-fix hidden-tab timeout must not keep forcing the official Nico PV.
    localStorage.setItem('diva_failedPVs', JSON.stringify({
      '167789': { 'Youtube:0X_pI_SCDK8': Date.now() },
    }));
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
    const requestUrl = request.url();
    if (requestUrl.startsWith('https://vocadb.net/api/songs/167789?')) {
      await request.respond({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(songs[0]),
      });
      return;
    }
    if (requestUrl.includes('/backend-api/api/songs/views?ids=167789')) {
      await request.respond({
        contentType: 'application/json',
        body: JSON.stringify({ 167789: { youtubeViews: 0, nicoViews: 0 } }),
      });
      return;
    }
    if (requestUrl !== 'https://www.youtube.com/iframe_api') {
      await request.continue();
      return;
    }
    await request.respond({
      contentType: 'application/javascript',
      body: `
        window.YT = {
          PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
          Player: function (_id, options) {
            window.__youtubePlayerConstructCount = (window.__youtubePlayerConstructCount || 0) + 1;
            if (document.hidden && window.__youtubePlayerConstructCount > 1) {
              window.__backgroundIframeCreationBlocked = true;
              throw new Error('Background iframe creation was blocked by the fixture');
            }
            const player = this;
            let state = -1;
            let startedAt = 0;
            let elapsed = 0;
            let currentVideoId = options.videoId || null;
            player.getCurrentTime = () => state === 1 ? elapsed + (Date.now() - startedAt) / 1000 : elapsed;
            player.getDuration = () => currentVideoId === '0X_pI_SCDK8' ? 3 : 30;
            player.getPlayerState = () => state;
            player.getVolume = () => 50;
            player.setVolume = () => {};
            player.mute = () => {};
            player.unMute = () => {};
            player.seekTo = (seconds) => { elapsed = seconds; startedAt = Date.now(); };
            player.loadVideoById = (videoId) => {
              currentVideoId = videoId;
              elapsed = 0;
              state = -1;
              if (videoId === 'fixture-2') window.__blockSecondStartUntil = Date.now() + 13_000;
              window.__youtubeLoadedVideoIds = [...(window.__youtubeLoadedVideoIds || []), videoId];
            };
            player.cueVideoById = (videoId) => {
              currentVideoId = videoId;
              elapsed = 0;
              state = 5;
              window.__youtubeLoadedVideoIds = [...(window.__youtubeLoadedVideoIds || []), videoId];
            };
            player.playVideo = () => {
              window.__playVideoAttemptCount = (window.__playVideoAttemptCount || 0) + 1;
              if (currentVideoId === 'fixture-2' && document.hidden && state === -1 && Date.now() < (window.__blockSecondStartUntil || 0)) {
                window.__backgroundInitialStartIgnoreCount = (window.__backgroundInitialStartIgnoreCount || 0) + 1;
                return;
              }
              if (document.hidden && state === 2 && !window.__backgroundRetryIgnored) {
                window.__backgroundRetryIgnored = true;
                return;
              }
              if (state !== 1) startedAt = Date.now();
              state = 1;
              if (window.__wakeRecoveryPending) {
                window.__wakeRecoveryPending = false;
                window.__wakeRecoveryPlayCount = (window.__wakeRecoveryPlayCount || 0) + 1;
              }
              window.__backgroundPlaybackStarted = true;
              if (currentVideoId === 'fixture-2') window.__backgroundSecondPlaybackStarted = true;
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
            window.__simulateDeviceWake = () => {
              elapsed = player.getCurrentTime();
              state = 2;
              window.__wakeRecoveryPending = true;
              document.dispatchEvent(new Event('resume'));
            };
            player.destroy = () => document.removeEventListener('visibilitychange', pauseForBackground);
            setTimeout(() => options.events.onReady({ target: player }), 0);
          },
        };
        window.onYouTubeIframeAPIReady();
      `,
    });
  });

  await playerPage.goto(new URL('watch?v=167789', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await playerPage.waitForFunction(() => {
    const queue = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
    return queue?.currentSongId === 167789 && document.querySelector('#yt-player-embed');
  });
  await playerPage.waitForFunction(() => window.__backgroundPlaybackStarted === true);
  console.log('PASS same-song page click resumes YouTube playback');
  await playerPage.waitForFunction(() => {
    const queue = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
    return queue?.currentSongId === 167789;
  });

  const otherPage = await browser.newPage();
  await otherPage.goto('about:blank');
  await otherPage.bringToFront();
  await new Promise((resolve) => setTimeout(resolve, 9_000));

  const result = await playerPage.evaluate(() => {
    const queue = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
    return {
      backgroundPauseCount: window.__backgroundPauseCount || 0,
      backgroundRetryIgnored: window.__backgroundRetryIgnored || false,
      currentSongId: queue?.currentSongId,
      visibilityState: document.visibilityState,
    };
  });
  if (result.backgroundPauseCount < 1) {
    throw new Error(`The fixture did not reproduce a background pause: ${JSON.stringify(result)}`);
  }
  if (!result.backgroundRetryIgnored) {
    throw new Error(`The fixture did not exercise the retry path: ${JSON.stringify(result)}`);
  }
  if (result.currentSongId !== 900002) {
    throw new Error(`Background end recovery did not advance the queue: ${JSON.stringify(result)}`);
  }
  console.log(`PASS background playback recovery (${result.visibilityState})`);

  await new Promise((resolve) => setTimeout(resolve, 14_000));
  const hiddenTimeoutState = await playerPage.evaluate(() => ({
    failedPVs: JSON.parse(localStorage.getItem('diva_failedPVsV2') || '{}'),
    selectedNicoEmbed: Boolean(document.querySelector('iframe[src*="embed.nicovideo.jp"]')),
    visibilityState: document.visibilityState,
  }));
  if (hiddenTimeoutState.selectedNicoEmbed || Object.keys(hiddenTimeoutState.failedPVs['900002'] || {}).length > 0) {
    throw new Error(`A hidden >12s delay incorrectly failed over to NicoNico: ${JSON.stringify(hiddenTimeoutState)}`);
  }
  // Model a provider/device wake while the DIVA tab remains hidden. Recovery
  // must start the same YouTube iframe without requiring focus or visibility.
  await playerPage.evaluate(() => {
    window.__blockSecondStartUntil = 0;
    document.dispatchEvent(new Event('resume'));
  });
  await playerPage.waitForFunction(() => window.__backgroundSecondPlaybackStarted === true, { timeout: 6_000 });
  const backgroundStart = await playerPage.evaluate(() => ({
    backgroundIframeCreationBlocked: window.__backgroundIframeCreationBlocked || false,
    ignoredStarts: window.__backgroundInitialStartIgnoreCount || 0,
    loadedVideoIds: window.__youtubeLoadedVideoIds || [],
    playAttempts: window.__playVideoAttemptCount || 0,
    playerConstructCount: window.__youtubePlayerConstructCount || 0,
    selectedNicoEmbed: Boolean(document.querySelector('iframe[src*="embed.nicovideo.jp"]')),
    currentFailureMap: JSON.parse(localStorage.getItem('diva_failedPVsV2') || '{}'),
    visibilityState: document.visibilityState,
  }));
  if (backgroundStart.ignoredStarts < 2 || backgroundStart.visibilityState !== 'hidden') {
    throw new Error(`The fixture did not exercise hidden initial-start recovery: ${JSON.stringify(backgroundStart)}`);
  }
  if (backgroundStart.backgroundIframeCreationBlocked || backgroundStart.playerConstructCount !== 1) {
    throw new Error(`YouTube iframe was recreated while hidden: ${JSON.stringify(backgroundStart)}`);
  }
  if (backgroundStart.loadedVideoIds.join(',') !== '0X_pI_SCDK8,fixture-2') {
    throw new Error(`Persistent player did not load both videos in order: ${JSON.stringify(backgroundStart)}`);
  }
  if (backgroundStart.selectedNicoEmbed || Object.keys(backgroundStart.currentFailureMap['900002'] || {}).length > 0) {
    throw new Error(`A hidden startup delay incorrectly failed over to NicoNico: ${JSON.stringify(backgroundStart)}`);
  }
  console.log(`PASS hidden >12s startup delay stays on YouTube and reuses one iframe (${backgroundStart.playAttempts} play attempts)`);

  await playerPage.bringToFront();
  await playerPage.waitForFunction(() => typeof window.__simulateDeviceWake === 'function');
  await playerPage.evaluate(() => window.__simulateDeviceWake());
  await playerPage.waitForFunction(() => (window.__wakeRecoveryPlayCount || 0) >= 1);
  const wakeResult = await playerPage.evaluate(() => ({
    currentSongId: JSON.parse(localStorage.getItem('diva_playerQueue') || 'null')?.currentSongId,
    wakeRecoveryPlayCount: window.__wakeRecoveryPlayCount || 0,
  }));
  if (wakeResult.currentSongId !== 900002) {
    throw new Error(`Device wake recovery changed the active queue item: ${JSON.stringify(wakeResult)}`);
  }
  console.log('PASS device sleep lifecycle recovery resumes the owned queue item');
} finally {
  await browser.close();
}
