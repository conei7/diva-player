import puppeteer from 'puppeteer';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/diva-player/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const capturedSearchUrls = [];
const fixtureSong = {
  id: 904001, name: '詳細検索 fixture', defaultName: 'Advanced fixture', defaultNameLanguage: 'Japanese',
  artistString: 'Facet producer', createDate: '2026-01-01T00:00:00Z', publishDate: '2026-01-01',
  favoritedTimes: 10, lengthSeconds: 180, pvServices: 'Youtube', ratingScore: 0,
  songType: 'Original', status: 'Finished', version: 1,
};

try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/backend-api/api/search/tags')) {
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 337, name: 'ピアノ', category: 'Instrumental', songCount: 14818 }] }) });
    } else if (url.includes('vocadb.net/api/artists?')) {
      request.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ items: [{ id: 777, name: 'Fixture illustrator', artistType: 'Illustrator' }], totalCount: 1 }) });
    } else if (url.includes('/backend-api/api/songs/search')) {
      capturedSearchUrls.push(url);
      request.respond({ status: 200, contentType: 'application/json', headers: { 'X-Diva-Search-Cache': 'miss' }, body: JSON.stringify({ items: [fixtureSong], totalCount: 321 }) });
    } else request.continue();
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('button[aria-label="詳細検索"]', { timeout: 60_000 });
  await page.click('button[aria-label="詳細検索"]');
  const requiredSections = ['再生数・支持', 'VocaDBタグ', '参加者・役割', '音源からの推定'];
  await page.evaluate(sectionTitles => {
    for (const title of sectionTitles) {
      const titleElement = [...document.querySelectorAll('.filter-section-title')]
        .find(element => element.textContent?.trim() === title);
      const button = titleElement?.closest('button.filter-section-header');
      if (!(button instanceof HTMLButtonElement)) throw new Error(`Filter section not found: ${title}`);
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
    }
  }, requiredSections);
  await page.waitForFunction(sectionTitles => sectionTitles.every(title => {
    const titleElement = [...document.querySelectorAll('.filter-section-title')]
      .find(element => element.textContent?.trim() === title);
    return titleElement?.closest('button.filter-section-header')?.getAttribute('aria-expanded') === 'true';
  }), {}, requiredSections);

  await page.evaluate(() => {
    const tagFilters = document.querySelector('[data-testid="vocadb-tag-filters"]');
    const tagButton = [...(tagFilters?.querySelectorAll('button') ?? [])].find(button => button.textContent?.trim() === 'ピアノ');
    if (!tagButton) throw new Error('VocaDB tag button not found');
    tagButton.click();

    const audioFilters = document.querySelector('[data-testid="audio-analysis-filters"]');
    const bpmInput = audioFilters?.querySelector('input[placeholder="80"]');
    const instrumentButton = [...(audioFilters?.querySelectorAll('button') ?? [])].find(button => button.textContent?.trim() === 'ピアノ');
    if (!(bpmInput instanceof HTMLInputElement)) throw new Error('BPM input not found');
    if (!instrumentButton) throw new Error('instrument button not found');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(bpmInput, '90');
    bpmInput.dispatchEvent(new Event('input', { bubbles: true }));
    instrumentButton.click();
  });
  await page.type('input[placeholder="P、絵師、動画師、演奏者…"]', 'Fixture');
  await page.waitForFunction(() => document.body.textContent?.includes('Fixture illustrator'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Fixture illustrator'))?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.evaluate(() => {
    const role = [...document.querySelectorAll('select')].find(select => [...select.options].some(option => option.value === 'Illustrator'));
    if (!role) throw new Error('credit role select not found');
    role.value = 'Illustrator';
    role.dispatchEvent(new Event('change', { bubbles: true }));
    const group = [...document.querySelectorAll('label')].find(label => label.textContent?.includes('YouTube再生数'));
    const input = group?.querySelector('input');
    if (!input) throw new Error('YouTube range input not found');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1000000');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('この条件で検索'))?.click());
  await page.waitForFunction(() => document.body.textContent?.includes('321') && document.body.textContent?.includes('詳細検索 fixture'));

  const requestUrl = capturedSearchUrls.at(-1);
  if (!requestUrl) throw new Error('advanced search request not captured');
  const parsed = new URL(requestUrl);
  if (parsed.searchParams.get('tagIds') !== '337') throw new Error(`tag filter missing: ${requestUrl}`);
  if (parsed.searchParams.get('bpmFrom') !== '90') throw new Error(`BPM filter missing: ${requestUrl}`);
  if (parsed.searchParams.get('instrumentKeys') !== 'piano' || parsed.searchParams.get('instrumentMatchMode') !== 'all') throw new Error(`instrument filter missing: ${requestUrl}`);
  if (parsed.searchParams.get('creditArtistId') !== '777' || parsed.searchParams.get('creditArtistRole') !== 'Illustrator') throw new Error(`credit filter missing: ${requestUrl}`);
  if (parsed.searchParams.get('minYoutubeViews') !== '1000000') throw new Error(`view range missing: ${requestUrl}`);

  await page.select('#sort-select', 'Random');
  await new Promise(resolve => setTimeout(resolve, 300));
  if (!capturedSearchUrls.at(-1)?.includes('randomSeed=')) throw new Error('random sort seed was not sent');
  console.log('PASS price-comparison style advanced search facets and random sorting');
} finally {
  await browser.close();
}
