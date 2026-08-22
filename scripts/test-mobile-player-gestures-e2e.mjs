import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--touch-events=enabled'] });

const songs = ['First gesture fixture', 'Second gesture fixture', 'Third gesture fixture'].map((name, index) => ({
  id: 901000 + index,
  name,
  artistString: 'Gesture producer',
  createDate: '2026-01-01T00:00:00Z',
  defaultName: name,
  defaultNameLanguage: 'English',
  favoritedTimes: 0,
  lengthSeconds: 30,
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  pvs: [{ author: '', disabled: false, id: 9010001 + index, length: 30, name: 'fixture', pvId: `fixture-${index}`, service: 'Youtube', pvType: 'Original', url: `https://youtu.be/fixture-${index}` }],
}));

async function swipe(page, from, to) {
  const geometry = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="mini-player-gesture-surface"]');
    const origin = document.querySelector('[data-testid="mini-player-swipe-origin"]');
    if (!(surface instanceof HTMLElement) || !(origin instanceof HTMLElement)) {
      throw new Error('mini player swipe geometry is unavailable');
    }
    const surfaceBox = surface.getBoundingClientRect();
    const originBox = origin.getBoundingClientRect();
    return {
      surface: { x: surfaceBox.x, width: surfaceBox.width },
      origin: { x: originBox.x, y: originBox.y, width: originBox.width, height: originBox.height },
    };
  });
  const client = await page.createCDPSession();
  // Begin on the song label's explicitly non-button region. Controls opt out
  // of gestures by design, and fixed edge coordinates can land on the close
  // button when fonts or mobile row height change.
  const y = geometry.origin.y + geometry.origin.height / 2;
  const startX = from < to
    ? geometry.origin.x + 8
    : geometry.origin.x + geometry.origin.width - 8;
  const endX = from < to
    ? geometry.surface.x + geometry.surface.width - 24
    : geometry.surface.x + 24;
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startX, y, radiusX: 1, radiusY: 1, id: 1 }],
    modifiers: 0,
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: endX, y, radiusX: 1, radiusY: 1, id: 1 }],
    modifiers: 0,
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
    modifiers: 0,
  });
  await client.detach();
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  // Keep the gesture contract independent from the availability of external
  // fixture videos. An invalid real iframe can auto-skip the queue while the
  // second swipe is being asserted, especially against a remote SBC build.
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
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
            player.getCurrentTime = () => 0;
            player.getDuration = () => 30;
            player.getPlayerState = () => state;
            player.getVolume = () => 50;
            player.setVolume = () => {};
            player.mute = () => {};
            player.unMute = () => {};
            player.seekTo = () => {};
            player.loadVideoById = () => { state = -1; };
            player.cueVideoById = () => { state = 5; };
            player.playVideo = () => {
              state = 1;
              options.events.onStateChange({ data: state, target: player });
            };
            player.pauseVideo = () => { state = 2; };
            player.stopVideo = () => { state = 0; };
            player.destroy = () => {};
            setTimeout(() => options.events.onReady({ target: player }), 0);
          },
        };
        window.onYouTubeIframeAPIReady();
      `,
    });
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate(currentSongs => {
    const tabId = 'mobile-gesture-fixture-tab';
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    localStorage.setItem('diva-playback-owner-v1', JSON.stringify({
      type: 'claim',
      tabId,
      songId: currentSongs[1].id,
      claimedAt: Date.now(),
    }));
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue: currentSongs,
      queueIndex: 1,
      currentSong: currentSongs[1],
      currentSongId: currentSongs[1].id,
      queueSources: ['manual'],
      currentPlaybackSource: 'manual',
    }));
  }, songs);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="mini-player-gesture-surface"]', { timeout: 60_000 });
  await page.evaluate(() => {
    window.__DIVA_GESTURE_EVENTS__ = [];
    const surface = document.querySelector('[data-testid="mini-player-gesture-surface"]');
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      surface?.addEventListener(type, event => {
        window.__DIVA_GESTURE_EVENTS__.push({
          type,
          pointerType: event.pointerType,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          target: event.target instanceof Element ? event.target.tagName : '',
        });
      }, { capture: true });
    }
  });
  const waitForSong = async (name) => {
    try {
      await page.waitForFunction(
        expected => document.querySelector('[data-testid="global-player"]')?.textContent?.includes(expected),
        { timeout: 10_000 },
        name,
      );
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        href: location.href,
        playerText: document.querySelector('[data-testid="global-player"]')?.textContent,
        owner: localStorage.getItem('diva-playback-owner-v1'),
        gestures: window.__DIVA_GESTURE_EVENTS__,
      }));
      throw new Error(`Timed out waiting for ${name}: ${JSON.stringify(diagnostic)} (${error.message})`);
    }
  };
  await waitForSong('Second gesture fixture');

  await swipe(page, 280, 80);
  await waitForSong('Third gesture fixture');
  console.log('PASS left swipe advances queue');

  // Let the first pointer lifecycle and the resulting React render settle
  // before starting a second physical gesture in the opposite direction.
  await new Promise(resolve => setTimeout(resolve, 500));
  await swipe(page, 80, 280);
  await waitForSong('Second gesture fixture');
  console.log('PASS right swipe goes to previous queue item');

  await new Promise(resolve => setTimeout(resolve, 500));

  const rect = await page.$eval('[data-testid="mini-player-swipe-origin"]', element => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  const client = await page.createCDPSession();
  // Use the same explicit non-button origin for the negative downward case so
  // it proves the classifier ignored the direction rather than a button.
  const x = rect.x + rect.width / 2;
  const startY = rect.y + rect.height / 2;
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: startY, radiusX: 1, radiusY: 1, id: 2 }],
    modifiers: 0,
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x, y: startY + 110, radiusX: 1, radiusY: 1, id: 2 }],
    modifiers: 0,
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], modifiers: 0 });
  await client.detach();
  await new Promise(resolve => setTimeout(resolve, 100));
  const stillCurrent = await page.$eval('[data-testid="global-player"]', element => element.textContent?.includes('Second gesture fixture'));
  if (!stillCurrent) throw new Error('downward movement unexpectedly changed the queue');
  console.log('PASS downward movement does not change queue');
} finally {
  await browser.close();
}
