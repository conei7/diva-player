import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'https://diva-player.pages.dev/';
const useLocalFixture = process.argv.includes('--local-fixture');
const AUTOPLAY_OBSERVATION_MS = 9_000;
const fixtureSong = {
  id: 3269,
  name: 'Nico autoplay fixture',
  artistString: 'DIVA fixture',
  createDate: '2009-08-30T00:00:00Z',
  defaultName: 'Nico autoplay fixture',
  defaultNameLanguage: 'English',
  favoritedTimes: 0,
  lengthSeconds: 30,
  pvServices: 'NicoNicoDouga',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  pvs: [{
    author: '',
    disabled: false,
    id: 32691,
    length: 30,
    name: 'Nico autoplay fixture',
    pvId: 'sm7918983',
    service: 'NicoNicoDouga',
    pvType: 'Original',
    url: 'https://www.nicovideo.jp/watch/sm7918983',
  }],
};
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  if (useLocalFixture) {
    await page.evaluateOnNewDocument(song => {
      localStorage.setItem('diva_pvPreference', JSON.stringify('NicoNicoDouga'));
      localStorage.setItem('diva_playerQueue', JSON.stringify({
        queue: [song],
        queueIndex: 0,
        currentSong: song,
        currentSongId: song.id,
        queueSources: ['manual'],
        currentPlaybackSource: 'manual',
      }));
    }, fixtureSong);
  }
  let embedStatus = null;
  page.on('response', response => {
    if (response.url().includes('embed.nicovideo.jp/watch/sm7918983')) embedStatus = response.status();
  });
  await page.goto(new URL('watch?v=3269', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const selector = 'iframe[src*="embed.nicovideo.jp/watch/sm7918983"]';
  await page.waitForSelector(selector, { timeout: 60_000 });
  // The app intentionally waits up to 12 seconds before falling back to a
  // different PV. Sample before that deadline, so a short Nico clip can be
  // distinguished from a fallback without reaching the next queue item.
  await new Promise(resolve => setTimeout(resolve, AUTOPLAY_OBSERVATION_MS));
  const src = await page.$eval(selector, element => element.src);
  const playerState = await page.evaluate(() => ({
    url: location.href,
    nicoFrames: document.querySelectorAll('iframe[src*="embed.nicovideo.jp"]').length,
    youtubeFrames: document.querySelectorAll('iframe[src*="youtube.com"]').length,
    activeYoutubeFrames: [...document.querySelectorAll('iframe[src*="youtube.com"]')]
      .filter(frame => !frame.closest('[aria-hidden="true"]')).length,
  }));
  // The app keeps one hidden, idle YouTube iframe warm even while Nico is the
  // active service. This lets a later YouTube song start in a background tab;
  // it is not a Nico-to-YouTube fallback.
  if (playerState.nicoFrames !== 1
    || playerState.youtubeFrames !== 1
    || playerState.activeYoutubeFrames !== 0) {
    throw new Error(`Nico playback fell back or disappeared: ${JSON.stringify(playerState)}`);
  }
  if (embedStatus !== null && embedStatus >= 400) throw new Error(`Nico embed returned HTTP ${embedStatus}`);
  console.log(`PASS Nico autoplay remained active for 9s (${embedStatus ?? 'loaded'}, ${src})`);
} finally {
  await browser.close();
}
