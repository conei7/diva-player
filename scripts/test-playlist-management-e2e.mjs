import puppeteer from 'puppeteer';
import { pinAppLanguage } from './pin-app-language.mjs';

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:4173/diva-player/');
const playlistUrl = new URL('playlists', baseUrl);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createSong(index) {
  const defaultName = index === 173 ? '特別な検索対象曲' : `Playlist fixture ${String(index + 1).padStart(3, '0')}`;
  return {
    id: 910000 + index,
    name: index === 0 ? 'プレイリスト旧表記001' : defaultName,
    defaultName,
    defaultNameLanguage: index === 173 ? 'Japanese' : 'English',
    artistString: index === 173 ? '検索対象プロデューサー' : `Producer ${index % 12}`,
    createDate: '2026-01-01T00:00:00Z',
    publishDate: `2025-${String((index % 12) + 1).padStart(2, '0')}-01T00:00:00Z`,
    favoritedTimes: index,
    lengthSeconds: 120 + (index % 180),
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    pvs: [{
      author: '', disabled: false, id: 920000 + index, length: 180,
      name: 'fixture', pvId: `playlist-fixture-${index}`, service: 'Youtube',
      pvType: 'Original', url: `https://youtu.be/playlist-fixture-${index}`,
    }],
  };
}

const now = Date.now();
const largePlaylist = {
  id: 'playlist-management-large',
  name: '240曲の発掘ライブラリ',
  description: '大量の曲でも検索・選択・並べ替えを快適に扱うための確認用プレイリスト',
  songs: Array.from({ length: 240 }, (_, index) => createSong(index)),
  folderId: 'folder-discovery',
  createdAt: now - 30_000,
  updatedAt: now,
};
const smartPlaylist = {
  id: 'playlist-management-smart',
  name: '最近の人気曲',
  songs: [createSong(0), createSong(1)],
  createdAt: now - 20_000,
  updatedAt: now - 10_000,
  smartRule: {
    minYoutubeViews: 1000,
    minNicoViews: 0,
    excludedSongTypes: [],
    maxSongs: 50,
    sortBy: 'YoutubeViews',
  },
};
const syncedPlaylist = {
  id: 'playlist-management-synced',
  name: '外部同期コレクション',
  songs: [createSong(2)],
  createdAt: now - 10_000,
  updatedAt: now - 5_000,
  nicoSync: {
    sourceKind: 'mylist',
    sourceId: '12345',
    sourceUrl: 'https://www.nicovideo.jp/mylist/12345',
    enabled: true,
    intervalHours: 24,
    lastStatus: 'success',
    lastSuccessfulAt: now,
  },
};

async function installFixtures(page) {
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().includes('/backend-api/api/ready') || request.url().includes('/backend-api/api/health')) {
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ready', postgres: true, qdrant: true }) });
      return;
    }
    void request.continue();
  });
  await page.evaluateOnNewDocument((playlists, folders) => {
    localStorage.setItem('diva_playlists', JSON.stringify(playlists));
    localStorage.setItem('diva_playlistFolders', JSON.stringify(folders));
  }, [largePlaylist, smartPlaylist, syncedPlaylist, ...Array.from({ length: 40 }, (_, index) => ({
    ...largePlaylist, id: `library-scroll-${index}`, name: `一覧スクロール確認 ${String(index).padStart(2, '0')}`, songs: [],
  }))], [{
    id: 'folder-discovery',
    name: '発掘用',
    createdAt: now,
    updatedAt: now,
  }]);
}

const LIBRARY = 'section[data-testid="playlist-library"][aria-label="プレイリストライブラリ"]';
const SEARCH_LABEL = 'プレイリスト内を検索';

async function openPlaylist(page) {
  await page.waitForSelector(LIBRARY, { visible: true });
  await page.waitForFunction(name => [...document.querySelectorAll('[data-testid="playlist-card"] a')].some(link => link.textContent?.includes(name)), {}, largePlaylist.name);
  await page.evaluate(name => {
    const link = [...document.querySelectorAll('[data-testid="playlist-card"] a')].find(item => item.textContent?.includes(name));
    if (!(link instanceof HTMLAnchorElement)) throw new Error('large playlist card not found');
    link.click();
  }, largePlaylist.name);
  // The open playlist lives in the URL (/playlists?list=<id>).
  await page.waitForFunction(id => new URL(location.href).searchParams.get('list') === id, {}, largePlaylist.id);
  await page.waitForFunction(name => document.querySelector('main section h1')?.textContent?.includes(name), {}, largePlaylist.name);
}

async function runDesktop(page) {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const response = await page.goto(playlistUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert(response && response.status() < 400, `playlist page returned ${response?.status() ?? 'unknown'}`);
  await page.waitForSelector(LIBRARY, { visible: true });

  const library = await page.$eval(LIBRARY, element => ({
    cards: element.querySelectorAll('[data-testid="playlist-card"]').length,
    scopeButtons: [...element.querySelectorAll('button[aria-pressed]')].map(button => button.textContent?.trim()),
    nestedAside: Boolean(document.querySelector('main aside')),
  }));
  assert(library.cards >= 3, `library cards are missing: ${library.cards}`);
  assert(!library.nestedAside, 'the old second sidebar is still rendered');
  assert(library.scopeButtons.some(label => label === 'スマート') && library.scopeButtons.some(label => label === '同期'), `library filter chips are missing: ${JSON.stringify(library.scopeButtons)}`);

  await openPlaylist(page);
  await page.waitForFunction(() => document.body.textContent?.includes('Playlist fixture 001'));
  assert(!await page.$eval('body', body => body.textContent?.includes('プレイリスト旧表記001')), 'saved playlist did not use the default song name');
  const desktopLayout = await page.evaluate(() => {
    const heading = document.querySelector('main section h1');
    const toolbar = document.querySelector('[data-testid="playlist-list-header"]');
    const rows = document.querySelectorAll('[data-testid="playlist-song-row"]');
    return {
      headingSize: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0,
      toolbarVisible: Boolean(toolbar && toolbar.getBoundingClientRect().height > 0 && getComputedStyle(toolbar).position === 'sticky'),
      renderedRows: rows.length,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  assert(desktopLayout.headingSize >= 28, `playlist hero heading is too small: ${desktopLayout.headingSize}`);
  assert(desktopLayout.toolbarVisible, 'sticky playlist list header is not visible');
  assert(desktopLayout.renderedRows > 0, 'virtual list rendered no rows');
  assert(desktopLayout.renderedRows < largePlaylist.songs.length, `virtual list rendered every row: ${desktopLayout.renderedRows}`);
  assert(desktopLayout.overflow <= 1, `desktop layout overflows horizontally by ${desktopLayout.overflow}px`);

  await page.click(`[data-testid="playlist-list-header"] button[aria-label="${SEARCH_LABEL}"]`);
  const search = `[data-testid="playlist-list-header"] input[aria-label="${SEARCH_LABEL}"]`;
  await page.waitForSelector(search, { visible: true });
  await page.type(search, '特別な検索対象曲');
  await page.waitForFunction(() => document.body.textContent?.includes('1 / 240曲を表示'));
  assert(await page.$eval('body', body => body.textContent?.includes('検索対象プロデューサー') ?? false), 'playlist search did not render the matching song');
  console.log('PASS desktop playlist library grid, detail URL, hero, sticky list header, and virtualized 240-song list');
}

async function runMobile(page) {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto(playlistUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await openPlaylist(page);

  const mobileLayout = await page.evaluate(() => {
    const library = document.querySelector('[data-testid="playlist-library"]');
    const playButton = [...document.querySelectorAll('main section button')].find(button => button.textContent?.trim() === 'すべて再生');
    const backButton = document.querySelector('main button[aria-label="プレイリスト一覧に戻る"]');
    const playRect = playButton?.getBoundingClientRect();
    return {
      libraryVisible: Boolean(library && getComputedStyle(library).display !== 'none'),
      playWidth: playRect?.width ?? 0,
      playHeight: playRect?.height ?? 0,
      backVisible: Boolean(backButton && backButton.getBoundingClientRect().height > 0),
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  assert(!mobileLayout.libraryVisible, 'mobile library should be hidden while viewing playlist details');
  // Button lg (40px) is the large button of the design system (DESIGN_SPEC §3.4).
  assert(mobileLayout.playWidth >= 40 && mobileLayout.playHeight >= 40, `mobile play target is too small: ${JSON.stringify(mobileLayout)}`);
  assert(mobileLayout.backVisible, 'mobile library back action is missing');
  assert(mobileLayout.overflow <= 1, `mobile layout overflows horizontally by ${mobileLayout.overflow}px`);

  const virtualScroll = await page.evaluate(() => {
    const heading = document.querySelector('main section h1');
    const detail = heading.closest('main');
    const nestedScrollers = [...detail.querySelectorAll('*')].filter(element => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1);
    return { count: nestedScrollers.length, height: document.documentElement.scrollHeight };
  });
  assert(virtualScroll.count === 0 && virtualScroll.height > 844, `mobile songs trapped in nested scroll: ${JSON.stringify(virtualScroll)}`);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForFunction(() => document.body.textContent.includes('Playlist fixture 240'));
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.click('main button[aria-label="プレイリスト一覧に戻る"]');
  await page.waitForSelector(LIBRARY, { visible: true });
  const libraryScroll = await page.$eval(LIBRARY, element => {
    const scrollers = [element, ...element.querySelectorAll('*')].filter(item => ['auto', 'scroll'].includes(getComputedStyle(item).overflowY) && item.scrollHeight > item.clientHeight + 1);
    return { nestedScrollers: scrollers.length, bottom: element.getBoundingClientRect().bottom + scrollY, pageHeight: document.documentElement.scrollHeight };
  });
  assert(libraryScroll.nestedScrollers === 0 && libraryScroll.bottom <= libraryScroll.pageHeight, `mobile library is boxed or clipped: ${JSON.stringify(libraryScroll)}`);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await new Promise(resolve => setTimeout(resolve, 300));
  const lastPlaylist = await page.evaluate(() => {
    const card = [...document.querySelectorAll('[data-testid="playlist-card"]')].find(item => item.textContent?.includes('一覧スクロール確認 39'));
    const rect = card?.getBoundingClientRect();
    // A bar fixed at the bottom (the phone navigation) must not cover the last row.
    const bottomBar = [...document.querySelectorAll('nav')].find(item => {
      const box = item.getBoundingClientRect();
      return getComputedStyle(item).position === 'fixed' && box.height > 0 && box.bottom >= innerHeight - 1 && box.top > innerHeight / 2;
    });
    return { top: rect?.top, bottom: rect?.bottom, headerBottom: document.querySelector('header').getBoundingClientRect().bottom, visibleBottom: bottomBar ? bottomBar.getBoundingClientRect().top : innerHeight };
  });
  assert(lastPlaylist.top >= lastPlaylist.headerBottom && lastPlaylist.bottom <= lastPlaylist.visibleBottom + 1, `last playlist cannot be reached by page scroll: ${JSON.stringify(lastPlaylist)}`);
  console.log('PASS 390px playlist detail, back navigation, window scrolling, and touch targets');
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=ja-JP'] });
try {
  const page = await browser.newPage();
  await pinAppLanguage(page);
  page.setDefaultTimeout(30_000);
  await installFixtures(page);
  await runDesktop(page);
  await runMobile(page);
  console.log('Playlist management browser E2E test passed.');
} finally {
  await browser.close();
}
