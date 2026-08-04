import puppeteer from 'puppeteer';

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:4173/diva-player/');
const playlistUrl = new URL('playlists', baseUrl);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createSong(index) {
  return {
    id: 910000 + index,
    name: index === 173 ? '特別な検索対象曲' : `Playlist fixture ${String(index + 1).padStart(3, '0')}`,
    defaultName: `Playlist fixture ${index + 1}`,
    defaultNameLanguage: 'English',
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
  }, [largePlaylist, smartPlaylist, syncedPlaylist], [{
    id: 'folder-discovery',
    name: '発掘用',
    createdAt: now,
    updatedAt: now,
  }]);
}

async function openPlaylist(page) {
  await page.waitForSelector('aside[aria-label="プレイリストライブラリ"]', { visible: true });
  await page.waitForFunction(name => [...document.querySelectorAll('button')].some(button => button.textContent?.includes(name)), {}, largePlaylist.name);
  await page.evaluate(name => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes(name));
    if (!(button instanceof HTMLButtonElement)) throw new Error('large playlist button not found');
    button.click();
  }, largePlaylist.name);
  await page.waitForSelector('h1');
  await page.waitForFunction(name => document.querySelector('h1')?.textContent?.includes(name), {}, largePlaylist.name);
}

async function runDesktop(page) {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const response = await page.goto(playlistUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert(response && response.status() < 400, `playlist page returned ${response?.status() ?? 'unknown'}`);
  await page.waitForSelector('aside[aria-label="プレイリストライブラリ"]', { visible: true });

  const library = await page.$eval('aside[aria-label="プレイリストライブラリ"]', element => ({
    text: element.textContent ?? '',
    width: element.getBoundingClientRect().width,
    scopeButtons: [...element.querySelectorAll('button[aria-pressed]')].map(button => button.textContent?.trim()),
  }));
  assert(library.width >= 320, `desktop library is too narrow: ${library.width}`);
  assert(library.text.includes('保存曲') && library.text.includes('同期中'), 'library overview is missing');
  assert(library.scopeButtons.some(label => label === 'スマート') && library.scopeButtons.some(label => label === '同期中'), 'library scope controls are missing');

  await openPlaylist(page);
  await page.waitForFunction(() => document.body.textContent?.includes('仮想スクロールを使用'));
  const desktopLayout = await page.evaluate(() => {
    const heading = document.querySelector('h1');
    const toolbar = document.querySelector('input[placeholder="曲名・アーティストを検索"]')?.closest('.sticky');
    const rows = [...document.querySelectorAll('button')].filter(button => button.textContent?.includes('Playlist fixture'));
    return {
      headingSize: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0,
      toolbarVisible: Boolean(toolbar && toolbar.getBoundingClientRect().height > 0),
      renderedRows: rows.length,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  assert(desktopLayout.headingSize >= 36, `playlist hero heading is too small: ${desktopLayout.headingSize}`);
  assert(desktopLayout.toolbarVisible, 'playlist toolbar is not visible');
  assert(desktopLayout.renderedRows < largePlaylist.songs.length, `virtual list rendered every row: ${desktopLayout.renderedRows}`);
  assert(desktopLayout.overflow <= 1, `desktop layout overflows horizontally by ${desktopLayout.overflow}px`);

  const search = 'input[placeholder="曲名・アーティストを検索"]';
  await page.type(search, '特別な検索対象曲');
  await page.waitForFunction(() => document.body.textContent?.includes('1 / 240曲を表示'));
  assert(await page.$eval('body', body => body.textContent?.includes('検索対象プロデューサー') ?? false), 'playlist search did not render the matching song');
  console.log('PASS refreshed desktop playlist library, hero, toolbar, and virtualized 240-song list');
}

async function runMobile(page) {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto(playlistUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await openPlaylist(page);

  const mobileLayout = await page.evaluate(() => {
    const library = document.querySelector('aside[aria-label="プレイリストライブラリ"]');
    const playButton = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '再生');
    const backButton = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('← ライブラリ'));
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
  assert(mobileLayout.playWidth >= 44 && mobileLayout.playHeight >= 44, `mobile play target is too small: ${JSON.stringify(mobileLayout)}`);
  assert(mobileLayout.backVisible, 'mobile library back action is missing');
  assert(mobileLayout.overflow <= 1, `mobile layout overflows horizontally by ${mobileLayout.overflow}px`);

  await page.evaluate(() => {
    const backButton = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('← ライブラリ'));
    if (!(backButton instanceof HTMLButtonElement)) throw new Error('library back button not found');
    backButton.click();
  });
  await page.waitForSelector('aside[aria-label="プレイリストライブラリ"]', { visible: true });
  console.log('PASS refreshed 390px playlist detail navigation and touch targets');
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  await installFixtures(page);
  await runDesktop(page);
  await runMobile(page);
  console.log('Playlist management browser E2E test passed.');
} finally {
  await browser.close();
}
