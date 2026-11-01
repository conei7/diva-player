import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });
// The mini player's play / pause toggle (its aria-label tells the state).
const PLAY_BUTTON = '[data-testid="global-mini-player-toggle"][aria-label="再生"]';
const PAUSE_BUTTON = '[data-testid="global-mini-player-toggle"][aria-label="一時停止"]';

const song = (service, pvId, url, id = service === 'SoundCloud' ? 900201 : service === 'NicoNicoDouga' ? 900203 : 900202) => ({
  id,
  name: `${service} fixture`,
  artistString: 'Fixture producer',
  createDate: '2026-01-01T00:00:00Z',
  defaultName: `${service} fixture`,
  defaultNameLanguage: 'English',
  favoritedTimes: 0,
  lengthSeconds: 120,
  pvServices: service,
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
  pvs: [{ author: '', disabled: false, id: id * 10 + 1, length: 120, name: 'fixture', pvId, service, pvType: 'Original', url }],
});

const soundCloudSong = song(
  'SoundCloud',
  '103524583 worldoncolorkoyori/feat-5',
  'http://soundcloud.com/worldoncolorkoyori/feat-5',
);
// Another song for the song-change cases: a new SoundCloud widget on a new iframe.
const secondSoundCloudSong = song(
  'SoundCloud',
  '103524584 worldoncolorkoyori/feat-6',
  'http://soundcloud.com/worldoncolorkoyori/feat-6',
  900204,
);
const bilibiliSong = song(
  'Bilibili',
  '45451154',
  'https://www.bilibili.com/video/av45451154',
);
const nicoSong = song(
  'NicoNicoDouga',
  'sm-nico-volume-fixture',
  'https://www.nicovideo.jp/watch/sm-nico-volume-fixture',
);

// Errors the player's error boundaries report: after one, the player is gone until a reload.
const playerFailures = new WeakMap();

async function preparePage(fixtureSong, savedVolume = 23, queue = [fixtureSong]) {
  // Each provider case is independent; separate contexts keep its playback
  // ownership and persisted volume from racing with the other fixture pages.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const failures = [];
  playerFailures.set(page, failures);
  page.on('console', message => {
    if (/DIVA Player (deferred part|embedded player) failed/.test(message.text())) failures.push(message.text());
  });
  await pinAppLanguage(page);
  await page.evaluateOnNewDocument((currentSong, currentVolume, currentQueue) => {
    // Puppeteer also runs this hook in child frames. A new about:blank player
    // frame shares the app's storage and can overwrite a native volume report
    // with the initial fixture value during a slow render. Seed only the app.
    if (window !== window.top) return;
    const tabId = `external-player-fixture-${currentSong.id}`;
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    localStorage.setItem('diva-playback-owner-v1', JSON.stringify({
      type: 'claim',
      tabId,
      songId: currentSong.id,
      claimedAt: Date.now(),
    }));
    if (currentVolume === null) localStorage.removeItem('diva_volume');
    else localStorage.setItem('diva_volume', JSON.stringify(currentVolume));
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue: currentQueue,
      queueIndex: 0,
      currentSong,
      currentSongId: currentSong.id,
      queueSources: currentQueue.map(() => 'manual'),
      currentPlaybackSource: 'manual',
    }));
  }, fixtureSong, savedVolume, queue);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = request.url();
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname.startsWith('/backend-api/') || parsedUrl.hostname === 'vocadb.net') {
      // These player cases use synthetic songs. Their IDs also exist in the
      // live catalog, so metadata/home requests must stay inside this fixture.
      const path = parsedUrl.pathname;
      let body = { items: [], totalCount: 0 };
      if (path.endsWith('/api/ready') || path.endsWith('/api/health')) {
        body = { status: path.endsWith('/api/ready') ? 'ready' : 'ok', dependencies: { postgres: { ok: true }, qdrant: { ok: true } } };
      } else if (parsedUrl.searchParams.get('fields') === 'Albums') {
        body = { albums: [] };
      } else if (path.endsWith('/api/songs/details') || path.endsWith('/api/songs/batch')) {
        body = { items: queue };
      } else if (/\/api\/songs\/\d+$/.test(path)) {
        body = queue.find(queued => path.endsWith(`/${queued.id}`)) ?? fixtureSong;
      } else if (path.endsWith('/api/songs/views')) {
        body = Object.fromEntries(queue.map(queued => [queued.id, { youtubeViews: 0, nicoViews: 0 }]));
      } else if (path.endsWith('/api/songs/discovery-eligibility')) {
        body = { items: queue.map(queued => ({ songId: queued.id, discoveryEligible: true })) };
      } else if (path.includes('/api/recommend/')) {
        body = [];
      }
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      return;
    }
    if (url === 'https://w.soundcloud.com/player/api.js') {
      await request.respond({
        contentType: 'application/javascript',
        body: `
          (() => {
            const Events = {
              READY: 'ready', PLAY: 'play', PAUSE: 'pause', FINISH: 'finish',
              SEEK: 'seek', PLAY_PROGRESS: 'play-progress', ERROR: 'error'
            };
            // Like the real api.js: one widget per iframe, READY once its player document has
            // loaded (window.__soundCloudReadyDelay), setters sent before READY are lost, and
            // unbind posts through the iframe, so it throws once the iframe has left the page.
            // auto_play=true in the src is not honoured (as when autoplay is blocked): only play() starts it.
            const widgets = new WeakMap();
            // The widget of an iframe, without creating one.
            window.__soundCloudWidgetOf = iframe => widgets.get(iframe);
            const Widget = function (iframe) {
              const existing = widgets.get(iframe);
              if (existing) return existing;
              window.__soundCloudWidgetCount = (window.__soundCloudWidgetCount || 0) + 1;
              const listeners = {};
              let paused = true;
              let ready = false;
              // api.js reports the first progress of a widget that has not fired PLAY as PLAY.
              let playEventFired = false;
              const emitPlay = () => {
                playEventFired = true;
                listeners[Events.PLAY]?.();
              };
              const widget = {
                bind(name, listener) {
                  listeners[name] = listener;
                  if (name !== Events.READY) return;
                  if (ready) {
                    setTimeout(listener, 1);
                    return;
                  }
                  setTimeout(() => {
                    if (!iframe.isConnected) return;
                    ready = true;
                    window.__soundCloudReady = true;
                    window.__soundCloudReadyCount = (window.__soundCloudReadyCount || 0) + 1;
                    listener();
                  }, window.__soundCloudReadyDelay || 0);
                },
                unbind(name) {
                  delete listeners[name];
                  if (name === Events.READY) return;
                  // A removed iframe has no contentWindow: TypeError, as in api.js.
                  iframe.contentWindow.postMessage(JSON.stringify({ method: 'removeEventListener', value: name }), '*');
                },
                play() {
                  // Like seekTo: the real widget drops a play() sent before READY, so a resume that only
                  // asks before READY never starts.
                  if (!ready) {
                    window.__soundCloudDroppedPlays = (window.__soundCloudDroppedPlays || 0) + 1;
                    return;
                  }
                  window.__soundCloudPlayCalls = (window.__soundCloudPlayCalls || 0) + 1;
                  if ((window.__soundCloudIgnoredStarts || 0) < (window.__soundCloudStartsToIgnore || 0)) {
                    window.__soundCloudIgnoredStarts = (window.__soundCloudIgnoredStarts || 0) + 1;
                    setTimeout(() => listeners[Events.PAUSE]?.(), 0);
                    return;
                  }
                  // Reproduce the transient stale PAUSE observed while a real
                  // SoundCloud Widget play request is settling.
                  setTimeout(() => listeners[Events.PAUSE]?.(), 0);
                  setTimeout(() => {
                    paused = false;
                    window.__soundCloudConfirmedPlaying = true;
                    emitPlay();
                  }, 50);
                },
                pause() {
                  window.__soundCloudPauseCalls = (window.__soundCloudPauseCalls || 0) + 1;
                  paused = true;
                  setTimeout(() => listeners[Events.PAUSE]?.(), 0);
                },
                seekTo(ms) {
                  if (!ready) {
                    (window.__soundCloudDroppedSeeks ||= []).push(ms);
                    return;
                  }
                  (window.__soundCloudSeeks ||= []).push(ms);
                  setTimeout(() => listeners[Events.SEEK]?.({ currentPosition: ms }), 0);
                  // A seek on a paused widget that never played reports PLAY, yet stays paused. api.js
                  // makes it from the player's first progress report, later than the app's 0 ms timers.
                  setTimeout(() => {
                    if (!playEventFired) emitPlay();
                  }, 20);
                },
                setVolume(value) { window.__soundCloudVolume = value; },
                getDuration(callback) { callback(120000); },
                isPaused(callback) { callback(paused); },
              };
              widgets.set(iframe, widget);
              window.__soundCloudWidget = widget;
              // The latest widget's own play / pause buttons.
              window.__soundCloudNativePlay = () => {
                paused = false;
                setTimeout(emitPlay, 0);
              };
              window.__soundCloudNativePause = () => {
                paused = true;
                setTimeout(() => listeners[Events.PAUSE]?.(), 0);
              };
              return widget;
            };
            Widget.Events = Events;
            window.SC = { Widget };
          })();
        `,
      });
      return;
    }
    if (url.startsWith('https://w.soundcloud.com/player/')) {
      await request.respond({ contentType: 'text/html', body: '<!doctype html><title>SoundCloud fixture</title>' });
      return;
    }
    if (url.startsWith('https://player.bilibili.com/player.html')) {
      await request.respond({ contentType: 'text/html', body: '<!doctype html><title>Bilibili fixture</title>' });
      return;
    }
    if (url.startsWith('https://embed.nicovideo.jp/watch/')) {
      await request.respond({ contentType: 'text/html', body: `<!doctype html><title>Niconico fixture</title>
        <script>
          window.addEventListener('message', event => {
            if (event.source !== window.parent || event.data?.eventName !== 'volumeChange') return;
            window.__nicoAppliedVolume = event.data.data?.volume;
            if (window.__nicoInitialVolume === undefined) {
              window.__nicoInitialVolume = window.__nicoAppliedVolume;
              // Native controls can report immediately after the app's first command.
              window.parent.postMessage({
                sourceConnectorType: 0,
                playerId: new URL(location.href).searchParams.get('playerId'),
                eventName: 'playerMetadataChange', data: { volume: 0.42 },
              }, '*');
            }
          });
        </script>` });
      return;
    }
    await request.continue();
  });
  return page;
}

const SOUNDCLOUD_EMBED = '[data-testid="soundcloud-player-embed"]';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Page shortcuts are ignored while a control has focus.
async function pressShortcut(page, key, shift = false) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up('Shift');
}

async function openSoundCloud(queue) {
  const page = await preparePage(queue[0], 23, queue);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.bringToFront();
  await page.waitForSelector(SOUNDCLOUD_EMBED, { timeout: 60_000 });
  await page.waitForFunction(() => window.__soundCloudReadyCount === 1);
  await page.waitForSelector(PLAY_BUTTON);
  // Settled: the pageshow after the page's load runs the wake recovery, which can start a widget too.
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60_000 });
  return page;
}

async function openPlayingSoundCloud(queue) {
  const page = await openSoundCloud(queue);
  await page.$eval(PLAY_BUTTON, button => button.click());
  await page.waitForSelector(PAUSE_BUTTON);
  // Settled: a pause before the widget's PLAY would be overtaken by it.
  await page.waitForFunction(() => window.__soundCloudConfirmedPlaying === true);
  return page;
}

// → three times: 15 s, past the 5 s under which 元に戻す starts the song over.
async function seekToFifteenSeconds(page) {
  for (let press = 0; press < 3; press += 1) await pressShortcut(page, 'ArrowRight');
  await page.waitForFunction(() => window.__soundCloudSeeks?.at(-1) === 15000);
}

async function closeAndUndo(page) {
  await page.$eval('[data-testid="mini-player-close"]', button => button.click());
  await page.waitForFunction(() => document.querySelector('[data-testid="toast-host"]')?.textContent?.includes('プレイヤーを閉じました'));
  await page.$eval('[data-testid="toast-host"] [data-toast-action]', button => button.click());
}

async function readSoundCloudCase(page) {
  return {
    ...await page.evaluate(() => {
      // Whether the widget of the SoundCloud iframe on the page is playing (null: no widget).
      let widgetPlaying = null;
      const soundCloudIframe = document.querySelector('[data-testid="soundcloud-player-embed"]');
      window.__soundCloudWidgetOf?.(soundCloudIframe)?.isPaused(paused => { widgetPlaying = !paused; });
      return {
        widgets: window.__soundCloudWidgetCount || 0,
        readyWidgets: window.__soundCloudReadyCount || 0,
        widgetPlaying,
        seeks: window.__soundCloudSeeks || [],
        droppedSeeks: window.__soundCloudDroppedSeeks || [],
        playCalls: window.__soundCloudPlayCalls || 0,
        pauseCalls: window.__soundCloudPauseCalls || 0,
        controlLabel: document.querySelector('[data-testid="global-mini-player-toggle"]')?.getAttribute('aria-label') ?? null,
        playerIframes: [...document.querySelectorAll('[data-testid="global-player"] iframe')].map(iframe => iframe.src.slice(0, 120)),
        youtubeContainer: document.getElementById('yt-player-embed') !== null,
      };
    }),
    failures: playerFailures.get(page),
  };
}

try {
  const soundCloudPage = await preparePage(soundCloudSong);
  await soundCloudPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await soundCloudPage.waitForSelector('[data-testid="soundcloud-player-embed"]', { timeout: 60_000 });
  const soundCloudSrc = new URL(await soundCloudPage.$eval('[data-testid="soundcloud-player-embed"]', iframe => iframe.src));
  if (soundCloudSrc.searchParams.get('url') !== 'https://soundcloud.com/worldoncolorkoyori/feat-5') {
    throw new Error(`Unexpected SoundCloud target: ${soundCloudSrc}`);
  }
  await soundCloudPage.waitForFunction(() => window.__soundCloudReady === true);
  // The mini player's controls are a separate chunk that loads once a song is set (performance budget).
  await soundCloudPage.waitForSelector(PLAY_BUTTON);
  await soundCloudPage.$eval(PLAY_BUTTON, button => button.click());
  await soundCloudPage.waitForFunction(() => window.__soundCloudPlayCalls > 0);
  await soundCloudPage.waitForSelector(PAUSE_BUTTON);
  await new Promise(resolve => setTimeout(resolve, 500));
  const soundCloudState = await soundCloudPage.evaluate(() => ({
    playCalls: window.__soundCloudPlayCalls || 0,
    pauseCalls: window.__soundCloudPauseCalls || 0,
    volume: window.__soundCloudVolume,
  }));
  if (soundCloudState.playCalls !== 1 || soundCloudState.pauseCalls !== 0 || soundCloudState.volume !== 23) {
    throw new Error(`Unstable SoundCloud state: ${JSON.stringify(soundCloudState)}`);
  }
  await soundCloudPage.$eval(PAUSE_BUTTON, button => button.click());
  await soundCloudPage.waitForFunction(() => window.__soundCloudPauseCalls > 0);
  await soundCloudPage.waitForSelector(PLAY_BUTTON);
  console.log('PASS SoundCloud stable playback and inherited volume');

  await soundCloudPage.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    window.__soundCloudStartsToIgnore = 2;
    window.__soundCloudIgnoredStarts = 0;
    window.__soundCloudConfirmedPlaying = false;
    document.querySelector('[data-testid="global-mini-player-toggle"][aria-label="再生"]')?.click();
  });
  await soundCloudPage.waitForFunction(() => window.__soundCloudConfirmedPlaying === true, { timeout: 5_000 });
  const soundCloudBackgroundState = await soundCloudPage.evaluate(() => ({
    confirmedPlaying: window.__soundCloudConfirmedPlaying === true,
    ignoredStarts: window.__soundCloudIgnoredStarts || 0,
    playCalls: window.__soundCloudPlayCalls || 0,
    controlLabel: document.querySelector('[data-testid="global-mini-player-toggle"]')?.getAttribute('aria-label'),
    visibilityState: document.visibilityState,
  }));
  if (!soundCloudBackgroundState.confirmedPlaying || soundCloudBackgroundState.visibilityState !== 'hidden') {
    throw new Error(`SoundCloud recovery did not run in the background: ${JSON.stringify(soundCloudBackgroundState)}`);
  }
  console.log(`PASS SoundCloud hidden start retries until PLAY (${soundCloudBackgroundState.playCalls} calls)`);

  {
    // Closing removes the widget's iframe (api.js throws when it is unbound then), and READY of
    // the restored one applies the pending seek and starts it again.
    const page = await openPlayingSoundCloud([soundCloudSong, secondSoundCloudSong]);
    await seekToFifteenSeconds(page);
    await page.evaluate(() => {
      window.__soundCloudSeeks = [];
      window.__soundCloudReadyDelay = 300;
      window.__soundCloudConfirmedPlaying = false;
    });
    await closeAndUndo(page);
    try {
      await page.waitForFunction(() => window.__soundCloudReadyCount === 2 && window.__soundCloudSeeks.includes(15000), { timeout: 10_000 });
      await page.waitForSelector(PAUSE_BUTTON, { timeout: 5_000 });
      // The toggle alone is no proof: it also reads 一時停止 when no widget plays.
      await page.waitForFunction(() => window.__soundCloudConfirmedPlaying === true, { timeout: 5_000 });
    } catch (error) {
      throw new Error(`SoundCloud 元に戻す did not resume the closed song: ${JSON.stringify(await readSoundCloudCase(page))}`, { cause: error });
    }
    const state = await readSoundCloudCase(page);
    if (state.widgetPlaying !== true || state.failures.length > 0 || state.droppedSeeks.length > 0) {
      throw new Error(`SoundCloud 元に戻す resumed unreliably: ${JSON.stringify(state)}`);
    }
    console.log('PASS SoundCloud close and 元に戻す resume at the closed position');
    await page.browserContext().close();
  }

  {
    // The restored widget has never played, and api.js reports a seek on it as PLAY while it stays
    // paused: a paused 元に戻す must only cue the song.
    const page = await openPlayingSoundCloud([soundCloudSong, secondSoundCloudSong]);
    await seekToFifteenSeconds(page);
    await page.$eval(PAUSE_BUTTON, button => button.click());
    await page.waitForSelector(PLAY_BUTTON);
    await page.waitForFunction(() => window.__soundCloudPauseCalls > 0);
    const playCallsBeforeClose = await page.evaluate(() => {
      window.__soundCloudSeeks = [];
      window.__soundCloudReadyDelay = 300;
      return window.__soundCloudPlayCalls;
    });
    await closeAndUndo(page);
    try {
      await page.waitForFunction(() => window.__soundCloudReadyCount === 2 && window.__soundCloudSeeks.includes(15000), { timeout: 10_000 });
    } catch (error) {
      throw new Error(`Paused SoundCloud 元に戻す did not cue the closed position: ${JSON.stringify(await readSoundCloudCase(page))}`, { cause: error });
    }
    await sleep(1_000);
    const state = await readSoundCloudCase(page);
    if (state.controlLabel !== '再生' || state.playCalls !== playCallsBeforeClose || state.failures.length > 0) {
      throw new Error(`Paused SoundCloud 元に戻す started playback: ${JSON.stringify({ ...state, playCallsBeforeClose })}`);
    }
    console.log('PASS SoundCloud paused 元に戻す stays paused at the closed position');
    await page.browserContext().close();
  }

  {
    // The widget's own play and pause buttons while the app is paused: that PLAY is unrequested too,
    // and the app follows it once isPaused confirms it, without a play() of its own.
    const page = await openSoundCloud([soundCloudSong]);
    await page.evaluate(() => window.__soundCloudNativePlay());
    try {
      await page.waitForSelector(PAUSE_BUTTON, { timeout: 5_000 });
    } catch (error) {
      throw new Error(`SoundCloud native play was not reflected: ${JSON.stringify(await readSoundCloudCase(page))}`, { cause: error });
    }
    await sleep(500);
    const playing = await readSoundCloudCase(page);
    if (playing.controlLabel !== '一時停止' || playing.widgetPlaying !== true || playing.playCalls !== 0 || playing.failures.length > 0) {
      throw new Error(`SoundCloud native play was followed unreliably: ${JSON.stringify(playing)}`);
    }
    await page.evaluate(() => window.__soundCloudNativePause());
    try {
      await page.waitForSelector(PLAY_BUTTON, { timeout: 5_000 });
    } catch (error) {
      throw new Error(`SoundCloud native pause was not reflected: ${JSON.stringify(await readSoundCloudCase(page))}`, { cause: error });
    }
    await sleep(500);
    const paused = await readSoundCloudCase(page);
    if (paused.controlLabel !== '再生' || paused.widgetPlaying !== false || paused.playCalls !== 0 || paused.pauseCalls !== 0 || paused.failures.length > 0) {
      throw new Error(`SoundCloud native pause was followed unreliably: ${JSON.stringify(paused)}`);
    }
    console.log('PASS SoundCloud native play and pause in the widget are reflected');
    await page.browserContext().close();
  }

  {
    // → right after a song change, before the new widget is READY (which would drop the seek).
    const page = await openPlayingSoundCloud([soundCloudSong, secondSoundCloudSong]);
    await page.evaluate(() => {
      window.__soundCloudSeeks = [];
      window.__soundCloudReadyDelay = 1_500;
    });
    await pressShortcut(page, 'ArrowRight', true);
    try {
      await page.waitForFunction(() => window.__soundCloudWidgetCount === 2, { timeout: 10_000 });
    } catch (error) {
      throw new Error(`The next SoundCloud song did not load: ${JSON.stringify(await readSoundCloudCase(page))}`, { cause: error });
    }
    for (let press = 0; press < 3; press += 1) await pressShortcut(page, 'ArrowRight');
    if (await page.evaluate(() => window.__soundCloudReadyCount !== 1)) {
      throw new Error('The → presses did not land before READY: raise __soundCloudReadyDelay');
    }
    try {
      await page.waitForFunction(() => window.__soundCloudReadyCount === 2, { timeout: 10_000 });
      await page.waitForFunction(() => window.__soundCloudSeeks.includes(15000), { timeout: 2_000 });
    } catch (error) {
      throw new Error(`SoundCloud seek before READY was lost: ${JSON.stringify(await readSoundCloudCase(page))}`, { cause: error });
    }
    const state = await readSoundCloudCase(page);
    if (!state.playerIframes.some(src => src.includes('feat-6')) || state.droppedSeeks.length > 0 || state.failures.length > 0) {
      throw new Error(`SoundCloud seek before READY was not applied to the next song: ${JSON.stringify(state)}`);
    }
    console.log('PASS SoundCloud seek before READY waits for READY');
    await page.browserContext().close();
  }

  {
    // Leaving a SoundCloud song unmounts its widget: the next song's player must still render.
    const page = await openPlayingSoundCloud([soundCloudSong, nicoSong]);
    await pressShortcut(page, 'ArrowRight', true);
    try {
      await page.waitForSelector('[data-testid="global-player"] iframe[src*="embed.nicovideo.jp/watch/sm-nico-volume-fixture"]', { timeout: 10_000 });
    } catch (error) {
      throw new Error(`The song after SoundCloud did not render: ${JSON.stringify(await readSoundCloudCase(page))}`, { cause: error });
    }
    const state = await readSoundCloudCase(page);
    if (!state.youtubeContainer || state.playerIframes.some(src => src.includes('soundcloud')) || state.failures.length > 0) {
      throw new Error(`Leaving SoundCloud broke the player: ${JSON.stringify(state)}`);
    }
    console.log('PASS SoundCloud song change renders the next player');
    await page.browserContext().close();
  }

  const bilibiliPage = await preparePage(bilibiliSong);
  await bilibiliPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await bilibiliPage.waitForSelector('[data-testid="bilibili-player-embed"]', { timeout: 60_000 });
  const bilibiliSrc = new URL(await bilibiliPage.$eval('[data-testid="bilibili-player-embed"]', iframe => iframe.src));
  if (
    bilibiliSrc.searchParams.get('aid') !== '45451154'
    || bilibiliSrc.searchParams.get('danmaku') !== '0'
    || bilibiliSrc.searchParams.get('muted') !== '0'
  ) {
    throw new Error(`Unexpected Bilibili embed: ${bilibiliSrc}`);
  }
  console.log('PASS Bilibili aid embed keeps native player audio enabled');

  const nicoPage = await preparePage(nicoSong);
  const nicoSession = await nicoPage.createCDPSession();
  await nicoSession.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.DIVA_E2E_CPU_RATE || 4) });
  await nicoPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await nicoPage.bringToFront();
  await nicoPage.waitForFunction(() => document.visibilityState === 'visible');
  await nicoPage.waitForSelector('iframe[src*="embed.nicovideo.jp/watch/sm-nico-volume-fixture"]', { timeout: 60_000 });
  await nicoPage.waitForFunction(() => {
    const iframe = document.querySelector('iframe[src*="embed.nicovideo.jp/watch/sm-nico-volume-fixture"]');
    return iframe instanceof HTMLIFrameElement && iframe.contentWindow !== null;
  }, { timeout: 15_000 });
  const nicoFrame = nicoPage.frames().find(frame => frame.url().includes('embed.nicovideo.jp/watch/sm-nico-volume-fixture'));
  if (!nicoFrame) throw new Error('Niconico volume fixture frame was not attached');
  // An attached iframe can precede React's player effects. Wait for the app's
  // initial volume command before testing the reverse (native control) path.
  await nicoFrame.waitForFunction(() => window.__nicoInitialVolume === 0.23, { timeout: 15_000 });
  try {
    await nicoPage.waitForFunction(() => localStorage.getItem('diva_volume') === '42', { timeout: 5_000 });
  } catch (error) {
    throw new Error(`Immediate Niconico volume was not persisted: ${JSON.stringify({
      savedVolume: await nicoPage.evaluate(() => localStorage.getItem('diva_volume')),
      initialVolume: await nicoFrame.evaluate(() => window.__nicoInitialVolume),
      appliedVolume: await nicoFrame.evaluate(() => window.__nicoAppliedVolume),
    })}`, { cause: error });
  }
  console.log('PASS immediate Niconico volume report during a throttled initial render');
  // A provider may create a same-origin blank child frame after the native
  // report. Its document must not rerun the top-level fixture initialization.
  await nicoPage.evaluate(() => new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.onload = () => {
      frame.remove();
      resolve();
    };
    frame.src = 'about:blank';
    document.body.append(frame);
  }));
  const volumeAfterChildFrame = await nicoPage.evaluate(() => localStorage.getItem('diva_volume'));
  if (volumeAfterChildFrame !== '42') {
    throw new Error(`Child-frame initialization overwrote Niconico volume: ${volumeAfterChildFrame}`);
  }
  console.log('PASS child-frame initialization preserves native volume');
  await nicoPage.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="embed.nicovideo.jp/watch/sm-nico-volume-fixture"]');
    window.__nicoVolumeMessageProbe = [];
    window.addEventListener('message', event => {
      if (event.data?.eventName !== 'playerMetadataChange') return;
      window.__nicoVolumeMessageProbe.push({
        origin: event.origin,
        sourceMatches: event.source === iframe?.contentWindow,
        playerId: event.data.playerId,
        volume: event.data.data?.volume,
      });
    }, true);
  });
  const volumeUpdateDeadline = Date.now() + 5_000;
  while (Date.now() < volumeUpdateDeadline) {
    if (await nicoPage.evaluate(() => localStorage.getItem('diva_volume') === '57')) break;
    // Send from the embedded document so Chromium supplies a real origin and
    // source WindowProxy. A synthetic top-window MessageEvent can lose those
    // properties across browser/runtime versions and silently miss the app's
    // origin/source checks.
    await nicoFrame.evaluate(() => {
      const playerId = new URL(window.location.href).searchParams.get('playerId');
      if (!playerId) return;
      window.parent.postMessage({
        sourceConnectorType: 0,
        playerId,
        eventName: 'playerMetadataChange',
        data: { volume: 0.57 },
      }, '*');
    });
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const savedNicoVolume = await nicoPage.evaluate(() => localStorage.getItem('diva_volume'));
  if (savedNicoVolume !== '57') {
    throw new Error(`Niconico volume event was not persisted: ${JSON.stringify({
      savedVolume: savedNicoVolume,
      iframeUrls: await nicoPage.$$eval('iframe[src*="embed.nicovideo.jp/watch/sm-nico-volume-fixture"]', frames => frames.map(frame => frame.src)),
      receivedEvents: await nicoPage.evaluate(() => window.__nicoVolumeMessageProbe?.slice(-3) ?? []),
    })}`);
  }
  console.log('PASS Niconico native volume changes persist in the shared player setting');
} finally {
  await browser.close();
}
