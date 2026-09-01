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
  await first.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await first.waitForSelector('[data-testid="mini-player-close"]', { timeout: 60_000 });
  await first.waitForFunction(() => document.title === 'Player controls fixture — Fixture producer | DIVA Player');
  console.log('PASS dynamic browser tab title');

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
