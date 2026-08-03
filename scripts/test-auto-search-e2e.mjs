import puppeteer from 'puppeteer';

const argumentIndex = process.argv.indexOf('--base-url');
const baseUrl = argumentIndex >= 0
  ? process.argv[argumentIndex + 1]
  : 'http://192.168.40.79:8080/diva-player/';
const expectedSongId = 163402;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (!response || response.status() >= 400) throw new Error(`Home returned HTTP ${response?.status() ?? 'unknown'}`);

  const searchInput = 'input[placeholder="ボカロP名や曲名で検索"]';
  await page.waitForSelector(searchInput, { visible: true, timeout: 30_000 });
  await page.click(searchInput);
  await page.type(searchInput, 'シャルル');
  await page.keyboard.press('Enter');

  const exactSongLink = `a[href*="/watch?v=${expectedSongId}"]`;
  try {
    await page.waitForSelector(exactSongLink, { visible: true, timeout: 60_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      alert: document.querySelector('[role="alert"]')?.textContent?.trim(),
      heading: document.querySelector('h1')?.textContent?.trim(),
      text: document.body.innerText.slice(0, 800),
      resultLinks: [...document.querySelectorAll('a[href*="/watch?v="]')].slice(0, 5).map(link => ({
        href: link.getAttribute('href'),
        title: link.textContent?.trim(),
      })),
    }));
    throw new Error(`Exact シャルル did not appear: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  const firstResult = await page.$eval('a[href*="/watch?v="]', link => ({
    href: link.getAttribute('href'),
    title: link.textContent?.trim(),
  }));
  if (!firstResult.href?.includes(`v=${expectedSongId}`)) {
    throw new Error(`Exact シャルル was not first: ${JSON.stringify(firstResult)}`);
  }
  console.log(`PASS auto search prefers exact song title: ${firstResult.title} (${expectedSongId})`);
} finally {
  await browser.close();
}
