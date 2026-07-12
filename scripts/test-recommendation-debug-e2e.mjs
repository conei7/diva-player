import puppeteer from 'puppeteer';

const TIMEOUT_MS = 60_000;

function getBaseUrl() {
  const argumentIndex = process.argv.indexOf('--base-url');
  const provided = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.SBC_WEB_URL;
  if (!provided) throw new Error('Set SBC_WEB_URL or pass --base-url http://192.168.40.79:8080/diva-player/.');
  const url = new URL(provided);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const baseUrl = getBaseUrl();
  const debugUrl = new URL(baseUrl);
  debugUrl.searchParams.set('recDebug', '1');
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  try {
    await page.goto(debugUrl.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[placeholder="ボカロP名や曲名で検索"]');
    await page.waitForSelector('h3');
    await page.waitForSelector('button', { timeout: TIMEOUT_MS });
    const debugButton = await page.evaluate(() => [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('推薦デバッグ'))?.textContent ?? null);
    assert(debugButton, 'The recommendation debug button was not rendered for recDebug=1.');

    await page.evaluate(() => [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('推薦デバッグ'))?.click());
    await page.waitForSelector('[role="dialog"]');
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] tbody tr').length > 0);
    const dialog = await page.evaluate(() => ({
      rows: document.querySelectorAll('[role="dialog"] tbody tr').length,
      text: document.querySelector('[role="dialog"]')?.textContent ?? '',
    }));
    assert(dialog.rows > 0, 'The recommendation debug dialog had no candidate rows.');
    assert(dialog.text.includes('Evidence'), 'The recommendation debug table did not show score columns.');
    console.log(`PASS recommendation debug home (${dialog.rows} trace rows)`);

    await page.goto(new URL('watch?v=1501', baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button', { timeout: TIMEOUT_MS });
    const preserved = await page.evaluate(() => [...document.querySelectorAll('button')]
      .some(button => button.textContent?.includes('推薦デバッグ')));
    assert(preserved, 'Debug mode was not preserved when navigating to the watch page.');
    console.log('PASS recommendation debug watch navigation');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`Recommendation debug E2E failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
