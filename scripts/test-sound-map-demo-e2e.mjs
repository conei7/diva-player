import puppeteer from 'puppeteer';

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:5173/diva-player/');
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

async function clickButtonByText(page, label) {
  const buttons = await page.$$('button');
  for (const button of buttons) {
    const text = await button.evaluate(element => element.textContent?.trim());
    if (text === label) {
      await button.click();
      return;
    }
  }
  throw new Error(`Button not found: ${label}`);
}

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  await page.setViewport({ width: 1580, height: 720 });
  await page.goto(new URL('sound-map?demo=1&seedSongId=123', baseUrl), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sound-map-canvas"] g[role="button"]');

  const state = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="sound-map-canvas"]');
    const disabledLabels = [...document.querySelectorAll('button:disabled')]
      .map(button => button.textContent?.trim());
    return {
      backendNotice: Boolean(document.querySelector('[data-testid="backend-status-notice"]')),
      crosshairLines: canvas?.querySelectorAll('line').length ?? -1,
      pointCount: canvas?.querySelectorAll('g[role="button"]').length ?? 0,
      knownPointCount: canvas?.querySelectorAll('circle.fill-fuchsia-400').length ?? 0,
      disabledLabels,
      text: document.querySelector('[data-testid="sound-map-page"]')?.textContent ?? '',
      canvasHeight: canvas?.getBoundingClientRect().height ?? 0,
      focusOriginBottom: [...document.querySelectorAll('button')]
        .find(button => button.textContent?.trim() === '起点を表示')
        ?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
      viewportHeight: innerHeight,
    };
  });

  if (state.backendNotice) throw new Error('Backend connection notice is visible in local demo mode.');
  if (state.crosshairLines !== 0) throw new Error(`Sound map rendered ${state.crosshairLines} axis lines.`);
  if (state.pointCount !== 29) throw new Error(`Expected 29 demo points, received ${state.pointCount}.`);
  if (state.knownPointCount === 0) throw new Error('Demo map does not illustrate known-song styling.');
  if (!state.text.includes('画面確認用デモです。')) throw new Error('Local demo explanation is missing.');
  if (!['再生', '保存', '詳細'].every(label => state.disabledLabels.includes(label))) {
    throw new Error(`Backend-dependent demo actions are not disabled: ${JSON.stringify(state.disabledLabels)}`);
  }
  if (state.canvasHeight > 521) throw new Error(`Desktop map is too tall for a 720px viewport: ${state.canvasHeight}px.`);
  if (state.focusOriginBottom > state.viewportHeight) {
    throw new Error(`Map controls are below the viewport: ${JSON.stringify(state)}`);
  }

  const points = await page.$$('[data-testid="sound-map-canvas"] g[role="button"]');
  const pointBox = await points[1].boundingBox();
  await points[1].click();
  await new Promise(resolve => setTimeout(resolve, 100));
  const selectedTitle = await page.$eval('[data-testid="sound-map-selected-title"]', element => element.textContent);
  if (selectedTitle !== '近傍デモ曲 124') {
    throw new Error(`Click did not select demo point 124: ${JSON.stringify({ pointBox, selectedTitle })}`);
  }
  await clickButtonByText(page, 'この曲の近くを探す');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('seedSongId') === '124');

  console.log('Sound map local demo E2E passed.');
} finally {
  await browser.close();
}
