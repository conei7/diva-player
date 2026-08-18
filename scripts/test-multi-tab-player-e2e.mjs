import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

const song = {
  id: 900008,
  name: 'Multi-tab ownership fixture',
  artistString: 'Fixture producer',
  createDate: '2026-01-01T00:00:00Z',
  defaultName: 'Multi-tab ownership fixture',
  defaultNameLanguage: 'English',
  favoritedTimes: 0,
  lengthSeconds: 120,
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  pvs: [{ author: '', disabled: false, id: 9000081, length: 120, name: 'fixture', pvId: 'fixture', service: 'Youtube', pvType: 'Original', url: 'https://youtu.be/fixture' }],
};

async function preparePage() {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__playerLifecycle = { created: 0, destroyed: 0, state: -1 };
  });
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const requestUrl = request.url();
    if (requestUrl.includes('KnowledgeMapPage')) {
      // Keep the lazy route suspended long enough to catch accidental teardown
      // of the persistent player boundary during navigation.
      await new Promise(resolve => setTimeout(resolve, 400));
      await request.continue();
      return;
    }
    if (requestUrl.startsWith('https://vocadb.net/api/songs/900008?')) {
      await request.respond({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(song),
      });
      return;
    }
    if (requestUrl.includes('/backend-api/api/songs/views?ids=900008')) {
      await request.respond({ contentType: 'application/json', body: JSON.stringify({ 900008: { youtubeViews: 0, nicoViews: 0 } }) });
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
            const player = this;
            let state = -1;
            window.__playerLifecycle.created += 1;
            window.__playerLifecycle.state = state;
            player.getCurrentTime = () => 1;
            player.getDuration = () => 120;
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
              window.__playerLifecycle.state = state;
              options.events.onStateChange({ data: state, target: player });
            };
            player.pauseVideo = () => { state = 2; window.__playerLifecycle.state = state; };
            player.stopVideo = () => { state = 0; window.__playerLifecycle.state = state; };
            player.destroy = () => { window.__playerLifecycle.destroyed += 1; };
            setTimeout(() => options.events.onReady({ target: player }), 0);
          },
        };
        window.onYouTubeIframeAPIReady();
      `,
    });
  });
  return page;
}

async function startAndOpenMiniPlayer(page) {
  await page.goto(new URL('watch?v=900008', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => {
    const owner = JSON.parse(localStorage.getItem('diva-playback-owner-v1') || 'null');
    return owner?.type === 'claim' && owner.tabId === sessionStorage.getItem('diva-playback-tab-v1');
  });
  await page.waitForSelector('[aria-label="DIVA Player home"]', { visible: true });
  await page.click('[aria-label="DIVA Player home"]');
  await page.waitForSelector('.global-mini-player', { visible: true });
}

async function assertLazyNavigationKeepsPlayback(page) {
  await page.goto(new URL('watch?v=900008', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__playerLifecycle?.state === 1);
  await page.click('button[aria-label="メニュー"]');
  await page.waitForSelector('a[href$="/knowledge-map"]', { visible: true });
  await page.$eval('a[href$="/knowledge-map"]', link => link.click());
  await new Promise(resolve => setTimeout(resolve, 100));
  const suspendedState = await page.evaluate(() => {
    const player = document.querySelector('[data-testid="global-player"]');
    return {
      exists: Boolean(player),
      hasLayoutBox: Boolean(player?.getClientRects().length),
      isMiniPlayerVisible: Boolean(document.querySelector('.global-mini-player')),
      lifecycle: window.__playerLifecycle,
    };
  });
  if (!suspendedState.exists || !suspendedState.hasLayoutBox || !suspendedState.isMiniPlayerVisible) {
    throw new Error(`Lazy route fallback hid the persistent player: ${JSON.stringify(suspendedState)}`);
  }
  await page.waitForSelector('[data-testid="knowledge-map-page"]', { timeout: 60_000 });
  await page.waitForSelector('.global-mini-player', { visible: true });

  const state = await page.evaluate(() => ({
    lifecycle: window.__playerLifecycle,
    isMiniPlayerVisible: Boolean(document.querySelector('.global-mini-player')),
    title: document.title,
    ownerTabId: JSON.parse(localStorage.getItem('diva-playback-owner-v1') || 'null')?.tabId,
    thisTabId: sessionStorage.getItem('diva-playback-tab-v1'),
  }));
  if (state.lifecycle.created !== 1 || state.lifecycle.destroyed !== 0 || state.lifecycle.state !== 1) {
    throw new Error(`Lazy navigation recreated or stopped the persistent player: ${JSON.stringify(state)}`);
  }
  if (!state.isMiniPlayerVisible || state.ownerTabId !== state.thisTabId) {
    throw new Error(`Lazy navigation lost the local mini-player owner: ${JSON.stringify(state)}`);
  }
  if (state.title !== 'Multi-tab ownership fixture — Fixture producer | DIVA Player') {
    throw new Error(`Lazy navigation left an inconsistent browser title: ${JSON.stringify(state)}`);
  }
  console.log('PASS lazy page navigation preserves playback, mini-player ownership, and title');
}

try {
  const first = await preparePage();
  await assertLazyNavigationKeepsPlayback(first);
  await startAndOpenMiniPlayer(first);

  const second = await preparePage();
  await second.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await second.waitForSelector('[data-testid="global-player"]');
  const passiveState = await second.evaluate(() => ({
    hasMiniPlayer: Boolean(document.querySelector('.global-mini-player')),
    ownerTabId: JSON.parse(localStorage.getItem('diva-playback-owner-v1') || 'null')?.tabId,
    thisTabId: sessionStorage.getItem('diva-playback-tab-v1'),
  }));
  if (passiveState.hasMiniPlayer || passiveState.ownerTabId === passiveState.thisTabId) {
    throw new Error(`Passive tab exposed the active tab's mini-player: ${JSON.stringify(passiveState)}`);
  }
  console.log('PASS passive tab hides another tab\'s mini-player');

  await startAndOpenMiniPlayer(second);
  await first.waitForFunction(() => !document.querySelector('.global-mini-player'));
  const activeState = await second.evaluate(() => ({
    hasMiniPlayer: Boolean(document.querySelector('.global-mini-player')),
    ownerTabId: JSON.parse(localStorage.getItem('diva-playback-owner-v1') || 'null')?.tabId,
    thisTabId: sessionStorage.getItem('diva-playback-tab-v1'),
  }));
  if (!activeState.hasMiniPlayer || activeState.ownerTabId !== activeState.thisTabId) {
    throw new Error(`Takeover tab did not become the sole mini-player owner: ${JSON.stringify(activeState)}`);
  }
  console.log('PASS playback takeover moves the mini-player to the active tab');
} finally {
  await browser.close();
}
