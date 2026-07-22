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

  await first.click('[data-testid="mini-player-close"]');
  await first.waitForFunction(() => !document.querySelector('[data-testid="mini-player-close"]'));
  const queueCleared = await first.evaluate(() => localStorage.getItem('diva_playerQueue') === null);
  if (!queueCleared) throw new Error('Closing the mini player did not clear the persisted queue.');
  console.log('PASS mini-player close control');
} finally {
  await browser.close();
}
