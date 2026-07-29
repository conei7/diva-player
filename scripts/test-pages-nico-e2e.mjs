import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'https://diva-player.pages.dev/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  let embedStatus = null;
  page.on('response', response => {
    if (response.url().includes('embed.nicovideo.jp/watch/sm7918983')) embedStatus = response.status();
  });
  await page.goto(new URL('watch?v=3269', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const selector = 'iframe[src*="embed.nicovideo.jp/watch/sm7918983"]';
  await page.waitForSelector(selector, { timeout: 60_000 });
  // The app intentionally waits up to 12 seconds before falling back to a
  // different PV. Waiting beyond that window catches regressions where the
  // iframe is visible but its playback events are not recognized.
  await new Promise(resolve => setTimeout(resolve, 30_000));
  const src = await page.$eval(selector, element => element.src);
  const playerState = await page.evaluate(() => ({
    url: location.href,
    nicoFrames: document.querySelectorAll('iframe[src*="embed.nicovideo.jp"]').length,
    youtubeFrames: document.querySelectorAll('iframe[src*="youtube.com"]').length,
  }));
  if (playerState.nicoFrames !== 1 || playerState.youtubeFrames !== 0) {
    throw new Error(`Nico playback fell back or disappeared: ${JSON.stringify(playerState)}`);
  }
  if (embedStatus !== null && embedStatus >= 400) throw new Error(`Nico embed returned HTTP ${embedStatus}`);
  console.log(`PASS Nico autoplay remained active for 30s (${embedStatus ?? 'loaded'}, ${src})`);
} finally {
  await browser.close();
}
