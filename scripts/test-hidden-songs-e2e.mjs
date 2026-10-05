import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });
const song = {
  id: 900009,
  name: 'Hidden song fixture',
  artistString: 'Fixture producer',
  createDate: '2026-01-01T00:00:00Z',
  defaultName: 'Hidden song fixture',
  defaultNameLanguage: 'English',
  favoritedTimes: 0,
  lengthSeconds: 120,
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  pvs: [{ author: '', disabled: false, id: 9000091, length: 120, name: 'fixture', pvId: 'fixture', service: 'Youtube', pvType: 'Original', url: 'https://youtu.be/fixture' }],
};

try {
  const page = await browser.newPage();
  const searchRequests = [];
  await pinAppLanguage(page);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = request.url();
    if (url.includes('/backend-api/api/songs/search?')) {
      const query = new URL(url).searchParams.get('query');
      searchRequests.push(query);
      const items = query?.toLowerCase().includes('hidden song fixture') ? [song] : [];
      await request.respond({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ items, totalCount: items.length }),
      });
      return;
    }
    if (url.startsWith('https://vocadb.net/api/songs?') || url.startsWith('https://vocadb.net/api/artists?')) {
      await request.respond({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ items: [] }),
      });
      return;
    }
    if (url.startsWith('https://vocadb.net/api/songs/900009?')) {
      await request.respond({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(song) });
      return;
    }
    if (url.includes('/backend-api/api/songs/views?ids=900009')) {
      await request.respond({ contentType: 'application/json', body: JSON.stringify({ 900009: { youtubeViews: 0, nicoViews: 0 } }) });
      return;
    }
    if (url === 'https://www.youtube.com/iframe_api') {
      await request.respond({
        contentType: 'application/javascript',
        body: `window.YT={PlayerState:{UNSTARTED:-1,ENDED:0,PLAYING:1,PAUSED:2,BUFFERING:3,CUED:5},Player:function(_id,o){this.getCurrentTime=()=>0;this.getDuration=()=>120;this.getPlayerState=()=>2;this.getVolume=()=>50;this.setVolume=()=>{};this.mute=()=>{};this.unMute=()=>{};this.loadVideoById=()=>{};this.cueVideoById=()=>{};this.playVideo=()=>{};this.pauseVideo=()=>{};this.stopVideo=()=>{};this.destroy=()=>{};setTimeout(()=>o.events.onReady({target:this}),0)}};window.onYouTubeIframeAPIReady();`,
      });
      return;
    }
    await request.continue();
  });

  await page.goto(new URL('watch?v=900009&autoplay=0', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[aria-label="好みではない・今後表示しない"]', { visible: true });
  await page.$eval('[aria-label="好みではない・今後表示しない"]', button => button.click());
  await page.waitForFunction(() => {
    const persisted = JSON.parse(localStorage.getItem('diva-hidden-songs') || 'null');
    return persisted?.state?.hiddenSongs?.['900009']?.song?.name === 'Hidden song fixture';
  });
  console.log('PASS explicit dislike persists the hidden song');

  await page.goto(new URL('', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const searchInput = 'input[placeholder="ボカロP名や曲名で検索"]';
  await page.waitForSelector(searchInput, { visible: true });
  await page.type(searchInput, 'Hidden song fixture');
  await page.keyboard.press('Enter');
  try {
    await page.waitForSelector('a[href*="/watch?v=900009"]', { visible: true, timeout: 30_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      alert: document.querySelector('[role="alert"]')?.textContent?.trim(),
      text: document.body.innerText.slice(0, 1200),
      cards: [...document.querySelectorAll('.song-card')].map(card => card.textContent?.trim()),
      links: [...document.querySelectorAll('a[href*="/watch"]')].map(link => link.getAttribute('href')),
    }));
    throw new Error(`Hidden search result did not appear: ${JSON.stringify({ diagnostic, searchRequests })}`, { cause: error });
  }
  console.log('PASS explicit search shows a song hidden from passive discovery');

  await page.goto(new URL('settings/hidden-songs', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.body.textContent?.includes('Hidden song fixture'));
  await page.$eval('button', (button) => {
    const target = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === '再表示');
    if (!target) throw new Error('Restore button not found');
    target.click();
  });
  await page.waitForFunction(() => {
    const persisted = JSON.parse(localStorage.getItem('diva-hidden-songs') || 'null');
    return !persisted?.state?.hiddenSongs?.['900009'];
  });
  await page.waitForFunction(() => document.body.textContent?.includes('表示しない曲はありません'));
  console.log('PASS hidden song management restores the song');
} finally {
  await browser.close();
}
