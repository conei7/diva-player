import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

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
  await page.evaluate(([start, end]) => new Promise(resolve => {
    const surface = document.querySelector('[data-testid="mini-player-gesture-surface"]');
    if (!surface) throw new Error('gesture surface not found');
    const pointerId = 42;
    surface.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId, pointerType: 'touch', clientX: start, clientY: 100 }));
    window.setTimeout(() => {
      surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId, pointerType: 'touch', clientX: end, clientY: 100 }));
      resolve();
    }, 80);
  }), [from, to]);
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate(currentSongs => {
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
  const waitForSong = (name) => page.waitForFunction(
    expected => document.querySelector('[data-testid="global-player"]')?.textContent?.includes(expected),
    { timeout: 60_000 },
    name,
  );
  await waitForSong('Second gesture fixture');

  await swipe(page, 280, 80);
  await waitForSong('Third gesture fixture');
  console.log('PASS left swipe advances queue');

  await swipe(page, 80, 280);
  await waitForSong('Second gesture fixture');
  console.log('PASS right swipe goes to previous queue item');

  await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="mini-player-gesture-surface"]');
    if (!surface) throw new Error('gesture surface not found');
    const pointerId = 43;
    surface.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId, pointerType: 'touch', clientX: 100, clientY: 100 }));
    surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId, pointerType: 'touch', clientX: 102, clientY: 210 }));
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const stillCurrent = await page.$eval('[data-testid="global-player"]', element => element.textContent?.includes('Second gesture fixture'));
  if (!stillCurrent) throw new Error('downward movement unexpectedly changed the queue');
  console.log('PASS downward movement does not change queue');
} finally {
  await browser.close();
}
