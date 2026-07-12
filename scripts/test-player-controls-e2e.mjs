import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'https://diva-player.pages.dev/';
const base = new URL(baseUrl);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

try {
  const first = await browser.newPage();
  await first.goto(new URL('watch?v=1501', base), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await first.waitForSelector('iframe', { timeout: 60_000 });
  await first.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await first.waitForSelector('button[aria-label="ミニプレイヤーを閉じる"]', { timeout: 60_000 });

  const second = await browser.newPage();
  await second.goto(new URL('watch?v=3269', base), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await second.waitForSelector('iframe', { timeout: 60_000 });
  await first.waitForFunction(() => document.querySelector('button[aria-label="再生"]') !== null, { timeout: 15_000 });
  console.log('PASS cross-tab playback ownership pause');

  await first.click('button[aria-label="ミニプレイヤーを閉じる"]');
  await first.waitForFunction(() => !document.querySelector('button[aria-label="ミニプレイヤーを閉じる"]'));
  const queueCleared = await first.evaluate(() => localStorage.getItem('diva_playerQueue') === null);
  if (!queueCleared) throw new Error('Closing the mini player did not clear the persisted queue.');
  console.log('PASS mini-player close control');
} finally {
  await browser.close();
}
