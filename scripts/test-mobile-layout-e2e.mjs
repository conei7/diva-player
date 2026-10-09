import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4181/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
try {
  const page = await browser.newPage();
  await pinAppLanguage(page);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.includes('/backend-api/api/') || url.hostname === 'vocadb.net') {
      const items = url.pathname.includes('artists')
        ? Array.from({ length: 20 }, (_, i) => ({ id: 80000 + i, name: `Layout fixture ${i}`, artistType: 'Illustrator' }))
        : [];
      void request.respond({ status: 200, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ status: 'ready', items, totalCount: items.length }) });
    } else void request.continue();
  });
  for (const [width, height] of [[320, 360], [390, 844], [1024, 768]]) {
    await page.setViewport({ width, height });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('divaSearchHistory', JSON.stringify(
      Array.from({ length: 10 }, (_, i) => `検索履歴 ${i}`),
    )));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.documentElement.classList.contains('diva-startup-home'));
    await page.focus('input[placeholder="ボカロP名や曲名で検索"]');
    await page.waitForFunction(() => document.body.textContent.includes('検索履歴 9'));
    const suggestions = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === '検索履歴 9');
      const panel = button.closest('ul').parentElement.parentElement;
      panel.scrollTop = panel.scrollHeight;
      const rect = panel.getBoundingClientRect();
      const last = button.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, lastBottom: last.bottom, height: innerHeight };
    });
    assert(suggestions.top >= 0 && suggestions.bottom <= height + 1
      && suggestions.lastBottom <= suggestions.bottom + 1,
    `Search history cannot reach last entry at ${width}x${height}: ${JSON.stringify(suggestions)}`);
    await page.keyboard.press('Escape');
    await page.goto(new URL('history', baseUrl), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1');
    const layout = await page.evaluate(() => {
      const heading = document.querySelector('h1').getBoundingClientRect();
      const actions = [...document.querySelectorAll('main button')].filter(button => button.textContent.includes('エクスポート'));
      return { heading, actions: actions.map(button => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top };
      }), width: document.documentElement.scrollWidth };
    });
    assert(layout.width <= width + 1 && layout.actions.every(rect => rect.left >= 0 && rect.right <= width),
      `History controls overflow at ${width}: ${JSON.stringify(layout)}`);
    await page.click('button[aria-label="設定"]');
    await page.waitForSelector('[role="dialog"][aria-label="設定"]');
    const settings = await page.$eval('[role="dialog"][aria-label="設定"] > div', panel => {
      panel.scrollTop = panel.scrollHeight;
      const rect = panel.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, remaining: panel.scrollHeight - panel.clientHeight - panel.scrollTop };
    });
    assert(settings.top >= 0 && settings.bottom <= height + 1 && Math.abs(settings.remaining) < 2,
      `Settings cannot reach bottom at ${width}x${height}: ${JSON.stringify(settings)}`);
    await page.keyboard.press('Escape');
    console.log(`PASS search history / history controls / settings bottom ${width}x${height}`);
  }
  // Suggestions must expand inside their filter section instead of being clipped by it.
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.documentElement.classList.contains('diva-startup-home'));
  await page.click('button[aria-label="詳細検索"]');
  await page.evaluate(() => [...document.querySelectorAll('.filter-section-header')]
    .find(button => button.textContent.includes('参加者・役割')).click());
  await page.type('input[placeholder="P、絵師、動画師、演奏者…"]', 'Layout');
  await page.waitForFunction(() => document.body.textContent.includes('Layout fixture 19'));
  // A fast fixture response may arrive during the section's opening transition.
  // Measure its final layout, while retaining the clipping assertion below.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.effect instanceof KeyframeEffect
      && animation.effect.target?.closest('.filter-section')
      && animation.effect.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
  const list = await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="P、絵師、動画師、演奏者…"]');
    const section = input.closest('.filter-section-content');
    const panel = section.querySelector('ul');
    const rect = panel.getBoundingClientRect();
    const boundary = section.getBoundingClientRect();
    return { bottom: rect.bottom, boundary: boundary.bottom, position: getComputedStyle(panel).position };
  });
  assert(list.position !== 'absolute' && list.bottom <= list.boundary + 1, `Clipped filter suggestions: ${JSON.stringify(list)}`);
  console.log('PASS advanced search suggestions stay within section');
} finally {
  await browser.close();
}
