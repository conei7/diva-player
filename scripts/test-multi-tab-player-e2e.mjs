import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

const song = {
  id: 483777,
  name: 'スターダストメドレー',
  artistString: 'Fixture producer',
  createDate: '2026-01-01T00:00:00Z',
  defaultName: 'スターダストメドレー',
  defaultNameLanguage: 'Japanese',
  favoritedTimes: 0,
  lengthSeconds: 120,
  pvServices: 'Youtube,NicoNicoDouga',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  pvs: [
    { author: '', disabled: false, id: 4837771, length: 120, name: 'YouTube Topic fixture', pvId: 'fixture', service: 'Youtube', pvType: 'Original', url: 'https://youtu.be/fixture' },
    { author: '', disabled: false, id: 4837772, length: 120, name: 'Nico official fixture', pvId: 'sm-fixture', service: 'NicoNicoDouga', pvType: 'Original', url: 'https://www.nicovideo.jp/watch/sm-fixture' },
  ],
};

async function preparePage() {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__playerLifecycle = { created: 0, destroyed: 0, state: -1, nativePlay: null };
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
    const parsedUrl = new URL(requestUrl);
    const requestedSongIds = parsedUrl.searchParams.get('ids')?.split(',') ?? [];
    if (
      (parsedUrl.pathname.endsWith('/api/songs/details') || parsedUrl.pathname.endsWith('/api/songs/batch'))
      && requestedSongIds.includes(String(song.id))
    ) {
      await request.respond({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ items: [song] }),
      });
      return;
    }
    if (requestUrl.startsWith(`https://vocadb.net/api/songs/${song.id}?`)) {
      await request.respond({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(song),
      });
      return;
    }
    if (requestUrl.includes(`/backend-api/api/songs/views?ids=${song.id}`)) {
      await request.respond({ contentType: 'application/json', body: JSON.stringify({ [song.id]: { youtubeViews: 0, nicoViews: 0 } }) });
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
            const iframe = document.getElementById(_id);
            iframe.tabIndex = -1;
            let state = -1;
            window.__playerLifecycle.created += 1;
            window.__playerLifecycle.state = state;
            player.getCurrentTime = () => 1;
            player.getDuration = () => 120;
            player.getPlayerState = () => state;
            player.getVolume = () => 50;
            player.getIframe = () => iframe;
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
            window.__playerLifecycle.nativePlay = () => {
              iframe.focus();
              player.playVideo();
            };
            player.pauseVideo = () => {
              state = 2;
              window.__playerLifecycle.state = state;
              options.events.onStateChange({ data: state, target: player });
            };
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
  await page.goto(new URL(`watch?v=${song.id}`, baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => {
    const owner = JSON.parse(localStorage.getItem('diva-playback-owner-v1') || 'null');
    return owner?.type === 'claim' && owner.tabId === sessionStorage.getItem('diva-playback-tab-v1');
  });
  await page.waitForSelector('[aria-label="DIVA Player home"]', { visible: true });
  await page.click('[aria-label="DIVA Player home"]');
  await page.waitForSelector('.global-mini-player', { visible: true });
}

async function assertLazyNavigationKeepsPlayback(page) {
  // With no live owner, a copied autoplay=0 URL is still expected to play.
  // The flag only prevents a newly opened tab from stealing another tab.
  await page.goto(new URL(`watch?v=${song.id}&autoplay=0`, baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
  if (state.title !== 'スターダストメドレー — Fixture producer | DIVA Player') {
    throw new Error(`Lazy navigation left an inconsistent browser title: ${JSON.stringify(state)}`);
  }
  console.log('PASS lazy page navigation preserves playback, mini-player ownership, and title');
}

async function assertAutoplayZeroStaysPassive(page) {
  await page.goto(new URL(`watch?v=${song.id}&autoplay=0`, baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(songName => (
    window.__playerLifecycle?.created === 1 && document.title.startsWith(songName)
  ), {}, song.name);
  const initialState = await page.evaluate(() => window.__playerLifecycle?.state);
  if (initialState === 1) {
    throw new Error(`autoplay=0 started while another tab owned playback (state ${initialState})`);
  }

  // The old implementation armed a 12-second readiness timeout even though
  // playback was intentionally paused. That falsely failed YouTube and fell
  // through to the Nico PV. Wait past that boundary to lock in the fix.
  await new Promise(resolve => setTimeout(resolve, 13_000));
  const state = await page.evaluate(songId => ({
    lifecycle: window.__playerLifecycle,
    failedPVs: JSON.parse(localStorage.getItem('diva_failedPVsV2') || '{}')[String(songId)] ?? null,
    hasNicoPlayer: Boolean(document.querySelector('iframe[src*="embed.nicovideo.jp"]')),
    hasMiniPlayer: Boolean(document.querySelector('.global-mini-player')),
    ownerTabId: JSON.parse(localStorage.getItem('diva-playback-owner-v1') || 'null')?.tabId,
    thisTabId: sessionStorage.getItem('diva-playback-tab-v1'),
  }), song.id);
  if (state.lifecycle.state === 1 || state.failedPVs || state.hasNicoPlayer || state.hasMiniPlayer) {
    throw new Error(`autoplay=0 falsely started or failed over after 12 seconds: ${JSON.stringify(state)}`);
  }
  if (state.ownerTabId === state.thisTabId) {
    throw new Error(`autoplay=0 stole playback ownership from the active tab: ${JSON.stringify(state)}`);
  }
  console.log('PASS song 483777 autoplay=0 stays paused on YouTube past the old 12-second failover');
}

try {
  const first = await preparePage();
  await assertLazyNavigationKeepsPlayback(first);
  await startAndOpenMiniPlayer(first);

  const second = await preparePage();
  await assertAutoplayZeroStaysPassive(second);
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

  await second.close();
  await first.bringToFront();
  await first.evaluate(() => window.__playerLifecycle.nativePlay());
  await first.waitForFunction(() => {
    const owner = JSON.parse(localStorage.getItem('diva-playback-owner-v1') || 'null');
    return window.__playerLifecycle?.state === 1
      && owner?.type === 'claim'
      && owner.tabId === sessionStorage.getItem('diva-playback-tab-v1');
  });
  await new Promise(resolve => setTimeout(resolve, 6_500));
  const reclaimedState = await first.evaluate(() => ({
    lifecycle: window.__playerLifecycle,
    isPlaying: document.querySelector('button[aria-label="一時停止"]') !== null,
    ownerTabId: JSON.parse(localStorage.getItem('diva-playback-owner-v1') || 'null')?.tabId,
    thisTabId: sessionStorage.getItem('diva-playback-tab-v1'),
  }));
  if (reclaimedState.lifecycle.state !== 1
      || !reclaimedState.isPlaying
      || reclaimedState.ownerTabId !== reclaimedState.thisTabId) {
    throw new Error(`Original tab could not reclaim stable playback after the owner closed: ${JSON.stringify(reclaimedState)}`);
  }
  console.log('PASS original tab reclaims stable playback after the takeover tab closes');
} finally {
  await browser.close();
}
