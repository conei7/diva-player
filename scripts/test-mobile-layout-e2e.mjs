import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4181/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const assert = (condition, message) => { if (!condition) throw new Error(message); };

// The standard mini player (YouTube's Required Minimum Functionality): the embedded player is at
// least 200×200 and nothing is drawn over it, at phone, landscape-phone and desktop sizes, playing
// and muted. The stub builds a real <iframe> where the IFrame API would.
const sizeSong = (id, service = 'Youtube') => ({
  id, name: `Mini size fixture ${id}`, defaultName: `Mini size fixture ${id}`, defaultNameLanguage: 'English',
  artistString: 'Fixture P feat. 初音ミク', createDate: '2026-01-01T00:00:00Z', publishDate: '2025-06-01T00:00:00Z',
  favoritedTimes: 10, lengthSeconds: 200, pvServices: service, ratingScore: 0, songType: 'Original', status: 'Finished', version: 1,
  artists: [
    { name: 'Fixture P', categories: 'Producer', isSupport: false, artist: { id: 1, name: 'Fixture P', artistType: 'Producer' } },
    { name: '初音ミク', categories: 'Vocalist', isSupport: false, artist: { id: 2, name: '初音ミク', artistType: 'Vocaloid' } },
  ],
  pvs: [service === 'Youtube'
    ? { author: '', disabled: false, id: id * 10, length: 200, name: 'pv', pvId: `mini${id}`, service, pvType: 'Original', url: `https://youtu.be/mini${id}` }
    : { author: '', disabled: false, id: id * 10, length: 200, name: 'pv', pvId: `sm${id}`, service, pvType: 'Original', url: `https://www.nicovideo.jp/watch/sm${id}` }],
});
const YOUTUBE_IFRAME_STUB = `
  window.YT = {
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 },
    Player: function (id, options) {
      const player = this; let state = -1; let videoId = ''; let volume = 50;
      const target = typeof id === 'string' ? document.getElementById(id) : id;
      const iframe = document.createElement('iframe');
      iframe.id = target.id; iframe.setAttribute('width', options.width ?? '640'); iframe.setAttribute('height', options.height ?? '390');
      iframe.src = 'about:blank'; iframe.title = 'YouTube video player';
      target.replaceWith(iframe);
      window.__yt = player;
      player.getIframe = () => iframe;
      player.getVideoData = () => ({ video_id: videoId });
      player.getPlayerState = () => state;
      player.getCurrentTime = () => 0;
      player.getDuration = () => 200;
      player.getVolume = () => volume;
      player.setVolume = value => { volume = value; };
      player.isMuted = () => false; player.mute = () => {}; player.unMute = () => {};
      player.seekTo = () => {};
      player.cueVideoById = player.loadVideoById = value => { videoId = typeof value === 'string' ? value : value.videoId; state = 5; };
      const emit = () => options.events.onStateChange({ data: state, target: player });
      player.playVideo = () => { if (state === 1) return; state = 1; emit(); };
      player.pauseVideo = () => { state = 2; emit(); };
      player.stopVideo = () => { state = 0; };
      player.destroy = () => {};
      setTimeout(() => options.events.onReady({ target: player }), 0);
    },
  };
  window.onYouTubeIframeAPIReady();
`;

/** A fresh context whose tab owns playback of `song` (restored queue), at `volume`, in `layout`. */
async function openMiniPlayerPage([width, height], { song, volume = 50, layout = null }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, isMobile: width < 1024, hasTouch: width < 1024 });
  await pinAppLanguage(page);
  await page.evaluateOnNewDocument(seed => {
    if (window !== window.top || sessionStorage.getItem('mini-size-seeded')) return;
    sessionStorage.setItem('mini-size-seeded', '1');
    localStorage.setItem('diva_volume', JSON.stringify(seed.volume));
    if (seed.layout) localStorage.setItem('diva_uiLayout', JSON.stringify(seed.layout));
    localStorage.setItem('diva-global-filters', JSON.stringify({ version: 2, state: { enabled: false } }));
    const tabId = 'mini-size-tab';
    sessionStorage.setItem('diva-playback-tab-v1', tabId);
    localStorage.setItem('diva-playback-owner-v1', JSON.stringify({ type: 'claim', tabId, songId: seed.song.id, claimedAt: Date.now() }));
    localStorage.setItem('diva_playerQueue', JSON.stringify({
      queue: [seed.song], queueIndex: 0, currentSong: seed.song, currentSongId: seed.song.id,
      queueSources: ['manual'], currentPlaybackSource: 'manual',
    }));
  }, { song, volume, layout });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.href === 'https://www.youtube.com/iframe_api') {
      void request.respond({ status: 200, contentType: 'application/javascript', body: YOUTUBE_IFRAME_STUB });
    } else if (url.pathname.includes('/backend-api/') || url.hostname === 'vocadb.net') {
      const body = /\/api\/songs\/\d+$/.test(url.pathname) ? song
        : /\/api\/(health|ready)$/.test(url.pathname) ? { status: 'ok', postgres: true, qdrant: true }
          : { items: [], totalCount: 0 };
      void request.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
    } else if (url.hostname === new URL(baseUrl).hostname) void request.continue();
    // Embedded players (Niconico) get an empty page: only their box is measured.
    else void request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>embed fixture</title>' });
  });
  return { context, page };
}

const MINI_PLAYER_IFRAMES = '.global-mini-player .global-player-video iframe';

/** Waits for the mini player's iframe (and its controls), then measures the player and what is around it. */
async function measureMiniPlayer(page, { volume, service }) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (service === 'Youtube') {
    await page.waitForFunction(() => window.__yt?.getVideoData?.().video_id, { timeout: 30_000 });
    await page.evaluate(() => window.__yt.playVideo());
  }
  // The shown embed (a hidden YouTube container can hold another iframe while Niconico plays).
  await page.waitForFunction(selector => [...document.querySelectorAll(selector)]
    .some(frame => frame.getBoundingClientRect().width > 0), { timeout: 30_000 }, MINI_PLAYER_IFRAMES);
  await page.waitForSelector('[data-testid="mini-player-gesture-surface"]', { visible: true, timeout: 30_000 });
  if (volume === 0) await page.waitForSelector('[data-testid="player-mute-badge"]', { visible: true, timeout: 10_000 });
  await new Promise(resolve => setTimeout(resolve, 300));
  return page.evaluate(selector => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const iframe = [...document.querySelectorAll(selector)].find(frame => frame.getBoundingClientRect().width > 0);
    const box = iframe.getBoundingClientRect();
    // 5×5 points inset 8% (inside the rounded corners): the header, the strip or its buttons must not cover any.
    const covered = [];
    for (const fx of [0.08, 0.29, 0.5, 0.71, 0.92]) {
      for (const fy of [0.08, 0.29, 0.5, 0.71, 0.92]) {
        const x = box.left + box.width * fx;
        const y = box.top + box.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit !== iframe) covered.push({ x: Math.round(x), y: Math.round(y), hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null });
      }
    }
    const controls = document.querySelector('[data-testid="mini-player-gesture-surface"]');
    const buttons = [...controls.querySelectorAll('button')].map(button => {
      const area = button.getBoundingClientRect();
      const hit = document.elementFromPoint(area.left + area.width / 2, area.top + area.height / 2);
      return { label: button.getAttribute('aria-label'), width: area.width, reachable: Boolean(hit && button.contains(hit)) };
    });
    const nav = document.querySelector('nav.app-bottom-nav');
    // Resolves the layout variables to pixels.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;width:var(--guide-offset,0px);height:var(--floating-player-clearance,0px)';
    document.body.append(probe);
    const variables = { guideOffset: probe.getBoundingClientRect().width, clearance: probe.getBoundingClientRect().height };
    probe.remove();
    return {
      iframe: rect(iframe), covered, buttons, ...variables,
      controls: { ...rect(controls), scrollWidth: controls.scrollWidth, clientWidth: controls.clientWidth },
      nav: nav ? { ...rect(nav), scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth } : null,
    };
  }, MINI_PLAYER_IFRAMES);
}

/** From 560px wide on screens under 420px tall the video sits in the corner; narrower and short keeps the old cap. */
function checkMiniPlayer(result, [width, height], label) {
  const { iframe } = result;
  const fallback = width < 560 && height < 420;
  if (fallback) {
    // Header + 200px + controls + bottom nav do not fit: the video keeps its cap of 50dvh - 60px.
    assert(Math.abs(iframe.height - (height / 2 - 60)) <= 1, `${label}: the narrow short fallback changed ${JSON.stringify(iframe)}`);
  } else {
    assert(iframe.width >= 199.5 && iframe.height >= 199.5, `${label}: embedded player under 200×200 ${JSON.stringify(iframe)}`);
  }
  assert(iframe.left >= -0.5 && iframe.top >= -0.5 && iframe.right <= width + 0.5 && iframe.bottom <= height + 0.5,
    `${label}: embedded player outside the viewport ${JSON.stringify(iframe)}`);
  assert(result.covered.length === 0, `${label}: something is drawn over the embedded player ${JSON.stringify(result.covered)}`);
  assert(result.controls.scrollWidth <= result.controls.clientWidth,
    `${label}: mini player controls overflow ${JSON.stringify(result.controls)}`);
  assert(result.controls.left >= result.guideOffset - 0.5,
    `${label}: controls start under the guide ${JSON.stringify({ controls: result.controls, guide: result.guideOffset })}`);
  assert(result.buttons.length >= 3 && result.buttons.every(button => button.reachable),
    `${label}: mini player buttons are covered or off screen ${JSON.stringify(result.buttons)}`);
  assert(result.clearance > 0, `${label}: --floating-player-clearance is not set`);
  if (result.nav) {
    assert(result.nav.width > 0 && result.nav.scrollWidth <= result.nav.clientWidth, `${label}: bottom navigation squeezed ${JSON.stringify(result.nav)}`);
    if (!fallback && height < 420) {
      assert(result.nav.right <= iframe.left + 0.5, `${label}: bottom navigation runs under the video ${JSON.stringify({ nav: result.nav, iframe })}`);
    }
  }
}
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
      // The search box is a combobox: #search-suggestions is its listbox, the panel around it scrolls.
      const listbox = document.getElementById('search-suggestions');
      const option = [...listbox.querySelectorAll('[role="option"]')].find(element => element.textContent.trim() === '検索履歴 9');
      const panel = listbox.closest('[data-testid="search-suggestions-panel"]');
      panel.scrollTop = panel.scrollHeight;
      const rect = panel.getBoundingClientRect();
      const last = option.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, lastBottom: last.bottom, height: innerHeight };
    });
    assert(suggestions.top >= 0 && suggestions.bottom <= height + 1
      && suggestions.lastBottom <= suggestions.bottom + 1,
    `Search history cannot reach last entry at ${width}x${height}: ${JSON.stringify(suggestions)}`);
    await page.keyboard.press('Escape');
    await page.goto(new URL('history', baseUrl), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main h1');
    // History actions live in the right column from 1024px and in the header's ⋮ below that.
    const historyActions = 'main [data-testid="history-actions"] button, main [data-testid="history-actions-menu"]';
    await page.waitForSelector(historyActions);
    const layout = await page.evaluate(selector => {
      const heading = document.querySelector('main h1').getBoundingClientRect();
      const actions = [...document.querySelectorAll(selector)];
      return { heading, actions: actions.map(button => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top };
      }), width: document.documentElement.scrollWidth };
    }, historyActions);
    assert(layout.actions.length > 0, `History controls are missing at ${width}`);
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
  await page.waitForSelector('[data-testid="advanced-search-dialog"] .filter-section-header');
  await page.evaluate(() => [...document.querySelectorAll('.filter-section-header')]
    .find(button => button.textContent.includes('参加者・役割')).click());
  await page.type('input[placeholder="クリエイターを検索"]', 'Layout');
  await page.waitForFunction(() => document.body.textContent.includes('Layout fixture 19'));
  // A fast fixture response may arrive during the section's opening transition.
  // Measure its final layout, while retaining the clipping assertion below.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.effect instanceof KeyframeEffect
      && animation.effect.target?.closest('.filter-section')
      && animation.effect.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
  const list = await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="クリエイターを検索"]');
    const section = input.closest('.filter-section-content');
    const panel = section.querySelector('ul');
    const rect = panel.getBoundingClientRect();
    const boundary = section.getBoundingClientRect();
    return { bottom: rect.bottom, boundary: boundary.bottom, position: getComputedStyle(panel).position };
  });
  assert(list.position !== 'absolute' && list.bottom <= list.boundary + 1, `Clipped filter suggestions: ${JSON.stringify(list)}`);
  console.log('PASS advanced search suggestions stay within section');

  const sizes = [[320, 360], [360, 400], [320, 568], [360, 640], [568, 320], [640, 360], [740, 340], [780, 300],
    [844, 390], [1280, 400], [768, 1024], [1280, 800]];
  for (const size of sizes) {
    for (const volume of [50, 0]) {
      const label = `standard mini player ${size.join('x')} volume ${volume}`;
      const { context, page } = await openMiniPlayerPage(size, { song: sizeSong(983001), volume });
      try {
        const result = await measureMiniPlayer(page, { volume, service: 'Youtube' });
        checkMiniPlayer(result, size, label);
        // Short windows from 768px keep the two rows: キュー and ⋮ fit beside the corner video.
        if (size[0] >= 768 && size[1] < 420) {
          const labels = result.buttons.map(button => button.label);
          assert(labels.includes('キュー') && labels.includes('その他の操作'), `${label}: queue / more actions missing ${JSON.stringify(labels)}`);
        }
        if (volume === 0) assert(result.buttons.some(button => button.label === 'ミュートを解除'), `${label}: ミュートを解除 missing`);
      } finally {
        await context.close();
      }
    }
    console.log(`PASS standard mini player ≥200×200, unobstructed, controls fit at ${size.join('x')} (volume 50 and 0)`);
  }

  // Niconico (like every other embed) fills the same box.
  {
    const size = [568, 320];
    const { context, page } = await openMiniPlayerPage(size, { song: sizeSong(983002, 'NicoNicoDouga') });
    try {
      checkMiniPlayer(await measureMiniPlayer(page, { volume: 50, service: 'NicoNicoDouga' }), size, 'Niconico mini player 568x320');
    } finally {
      await context.close();
    }
    console.log('PASS Niconico mini player ≥200×200 and unobstructed at 568x320');
  }

  // On short screens the corner video sits beside the bottom navigation (or the music layout's bars), not
  // on it: a toast (here M's) must still be on screen and above the video, in both layouts. From 1024px
  // the toast sits bottom-left, where the standard layout's strip is: above the strip, over none of its
  // controls (nor the video).
  for (const layout of [null, 'music']) {
    const toastSizes = layout ? [[568, 320], [600, 300]] : [[568, 320], [600, 300], [1280, 400]];
    for (const size of toastSizes) {
      const label = `${layout ?? 'standard'} toast beside the corner mini player ${size.join('x')}`;
      const { context, page } = await openMiniPlayerPage(size, { song: sizeSong(983004), layout });
      try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForFunction(() => window.__yt?.getVideoData?.().video_id, { timeout: 30_000 });
        await page.evaluate(() => window.__yt.playVideo());
        await page.waitForFunction(selector => [...document.querySelectorAll(selector)]
          .some(frame => frame.getBoundingClientRect().width > 0), { timeout: 30_000 }, MINI_PLAYER_IFRAMES);
        if (!layout) await page.waitForSelector('[data-testid="mini-player-gesture-surface"]', { visible: true, timeout: 30_000 });
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press('m');
        await page.waitForFunction(() => document.querySelector('[data-testid="toast-host"]')?.textContent.includes('ミュートしました'),
          { timeout: 10_000 });
        // Past the toast's 150ms entrance.
        await new Promise(resolve => setTimeout(resolve, 400));
        const boxes = await page.evaluate(selector => {
          const iframe = [...document.querySelectorAll(selector)].find(frame => frame.getBoundingClientRect().width > 0).getBoundingClientRect();
          const toast = [...document.querySelector('[data-testid="toast-host"]').children]
            // Not ToastHost's aria-hidden safe-area probe, which has a height once there is a bottom inset.
            .find(child => !child.matches('[aria-hidden="true"]') && child.getBoundingClientRect().height > 0).getBoundingClientRect();
          const overlaps = box => Math.min(box.right, toast.right) - Math.max(box.left, toast.left) > 0
            && Math.min(box.bottom, toast.bottom) - Math.max(box.top, toast.top) > 0;
          const underToast = [...document.querySelectorAll('[data-testid="mini-player-gesture-surface"] :is(button, [data-testid="mini-player-swipe-origin"])')]
            .filter(control => overlaps(control.getBoundingClientRect()))
            .map(control => control.getAttribute('aria-label') ?? control.getAttribute('data-testid'));
          return { toast: { top: toast.top, bottom: toast.bottom, left: toast.left, right: toast.right }, videoTop: iframe.top, overVideo: overlaps(iframe), underToast };
        }, MINI_PLAYER_IFRAMES);
        assert(boxes.toast.top >= 0 && !boxes.overVideo && (size[0] >= 1024 || boxes.toast.bottom <= boxes.videoTop),
          `${label}: the toast is off screen or over the video ${JSON.stringify(boxes)}`);
        assert(boxes.underToast.length === 0, `${label}: the toast covers the mini player's controls ${JSON.stringify(boxes)}`);
      } finally {
        await context.close();
      }
    }
    console.log(`PASS toast on screen, clear of the corner mini player and its controls at ${toastSizes.map(size => size.join('x')).join(', ')} (${layout ?? 'standard'} layout)`);
  }

  // The song page's video frame is at least 200px tall on a 320px phone, in both layouts.
  for (const layout of [null, 'music']) {
    const song = sizeSong(983003);
    const { context, page } = await openMiniPlayerPage([320, 568], { song, layout });
    try {
      await page.goto(new URL(`watch?v=${song.id}`, baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForFunction(() => {
        const container = document.querySelector('[data-testid="global-player"]');
        return container?.style.position === 'absolute' && container.querySelector('iframe');
      }, { timeout: 30_000 });
      const frame = await page.evaluate(() => {
        const box = document.querySelector('[data-testid="global-player"] iframe').getBoundingClientRect();
        return { width: box.width, height: box.height };
      });
      assert(frame.width >= 199.5 && frame.height >= 199.5, `Song page frame under 200×200 at 320x568 (${layout ?? 'standard'}): ${JSON.stringify(frame)}`);
    } finally {
      await context.close();
    }
    console.log(`PASS song page frame ≥200px tall at 320x568 (${layout ?? 'standard'} layout)`);
  }
} finally {
  await browser.close();
}
