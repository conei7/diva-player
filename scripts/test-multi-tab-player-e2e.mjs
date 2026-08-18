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
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const requestUrl = request.url();
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

try {
  const first = await preparePage();
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
