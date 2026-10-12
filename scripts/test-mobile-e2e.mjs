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

async function assertBackendNoticePlacement(page, label) {
  const placement = await page.$eval('header', header => {
    const notice = document.querySelector('[data-testid="backend-status-notice"]');
    if (!notice) return null;
    const headerRect = header.getBoundingClientRect();
    const noticeRect = notice.getBoundingClientRect();
    const mainRect = document.querySelector('main')?.getBoundingClientRect();
    return {
      headerBottom: headerRect.bottom,
      noticeTop: noticeRect.top,
      noticeBottom: noticeRect.bottom,
      mainTop: mainRect?.top ?? null,
    };
  });
  if (!placement) {
    console.log(`SKIP ${label} backend notice placement (API healthy)`);
    return;
  }
  assert(placement.headerBottom <= placement.noticeTop + 1,
    `${label} backend notice overlaps the header: ${JSON.stringify(placement)}`);
  assert(placement.noticeBottom <= (placement.mainTop ?? placement.noticeBottom) + 1,
    `${label} main content overlaps the backend notice: ${JSON.stringify(placement)}`);
  console.log(`PASS ${label} backend notice placement`);
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

async function assertMobileButtonTargets(page, label) {
  const undersized = await page.$$eval('main button', buttons => buttons.flatMap(button => {
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return [];
    if (rect.width >= 36 && rect.height >= 36) return [];
    return [{
      label: button.getAttribute('aria-label') || button.textContent?.trim() || '(unlabelled)',
      width: rect.width,
      height: rect.height,
    }];
  }));
  assert(undersized.length === 0, `${label} has undersized mobile buttons: ${JSON.stringify(undersized)}`);
  console.log(`PASS ${label} mobile button targets`);
}

async function main() {
  const baseUrl = getBaseUrl();
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });

    for (const [route, selector, label] of [
      ['', 'main', 'home'],
      ['chorus-highlights', 'h1', 'chorus highlights'],
      ['history', 'h1', 'history'],
      ['reports', 'h1', 'reports'],
      ['knowledge-map', '[data-testid="knowledge-map-page"]', 'knowledge map'],
      ['settings/hidden-songs', 'h1', 'hidden songs'],
      ['favorites', 'h1', 'favorites'],
      ['favorite-producers', 'h1', 'favorite producers'],
      ['playlists', 'section[data-testid="playlist-library"]', 'playlists'],
      ['watch?v=1501', 'main', 'watch'],
    ]) {
      const response = await page.goto(new URL(route, baseUrl), { waitUntil: 'domcontentloaded' });
      assert(response?.ok(), `${label} returned HTTP ${response?.status() ?? 'unknown'}`);
      await waitForLayout(page);
      await page.waitForSelector(selector);
      await assertBackendNoticePlacement(page, label);
      await assertNoHorizontalOverflow(page, label);
      await assertMobileButtonTargets(page, label);
    }

    await page.goto(new URL('playlists', baseUrl), { waitUntil: 'domcontentloaded' });
    await waitForLayout(page);
    // 新規作成 (＋ on phones) opens a menu; 「新しいプレイリスト」 opens the dialog.
    await page.waitForSelector('section[data-testid="playlist-library"] button[aria-label="新規作成"]');
    await page.click('section[data-testid="playlist-library"] button[aria-label="新規作成"]');
    await page.waitForSelector('[role="menu"]');
    await page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(item => item.textContent?.trim() === '新しいプレイリスト')?.click());
    await page.waitForSelector('[role="dialog"] input[placeholder="タイトルを入力"]');
    const createButtonLayout = await page.$eval('button[aria-label="プレイリストを作成"]', button => {
      const style = getComputedStyle(button);
      return { display: style.display, alignItems: style.alignItems, justifyContent: style.justifyContent };
    });
    assert(['flex', 'inline-flex'].includes(createButtonLayout.display)
      && createButtonLayout.alignItems === 'center'
      && createButtonLayout.justifyContent === 'center',
    `Playlist create button is not centered: ${JSON.stringify(createButtonLayout)}`);
    const createdName = '長いタイトルでも操作が重ならないことを確認するプレイリスト';
    await page.type('input[placeholder="タイトルを入力"]', createdName);
    await page.click('button[aria-label="プレイリストを作成"]');
    await page.waitForFunction(name => document.querySelector('main section h1')?.textContent === name, {}, createdName);
    const headerLayout = await page.$eval('main section h1', heading => {
      const section = heading.closest('section');
      if (!section) return { sectionBottom: 0, lastButtonBottom: 1 };
      const sectionRect = section.getBoundingClientRect();
      const buttonBottoms = [...section.querySelectorAll('button')].map(button => button.getBoundingClientRect().bottom);
      return { sectionBottom: sectionRect.bottom, lastButtonBottom: Math.max(0, ...buttonBottoms) };
    });
    assert(headerLayout.lastButtonBottom <= headerLayout.sectionBottom + 1,
      `Playlist header actions are clipped: ${JSON.stringify(headerLayout)}`);
    await assertNoHorizontalOverflow(page, 'selected playlist');
    console.log('PASS playlist create button and selected header layout');

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForLayout(page);
    await page.waitForSelector('a[href*="/watch?v="]', { timeout: 10_000 }).catch(() => {});
    const topNavTargets = await page.$$eval('.topnav-action-btn', buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
    assert(topNavTargets.length > 0 && topNavTargets.every(({ width, height }) => width >= 40 && height >= 40),
      `Mobile top-nav controls are too small: ${JSON.stringify(topNavTargets)}`);
    console.log('PASS mobile top-nav tap targets');

    const longPressSelector = await page.$('.song-card a[href*="/watch?v="]')
      ? '.song-card a[href*="/watch?v="]'
      : 'a[href*="/watch?v="]';
    if (await page.$(longPressSelector)) {
      const longPressResult = await page.$eval(longPressSelector, link => new Promise(resolve => {
        link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
        window.setTimeout(() => {
          link.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
          resolve(!document.querySelector('[data-testid="selection-fab"]'));
        }, 650);
      }));
      assert(longPressResult, 'Touch long-press unexpectedly entered selection mode');
      console.log('PASS touch long-press does not enter selection mode');
    } else {
      console.log('SKIP touch long-press check (no song card rendered)');
    }

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

    await page.click('button[aria-label="設定"]');
    await page.waitForSelector('[role="dialog"][aria-label="設定"]', { visible: true });
    await page.waitForSelector('[role="tablist"] [role="tab"][aria-selected="true"]');
    await page.click('[role="tab"][aria-controls="settings-panel-data"]');
    await page.waitForSelector('[role="tabpanel"]#settings-panel-data');
    const settingsTabs = await page.$$eval('[role="dialog"][aria-label="設定"] [role="tab"]', tabs => tabs.map(tab => ({
      selected: tab.getAttribute('aria-selected'),
      controls: tab.getAttribute('aria-controls'),
    })));
    assert(settingsTabs.length === 3 && settingsTabs.filter(tab => tab.selected === 'true').length === 1,
      `Settings tabs do not expose a single active tab: ${JSON.stringify(settingsTabs)}`);
    console.log('PASS settings tab separation and accessibility');
    const settingsPanel = await page.$eval('[role="dialog"][aria-label="設定"] > div', element => {
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

    // バックアップの保存・復元はデータタブに直接ある（別のダイアログは無い）。開く時の拡大が終わってから測る
    await page.waitForFunction(() => document.getAnimations().every(animation => {
      const target = animation.effect?.target;
      return animation.playState !== 'running' || !(target instanceof Element && target.closest('[role="dialog"]'));
    }));
    const dataActions = await page.$$eval('#settings-panel-data button', buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      return { text: button.textContent?.trim(), width: rect.width, height: rect.height, left: rect.left, right: rect.right };
    }));
    for (const label of ['バックアップを保存', 'ファイルから復元']) {
      const action = dataActions.find(item => item.text === label);
      assert(action && action.height >= 40 && action.left >= 0 && action.right <= 390,
        `Data tab action "${label}" is missing, too small, or off screen: ${JSON.stringify(dataActions)}`);
    }
    const closeTarget = await page.$eval('[role="dialog"][aria-label="設定"] button[aria-label="閉じる"]', button => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    assert(closeTarget.width >= 40 && closeTarget.height >= 40,
      `The settings close button is too small: ${JSON.stringify(closeTarget)}`);
    console.log('PASS mobile data tab actions and tap targets');
    console.log('Mobile browser E2E test passed.');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`Mobile browser E2E test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
