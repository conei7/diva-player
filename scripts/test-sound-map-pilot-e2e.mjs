import puppeteer from 'puppeteer';

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:5173/diva-player/');
const seedSongId = process.argv[3];
if (!seedSongId) throw new Error('Pass the exported default seed song ID as the second argument.');

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  await page.setViewport({ width: 1580, height: 900 });
  const url = new URL('sound-map', baseUrl);
  url.searchParams.set('pilot', '1');
  url.searchParams.set('seedSongId', seedSongId);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sound-map-canvas"] g[role="button"]');

  const initial = await page.evaluate(() => ({
    pointCount: document.querySelectorAll('[data-testid="sound-map-canvas"] g[role="button"]').length,
    selectedTitle: document.querySelector('[data-testid="sound-map-selected-title"]')?.textContent,
    hasPilotCopy: document.querySelector('[data-testid="sound-map-page"]')?.textContent?.includes('実データpilotです。'),
    hasBackendNotice: Boolean(document.querySelector('[data-testid="backend-status-notice"]')),
  }));
  if (initial.pointCount !== 200) throw new Error(`Expected 200 rendered pilot points, received ${initial.pointCount}.`);
  if (!initial.hasPilotCopy) throw new Error('Real-data pilot explanation is missing.');
  if (initial.hasBackendNotice) throw new Error('Backend connection notice is visible in pilot mode.');

  const points = await page.$$('[data-testid="sound-map-canvas"] g[role="button"]');
  const targetId = await points[1].evaluate(element => element.getAttribute('data-song-id'));
  await points[1].click();
  await page.waitForFunction(
    previous => document.querySelector('[data-testid="sound-map-selected-title"]')?.textContent !== previous,
    {},
    initial.selectedTitle,
  );
  const selectedTitle = await page.$eval('[data-testid="sound-map-selected-title"]', element => element.textContent);

  const buttons = await page.$$('button');
  const originButton = await Promise.all(buttons.map(async button => ({
    button,
    text: await button.evaluate(element => element.textContent?.trim()),
  }))).then(entries => entries.find(entry => entry.text === 'この曲の近くを探す')?.button);
  if (!originButton) throw new Error('Origin-change button is missing.');
  await originButton.click();
  await page.waitForFunction(
    expected => new URL(location.href).searchParams.get('seedSongId') === expected,
    {},
    targetId,
  );

  console.log(JSON.stringify({
    renderedPoints: initial.pointCount,
    initialTitle: initial.selectedTitle,
    selectedTitle,
    newSeedSongId: targetId,
  }));
} finally {
  await browser.close();
}
