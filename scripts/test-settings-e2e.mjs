import puppeteer from 'puppeteer';

const PAGE_TIMEOUT_MS = 30_000;

function getBaseUrl() {
  const argumentIndex = process.argv.indexOf('--base-url');
  const provided = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : 'http://127.0.0.1:4173/';
  const url = new URL(provided);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertDialogFits(page, label, selector) {
  const layout = await page.$eval(`${selector} > div`, element => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      overflowY: getComputedStyle(element).overflowY,
    };
  });
  assert(layout.left >= 0 && layout.right <= layout.viewportWidth
    && layout.top >= 0 && layout.bottom <= layout.viewportHeight,
  `${label} does not fit the viewport: ${JSON.stringify(layout)}`);
  assert(['auto', 'scroll'].includes(layout.overflowY), `${label} is not scrollable: ${JSON.stringify(layout)}`);
}

async function runViewport(page, baseUrl, width, height) {
  const label = `${width}x${height}`;
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  assert(response && response.status() < 400, `Home returned HTTP ${response?.status() ?? 'unknown'}`);
  await page.waitForSelector('button[aria-label="設定"]');
  await page.click('button[aria-label="設定"]');
  await page.waitForSelector('[role="dialog"][aria-label="設定"]', { visible: true });

  const tabs = await page.$$eval('[role="dialog"][aria-label="設定"] [role="tab"]', elements => elements.map(element => ({
    controls: element.getAttribute('aria-controls'),
    selected: element.getAttribute('aria-selected'),
  })));
  assert(tabs.length === 3 && tabs.filter(tab => tab.selected === 'true').length === 1,
    `${label} settings tabs are invalid: ${JSON.stringify(tabs)}`);
  await assertDialogFits(page, `${label} settings dialog`, '[role="dialog"][aria-label="設定"]');

  const initialHintState = await page.$$eval('.setting-row', rows => {
    const row = rows.find(element => element.textContent?.includes('選曲ヒント'));
    return row?.querySelector('input[type="checkbox"]')?.checked ?? null;
  });
  assert(initialHintState === false, `${label} recommendation hints should be hidden by default`);
  const enabledHintState = await page.$$eval('.setting-row', rows => {
    const row = rows.find(element => element.textContent?.includes('選曲ヒント'));
    const input = row?.querySelector('input[type="checkbox"]');
    if (!(input instanceof HTMLInputElement)) return null;
    input.click();
    return input.checked;
  });
  assert(enabledHintState === true, `${label} recommendation hints could not be enabled`);
  assert(await page.evaluate(() => localStorage.getItem('diva-player-recommendation-hints')) === '1',
    `${label} recommendation hint preference was not persisted`);
  await page.$$eval('.setting-row', rows => {
    const row = rows.find(element => element.textContent?.includes('選曲ヒント'));
    const input = row?.querySelector('input[type="checkbox"]');
    if (input instanceof HTMLInputElement) input.click();
  });

  await page.click('[role="tab"][aria-controls="settings-panel-data"]');
  await page.waitForSelector('#settings-panel-data');
  const openButtonFound = await page.evaluate(() => [...document.querySelectorAll('button')]
    .some(button => button.textContent?.includes('データとバックアップを開く')));
  assert(openButtonFound, `${label} backup entry point is missing`);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(element => element.textContent?.includes('データとバックアップを開く'));
    if (button instanceof HTMLButtonElement) button.click();
  });

  await page.waitForSelector('[role="dialog"][aria-label="データとバックアップ"]', { visible: true });
  assert(!await page.$('[role="dialog"][aria-label="設定"]'), `${label} nested settings dialog remained mounted`);
  await assertDialogFits(page, `${label} backup dialog`, '[role="dialog"][aria-label="データとバックアップ"]');

  const backupUi = await page.$eval('[role="dialog"][aria-label="データとバックアップ"]', dialog => ({
    hasExport: [...dialog.querySelectorAll('button')].some(button => button.textContent?.includes('完全バックアップを保存')),
    hasImport: [...dialog.querySelectorAll('button')].some(button => button.textContent?.includes('バックアップファイルを選択')),
    navigationTargets: [...dialog.querySelectorAll('.backup-modal-header button')].map(button => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  }));
  assert(backupUi.hasExport && backupUi.hasImport, `${label} backup actions are incomplete: ${JSON.stringify(backupUi)}`);
  assert(backupUi.navigationTargets.every(target => target.width >= 40 && target.height >= 40),
    `${label} backup navigation targets are too small: ${JSON.stringify(backupUi.navigationTargets)}`);

  await page.click('.backup-back-button');
  await page.waitForSelector('[role="dialog"][aria-label="設定"] #settings-panel-data', { visible: true });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"][aria-label="設定"]', { hidden: true });
  console.log(`PASS settings and backup separation ${label}`);
}

async function main() {
  const baseUrl = getBaseUrl();
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await runViewport(page, baseUrl, 390, 844);
    await runViewport(page, baseUrl, 1280, 900);
    console.log('Settings browser E2E test passed.');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`Settings browser E2E test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
