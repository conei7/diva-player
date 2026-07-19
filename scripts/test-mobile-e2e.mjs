import puppeteer from 'puppeteer';

const PAGE_TIMEOUT_MS = 60_000;

function getBaseUrl() {
  const argumentIndex = process.argv.indexOf('--base-url');
  const provided = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : 'https://diva-player.pages.dev/';
  const url = new URL(provided);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForLayout(page) {
  await page.waitForSelector('input[placeholder="ボカロP名や曲名で検索"]');
  await new Promise(resolve => setTimeout(resolve, 750));
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  assert(
    dimensions.documentWidth <= dimensions.viewportWidth + 1
      && dimensions.bodyWidth <= dimensions.viewportWidth + 1,
    `${label} has horizontal overflow: ${JSON.stringify(dimensions)}`,
  );
  console.log(`PASS ${label} mobile width (${dimensions.viewportWidth}px)`);
}

async function main() {
  const baseUrl = getBaseUrl();
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });

    for (const [route, selector, label] of [
      ['', 'a[href*="/watch?v="]', 'home'],
      ['history', 'h1', 'history'],
      ['reports', 'h1', 'reports'],
      ['favorites', 'h1', 'favorites'],
      ['favorite-producers', 'h1', 'favorite producers'],
      ['playlists', 'input[placeholder="新しいプレイリスト"]', 'playlists'],
      ['watch?v=1501', 'main', 'watch'],
    ]) {
      const response = await page.goto(new URL(route, baseUrl), { waitUntil: 'domcontentloaded' });
      assert(response?.ok(), `${label} returned HTTP ${response?.status() ?? 'unknown'}`);
      await waitForLayout(page);
      await page.waitForSelector(selector);
      await assertNoHorizontalOverflow(page, label);
    }

    await page.goto(new URL('playlists', baseUrl), { waitUntil: 'domcontentloaded' });
    await waitForLayout(page);
    const createButtonLayout = await page.$eval('button[aria-label="プレイリストを作成"]', button => {
      const style = getComputedStyle(button);
      return { display: style.display, alignItems: style.alignItems, justifyContent: style.justifyContent };
    });
    assert(createButtonLayout.display === 'flex'
      && createButtonLayout.alignItems === 'center'
      && createButtonLayout.justifyContent === 'center',
    `Playlist create button is not centered: ${JSON.stringify(createButtonLayout)}`);
    await page.type('input[placeholder="新しいプレイリスト"]', '長いタイトルでも操作が重ならないことを確認するプレイリスト');
    await page.click('button[aria-label="プレイリストを作成"]');
    await page.waitForSelector('main main section h1');
    const headerLayout = await page.$eval('main main section', section => {
      const sectionRect = section.getBoundingClientRect();
      const buttonBottoms = [...section.querySelectorAll('button')].map(button => button.getBoundingClientRect().bottom);
      return { sectionBottom: sectionRect.bottom, lastButtonBottom: Math.max(...buttonBottoms) };
    });
    assert(headerLayout.lastButtonBottom <= headerLayout.sectionBottom + 1,
      `Playlist header actions are clipped: ${JSON.stringify(headerLayout)}`);
    await assertNoHorizontalOverflow(page, 'selected playlist');
    console.log('PASS playlist create button and selected header layout');

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForLayout(page);
    await page.click('button[aria-label="メニュー"]');
    await page.waitForSelector('button[aria-label="メニューを閉じる"]', { visible: true });
    await page.waitForFunction(() => {
      const drawer = document.querySelector('button[aria-label="メニューを閉じる"]')?.closest('aside');
      return drawer && Math.abs(drawer.getBoundingClientRect().left) < 1;
    });
    const drawer = await page.$eval('button[aria-label="メニューを閉じる"]', button => {
      const rect = button.closest('aside')?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
    });
    assert(drawer && drawer.left >= -1 && drawer.right <= 391 && drawer.top >= 0 && drawer.bottom <= 844,
      `The mobile drawer does not fit the viewport: ${JSON.stringify(drawer)}`);
    console.log('PASS mobile navigation drawer');
    await page.click('button[aria-label="メニューを閉じる"]');
    await page.waitForFunction(() => {
      const drawer = document.querySelector('button[aria-label="メニューを閉じる"]')?.closest('aside');
      return drawer && drawer.getBoundingClientRect().right <= 1;
    });

    await page.click('button[aria-label="設定・バックアップ"]');
    await page.waitForSelector('[role="dialog"][aria-label="設定・バックアップ"]', { visible: true });
    const settingsPanel = await page.$eval('[role="dialog"][aria-label="設定・バックアップ"] > div', element => {
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
    assert(settingsPanel.left >= 0 && settingsPanel.right <= settingsPanel.viewportWidth,
      `The settings panel overflows horizontally: ${JSON.stringify(settingsPanel)}`);
    assert(settingsPanel.top >= 0 && settingsPanel.bottom <= settingsPanel.viewportHeight,
      `The settings panel overflows vertically: ${JSON.stringify(settingsPanel)}`);
    assert(['auto', 'scroll'].includes(settingsPanel.overflowY),
      `The settings panel is not scrollable: ${JSON.stringify(settingsPanel)}`);
    console.log('PASS mobile settings dialog');
    console.log('Mobile browser E2E test passed.');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`Mobile browser E2E test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
