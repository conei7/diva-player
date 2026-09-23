import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'https://diva-player.pages.dev/';
const base = new URL(baseUrl);
const normalizePath = path => path.replace(/\/+$/, '') || '/';
const expectedRoot = normalizePath(new URL(base.pathname, base.origin).pathname);
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
const fixtureSongs = [fixtureSong, fixtureHomeSong];
const fixtureResponse = (body, contentType = 'application/json') => ({
  status: 200,
  headers: {
    'access-control-allow-origin': '*',
    'content-type': contentType,
  },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

async function installApiFixtures(page) {
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    const path = url.pathname;
    const isBackend = path.startsWith('/backend-api/');
    const isVocaDb = url.hostname === 'vocadb.net';
    if (!isBackend && !isVocaDb) {
      void request.continue();
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
      response = fixtureResponse({ items: [] });
    } else if (path.includes('/api/songs/search')) {
      response = fixtureResponse({ items: fixtureSongs, totalCount: fixtureSongs.length });
    } else if (path.match(/\/api\/songs\/\d+$/)) {
      response = fixtureResponse(fixtureSong);
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

try {
  const page = await browser.newPage();
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
    await page.click('button[aria-label="表示言語を英語に切り替え"]');
  }
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.waitForSelector('button[aria-label="Switch display language to Japanese"]', { timeout: 60_000 });
  await page.waitForSelector('button[aria-label="Share"]', { timeout: 60_000 });
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
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.body.innerText.includes('For you'));
  const englishShell = await page.evaluate(() => ({
    language: document.documentElement.lang,
    searchPlaceholder: document.querySelector('input[placeholder="Search Vocaloid producers or songs"]') !== null,
    soundMap: document.body.innerText.includes('Sound map'),
  }));
  if (englishShell.language !== 'en' || !englishShell.searchPlaceholder || !englishShell.soundMap) {
    throw new Error(`English language switch did not update the discovery shell: ${JSON.stringify(englishShell)}`);
  }
  await page.click('button[aria-label="Advanced search"]');
  await page.waitForFunction(() => document.querySelector('button[aria-label="Advanced search"]')?.getAttribute('aria-pressed') === 'true');
  await page.waitForSelector('.filter-section-header', { timeout: 10_000 });
  const advancedSearchEnglish = await page.evaluate(() => document.body.innerText);
  if (!advancedSearchEnglish.includes('QUICK FILTERS')) {
    throw new Error(`Quick-filter heading translation is missing: ${advancedSearchEnglish.slice(0, 1200)}`);
  }
  if (!advancedSearchEnglish.includes('Early Vocaloid era')
    || !advancedSearchEnglish.includes('Release year & duration')
    || !advancedSearchEnglish.includes('Views & favorites')
    || !advancedSearchEnglish.includes('Search with these filters')) {
    throw new Error(`Advanced-search filters are not translated: ${advancedSearchEnglish.slice(0, 500)}`);
  }
  const filterSections = await page.$$('button.filter-section-header');
  const audioSectionIndex = (await Promise.all(filterSections.map(button => button.evaluate(element => element.textContent))))
    .findIndex(text => text?.includes('Audio-based estimates'));
  if (audioSectionIndex < 0) throw new Error('English audio-filter section is missing');
  await filterSections[audioSectionIndex].click();
  await page.waitForFunction(() => document.body.innerText.includes('Electric piano'));
  await page.click('button[aria-label="Advanced search"]');
  const homeSongMenu = 'button[aria-label="Menu for DIVA E2E Home Song"]';
  await page.waitForSelector(homeSongMenu, { timeout: 30_000 });
  await page.hover(homeSongMenu);
  await page.click(homeSongMenu);
  await page.waitForSelector('[role="menu"]', { timeout: 10_000 });
  const songMenuEnglish = await page.$eval('[role="menu"]', menu => menu.innerText);
  if (!songMenuEnglish.includes('Listen Later')
    || !songMenuEnglish.includes('Save to playlist')
    || !songMenuEnglish.includes('Share song')
    || !songMenuEnglish.includes('Hide this song')) {
    throw new Error(`Song-card menu is not translated: ${songMenuEnglish}`);
  }
  await page.keyboard.press('Escape');
  console.log('PASS English player controls, song-card menu, and advanced-search filters');
  await page.goto(new URL('playlists', base), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('aside[aria-label="Playlist library"]', { timeout: 60_000 });
  await page.waitForSelector('input[placeholder="New playlist"]', { timeout: 60_000 });
  await page.type('input[placeholder="New playlist"]', 'DIVA English UI E2E');
  await page.click('button[aria-label="Create playlist"]');
  await page.waitForFunction(() => document.body.innerText.includes('DIVA English UI E2E'));
  await page.click('button[aria-label="Create smart playlist"]');
  await page.waitForSelector('[role="dialog"] h2#smart-playlist-builder-title', { timeout: 60_000 });
  const smartPlaylistEnglish = await page.$eval('#smart-playlist-builder-title', heading => heading.textContent);
  if (smartPlaylistEnglish !== 'Create smart playlist') {
    throw new Error(`Smart-playlist dialog is not translated: ${smartPlaylistEnglish}`);
  }
  await page.click('[role="dialog"] button[aria-label="Close"]');
  await page.click('button[aria-label="Settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 60_000 });
  const settingsEnglish = await page.$eval('[role="dialog"][aria-label="Settings"]', dialog => dialog.innerText);
  if (!settingsEnglish.includes('Global discovery filters') || !settingsEnglish.includes('Playback & controls')) {
    throw new Error(`Settings dialog is not translated: ${settingsEnglish.slice(0, 300)}`);
  }
  await page.click('#settings-tab-data');
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Open data & backups');
    if (!button) throw new Error('Open data & backups button is missing');
    button.click();
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  const backupDialogs = await page.$$eval('[role="dialog"]', dialogs => dialogs.map(dialog => ({
    label: dialog.getAttribute('aria-label'),
    text: dialog.innerText.slice(0, 200),
  })));
  if (!backupDialogs.some(dialog => dialog.label === 'Data & backups')) {
    throw new Error(`Backup dialog did not open: ${JSON.stringify(backupDialogs)}`);
  }
  const backupEnglish = await page.$eval('[role="dialog"][aria-label="Data & backups"]', dialog => dialog.innerText);
  if (!backupEnglish.includes('Save everything from your history to settings in one file')
    || !backupEnglish.includes('Audio and video files are not included')) {
    throw new Error(`Backup dialog is not translated: ${backupEnglish.slice(0, 350)}`);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  console.log('PASS English playlist library, smart-playlist builder, and settings dialog');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[aria-label="Switch display language to Japanese"]', { timeout: 60_000 });
  await page.click('button[aria-label="Switch display language to Japanese"]');
  await page.waitForFunction(() => document.documentElement.lang === 'ja');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[aria-label="表示言語を英語に切り替え"]', { timeout: 60_000 });
  await page.goto(new URL('watch?v=1501', base), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('button[aria-label="表示言語を英語に切り替え"]', { timeout: 60_000 });
  console.log('PASS browser language detection, language switch, discovery translations, and persistence');
  await page.waitForSelector('a[aria-label="DIVA Player home"]', { timeout: 60_000 });
  await page.waitForSelector('a[aria-label$=" の曲を表示"]', { timeout: 60_000 });
  const producerHref = await page.$eval('a[aria-label$=" の曲を表示"]', element => element.getAttribute('href'));
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
  const collapsedProducerButtons = await page.$$eval('.watch-favorite-producer-button', buttons => buttons.length);
  if (collapsedProducerButtons !== 3) throw new Error(`Expected 3 collapsed producers, got ${collapsedProducerButtons}`);
  await page.click('button[aria-label="他1名のPを表示"]');
  await page.waitForSelector('button[aria-label="P一覧を折りたたむ"]');
  const expandedProducerButtons = await page.$$eval('.watch-favorite-producer-button', buttons => buttons.length);
  if (expandedProducerButtons !== 4) throw new Error(`Expected 4 expanded producers, got ${expandedProducerButtons}`);
  await page.click('button[aria-label="P一覧を折りたたむ"]');
  await page.waitForSelector('button[aria-label="他1名のPを表示"]');
  console.log('PASS compact watch metadata, producer collapse, and action layout');
  await page.waitForSelector('button[aria-label="概要を展開する"]', { timeout: 60_000 });
  await page.click('button[aria-label="概要を展開する"]');
  await page.waitForSelector('button[aria-label="概要を折りたたむ"]', { timeout: 60_000 });
  const descriptionState = await page.$eval('button[aria-label="概要を折りたたむ"]', button => {
    const root = button.closest('div[aria-expanded]');
    const text = root?.querySelector('p');
    text?.click();
    return {
      expanded: root?.getAttribute('aria-expanded'),
      whiteSpace: text ? getComputedStyle(text).whiteSpace : null,
      linkCount: root?.querySelectorAll('p a[href^="http"]').length ?? 0,
    };
  });
  if (descriptionState.expanded !== 'true' || descriptionState.whiteSpace !== 'pre-wrap') {
    throw new Error(`Unexpected description state: ${JSON.stringify(descriptionState)}`);
  }
  await page.click('button[aria-label="概要を折りたたむ"]');
  await page.waitForSelector('button[aria-label="概要を展開する"]', { timeout: 60_000 });
  console.log(`PASS description expansion UX (${descriptionState.linkCount} inline links)`);
  const href = await page.$eval('a[aria-label="DIVA Player home"]', element => element.getAttribute('href'));
  await page.click('a[aria-label="DIVA Player home"]');
  await page.waitForFunction(path => (location.pathname.replace(/\/+$/, '') || '/') === path, {}, expectedRoot);
  if (normalizePath(href ?? '') !== expectedRoot) {
    throw new Error(`Unexpected home link href: ${href}; expected ${expectedRoot}`);
  }
  console.log(`PASS logo navigation (${href} -> ${expectedRoot})`);
  console.log(`PASS watch-page producer link (${producerHref})`);

  const searchInput = 'input[placeholder="ボカロP名や曲名で検索"]';
  await page.waitForSelector(searchInput, { timeout: 60_000 });
  await page.type(searchInput, '千本桜');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.textContent?.includes('検索結果'), { timeout: 60_000 });
  await page.click('a[aria-label="DIVA Player home"]');
  await page.waitForFunction(() => {
    const activeCategory = document.querySelector('button[data-active="true"]');
    const input = document.querySelector('input[placeholder="ボカロP名や曲名で検索"]');
    return activeCategory?.textContent?.includes('あなたへのおすすめ')
      && input instanceof HTMLInputElement
      && input.value === '';
  }, { timeout: 60_000 });
  console.log('PASS search state resets on home navigation');

  const discoveryMixState = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button[aria-label="発掘ミックスを生成して再生"]')];
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
  await page.click('button[aria-label="発掘ミックスを生成して再生"]');
  await page.waitForFunction(() => [...document.querySelectorAll('button[aria-label="発掘ミックスを生成して再生"]')]
    .find(button => button.getBoundingClientRect().width > 0)?.textContent?.includes('曲を再生中'), { timeout: 60_000 });
  const discoveryResultText = await page.$$eval('button[aria-label="発掘ミックスを生成して再生"]', buttons => (
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
} finally {
  await browser.close();
}
