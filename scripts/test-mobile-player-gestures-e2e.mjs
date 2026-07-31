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
  const rect = await page.$eval('[data-testid="mini-player-gesture-surface"]', element => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  const client = await page.createCDPSession();
  const y = rect.y + rect.height / 2;
  const startX = from < to ? rect.x + 24 : rect.x + rect.width - 24;
  const endX = from < to ? rect.x + rect.width - 24 : rect.x + 24;
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

  const rect = await page.$eval('[data-testid="mini-player-gesture-surface"]', element => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  const client = await page.createCDPSession();
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
