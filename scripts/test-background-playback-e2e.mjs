import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });

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
  await playerPage.bringToFront();
  await playerPage.waitForFunction(() => document.visibilityState === 'visible');
  await pinAppLanguage(playerPage);
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
    const parsedUrl = new URL(requestUrl);
    if (parsedUrl.pathname === '/backend-api/api/songs/details') {
      const ids = (parsedUrl.searchParams.get('ids') || '').split(',').filter(Boolean).map(Number);
      const items = ids.flatMap(id => {
        const song = songs.find(candidate => candidate.id === id);
        return song ? [song] : [];
      });
      await request.respond({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ items }),
      });
      return;
    }
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
            player.getDuration = () => 30;
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
              if (state !== 1) startedAt = Date.now();
              state = 1;
              window.__successfulPlayCount = (window.__successfulPlayCount || 0) + 1;
              if (window.__wakeRecoveryPending) {
                window.__wakeRecoveryPending = false;
                window.__wakeRecoveryPlayCount = (window.__wakeRecoveryPlayCount || 0) + 1;
              }
              window.__backgroundPlaybackStarted = true;
              options.events.onStateChange({ data: state, target: player });
            };
            player.pauseVideo = () => {
              if (document.hidden && state === 1) {
                window.__backgroundPauseCount = (window.__backgroundPauseCount || 0) + 1;
              }
              elapsed = player.getCurrentTime();
              state = 2;
            };
            player.stopVideo = () => { state = 0; };
            window.__youtubeState = () => state;
            window.__simulateDeviceWake = () => {
              elapsed = player.getCurrentTime();
              state = 2;
              window.__wakeRecoveryPending = true;
              document.dispatchEvent(new Event('resume'));
            };
            player.destroy = () => {};
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
    return queue?.currentSongId === 167789
      && document.querySelector('#yt-player-embed')
      && document.body.innerText.includes('コバルトメモリーズ');
  });
  try {
    await playerPage.waitForFunction(() => window.__backgroundPlaybackStarted === true);
  } catch {
    const playbackStartState = await playerPage.evaluate(() => ({
      backgroundPlaybackStarted: window.__backgroundPlaybackStarted === true,
      loadedVideoIds: window.__youtubeLoadedVideoIds || [],
      nativePlayerState: window.__youtubeState?.(),
      playerConstructCount: window.__youtubePlayerConstructCount || 0,
      playVideoAttemptCount: window.__playVideoAttemptCount || 0,
      queueSongId: JSON.parse(localStorage.getItem('diva_playerQueue') || 'null')?.currentSongId,
      visibilityState: document.visibilityState,
    }));
    throw new Error(`YouTube playback did not start in the foreground fixture: ${JSON.stringify(playbackStartState)}`);
  }
  console.log('PASS same-song page click resumes YouTube playback');
  await playerPage.waitForFunction(() => {
    const queue = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
    return queue?.currentSongId === 167789;
  });
  await playerPage.evaluate(() => window.__simulateDeviceWake());
  await playerPage.waitForFunction(() => (window.__wakeRecoveryPlayCount || 0) >= 1);
  const foregroundWakePlayCount = await playerPage.evaluate(() => window.__successfulPlayCount || 0);

  const otherPage = await browser.newPage();
  await otherPage.goto('about:blank');
  await otherPage.bringToFront();
  await new Promise((resolve) => setTimeout(resolve, 9_000));

  const result = await playerPage.evaluate(() => {
    const queue = JSON.parse(localStorage.getItem('diva_playerQueue') || 'null');
    return {
      backgroundPauseCount: window.__backgroundPauseCount || 0,
      nativePlayerState: window.__youtubeState?.(),
      successfulPlayCount: window.__successfulPlayCount || 0,
      currentSongId: queue?.currentSongId,
      visibilityState: document.visibilityState,
    };
  });
  if (result.visibilityState !== 'hidden' || result.backgroundPauseCount !== 0 || result.nativePlayerState !== 1) {
    throw new Error(`YouTube playback did not continue while hidden: ${JSON.stringify(result)}`);
  }
  if (result.currentSongId !== 167789 || result.successfulPlayCount !== foregroundWakePlayCount) {
    throw new Error(`YouTube playback unexpectedly advanced or restarted while hidden: ${JSON.stringify(result)}`);
  }
  console.log('PASS YouTube keeps playing when its app tab is hidden');

  // Browsers may suspend a hidden iframe on device sleep; its existing intent
  // should recover without a foreground interaction.
  await playerPage.evaluate(() => {
    window.__simulateDeviceWake();
  });
  await playerPage.waitForFunction(() => (window.__wakeRecoveryPlayCount || 0) >= 2);
  const hiddenWake = await playerPage.evaluate(() => ({
    nativePlayerState: window.__youtubeState?.(),
    successfulPlayCount: window.__successfulPlayCount || 0,
  }));
  if (hiddenWake.nativePlayerState !== 1 || hiddenWake.successfulPlayCount <= foregroundWakePlayCount) {
    throw new Error(`YouTube did not recover while hidden after device wake: ${JSON.stringify(hiddenWake)}`);
  }
  console.log('PASS hidden device-wake signal recovers the same YouTube player');

  await playerPage.bringToFront();
  await playerPage.waitForFunction(() => document.visibilityState === 'visible');
  await playerPage.waitForFunction(() => window.__youtubeState?.() === 1);
  const foregroundReturn = await playerPage.evaluate(() => ({
    currentSongId: JSON.parse(localStorage.getItem('diva_playerQueue') || 'null')?.currentSongId,
    successfulPlayCount: window.__successfulPlayCount || 0,
  }));
  if (foregroundReturn.currentSongId !== 167789 || foregroundReturn.successfulPlayCount !== hiddenWake.successfulPlayCount) {
    throw new Error(`Returning to the DIVA tab changed its YouTube item or restarted playback: ${JSON.stringify(foregroundReturn)}`);
  }
  console.log('PASS returning to the DIVA tab keeps the same YouTube item playing');
} finally {
  await browser.close();
}
