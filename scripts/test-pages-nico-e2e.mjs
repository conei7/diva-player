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
  await new Promise(resolve => setTimeout(resolve, 3_000));
  const src = await page.$eval(selector, element => element.src);
  if (embedStatus !== null && embedStatus >= 400) throw new Error(`Nico embed returned HTTP ${embedStatus}`);
  console.log(`PASS fixed-origin Nico embed (${embedStatus ?? 'loaded'}, ${src})`);
} finally {
  await browser.close();
}
