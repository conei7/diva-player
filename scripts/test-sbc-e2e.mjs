import puppeteer from 'puppeteer';

const PAGE_TIMEOUT_MS = 60_000;

function getBaseUrl() {
  const argumentIndex = process.argv.indexOf('--base-url');
  const provided = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.SBC_WEB_URL;
  if (!provided) {
    throw new Error('Set SBC_WEB_URL or pass --base-url http://192.168.40.79:8080/diva-player/.');
  }
  const url = new URL(provided);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function inspectPage(page) {
  return page.evaluate(() => ({
    title: document.title,
    searchInput: Boolean(document.querySelector('input[placeholder="ボカロP名や曲名で検索"]')),
    cards: document.querySelectorAll('h3').length,
    warningVisible: [...document.querySelectorAll('[role="status"]')]
      .some(element => element.textContent?.includes('SBCのデータサービスに接続できません')),
  }));
}

async function main() {
  const baseUrl = getBaseUrl();
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const failures = [];
  page.on('pageerror', error => failures.push(`page error: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') failures.push(`console error: ${message.text()}`);
  });

  try {
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await page.setViewport({ width: 1440, height: 900 });

    const homeResponse = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    assert(homeResponse?.ok(), `The home page returned HTTP ${homeResponse?.status() ?? 'unknown'}.`);
    try {
      await page.waitForSelector('input[placeholder="ボカロP名や曲名で検索"]');
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        text: document.body.innerText.slice(0, 500),
      }));
      throw new Error(`The global search input did not render: ${JSON.stringify(diagnostic)} (${error.message})`);
    }
    await page.waitForSelector('h3');
    const home = await inspectPage(page);
    assert(home.title.includes('DIVA Player'), 'The DIVA Player title was not rendered.');
    assert(home.searchInput, 'The global search input was not rendered.');
    assert(home.cards > 0, 'The home page did not render song cards.');
    assert(!home.warningVisible, 'The SBC unavailable warning is visible while the SBC API is healthy.');
    console.log(`PASS home page (${home.cards} visible song cards)`);

    await page.goto(`${baseUrl}history`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('h1');
    const history = await page.evaluate(() => ({
      heading: document.querySelector('h1')?.textContent?.trim(),
      exportEnabled: !document.querySelector('button[title="履歴をJSONで保存"]')?.hasAttribute('disabled'),
      importEnabled: !document.querySelector('button[title="履歴バックアップを追加"]')?.hasAttribute('disabled'),
      statsVisible: Boolean(document.querySelector('[aria-label="視聴統計"]')),
    }));
    assert(history.heading === '視聴履歴', 'The history page heading was not rendered.');
    assert(history.exportEnabled, 'The history export control is unavailable.');
    assert(history.importEnabled, 'The history import control is unavailable.');
    assert(history.statsVisible, 'The history statistics region was not rendered.');
    console.log('PASS history controls and statistics');

    if (failures.length > 0) throw new Error(failures.join('\n'));
    console.log('SBC browser E2E test passed.');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`SBC browser E2E test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
