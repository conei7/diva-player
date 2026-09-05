import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/diva-player/';
const songs = ['Youtube', 'NicoNicoDouga', 'Youtube'].map((service, index) => ({
  id: 990100 + index, name: `Service switch ${index}`, artistString: 'Fixture',
  createDate: '2026-01-01T00:00:00Z', defaultName: `Service switch ${index}`,
  defaultNameLanguage: 'English', favoritedTimes: 0, lengthSeconds: index === 1 ? 85 : 300,
  pvServices: service, ratingScore: 0, songType: 'Original', status: 'Finished', version: 1,
  pvs: [{ author: '', disabled: false, id: 9901000 + index, length: index === 1 ? 85 : 300,
    name: 'fixture', pvId: `fixture-${index}`, service, pvType: 'Original',
    url: service === 'Youtube' ? `https://youtu.be/fixture-${index}` : 'https://www.nicovideo.jp/watch/fixture-1' }],
}));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const clickControl = async title => {
    const selector = `button[title="${title}"]`;
    for (const button of await page.$$(selector)) {
      const box = await button.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        await button.click();
        return;
      }
    }
    await page.click('body');
    await page.$eval(selector, button => button.click());
  };
  page.on('pageerror', error => { throw error; });
  await page.evaluateOnNewDocument(queue => {
    if (window !== window.top) return;
    const tabId = 'service-switch-fixture';
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    localStorage.setItem('diva-playback-owner-v1', JSON.stringify({
      type: 'claim', tabId, songId: queue[0].id, claimedAt: Date.now(),
    }));
    localStorage.setItem('diva_volume', '37');
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue, queueIndex: 0, currentSong: queue[0], currentSongId: queue[0].id,
      queueSources: ['manual', 'manual', 'manual'], currentPlaybackSource: 'manual',
    }));
  }, songs);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = request.url();
    if (url === 'https://www.youtube.com/iframe_api') {
      await request.respond({ contentType: 'application/javascript', body: `
        window.YT = {
          PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 },
          Player: function (_, options) {
            const p = this;
            let state = -1, videoId = '', volume = 37;
            window.__yt = p; window.__ytPlays = 0;
            const emit = () => options.events.onStateChange({ data: state, target: p });
            p.getVideoData = () => ({ video_id: videoId });
            p.getPlayerState = () => state;
            p.getCurrentTime = () => 7;
            p.getDuration = () => 300;
            p.getVolume = () => volume;
            p.setVolume = v => { volume = v; };
            p.mute = p.unMute = p.destroy = () => {};
            p.cueVideoById = p.loadVideoById = id => { videoId = id; state = 5; };
            p.playVideo = () => { state = 1; window.__ytPlays++; emit(); };
            p.pauseVideo = () => { state = 2; emit(); };
            // A stopped iframe can report CUED and receive delayed native events.
            p.stopVideo = () => { state = 5; };
            p.latePlaying = () => { state = 1; emit(); };
            p.lateEnded = () => { state = 0; emit(); };
            setTimeout(() => options.events.onReady({ target: p }), 0);
          }
        }; window.onYouTubeIframeAPIReady();
      ` });
    } else if (url.startsWith('https://embed.nicovideo.jp/')) {
      await request.respond({ contentType: 'text/html', body: `<!doctype html>
        <button id="pause">Pause</button><button id="play">Play</button>
        <script>
          window.commands = []; window.playing = false; window.muted = false; window.volume = 0;
          window.emit = (eventName, data = {}) => parent.postMessage({ eventName, data }, '*');
          window.addEventListener('message', e => {
            if (e.source !== parent || e.data?.sourceConnectorType !== 1) return;
            commands.push(e.data);
            if (e.data.eventName === 'mute') muted = e.data.data.mute;
            if (e.data.eventName === 'volumeChange') volume = e.data.data.volume;
            if (e.data.eventName === 'play' && !playing) {
              playing = true; emit('player:play'); emit('player:currentTime', { currentTime: 0.5 });
            }
            if (e.data.eventName === 'pause' && playing) {
              playing = false; if (!window.omitPaused) emit('player:pause');
            }
          });
          document.querySelector('#pause').onclick = () => { playing = false; emit('player:pause'); };
          document.querySelector('#play').onclick = () => { playing = true; emit('player:play'); };
          setTimeout(() => emit('loadComplete', { videoInfo: { lengthInSeconds: 85 } }), 20);
        </script>` });
    } else if (url.includes('vocadb.net/api/') || url.includes('/backend-api/')) {
      const song = songs.find(item => url.includes(`/songs/${item.id}`));
      await request.respond({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(song ?? { items: [], totalCount: 0 }) });
    } else await request.continue();
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__yt?.getVideoData().video_id === 'fixture-0');
  await clickControl('再生');
  await page.waitForFunction(() => window.__yt.getPlayerState() === 1);
  await clickControl('次の曲');
  await page.waitForSelector('iframe[src*="embed.nicovideo.jp"]');
  const frame = await (await page.$('iframe[src*="embed.nicovideo.jp"]')).contentFrame();
  await frame.waitForFunction(() => playing && volume === 0.37);
  assert.equal(await frame.evaluate(() => muted), false, 'User-initiated Nico playback must be audible');
  const ytPlays = await page.evaluate(() => window.__ytPlays);
  await page.evaluate(() => { window.__yt.setVolume(0); window.__yt.latePlaying(); });
  await page.waitForFunction(() => window.__yt.getPlayerState() !== 1);
  await page.evaluate(() => window.__yt.lateEnded());
  await new Promise(resolve => setTimeout(resolve, 31_000));
  assert.equal(await page.evaluate(() => window.__ytPlays), ytPlays, 'Old recovery must not restart YouTube while Nico plays');
  assert.equal(await frame.evaluate(() => volume), 0.37, 'Inactive YouTube must not overwrite volume');
  console.log('PASS service switch rejects late YouTube play/end and preserves Nico audio');

  await frame.click('#pause');
  await page.waitForSelector('button[title="再生"]');
  await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.equal(await frame.evaluate(() => playing), false, 'Native pause must not be retried');
  await frame.click('#play');
  await page.waitForSelector('button[title="一時停止"]');
  await frame.evaluate(() => { window.omitPaused = true; });
  await clickControl('一時停止');
  await frame.waitForFunction(() => !playing);
  const nicoPlayCount = await frame.evaluate(() => commands.filter(c => c.eventName === 'play').length);
  // Even when PAUSED is lost, the app's pause must stop its estimated progress.
  await frame.evaluate(() => {
    setTimeout(() => {
      playing = true;
      emit('player:play');
      emit('player:currentTime', { currentTime: 85 });
      emit('player:ended');
      emit('loadComplete', { videoInfo: { lengthInSeconds: 85 } });
    }, 85_000);
  });
  const other = await browser.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await page.waitForFunction(() => document.hidden);
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 30_000));
    console.log(`Observing paused background Nico: ${(i + 1) * 30}s`);
  }
  assert.equal(await page.evaluate(() => window.__ytPlays), ytPlays, 'Retired YouTube recovery must not run');
  assert.equal(await frame.evaluate(() => playing), false, 'Delayed Nico PLAYING must be paused');
  assert.equal(await frame.evaluate(() => commands.filter(c => c.eventName === 'play').length), nicoPlayCount);
  assert.ok(await page.$('button[title="再生"]'), 'UI must remain paused');
  assert.ok(await page.$('iframe[src*="fixture-1"]'), 'Paused duration/ENDED must not advance queue');
  assert.equal(await frame.evaluate(() => volume), 0.37, 'Inactive YouTube must not overwrite volume');
  await page.bringToFront();
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.equal(await frame.evaluate(() => playing), false, 'Focus recovery must respect pause');
  await clickControl('再生');
  await frame.waitForFunction(() => playing && !muted);
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.ok(await page.$('iframe[src*="fixture-1"]'), 'Late paused progress must not corrupt resume position');
  console.log('PASS native/app Nico pause, hidden/resume/focus, 85s late events, 90s idle and explicit resume');
} finally {
  await browser.close();
}
