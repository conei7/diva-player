import { installSavedLibraryReader } from './saved-library-fixture.mjs';
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = process.argv[2] || 'https://diva-player.pages.dev/';
const base = new URL(baseUrl);
const normalizePath = path => path.replace(/\/+$/, '') || '/';
const expectedRoot = normalizePath(new URL(base.pathname, base.origin).pathname);
const expectedWatch = normalizePath(new URL('watch', base).pathname);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=en-US'] });

// The shell/navigation assertions must be reproducible on pull requests and
// should not depend on VocaDB or the SBC being reachable from a GitHub runner.
// Keep the browser flow real, but provide a small API fixture at the network
// boundary so API outages are covered by the dedicated contract tests instead
// of making this UI smoke test flaky.
const fixtureProducer = {
  id: 424242,
  artistType: 'Producer',
  name: 'DIVA E2E Producer',
  additionalNames: '',
  deleted: false,
  releaseDate: '2020-01-01T00:00:00Z',
  status: 'Finished',
  version: 1,
};
const fixtureProducers = [
  fixtureProducer,
  ...[2, 3, 4].map(index => ({
    ...fixtureProducer,
    id: fixtureProducer.id + index,
    name: `DIVA E2E Producer ${index}`,
  })),
];
const fixtureVocalist = {
  id: 424243,
  artistType: 'Vocaloid',
  name: 'DIVA E2E Vocalist',
  additionalNames: '',
  deleted: false,
  releaseDate: '2020-01-01T00:00:00Z',
  status: 'Finished',
  version: 1,
};
const fixturePv = {
  author: 'DIVA E2E',
  disabled: false,
  id: 424242,
  length: 180,
  name: 'DIVA E2E PV',
  publishDate: '2020-01-01T00:00:00Z',
  pvId: 'dQw4w9WgXcQ',
  service: 'Youtube',
  pvType: 'Original',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  description: 'DIVA E2E description\\nhttps://example.com/diva-e2e',
};
const fixtureNicoPv = {
  ...fixturePv,
  id: fixturePv.id + 1,
  name: 'DIVA E2E Nico PV',
  pvId: 'sm9',
  service: 'NicoNicoDouga',
  url: 'https://www.nicovideo.jp/watch/sm9',
};
const fixtureSong = {
  artists: [
    ...fixtureProducers.map(producer => ({
      artist: producer,
      categories: 'Producer',
      effectiveRoles: 'Producer',
      id: producer.id,
      isCustomName: false,
      isSupport: false,
      name: producer.name,
      roles: 'Producer',
    })),
    {
      artist: fixtureVocalist,
      categories: 'Vocalist',
      effectiveRoles: 'Vocalist',
      id: fixtureVocalist.id,
      isCustomName: false,
      isSupport: false,
      name: fixtureVocalist.name,
      roles: 'Vocalist',
    },
  ],
  artistString: fixtureProducer.name,
  createDate: '2020-01-01T00:00:00Z',
  defaultName: 'DIVA E2E Song',
  defaultNameLanguage: 'Japanese',
  favoritedTimes: 42,
  id: 1501,
  lengthSeconds: 180,
  name: 'DIVA E2E Song',
  publishDate: '2020-01-01T00:00:00Z',
  pvs: [fixturePv, fixtureNicoPv],
  pvServices: 'Youtube,NicoNicoDouga',
  ratingScore: 5,
  songType: 'Original',
  status: 'Finished',
  tags: [],
  thumbUrl: '',
  version: 1,
  youtubeViews: 1234,
  nicoViews: 567,
};
const fixtureHomeSong = {
  ...fixtureSong,
  id: 1502,
  name: 'DIVA E2E Home Song',
  defaultName: 'DIVA E2E Home Song',
};
const fixtureHomeSongs = [
  fixtureHomeSong,
  ...[1503, 1504, 1505, 1506].map(id => ({
    ...fixtureHomeSong,
    id,
    name: `DIVA E2E Home Song ${id}`,
    defaultName: `DIVA E2E Home Song ${id}`,
  })),
];
const fixtureSongs = [fixtureSong, fixtureHomeSong];
const fixtureResponse = (body, contentType = 'application/json') => ({
  status: 200,
  headers: {
    'access-control-allow-origin': '*',
    'content-type': contentType,
  },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/** `songs`: more songs by id; `external`: a stubbed response for another host (else the network). */
async function installApiFixtures(page, homeSongs = fixtureHomeSongs, recommendationSongs = [], { songs = [], external } = {}) {
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    const path = url.pathname;
    const isBackend = path.startsWith('/backend-api/');
    const isVocaDb = url.hostname === 'vocadb.net';
    if (!isBackend && !isVocaDb) {
      const stub = external?.(url);
      if (stub) void request.respond(stub);
      else void request.continue();
      return;
    }

    let response = null;
    if (path.endsWith('/api/health') || path.endsWith('/api/ready')) {
      response = fixtureResponse({ status: path.endsWith('/api/ready') ? 'ready' : 'ok', postgres: true, qdrant: true });
    } else if (path.endsWith('/api/songs/views')) {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      response = fixtureResponse(Object.fromEntries(ids.map(id => [id, { youtubeViews: 1234, nicoViews: 567 }])));
    } else if (path.endsWith('/api/recommend/dig')) {
      response = fixtureResponse({ items: fixtureSongs, totalCount: fixtureSongs.length });
    } else if (path.includes('/api/recommend')) {
      response = fixtureResponse({
        items: recommendationSongs.map(song => ({ songId: song.id, score: 1 })),
        cards: recommendationSongs,
      });
    } else if (path.includes('/api/songs/search')) {
      const isRecommendedHomeFeed = url.searchParams.get('sort') === 'FavoritedTimes'
        && url.searchParams.get('discoveryOnly') === 'true'
        && !url.searchParams.has('query')
        && !url.searchParams.has('artistIds')
        && !url.searchParams.has('anyArtistIds');
      const items = isRecommendedHomeFeed ? homeSongs : fixtureSongs;
      response = fixtureResponse({ items, totalCount: items.length });
    } else if (isVocaDb && url.searchParams.get('fields') === 'Albums') {
      response = fixtureResponse({ albums: path.endsWith('/1501') ? [
        { id: 901, name: 'DIVA E2E Album' },
        { id: 902, name: 'DIVA E2E Second Album' },
      ] : [] });
    } else if (isVocaDb && path === '/api/albums/901/tracks') {
      response = fixtureResponse([
        { songId: 1502, discNumber: 1, trackNumber: 2 },
        { songId: 1501, discNumber: 1, trackNumber: 1 },
      ]);
    } else if (isVocaDb && path === '/api/albums/901') {
      response = fixtureResponse({ id: 901, name: 'DIVA E2E Album' });
    } else if (path.match(/\/api\/songs\/\d+$/)) {
      response = fixtureResponse(songs.find(song => path.endsWith(`/${song.id}`))
        ?? (path.endsWith('/1502') ? fixtureHomeSong : fixtureSong));
    } else if (isVocaDb && path.match(/\/api\/songs$/)) {
      response = fixtureResponse({ items: fixtureSongs, term: url.searchParams.get('query') ?? '', totalCount: fixtureSongs.length });
    } else if (isVocaDb && path.startsWith('/api/songs/')) {
      // Trending/related VocaDB endpoints return a plain song array.
      response = fixtureResponse(fixtureSongs);
    } else if (path.includes('/api/songs/') && path.endsWith('/history')) {
      response = fixtureResponse({ items: [] });
    }

    if (response) {
      void request.respond(response);
    } else {
      // Unknown API calls are nonessential to this shell test; returning a
      // controlled 404 avoids waiting on an unavailable external service.
      void request.respond({ status: 404, headers: { 'content-type': 'application/json' }, body: '{}' });
    }
  });
}

async function pinAppLanguage(page, language = 'en') {
  await page.evaluateOnNewDocument(value => {
    localStorage.setItem('diva_uiLanguage', JSON.stringify(value));
  }, language);
}

try {
  const page = await browser.newPage();
  await installSavedLibraryReader(page);
  await page.setViewport({ width: 1440, height: 900 });
  await installApiFixtures(page);
  await page.goto(new URL('watch?v=1501', base), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const detectedLanguage = await page.evaluate(() => {
    const languages = [...(navigator.languages ?? []), navigator.language];
    return languages.some(language => /^ja(?:-|$)/i.test(language)) ? 'ja' : 'en';
  });
  await page.waitForFunction(expected => document.documentElement.lang === expected, {}, detectedLanguage);
  const initialLanguage = await page.evaluate(() => document.documentElement.lang);
  if (initialLanguage !== detectedLanguage) {
    throw new Error(`Browser language detection mismatch: ${initialLanguage} !== ${detectedLanguage}`);
  }
  if (initialLanguage === 'ja') {
    // The display language lives in the top bar's ⋮ menu (MenuLabel 表示言語 + radios).
    await page.click('header button[aria-label="その他の操作"]');
    await page.waitForSelector('[role="menu"] [role="menuitemradio"]', { timeout: 10_000 });
    await page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitemradio"]')]
      .find(item => item.textContent?.trim() === 'English')?.click());
  }
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.waitForSelector('header button[aria-label="More actions"]', { timeout: 60_000 });
  await page.waitForSelector('button[aria-label="Share"]', { timeout: 60_000 });
  // With several producers the favorite-producer pill opens a menu with one item per producer.
  await page.click('[data-testid="watch-favorite-producer-pill"]');
  await page.waitForSelector('[role="menu"] .watch-favorite-producer-button', { timeout: 10_000 });
  const englishWatch = await page.evaluate(() => ({
    shareButton: [...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Share'),
    starRating: document.querySelector('[role="group"][aria-label="Star rating"]') !== null,
    favoriteProducerButton: [...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Add DIVA E2E Producer to favorite producers'),
    recommendationTab: [...document.querySelectorAll('button')].some(button => button.textContent?.includes('For you')),
    sourceSelector: document.querySelector('select[aria-label="Select playback source"]') !== null,
  }));
  if (!englishWatch.shareButton || !englishWatch.starRating || !englishWatch.favoriteProducerButton || !englishWatch.recommendationTab || !englishWatch.sourceSelector) {
    throw new Error(`English watch interface is incomplete: ${JSON.stringify(englishWatch)}`);
  }
  await page.keyboard.press('Escape');
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.body.innerText.includes('For you'));
  const englishShell = await page.evaluate(() => ({
    language: document.documentElement.lang,
    searchPlaceholder: document.querySelector('input[placeholder="Search songs & producers"]') !== null,
    soundMap: document.body.innerText.includes('Sound map'),
  }));
  if (englishShell.language !== 'en' || !englishShell.searchPlaceholder || !englishShell.soundMap) {
    throw new Error(`English language switch did not update the discovery shell: ${JSON.stringify(englishShell)}`);
  }
  await page.click('button[aria-label="Advanced search"]');
  await page.waitForFunction(() => document.querySelector('button[aria-label="Advanced search"]')?.getAttribute('aria-pressed') === 'true');
  await page.waitForSelector('[data-testid="advanced-search-dialog"] .filter-section-header', { timeout: 10_000 });
  const advancedSearchEnglish = await page.$eval('[data-testid="advanced-search-dialog"]', dialog => dialog.innerText);
  if (!advancedSearchEnglish.includes('Early Vocaloid era')
    || !advancedSearchEnglish.includes('Release year & length')
    || !advancedSearchEnglish.includes('Views & favorites')
    || !advancedSearchEnglish.includes('Apply')) {
    throw new Error(`Advanced-search filters are not translated: ${advancedSearchEnglish.slice(0, 500)}`);
  }
  const filterSections = await page.$$('button.filter-section-header');
  const audioSectionIndex = (await Promise.all(filterSections.map(button => button.evaluate(element => element.textContent))))
    .findIndex(text => text?.includes('Audio-based estimates'));
  if (audioSectionIndex < 0) throw new Error('English audio-filter section is missing');
  await filterSections[audioSectionIndex].click();
  await page.waitForFunction(() => document.body.innerText.includes('Electric piano'));
  await page.click('[data-testid="advanced-search-dialog"] button[aria-label="Close"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="advanced-search-dialog"]'));
  const homeSongMenu = 'button[aria-label="More actions for “DIVA E2E Home Song”"]';
  await page.waitForSelector(homeSongMenu, { timeout: 30_000 });
  const homeSongMenuLocator = page.locator(homeSongMenu);
  await homeSongMenuLocator.hover();
  await homeSongMenuLocator.click();
  await page.waitForSelector('[role="menu"]', { timeout: 10_000 });
  const songMenuEnglish = await page.$eval('[role="menu"]', menu => menu.innerText);
  if (!songMenuEnglish.includes('Save to Listen later')
    || !songMenuEnglish.includes('Save to playlist')
    || !songMenuEnglish.includes('Share')
    || !songMenuEnglish.includes('Hide')) {
    throw new Error(`Song-card menu is not translated: ${songMenuEnglish}`);
  }
  await page.keyboard.press('Escape');
  console.log('PASS English player controls, song-card menu, and advanced-search filters');
  await page.goto(new URL('playlists', base), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // The library's 「New」 menu: New playlist → dialog; Smart playlist → the rules dialog.
  const openNewMenuItem = async label => {
    await page.waitForSelector('section[aria-label="Playlist library"]', { timeout: 60_000 });
    await page.evaluate(() => [...document.querySelectorAll('section[aria-label="Playlist library"] button')].find(button => button.textContent?.trim() === 'New')?.click());
    await page.waitForSelector('[role="menu"]', { timeout: 60_000 });
    await page.evaluate(text => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(item => item.textContent?.trim() === text)?.click(), label);
  };
  await openNewMenuItem('New playlist');
  await page.waitForSelector('[role="dialog"] input[placeholder="Add a title"]', { timeout: 60_000 });
  await page.type('[role="dialog"] input[placeholder="Add a title"]', 'DIVA English UI E2E');
  await page.click('button[aria-label="Create playlist"]');
  await page.waitForFunction(() => document.querySelector('main section h1')?.textContent === 'DIVA English UI E2E');
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await openNewMenuItem('Smart playlist');
  await page.waitForSelector('[role="dialog"] h2', { timeout: 60_000 });
  const smartPlaylistEnglish = await page.$eval('[role="dialog"] h2', heading => heading.textContent);
  if (smartPlaylistEnglish !== 'New smart playlist') {
    throw new Error(`Smart-playlist dialog is not translated: ${smartPlaylistEnglish}`);
  }
  await page.click('[role="dialog"] button[aria-label="Close"]');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-modal="true"]'));
  await page.click('button[aria-label="Settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 60_000 });
  const settingsEnglish = await page.$eval('[role="dialog"][aria-label="Settings"]', dialog => dialog.innerText);
  if (!settingsEnglish.includes('Use filters') || !settingsEnglish.includes('General')) {
    throw new Error(`Settings dialog is not translated: ${settingsEnglish.slice(0, 300)}`);
  }
  await page.click('#settings-tab-data');
  await page.waitForSelector('#settings-panel-data', { timeout: 60_000 });
  const dataActionsEnglish = await page.$$eval('#settings-panel-data button', buttons => buttons.map(button => button.textContent?.trim()));
  if (!dataActionsEnglish.includes('Save backup') || !dataActionsEnglish.includes('Restore from file')) {
    throw new Error(`Backup actions are not translated: ${JSON.stringify(dataActionsEnglish)}`);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  console.log('PASS English playlist library, smart-playlist builder, and settings dialog');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('header button[aria-label="More actions"]', { timeout: 60_000 });
  await page.click('header button[aria-label="More actions"]');
  await page.waitForSelector('[role="menu"] [role="menuitemradio"]', { timeout: 10_000 });
  await page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitemradio"]')]
    .find(item => item.textContent?.trim() === '日本語')?.click());
  await page.waitForFunction(() => document.documentElement.lang === 'ja');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('header button[aria-label="その他の操作"]', { timeout: 60_000 });
  await page.goto(new URL('watch?v=1501', base), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('header button[aria-label="その他の操作"]', { timeout: 60_000 });
  console.log('PASS browser language detection, language switch, discovery translations, and persistence');
  await page.waitForSelector('a[aria-label="DIVA Player ホーム"]', { timeout: 60_000 });
  await page.waitForSelector('a[aria-label$="の曲を表示"]', { timeout: 60_000 });
  const producerHref = await page.$eval('a[aria-label$="の曲を表示"]', element => element.getAttribute('href'));
  if (!producerHref?.includes('artistId=') && !producerHref?.includes('?q=')) {
    throw new Error(`Watch-page producer is not a searchable link: ${producerHref}`);
  }
  await page.waitForSelector('[data-testid="watch-action-bar"] select[aria-label="再生PVを選択"]', { timeout: 60_000 });
  const compactWatchLayout = await page.$eval('[data-testid="watch-action-bar"]', actionBar => {
    const selector = actionBar.querySelector('select[aria-label="再生PVを選択"]');
    const info = document.querySelector('[data-testid="watch-video-info"]');
    return {
      optionCount: selector?.querySelectorAll('option').length ?? 0,
      selectorInActionBar: Boolean(selector),
      selectorStillInInfo: Boolean(info?.querySelector('select[aria-label="再生PVを選択"]')),
      actionBarWidth: actionBar.getBoundingClientRect().width,
      actionBarScrollWidth: actionBar.scrollWidth,
    };
  });
  if (!compactWatchLayout.selectorInActionBar
    || compactWatchLayout.selectorStillInInfo
    || compactWatchLayout.optionCount !== 2
    || compactWatchLayout.actionBarScrollWidth > compactWatchLayout.actionBarWidth + 1) {
    throw new Error(`Unexpected watch action layout: ${JSON.stringify(compactWatchLayout)}`);
  }
  await page.waitForSelector('button[aria-label="他1名のPを表示"]');
  const producerLinks = 'a[aria-label$="の曲を表示"]';
  const collapsedProducerLinks = await page.$$eval(`#watch-producer-list ${producerLinks}`, links => links.length);
  if (collapsedProducerLinks !== 3) throw new Error(`Expected 3 collapsed producers, got ${collapsedProducerLinks}`);
  await page.click('button[aria-label="他1名のPを表示"]');
  await page.waitForSelector('button[aria-label="P一覧を折りたたむ"]');
  const expandedProducerLinks = await page.$$eval(`#watch-producer-list ${producerLinks}`, links => links.length);
  if (expandedProducerLinks !== 4) throw new Error(`Expected 4 expanded producers, got ${expandedProducerLinks}`);
  await page.click('button[aria-label="P一覧を折りたたむ"]');
  await page.waitForSelector('button[aria-label="他1名のPを表示"]');
  // One favorite-producer toggle per producer, in the menu of the お気に入りP pill.
  await page.click('[data-testid="watch-favorite-producer-pill"]');
  await page.waitForSelector('[role="menu"] .watch-favorite-producer-button');
  const favoriteProducerItems = await page.$$eval('[role="menu"] .watch-favorite-producer-button', items => items.length);
  if (favoriteProducerItems !== 4) throw new Error(`Expected 4 favorite-producer items, got ${favoriteProducerItems}`);
  await page.keyboard.press('Escape');
  console.log('PASS compact watch metadata, producer collapse, and action layout');
  await page.waitForSelector('button[aria-label="概要を展開する"]', { timeout: 60_000 });
  await page.click('button[aria-label="概要を展開する"]');
  await page.waitForSelector('button[aria-label="概要を折りたたむ"]', { timeout: 60_000 });
  const descriptionState = await page.$eval('[data-testid="watch-description"]', root => {
    const text = root.querySelector('p');
    text?.click();
    return {
      expanded: root.getAttribute('data-expanded'),
      whiteSpace: text ? getComputedStyle(text).whiteSpace : null,
      linkCount: root.querySelectorAll('p a[href^="http"]').length,
    };
  });
  if (descriptionState.expanded !== 'true' || descriptionState.whiteSpace !== 'pre-wrap') {
    throw new Error(`Unexpected description state: ${JSON.stringify(descriptionState)}`);
  }
  console.log(`PASS description expansion UX (${descriptionState.linkCount} inline links)`);
  // Albums are part of the expanded description.
  await page.waitForSelector('[data-testid="song-albums"] button[aria-label="「DIVA E2E Album」からプレイリストを作成"]');
  const albumSection = await page.$eval('[data-testid="song-albums"]', section => ({
    inDescription: Boolean(section.closest('[data-testid="watch-description"]')),
    inActions: Boolean(section.closest('[data-testid="watch-action-bar"]')),
    names: [...section.querySelectorAll('a')].map(link => link.textContent),
  }));
  if (!albumSection.inDescription || albumSection.inActions || albumSection.names.length !== 2) {
    throw new Error(`Unexpected album placement: ${JSON.stringify(albumSection)}`);
  }
  await page.click('[data-testid="song-albums"] button[aria-label="「DIVA E2E Album」からプレイリストを作成"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="toast-host"]')?.textContent?.includes('「DIVA E2E Album」を作成しました'));
  if (!await page.$('button[aria-label="概要を折りたたむ"]')) throw new Error('Album action unexpectedly collapsed the description');
  const albumPlaylist = await page.evaluate(async () => {
    const playlists = (await window.__readSavedPlaylists());
    return playlists?.find(playlist => playlist.name === 'DIVA E2E Album')?.songs.map(song => song.id);
  });
  if (JSON.stringify(albumPlaylist) !== '[1501,1502]') throw new Error(`Album track order was not preserved: ${JSON.stringify(albumPlaylist)}`);
  await page.setViewport({ width: 390, height: 844 });
  const albumOverflow = await page.$eval('[data-testid="song-albums"]', section => section.scrollWidth > section.clientWidth + 1);
  if (albumOverflow) throw new Error('Album rows overflow at 390px');
  await page.setViewport({ width: 1440, height: 900 });
  console.log('PASS album names and adjacent playlist actions in description, saved track order, and mobile layout');
  // The album toast stays at the bottom-left for 8 seconds (DESIGN_SPEC §4.8) and covers whatever is
  // under it, like YouTube's. After the viewport resize the collapse button can sit right there, so
  // bring it to the middle of the screen as a user would, and press it once nothing covers it. The
  // toast can still move after the resize (the 390px song page's scrolled-controls row lifted it and
  // goes away a few frames later), so wait for it to leave instead of trusting one hit test.
  const collapseDescription = 'button[aria-label="概要を折りたたむ"]';
  await page.waitForFunction(() => !document.querySelector('[data-testid="toast-host"]')?.textContent?.includes('「DIVA E2E Album」を作成しました'),
    { timeout: 20_000 });
  await page.$eval(collapseDescription, button => button.scrollIntoView({ block: 'center' }));
  await page.waitForFunction(selector => {
    const button = document.querySelector(selector);
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && button.contains(hit));
  }, { timeout: 15_000 }, collapseDescription);
  await page.click(collapseDescription);
  await page.waitForSelector('button[aria-label="概要を展開する"]', { timeout: 60_000 });
  const href = await page.$eval('a[aria-label="DIVA Player ホーム"]', element => element.getAttribute('href'));
  await page.click('a[aria-label="DIVA Player ホーム"]');
  await page.waitForFunction(path => (location.pathname.replace(/\/+$/, '') || '/') === path, {}, expectedRoot);
  if (normalizePath(href ?? '') !== expectedRoot) {
    throw new Error(`Unexpected home link href: ${href}; expected ${expectedRoot}`);
  }
  console.log(`PASS logo navigation (${href} -> ${expectedRoot})`);
  console.log(`PASS watch-page producer link (${producerHref})`);

  const searchInput = 'input[placeholder="ボカロP名や曲名で検索"]';
  await page.waitForSelector(searchInput, { timeout: 60_000 });
  // A new search opens its results at the top, also from a scrolled page (the fixture feed is
  // short, so the page is made taller for this check).
  await page.evaluate(() => {
    document.body.style.minHeight = '5000px';
    window.scrollTo(0, 1500);
  });
  await page.type(searchInput, '千本桜');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.textContent?.includes('検索結果'), { timeout: 60_000 });
  const searchScrollY = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => { document.body.style.minHeight = ''; });
  if (searchScrollY !== 0) throw new Error(`Search results did not open at the top: scrollY=${searchScrollY}`);
  await page.waitForFunction(() => document.title === '「千本桜」の検索結果 | DIVA Player', { timeout: 10_000 })
    .catch(async () => {
      throw new Error(`Search results tab title was not updated: ${await page.title()}`);
    });
  await page.click('a[aria-label="DIVA Player ホーム"]');
  await page.waitForFunction(() => {
    const activeCategory = document.querySelector('button[data-active="true"]');
    const input = document.querySelector('input[placeholder="ボカロP名や曲名で検索"]');
    return activeCategory?.textContent?.trim() === 'おすすめ'
      && input instanceof HTMLInputElement
      && input.value === '';
  }, { timeout: 60_000 });
  await page.waitForFunction(() => document.title === 'DIVA Player — ボカロミュージックプレイヤー', { timeout: 10_000 })
    .catch(async () => {
      throw new Error(`Home kept another tab title: ${await page.title()}`);
    });
  console.log('PASS search opens at the top with its own tab title, and its state resets on home navigation');

  // Use a fresh browser context so earlier smoke tests cannot leak their
  // persisted player queue or cross-tab playback ownership into this flow.
  const backContext = await browser.createBrowserContext();
  const backPage = await backContext.newPage();
  const backHistorySession = await backPage.createCDPSession();
  await backPage.setViewport({ width: 1440, height: 900 });
  await pinAppLanguage(backPage);
  await installSavedLibraryReader(backPage);
  await installApiFixtures(backPage);
  await backPage.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await backPage.waitForSelector('main a[href*="/watch?v=1502"]', { timeout: 60_000 });
  const homeHistoryLength = await backPage.evaluate(() => window.history.length);
  const homeMixIdsBeforeBack = await backPage.$$eval('main a[href*="/watch?v="]', links => [...new Set(
    links.map(link => new URL(link.href).searchParams.get('v')).filter(Boolean),
  )]);
  if (homeMixIdsBeforeBack.length < 3) {
    throw new Error(`Navigation fixture did not load enough home mix songs: ${JSON.stringify(homeMixIdsBeforeBack)}`);
  }
  await backPage.evaluate(() => window.__DIVA_PERFORMANCE__?.clear());
  await backPage.click('main a[href*="/watch?v=1502"]');
  await backPage.waitForFunction(path => (location.pathname.replace(/\/+$/, '') || '/') === path, { timeout: 60_000 }, expectedWatch);
  if (new URL(backPage.url()).searchParams.get('autoplay') === '0') {
    throw new Error('A same-tab Home song click suppressed the playback intent.');
  }
  const watchHistoryLength = await backPage.evaluate(() => window.history.length);
  if (watchHistoryLength !== homeHistoryLength + 1) {
    const browserHistoryAfterOpen = await backHistorySession.send('Page.getNavigationHistory');
    throw new Error(`Opening a Home song did not add exactly one browser history entry: ${JSON.stringify({
      before: homeHistoryLength,
      after: watchHistoryLength,
      url: backPage.url(),
      browserHistory: browserHistoryAfterOpen.entries.map(({ url, title }) => ({ url, title })),
    })}`);
  }
  const browserHistoryBeforeBack = await backHistorySession.send('Page.getNavigationHistory');
  await backPage.evaluate(() => {
    window.__DIVA_NAV_HISTORY_EVENTS__ = [];
    window.addEventListener('popstate', () => {
      window.__DIVA_NAV_HISTORY_EVENTS__.push({ href: location.href, state: history.state });
    });
  });
  // Drive the browser's actual session-history traversal and let the SPA
  // handle the resulting popstate, as it does for the browser Back button.
  await backPage.evaluate(() => window.history.back());
  try {
    await backPage.waitForFunction(path => (location.pathname.replace(/\/+$/, '') || '/') === path, { timeout: 15_000 }, expectedRoot);
  } catch {
    const [backState, browserHistoryAfterBack] = await Promise.all([
      backPage.evaluate(() => ({
        href: location.href,
        historyLength: window.history.length,
        historyState: window.history.state,
        popstateEvents: window.__DIVA_NAV_HISTORY_EVENTS__,
      })),
      backHistorySession.send('Page.getNavigationHistory'),
    ]);
    const summarizeHistory = history => ({
      currentIndex: history.currentIndex,
      entries: history.entries.map(({ url, title }) => ({ url, title })),
    });
    throw new Error(`Browser Back did not restore Home: ${JSON.stringify({
      ...backState,
      browserHistoryBeforeBack: summarizeHistory(browserHistoryBeforeBack),
      browserHistoryAfterBack: summarizeHistory(browserHistoryAfterBack),
    })}`);
  }
  await backHistorySession.detach();
  await backPage.waitForSelector('main a[href*="/watch?v=1502"]', { timeout: 60_000 });
  const homeMixIdsAfterBack = await backPage.$$eval('main a[href*="/watch?v="]', links => [...new Set(
    links.map(link => new URL(link.href).searchParams.get('v')).filter(Boolean),
  )]);
  const retainedMixIds = homeMixIdsBeforeBack.filter(id => id !== '1502');
  const retainedMixIdsAfterBack = homeMixIdsAfterBack.filter(id => retainedMixIds.includes(id));
  const repeatedHomeLoads = await backPage.evaluate(() => window.__DIVA_PERFORMANCE__
    ?.getMetrics().filter(metric => metric.name === 'home.load').length ?? 0);
  if (JSON.stringify(retainedMixIdsAfterBack) !== JSON.stringify(retainedMixIds) || repeatedHomeLoads !== 0) {
    throw new Error(`Back regenerated the home mix: before=${JSON.stringify(homeMixIdsBeforeBack)}, after=${JSON.stringify(homeMixIdsAfterBack)}, homeLoads=${repeatedHomeLoads}`);
  }
  console.log(`PASS browser Back restores home mix order without regenerating (${retainedMixIds.length} retained songs)`);

  // Another chip opens its list at the top, and Back returns to that chip (not to For you) with
  // the same songs, without loading it again.
  await backPage.evaluate(() => {
    document.body.style.minHeight = '5000px';
    window.scrollTo(0, 1500);
  });
  await backPage.waitForFunction(() => [...document.querySelectorAll('main button[aria-pressed]')]
    .some(button => button.textContent?.trim() === 'Rankings'), { timeout: 60_000 });
  await backPage.evaluate(() => [...document.querySelectorAll('main button[aria-pressed]')]
    .find(button => button.textContent?.trim() === 'Rankings')?.click());
  // 1501 is only in the ranking fixture (the mix is 1502-1506), so the old list is gone by then.
  await backPage.waitForFunction(() => document.querySelector('main button[data-active="true"]')?.textContent?.trim() === 'Rankings'
    && document.querySelector('main a[href*="/watch?v=1501"]') !== null
    && document.querySelector('main [aria-busy="true"]') === null, { timeout: 60_000 });
  const chipSwitchScrollY = await backPage.evaluate(() => window.scrollY);
  await backPage.evaluate(() => { document.body.style.minHeight = ''; });
  if (chipSwitchScrollY > 100) throw new Error(`Switching chips kept the old scroll position: scrollY=${chipSwitchScrollY}`);
  const rankingIdsBeforeBack = await backPage.$$eval('main a[href*="/watch?v="]', links => [...new Set(
    links.map(link => new URL(link.href).searchParams.get('v')).filter(Boolean),
  )]);
  if (rankingIdsBeforeBack.length < 2) {
    throw new Error(`Navigation fixture did not load enough ranking songs: ${JSON.stringify(rankingIdsBeforeBack)}`);
  }
  const openedRankingId = rankingIdsBeforeBack[0];
  await backPage.evaluate(() => window.__DIVA_PERFORMANCE__?.clear());
  await backPage.click(`main a[href*="/watch?v=${openedRankingId}"]`);
  await backPage.waitForFunction(path => (location.pathname.replace(/\/+$/, '') || '/') === path, { timeout: 60_000 }, expectedWatch);
  await backPage.evaluate(() => window.history.back());
  await backPage.waitForFunction(path => (location.pathname.replace(/\/+$/, '') || '/') === path, { timeout: 15_000 }, expectedRoot);
  // Home's own (visually hidden) heading: the song page, which also has chips and song links, is gone.
  await backPage.waitForFunction(() => document.querySelector('main h1')?.textContent === 'Home'
    && document.querySelector('main a[href*="/watch?v="]') !== null, { timeout: 60_000 });
  const rankingBackState = await backPage.evaluate(() => ({
    activeChip: document.querySelector('main button[data-active="true"]')?.textContent?.trim(),
    ids: [...new Set([...document.querySelectorAll('main a[href*="/watch?v="]')]
      .map(link => new URL(link.href).searchParams.get('v')).filter(Boolean))],
    homeLoads: window.__DIVA_PERFORMANCE__?.getMetrics().filter(metric => metric.name === 'home.load').length ?? 0,
  }));
  const retainedRankingIds = rankingIdsBeforeBack.filter(id => id !== openedRankingId);
  if (rankingBackState.activeChip !== 'Rankings'
    || JSON.stringify(rankingBackState.ids.filter(id => retainedRankingIds.includes(id))) !== JSON.stringify(retainedRankingIds)
    || rankingBackState.homeLoads !== 0) {
    throw new Error(`Back did not restore the Rankings chip: before=${JSON.stringify(rankingIdsBeforeBack)}, after=${JSON.stringify(rankingBackState)}`);
  }
  console.log(`PASS chip switch opens at the top and Back restores the Rankings chip (${retainedRankingIds.length} retained songs)`);

  const discoveryMixState = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button[aria-label="発掘ミックスを再生"]')];
    const visibleButton = buttons.find(button => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const navigationContainsMix = [...document.querySelectorAll('nav a')]
      .some(link => link.textContent?.includes('発掘ミックス'));
    const rect = visibleButton?.getBoundingClientRect();
    return {
      found: Boolean(visibleButton),
      navigationContainsMix,
      y: rect?.y ?? -1,
      viewportHeight: window.innerHeight,
    };
  });
  if (!discoveryMixState.found || discoveryMixState.navigationContainsMix || discoveryMixState.y < discoveryMixState.viewportHeight / 2) {
    throw new Error(`Discovery mix is not an independent lower-sidebar action: ${JSON.stringify(discoveryMixState)}`);
  }
  const pathBeforeDiscovery = normalizePath(new URL(page.url()).pathname);
  await page.click('button[aria-label="発掘ミックスを再生"]');
  await page.waitForFunction(() => [...document.querySelectorAll('button[aria-label="発掘ミックスを再生"]')]
    .find(button => button.getBoundingClientRect().width > 0)?.textContent?.includes('曲を再生中'), { timeout: 60_000 });
  const discoveryResultText = await page.$$eval('button[aria-label="発掘ミックスを再生"]', buttons => (
    buttons.find(button => button.getBoundingClientRect().width > 0)?.textContent?.trim() ?? ''
  ));
  // The watch-page fixture song was just played and must be excluded, leaving
  // only the second fixture as an unheard direct-queue candidate.
  if (!discoveryResultText.includes('1曲を再生中')) {
    throw new Error(`Discovery mix did not populate the direct queue: ${discoveryResultText}`);
  }
  const pathAfterDiscovery = normalizePath(new URL(page.url()).pathname);
  if (pathAfterDiscovery !== pathBeforeDiscovery) {
    throw new Error(`Discovery mix unexpectedly navigated: ${pathBeforeDiscovery} -> ${pathAfterDiscovery}`);
  }
  console.log(`PASS direct discovery-mix queue action (sidebar y=${Math.round(discoveryMixState.y)})`);

  await page.waitForSelector('a[href*="/watch?v="]', { timeout: 60_000 });
  const songHref = await page.$eval('a[href*="/watch?v="]', element => element.getAttribute('href'));
  if (!songHref?.includes('/watch?v=')) throw new Error(`Song card is not a semantic link: ${songHref}`);
  if (!songHref.includes('autoplay=0')) throw new Error(`Song card link does not suppress new-tab autoplay: ${songHref}`);
  const vocadbFavoriteBadgeCount = await page.$$eval('[title="VocaDB お気に入り数"]', elements => elements.length);
  if (vocadbFavoriteBadgeCount !== 0) throw new Error('VocaDB favorite badge is still visible.');
  console.log(`PASS semantic song link, new-tab autoplay guard, and hidden VocaDB favorite badge (${songHref})`);

  const albumsLoaded = page.waitForResponse(response => new URL(response.url()).searchParams.get('fields') === 'Albums');
  await page.goto(new URL('watch?v=1502', base), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Albums are listed (and requested) only in the expanded description.
  await page.waitForSelector('button[aria-label="概要を展開する"]');
  await page.click('button[aria-label="概要を展開する"]');
  await albumsLoaded;
  await page.waitForSelector('button[aria-label="概要を折りたたむ"]');
  if (await page.$('[data-testid="song-albums"]')) throw new Error('Album section remained visible for a song without albums');
  console.log('PASS songs without albums hide the album section');

  // A fresh tab must use the complete raw log, including events outside the
  // initial 300 metadata records and the newest timestamp of repeated songs.
  const cooldownContext = await browser.createBrowserContext();
  const setupPage = await cooldownContext.newPage();
  await installApiFixtures(setupPage);
  await setupPage.goto(base.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await setupPage.waitForSelector('main a[href*="/watch?v="]');
  await setupPage.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('diva-listening-history', 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = database.transaction('plays', 'readwrite');
      const store = tx.objectStore('plays');
      store.clear();
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      store.add({ s: 1502, t: now - day, f: 0 });
      for (let i = 0; i < 350; i++) store.add({ s: 999999, t: now - i, f: 0 });
      store.add({ s: 1503, t: now - day, f: 0 });
      store.add({ s: 1503, t: now - 8 * day, f: 0 });
      store.add({ s: 1504, t: now - 8 * day, f: 0 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
    localStorage.clear();
    localStorage.setItem('diva-global-filters', JSON.stringify({ version: 2, state: { enabled: false, cooldownHours: 168 } }));
  });
  await setupPage.close();
  const cooldownCandidates = Array.from({ length: 20 }, (_, i) => ({
    ...fixtureHomeSong, id: 1502 + i, name: `Cooldown candidate ${1502 + i}`,
  }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopenedPage = await cooldownContext.newPage();
    await installApiFixtures(reopenedPage, cooldownCandidates);
    await reopenedPage.goto(base.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await reopenedPage.waitForSelector('main a[href*="/watch?v=1504"]', { timeout: 60_000 });
    const visibleIds = await reopenedPage.$$eval('main a[href*="/watch?v="]', links => links.map(link => Number(new URL(link.href).searchParams.get('v'))));
    if (visibleIds.includes(1502) || visibleIds.includes(1503)) throw new Error(`Seven-day cooldown lost after reopening tab: ${JSON.stringify(visibleIds)}`);
    const hours = await reopenedPage.evaluate(() => JSON.parse(localStorage.getItem('diva-global-filters')).state.cooldownHours);
    if (hours !== 168) throw new Error(`Cooldown setting was reset: ${hours}`);
    await reopenedPage.close();
  }
  await cooldownContext.close();
  console.log('PASS seven-day cooldown survives closing and reopening tabs with >300 plays and older repeated events');

  const layoutContext = await browser.createBrowserContext();
  const layoutPage = await layoutContext.newPage();
  await installApiFixtures(layoutPage, fixtureHomeSongs, fixtureHomeSongs);
  await layoutPage.evaluateOnNewDocument(() => {
    localStorage.setItem('diva-global-filters', JSON.stringify({ version: 2, state: { enabled: false } }));
  });
  const screenshotDirectory = process.env.DIVA_WATCH_LAYOUT_SCREENSHOTS;
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
  let previousFluidDimensions;
  for (const [width, height] of [[390, 844], [768, 1024], [1024, 768], [1280, 900], [1440, 900], [1600, 900], [1920, 1080], [2556, 1267]]) {
    await layoutPage.setViewport({ width, height });
    await layoutPage.goto(new URL('watch?v=1501', base), { waitUntil: 'domcontentloaded' });
    await layoutPage.waitForSelector('[data-testid="watch-video-info"]');
    if (width >= 1024) await layoutPage.waitForSelector('[data-testid="watch-recommendation-row"]');
    const dimensions = await layoutPage.evaluate(() => {
      const video = document.querySelector('[data-testid="watch-video-column"]')?.firstElementChild?.getBoundingClientRect();
      const sidebar = document.querySelector('[data-testid="watch-recommendations-column"]')?.getBoundingClientRect();
      const row = document.querySelector('[data-testid="watch-recommendation-row"]');
      const thumbnail = row?.querySelector('.aspect-video')?.getBoundingClientRect();
      return {
        videoWidth: video?.width, videoHeight: video?.height,
        sidebarWidth: sidebar?.width, sidebarLeft: sidebar?.left, sidebarTop: sidebar?.top,
        videoRight: video?.right, videoBottom: video?.bottom,
        rowHeight: row?.getBoundingClientRect().height,
        thumbnailWidth: thumbnail?.width, thumbnailHeight: thumbnail?.height,
        titleSize: row ? parseFloat(getComputedStyle(row.querySelector('h3')).fontSize) : null,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
      };
    });
    if (dimensions.overflow || Math.abs(dimensions.videoWidth / dimensions.videoHeight - 16 / 9) > 0.01) {
      throw new Error(`Watch frame overflow or ratio at ${width}: ${JSON.stringify(dimensions)}`);
    }
    if (width >= 1024) {
      if (dimensions.sidebarWidth < 399 || dimensions.sidebarWidth > 601
        || dimensions.sidebarLeft < dimensions.videoRight
        || dimensions.thumbnailWidth < 195 || dimensions.thumbnailHeight < 109
        || dimensions.rowHeight < 125 || dimensions.titleSize < 16 || dimensions.titleSize > 20.1
        || (width >= 1280 && dimensions.videoWidth < dimensions.sidebarWidth * 1.8)) {
        throw new Error(`Watch video/list balance at ${width}: ${JSON.stringify(dimensions)}`);
      }
    } else if (dimensions.sidebarTop < dimensions.videoBottom) {
      throw new Error(`Watch columns did not stack at ${width}: ${JSON.stringify(dimensions)}`);
    }
    if (width >= 1440) {
      if (previousFluidDimensions && (dimensions.thumbnailWidth <= previousFluidDimensions.thumbnailWidth
        || dimensions.titleSize <= previousFluidDimensions.titleSize
        || dimensions.rowHeight <= previousFluidDimensions.rowHeight)) {
        throw new Error(`Watch elements did not grow with their column at ${width}: ${JSON.stringify(dimensions)}`);
      }
      previousFluidDimensions = dimensions;
    }
    if (screenshotDirectory) await layoutPage.screenshot({ path: join(screenshotDirectory, `watch-${width}.png`) });
    console.log(`PASS Watch video/list balance at ${width}: ${JSON.stringify(dimensions)}`);
  }
  await layoutContext.close();

  // 「Skip to player」 goes to the play button of the player on screen. The song page has none
  // (apart from the music layout's player bar on wider windows), so there it goes to the video,
  // which comes after <main> and its endless related list, scrolled into view below the top bar
  // (only when it is not wholly there already, and never with its top under the bar).
  // Without a video it goes to <main>. A stub YouTube API puts an iframe where the real one would.
  {
    const nicoSong = { ...fixtureSong, id: 1510, name: 'DIVA E2E Nico Song', defaultName: 'DIVA E2E Nico Song', pvs: [fixtureNicoPv], pvServices: 'NicoNicoDouga' };
    const noVideoSong = { ...fixtureSong, id: 1511, name: 'DIVA E2E No Video Song', defaultName: 'DIVA E2E No Video Song', pvs: [], pvServices: 'Nothing' };
    const youtubeStub = `
      window.YT = {
        PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 },
        Player: function (id, options) {
          const player = this;
          let state = -1;
          let videoId = '';
          const frame = document.createElement('iframe');
          frame.id = id;
          frame.title = 'YouTube video player';
          frame.style.cssText = 'width:100%;height:100%;border:0';
          document.getElementById(id)?.replaceWith(frame);
          const emit = () => options.events.onStateChange({ data: state, target: player });
          player.getIframe = () => frame;
          player.getVideoData = () => ({ video_id: videoId });
          player.getPlayerState = () => state;
          player.getCurrentTime = () => 0;
          player.getDuration = () => 180;
          player.getVolume = () => 50;
          player.setVolume = player.mute = player.unMute = player.seekTo = player.destroy = () => {};
          player.isMuted = () => false;
          player.cueVideoById = player.loadVideoById = value => { videoId = typeof value === 'string' ? value : value.videoId; state = 5; };
          player.playVideo = () => { state = 1; emit(); };
          player.pauseVideo = () => { state = 2; emit(); };
          player.stopVideo = () => { state = 0; };
          setTimeout(() => options.events.onReady({ target: player }), 0);
        },
      };
      window.onYouTubeIframeAPIReady();
    `;
    const external = url => {
      if (url.href === 'https://www.youtube.com/iframe_api') return fixtureResponse(youtubeStub, 'application/javascript');
      if (url.hostname === 'embed.nicovideo.jp') return fixtureResponse('<!doctype html><title>Niconico</title>', 'text/html');
      if (url.origin !== base.origin) return { status: 204, body: '' };
      return null;
    };
    const cases = [
      { name: 'standard 1280px song page', layout: 'standard', viewport: { width: 1280, height: 900 }, path: 'watch?v=1501', expected: 'video' },
      { name: 'standard 1280px song page scrolled down', layout: 'standard', viewport: { width: 1280, height: 900 }, path: 'watch?v=1501', scrolled: true, expected: 'video' },
      { name: 'standard 390px song page', layout: 'standard', viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, path: 'watch?v=1501', expected: 'video' },
      // Short windows: at the top of the page the whole video is already in view below the top bar
      // (1280×540), or it is taller than the room below the bar (landscape phones).
      { name: 'standard 1280×540 song page', layout: 'standard', viewport: { width: 1280, height: 540 }, path: 'watch?v=1501', fitsAtTop: true, expected: 'video' },
      { name: 'standard 1280×540 song page scrolled down', layout: 'standard', viewport: { width: 1280, height: 540 }, path: 'watch?v=1501', scrolled: true, expected: 'video' },
      { name: 'standard 844×390 song page', layout: 'standard', viewport: { width: 844, height: 390, isMobile: true, hasTouch: true }, path: 'watch?v=1501', expected: 'video' },
      { name: 'standard 667×375 song page', layout: 'standard', viewport: { width: 667, height: 375, isMobile: true, hasTouch: true }, path: 'watch?v=1501', expected: 'video' },
      { name: 'standard Home with the mini player', layout: 'standard', viewport: { width: 1280, height: 900 }, path: '', expected: 'global-mini-player-toggle' },
      { name: 'music 1280px song page', layout: 'music', viewport: { width: 1280, height: 900 }, path: 'watch?v=1501', expected: 'music-play-toggle' },
      { name: 'music 1280px Home', layout: 'music', viewport: { width: 1280, height: 900 }, path: '', expected: 'music-play-toggle' },
      { name: 'music 390px Home', layout: 'music', viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, path: '', expected: 'music-mini-play-toggle' },
      { name: 'music 390px song page', layout: 'music', viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, path: 'watch?v=1501', expected: 'video' },
      // The idle YouTube iframe stays (hidden) before another service's video.
      { name: 'standard 1280px Niconico song page', layout: 'standard', viewport: { width: 1280, height: 900 }, song: nicoSong, path: 'watch?v=1510', expected: 'video' },
      // The player (with the queue's video) stays under the page's frame, inert.
      { name: 'standard 1280px song page without a video', layout: 'standard', viewport: { width: 1280, height: 900 }, path: 'watch?v=1511', expected: 'main' },
    ];
    for (const { name, layout, viewport, path, song = fixtureSong, scrolled = false, fitsAtTop = false, expected } of cases) {
      const skipContext = await browser.createBrowserContext();
      const skipPage = await skipContext.newPage();
      await skipPage.setViewport(viewport);
      await pinAppLanguage(skipPage);
      await skipPage.evaluateOnNewDocument(seed => {
        if (window !== window.top || sessionStorage.getItem('skip-link-e2e-seeded')) return;
        sessionStorage.setItem('skip-link-e2e-seeded', '1');
        localStorage.setItem('diva_uiLayout', JSON.stringify(seed.layout));
        localStorage.setItem('diva-global-filters', JSON.stringify({ version: 2, state: { enabled: false } }));
        const tabId = 'skip-link-e2e-tab';
        sessionStorage.setItem('diva-playback-tab-v1', tabId);
        localStorage.setItem('diva-playback-owner-v1', JSON.stringify({ type: 'claim', tabId, songId: seed.song.id, claimedAt: Date.now() }));
        localStorage.setItem('diva_playerQueue', JSON.stringify({
          queue: [seed.song],
          queueIndex: 0,
          currentSong: seed.song,
          currentSongId: seed.song.id,
          queueSources: ['manual'],
          currentPlaybackSource: 'manual',
        }));
      }, { layout, song });
      await installApiFixtures(skipPage, fixtureHomeSongs, [], { songs: [nicoSong, noVideoSong], external });
      await skipPage.goto(new URL(path, base), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await skipPage.waitForFunction(music => (document.documentElement.dataset.shell === 'music') === music, { timeout: 30_000 }, layout === 'music');
      await skipPage.waitForFunction(target => {
        const visible = selector => [...document.querySelectorAll(selector)].some(element => element.getClientRects().length > 0);
        if (target === 'main') return visible('[data-testid="watch-no-video"]') && document.querySelector('[data-testid="global-player"] iframe');
        if (target !== 'video') return visible(`[data-testid="${target}"]`);
        const player = document.querySelector('[data-testid="global-player"]');
        return player?.style.position === 'absolute'
          && [...player.querySelectorAll('iframe')].some(frame => frame.getBoundingClientRect().width > 100);
      }, { timeout: 30_000 }, expected);
      if (scrolled) {
        await skipPage.evaluate(() => {
          document.body.style.minHeight = '5000px';
          window.scrollTo(0, 1500);
        });
      }
      const skipButton = await skipPage.waitForFunction(() => [...document.querySelectorAll('button')]
        .find(button => button.textContent?.trim() === 'Skip to player'), { timeout: 10_000 });
      await skipButton.focus();
      const before = await skipPage.evaluate(() => {
        const video = [...document.querySelectorAll('[data-testid="global-player"] iframe')]
          .find(frame => frame.getBoundingClientRect().width > 1 && !frame.closest('[inert],[aria-hidden="true"]'));
        const rect = video?.getBoundingClientRect();
        return { top: rect?.top, bottom: rect?.bottom, scrollY };
      });
      await skipPage.keyboard.press('Enter');
      const landed = await skipPage.evaluate(() => {
        const active = document.activeElement;
        const player = document.querySelector('[data-testid="global-player"]');
        const rect = active?.getBoundingClientRect();
        return {
          target: active?.tagName === 'IFRAME' && player?.contains(active) ? 'video'
            : active?.id === 'main-content' ? 'main'
              : active?.getAttribute('data-testid') ?? active?.tagName ?? null,
          title: active?.getAttribute('title') ?? null,
          top: rect?.top,
          bottom: rect?.bottom,
          headerBottom: document.querySelector('header')?.getBoundingClientRect().bottom ?? 0,
          innerHeight,
          scrollY,
        };
      });
      if (landed.target !== expected) throw new Error(`Skip to player on the ${name} must reach ${expected}: ${JSON.stringify(landed)}`);
      if (expected === 'video') {
        // Never under the top bar; wholly in view when it fits below the bar; not moved when it already was.
        const inView = rect => rect.top >= landed.headerBottom - 0.5 && rect.bottom <= landed.innerHeight + 0.5;
        const fits = landed.bottom - landed.top <= landed.innerHeight - landed.headerBottom + 0.5;
        // The no-scroll check below needs a video already in view: a layout change that ends it must fail here,
        // not switch that check off.
        if (fitsAtTop && !inView(before)) {
          throw new Error(`The ${name} must start with the whole video in view below the top bar: ${JSON.stringify({ before, landed })}`);
        }
        if (landed.top < landed.headerBottom - 0.5 || (fits && !inView(landed))) {
          throw new Error(`Skip to player on the ${name} must bring the video into view below the top bar: ${JSON.stringify({ before, landed })}`);
        }
        if (inView(before) && landed.scrollY !== before.scrollY) {
          throw new Error(`Skip to player on the ${name} must not scroll a video already in view: ${JSON.stringify({ before, landed })}`);
        }
      }
      if (song === nicoSong && landed.title !== fixtureNicoPv.name) throw new Error(`Skip to player must reach the Niconico video: ${JSON.stringify(landed)}`);
      console.log(`PASS Skip to player on the ${name} reaches ${expected}${expected === 'video' ? ` (scrollY ${before.scrollY} → ${landed.scrollY}, top ${landed.top})` : ''}`);
      await skipContext.close();
    }
  }
} finally {
  await browser.close();
}
