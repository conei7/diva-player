// 小窓プレイヤー (設定 > 全般): the music player bar's button opens the window with the song and working
// controls, the browser's automatic opening ('enterpictureinpicture') is registered only while the
// setting is on, turning it off closes the window and hides the button, and a browser without the
// window shows the setting as unavailable. Document Picture-in-Picture is replaced by a same-origin
// iframe (headless browsers have no picture-in-picture windows); API and YouTube are fixtures.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:4173/diva-player/');

function songFixture(id) {
  return {
    id,
    name: `小窓 ${id}`,
    artistString: 'Floating fixture',
    createDate: '2026-01-01T00:00:00Z',
    defaultName: `小窓 ${id}`,
    defaultNameLanguage: 'Japanese',
    favoritedTimes: 0,
    lengthSeconds: 180,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    artists: [],
    pvs: [{
      author: '', disabled: false, id: id * 10, length: 180, name: 'floating-fixture', pvId: `floating-${id}`,
      service: 'Youtube', pvType: 'Original', url: `https://youtu.be/floating-${id}`,
    }],
  };
}
const queue = [960001, 960002, 960003].map(songFixture);

const youtubeApi = `
  window.YT = {
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    Player: function (_id, options) {
      const player = this;
      let state = 5;
      player.getCurrentTime = () => 42;
      player.getDuration = () => 180;
      player.getPlayerState = () => state;
      player.getVolume = () => 50;
      player.setVolume = () => {};
      player.mute = () => {};
      player.unMute = () => {};
      player.isMuted = () => false;
      player.seekTo = () => {};
      player.getVideoData = () => ({ video_id: '' });
      player.loadVideoById = player.cueVideoById = () => { state = 5; };
      player.playVideo = () => { state = 1; options.events.onStateChange({ data: state, target: player }); };
      player.pauseVideo = () => { state = 2; options.events.onStateChange({ data: state, target: player }); };
      player.stopVideo = () => { state = 0; };
      player.destroy = () => {};
      setTimeout(() => options.events.onReady({ target: player }), 0);
    },
  };
  window.onYouTubeIframeAPIReady();
`;

/** Runs in the page before its scripts: an iframe stands in for the picture-in-picture window. */
function installPictureInPictureStub(supported) {
  if (window !== window.top) return;
  window.__mediaActions = [];
  const setActionHandler = navigator.mediaSession?.setActionHandler?.bind(navigator.mediaSession);
  if (navigator.mediaSession) {
    navigator.mediaSession.setActionHandler = (action, handler) => {
      // Model a delayed observable cleanup so the off assertion must wait for it,
      // independently of when React removes the window and the button.
      if (action === 'enterpictureinpicture' && handler === null) {
        setTimeout(() => {
          window.__mediaActions.push([action, false]);
          window.__enterPictureInPicture = null;
        }, 150);
        return;
      }
      window.__mediaActions.push([action, handler !== null]);
      if (action === 'enterpictureinpicture') window.__enterPictureInPicture = handler;
      else setActionHandler?.(action, handler);
    };
  }
  // Chromium has a read-only accessor on Window.prototype: an own property shadows it.
  const define = value => Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value });
  if (!supported) {
    define(undefined);
    return;
  }
  window.__pipRequests = [];
  define({
    window: null,
    async requestWindow(options) {
      window.__pipRequests.push(options);
      const frame = document.createElement('iframe');
      frame.dataset.testid = 'pip-stand-in';
      frame.style.cssText = `position:fixed;left:0;top:0;width:${options.width}px;height:${options.height}px;z-index:99999;border:0`;
      document.body.append(frame);
      const win = frame.contentWindow;
      win.document.open();
      win.document.write('<!doctype html><html><head></head><body></body></html>');
      win.document.close();
      // A real window closes itself; the stand-in frame goes away and fires pagehide.
      win.close = () => frame.remove();
      return win;
    },
  });
}

async function respondJson(request, body, status = 200) {
  await request.respond({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
}

async function newPage(browser, { supported, enabled = true }) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await pinAppLanguage(page);
  await page.evaluateOnNewDocument(installPictureInPictureStub, supported);
  await page.evaluateOnNewDocument((songs, on) => {
    if (window !== window.top) return;
    localStorage.setItem('diva_uiLayout', JSON.stringify('music'));
    localStorage.setItem('diva-player-floating-window', on ? '1' : '0');
    if (localStorage.getItem('diva_playerQueue')) return;
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue: songs, queueIndex: 0, currentSong: songs[0], currentSongId: songs[0].id,
      queueSources: songs.map(() => 'manual'), currentPlaybackSource: 'manual', queueTitle: 'ミックスリスト',
    }));
  }, queue, enabled);
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/backend-api/, '/backend-api');
    if (request.url() === 'https://www.youtube.com/iframe_api') {
      await request.respond({ contentType: 'application/javascript', body: youtubeApi });
    } else if (path === '/backend-api/api/ready') {
      await respondJson(request, { status: 'ready' });
    } else if (path === '/backend-api/api/songs/batch' || path === '/backend-api/api/songs/details') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);
      await respondJson(request, { items: ids.map(songFixture) });
    } else if (path.startsWith('/backend-api/api/')) {
      await respondJson(request, { items: [], cards: [] });
    } else if (url.origin !== baseUrl.origin) {
      await request.abort();
    } else {
      await request.continue();
    }
  });
  await page.goto(new URL('history', baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="music-player-bar"]', { timeout: 60_000 });
  return { page, pageErrors };
}

const pipFrame = async page => {
  const handle = await page.waitForSelector('iframe[data-testid="pip-stand-in"]', { timeout: 15_000 });
  return handle.contentFrame();
};

async function openSettingsGeneral(page) {
  await page.click('button[aria-label="設定"]');
  await page.waitForSelector('[role="dialog"][aria-label="設定"]');
  await page.click('[role="tab"][aria-controls="settings-panel-playback"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"][aria-label="設定"] label')]
    .some(label => label.textContent?.includes('小窓プレイヤー')));
}

const floatingSwitch = page => page.evaluateHandle(() => [...document.querySelectorAll('[role="dialog"][aria-label="設定"] label')]
  .find(label => label.textContent?.includes('小窓プレイヤー'))?.querySelector('input'));

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP', '--autoplay-policy=no-user-gesture-required'] });
try {
  // 1. The bar's button opens the window with the current song and controls that drive the player.
  const { page, pageErrors } = await newPage(browser, { supported: true });
  await page.waitForSelector('[data-testid="music-floating-player"]:not([disabled])', { timeout: 30_000 });
  await page.click('[data-testid="music-floating-player"]');
  const frame = await pipFrame(page);
  await frame.waitForSelector('[data-testid="floating-player"]', { timeout: 15_000 });
  assert.deepEqual(await page.evaluate(() => window.__pipRequests), [{ width: 320, height: 320 }]);
  assert.equal(await frame.$eval('[data-testid="floating-player-title"]', node => node.textContent), '小窓 960001');
  assert.equal(await frame.$eval('[data-testid="floating-player"]', node => node.dataset.shape), 'stacked');
  assert.equal(await page.$eval('[data-testid="music-floating-player"]', node => node.getAttribute('aria-pressed')), 'true');
  // The page's stylesheet came along: the play button is a white circle, not an unstyled button.
  assert.equal(await frame.$eval('[data-testid="floating-player-toggle"]', node => getComputedStyle(node).borderRadius !== '0px'), true);

  const toggleLabel = () => frame.$eval('[data-testid="floating-player-toggle"]', node => node.getAttribute('aria-label'));
  const before = await toggleLabel();
  await frame.click('[data-testid="floating-player-toggle"]');
  await page.waitForFunction(label => {
    const frameDoc = document.querySelector('iframe[data-testid="pip-stand-in"]')?.contentDocument;
    return frameDoc?.querySelector('[data-testid="floating-player-toggle"]')?.getAttribute('aria-label') !== label;
  }, { timeout: 10_000 }, before);
  console.log(`PASS the window's play button switches playback (${before} → ${await toggleLabel()})`);

  await frame.click('[data-testid="floating-player-next"]');
  await frame.waitForFunction(() => document.querySelector('[data-testid="floating-player-title"]')?.textContent === '小窓 960002', { timeout: 10_000 });
  const barTitle = await page.$eval('[data-testid="music-player-bar"] [data-bar-song] a:not([aria-hidden])', node => node.textContent);
  assert.equal(barTitle, '小窓 960002', 'the page follows the window’s 次の曲');
  console.log('PASS the bar button opens the window with the song, and 次の曲 there moves the page’s player');

  // A wide, low window puts the artwork beside the controls.
  await page.$eval('iframe[data-testid="pip-stand-in"]', node => { node.style.width = '480px'; node.style.height = '160px'; });
  await frame.waitForFunction(() => document.querySelector('[data-testid="floating-player"]')?.dataset.shape === 'row', { timeout: 10_000 });
  console.log('PASS a wide, low window switches to the row layout');

  // 2. The automatic opening is registered while the setting is on; the browser calling it opens the window.
  assert.ok(await page.evaluate(() => window.__mediaActions.some(([action, set]) => action === 'enterpictureinpicture' && set)));
  await page.click('[data-testid="music-floating-player"]');
  await page.waitForFunction(() => !document.querySelector('iframe[data-testid="pip-stand-in"]'), { timeout: 10_000 });
  assert.equal(await page.$eval('[data-testid="music-floating-player"]', node => node.getAttribute('aria-pressed')), 'false');
  await page.evaluate(() => window.__enterPictureInPicture());
  const autoFrame = await pipFrame(page);
  await autoFrame.waitForSelector('[data-testid="floating-player"]', { timeout: 15_000 });
  console.log('PASS the registered enterpictureinpicture action (tab switch / minimize in Chrome) opens the window');

  // 3. Turning the setting off closes the window, hides the button and unregisters the action.
  await openSettingsGeneral(page);
  const on = await floatingSwitch(page);
  assert.equal(await on.evaluate(node => node.checked), true);
  await on.evaluate(node => node.click());
  await page.waitForFunction(() => !document.querySelector('iframe[data-testid="pip-stand-in"]'), { timeout: 10_000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('diva-player-floating-window')), '0');
  assert.equal(await page.$('[data-testid="music-floating-player"]'), null);
  await page.waitForFunction(() => {
    const actions = window.__mediaActions.filter(([action]) => action === 'enterpictureinpicture');
    return actions.at(-1)?.[1] === false && window.__enterPictureInPicture === null;
  }, { timeout: 10_000 });
  assert.equal(await page.evaluate(() => window.__mediaActions
    .filter(([action]) => action === 'enterpictureinpicture').at(-1)?.[1]), false);
  console.log('PASS turning 小窓プレイヤー off closes the window, removes the button and the automatic opening');
  await page.keyboard.press('Escape');
  assert.deepEqual(pageErrors, []);
  await page.close();

  // 4. Off from the start: no button and no automatic opening.
  const off = await newPage(browser, { supported: true, enabled: false });
  await off.page.waitForSelector('[data-testid="music-player-more"]:not([disabled])', { timeout: 30_000 });
  assert.equal(await off.page.$('[data-testid="music-floating-player"]'), null);
  assert.equal(await off.page.evaluate(() => window.__mediaActions.some(([action, set]) => action === 'enterpictureinpicture' && set)), false);
  await off.page.close();
  console.log('PASS with the setting off there is no button and no automatic opening');

  // 5. A browser without the window: the setting is shown as unavailable.
  const unsupported = await newPage(browser, { supported: false });
  await unsupported.page.waitForSelector('[data-testid="music-player-more"]:not([disabled])', { timeout: 30_000 });
  assert.equal(await unsupported.page.$('[data-testid="music-floating-player"]'), null);
  await openSettingsGeneral(unsupported.page);
  const disabled = await floatingSwitch(unsupported.page);
  assert.deepEqual(await disabled.evaluate(node => [node.disabled, node.checked]), [true, false]);
  assert.ok(await unsupported.page.evaluate(() => document.querySelector('[role="dialog"][aria-label="設定"]').textContent.includes('このブラウザでは使えません')));
  assert.deepEqual(unsupported.pageErrors, []);
  console.log('PASS a browser without Document Picture-in-Picture shows the setting as unavailable');
} finally {
  await browser.close();
}
