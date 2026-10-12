import puppeteer from 'puppeteer';

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:5173/diva-player/');
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });

async function clickButtonByText(page, label) {
  const buttons = await page.$$('[data-testid="sound-map-page"] button');
  for (const button of buttons) {
    const text = await button.evaluate(element => element.textContent?.trim());
    if (text === label) {
      await button.click();
      return;
    }
  }
  throw new Error(`Button not found: ${label}`);
}

async function readAboutPopover(page, label) {
  await page.click(`[data-testid="sound-map-page"] button[aria-label="${label}"]`);
  const selector = `[role="dialog"][aria-label="${label}"]`;
  await page.waitForSelector(selector);
  const text = await page.$eval(selector, element => element.textContent ?? '');
  await page.keyboard.press('Escape');
  await page.waitForFunction(dialogSelector => !document.querySelector(dialogSelector), {}, selector);
  return text;
}

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  await page.setViewport({ width: 1580, height: 720 });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(new URL('sound-map?demo=1&seedSongId=123', baseUrl), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sound-map-canvas"] g[role="button"]');

  const state = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="sound-map-canvas"]');
    const disabledLabels = [...document.querySelectorAll('[data-testid="sound-map-page"] button:disabled')]
      .map(button => button.textContent?.trim() || button.getAttribute('aria-label'));
    return {
      backendNotice: Boolean(document.querySelector('[data-testid="backend-status-notice"]')),
      crosshairLines: canvas?.querySelectorAll('line').length ?? -1,
      pointCount: canvas?.querySelectorAll('g[role="button"]').length ?? 0,
      knownPointCount: canvas?.querySelectorAll('g[role="button"][data-known="true"]').length ?? 0,
      disabledLabels,
      previewChip: document.querySelector('[data-testid="sound-map-preview-chip"]')?.textContent?.trim() ?? '',
      guideText: document.querySelector('[data-testid="sound-map-guide"]')?.textContent ?? '',
      canvasHeight: canvas?.getBoundingClientRect().height ?? 0,
      focusOriginBottom: document.querySelector('[data-testid="sound-map-canvas"] button[aria-label="起点へ移動"]')
        ?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
      viewportHeight: innerHeight,
    };
  });

  if (state.backendNotice) throw new Error('Backend connection notice is visible in local demo mode.');
  if (state.crosshairLines !== 0) throw new Error(`Sound map rendered ${state.crosshairLines} axis lines.`);
  if (state.pointCount !== 29) throw new Error(`Expected 29 demo points, received ${state.pointCount}.`);
  if (state.knownPointCount === 0) throw new Error('Demo map does not illustrate known-song styling.');
  if (state.previewChip !== 'デモ') throw new Error(`Local demo chip is missing: ${state.previewChip}`);
  if (!state.guideText.includes('点を選ぶと曲の情報が出ます（再生はされません）')) {
    throw new Error(`First-visit sound map guide is missing the no-autoplay hint: ${state.guideText}`);
  }
  if (!['再生', '保存', 'その他の操作'].every(label => state.disabledLabels.includes(label))) {
    throw new Error(`Backend-dependent demo actions are not disabled: ${JSON.stringify(state.disabledLabels)}`);
  }
  if (state.canvasHeight > 521) throw new Error(`Desktop map is too tall for a 720px viewport: ${state.canvasHeight}px.`);
  if (state.focusOriginBottom > state.viewportHeight) {
    throw new Error(`Map controls are below the viewport: ${JSON.stringify(state)}`);
  }

  const aboutText = await readAboutPopover(page, 'このマップについて');
  if (!aboutText.includes('近い点ほど音が似ています。軸はジャンルではありません。')) {
    throw new Error(`Map projection explanation is missing: ${aboutText}`);
  }
  if (!aboutText.includes('更新')) throw new Error(`Map generation date is missing: ${aboutText}`);

  await page.click('[data-testid="sound-map-guide"] button');
  if (await page.$('[data-testid="sound-map-guide"]')) throw new Error('Sound map guide remained visible after dismissal.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sound-map-canvas"] g[role="button"]');
  if (await page.$('[data-testid="sound-map-guide"]')) throw new Error('Dismissed sound map guide returned after reload.');

  const points = await page.$$('[data-testid="sound-map-canvas"] g[role="button"]');
  const pointBox = await points[1].boundingBox();
  await points[1].click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="sound-map-selected-title"]')?.textContent === '近傍デモ曲 124',
    { timeout: 5_000 },
  ).catch(() => undefined);
  const selectedTitle = await page.$eval('[data-testid="sound-map-selected-title"]', element => element.textContent);
  if (selectedTitle !== '近傍デモ曲 124') {
    throw new Error(`Click did not select demo point 124: ${JSON.stringify({ pointBox, selectedTitle })}`);
  }
  await clickButtonByText(page, 'この曲の近くを探す');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('seedSongId') === '124');
  await page.waitForFunction(() => !document.querySelector('[data-testid="sound-map-canvas"] button[aria-label="前の起点に戻る"]')?.disabled);

  // 「前の起点に戻る」 is the browser history: it returns to the previous starting song.
  await page.click('[data-testid="sound-map-canvas"] button[aria-label="前の起点に戻る"]');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('seedSongId') === '123');
  await page.waitForFunction(() => document.querySelector('[data-testid="sound-map-canvas"] button[aria-label="前の起点に戻る"]')?.disabled === true);

  await page.evaluate(() => {
    localStorage.setItem('diva_uiLanguage', JSON.stringify('en'));
    localStorage.removeItem('diva_sound_map_guide_dismissed_v1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sound-map-guide"]');
  const englishGuide = await page.$eval('[data-testid="sound-map-guide"]', element => element.textContent ?? '');
  if (!englishGuide.includes("Select a dot to see the song. It won't start playing.")) {
    throw new Error(`Sound map guide did not localize to English: ${englishGuide}`);
  }
  const englishAbout = await readAboutPopover(page, 'About this map');
  if (!englishAbout.includes("Closer dots sound more alike. The axes aren't genres.")) {
    throw new Error(`Sound map explanation did not localize to English: ${englishAbout}`);
  }
  const exploreButton = await page.$$eval('[data-testid="sound-map-page"] button', buttons => buttons
    .some(button => button.textContent?.trim() === 'Explore songs like this'));
  if (!exploreButton) throw new Error('The explore action did not localize to English.');

  console.log('Sound map local demo E2E passed.');
} finally {
  await browser.close();
}
