import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'https://diva-player.pages.dev/';
const base = new URL(baseUrl);
const expectedRoot = new URL(base.pathname, base.origin).pathname;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage();
  await page.goto(new URL('watch?v=1501', base), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('a[aria-label="DIVA Player home"]', { timeout: 60_000 });
  const href = await page.$eval('a[aria-label="DIVA Player home"]', element => element.getAttribute('href'));
  await page.click('a[aria-label="DIVA Player home"]');
  await page.waitForFunction(path => location.pathname === path, {}, expectedRoot);
  if (href !== expectedRoot && !(expectedRoot === '/' && href === '/')) {
    throw new Error(`Unexpected home link href: ${href}; expected ${expectedRoot}`);
  }
  console.log(`PASS logo navigation (${href} -> ${expectedRoot})`);
} finally {
  await browser.close();
}
