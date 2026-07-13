import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'https://diva-player.pages.dev/';
const base = new URL(baseUrl);
const normalizePath = path => path.replace(/\/+$/, '') || '/';
const expectedRoot = normalizePath(new URL(base.pathname, base.origin).pathname);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage();
  await page.goto(new URL('watch?v=1501', base), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('a[aria-label="DIVA Player home"]', { timeout: 60_000 });
  await page.waitForSelector('a[aria-label$=" の曲を表示"]', { timeout: 60_000 });
  const producerHref = await page.$eval('a[aria-label$=" の曲を表示"]', element => element.getAttribute('href'));
  if (!producerHref?.includes('artistId=') && !producerHref?.includes('?q=')) {
    throw new Error(`Watch-page producer is not a searchable link: ${producerHref}`);
  }
  await page.waitForSelector('button[aria-label="概要を展開する"]', { timeout: 60_000 });
  await page.click('button[aria-label="概要を展開する"]');
  await page.waitForSelector('button[aria-label="概要を折りたたむ"]', { timeout: 60_000 });
  const descriptionState = await page.$eval('button[aria-label="概要を折りたたむ"]', button => {
    const root = button.closest('div[aria-expanded]');
    const text = root?.querySelector('p');
    text?.click();
    return {
      expanded: root?.getAttribute('aria-expanded'),
      whiteSpace: text ? getComputedStyle(text).whiteSpace : null,
      linkCount: root?.querySelectorAll('p a[href^="http"]').length ?? 0,
    };
  });
  if (descriptionState.expanded !== 'true' || descriptionState.whiteSpace !== 'pre-wrap') {
    throw new Error(`Unexpected description state: ${JSON.stringify(descriptionState)}`);
  }
  await page.click('button[aria-label="概要を折りたたむ"]');
  await page.waitForSelector('button[aria-label="概要を展開する"]', { timeout: 60_000 });
  console.log(`PASS description expansion UX (${descriptionState.linkCount} inline links)`);
  const href = await page.$eval('a[aria-label="DIVA Player home"]', element => element.getAttribute('href'));
  await page.click('a[aria-label="DIVA Player home"]');
  await page.waitForFunction(path => (location.pathname.replace(/\/+$/, '') || '/') === path, {}, expectedRoot);
  if (normalizePath(href ?? '') !== expectedRoot) {
    throw new Error(`Unexpected home link href: ${href}; expected ${expectedRoot}`);
  }
  console.log(`PASS logo navigation (${href} -> ${expectedRoot})`);
  console.log(`PASS watch-page producer link (${producerHref})`);

  const searchInput = 'input[placeholder="ボカロP名や曲名で検索"]';
  await page.waitForSelector(searchInput, { timeout: 60_000 });
  await page.type(searchInput, '千本桜');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.textContent?.includes('検索結果'), { timeout: 60_000 });
  await page.click('a[aria-label="DIVA Player home"]');
  await page.waitForFunction(() => {
    const activeCategory = document.querySelector('button[data-active="true"]');
    const input = document.querySelector('input[placeholder="ボカロP名や曲名で検索"]');
    return activeCategory?.textContent?.includes('あなたへのおすすめ')
      && input instanceof HTMLInputElement
      && input.value === '';
  }, { timeout: 60_000 });
  console.log('PASS search state resets on home navigation');

  await page.waitForSelector('a[href*="/watch?v="]', { timeout: 60_000 });
  const songHref = await page.$eval('a[href*="/watch?v="]', element => element.getAttribute('href'));
  if (!songHref?.includes('/watch?v=')) throw new Error(`Song card is not a semantic link: ${songHref}`);
  const vocadbFavoriteBadgeCount = await page.$$eval('[title="VocaDB お気に入り数"]', elements => elements.length);
  if (vocadbFavoriteBadgeCount !== 0) throw new Error('VocaDB favorite badge is still visible.');
  console.log(`PASS semantic song link and hidden VocaDB favorite badge (${songHref})`);
} finally {
  await browser.close();
}
