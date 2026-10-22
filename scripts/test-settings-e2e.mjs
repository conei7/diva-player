import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const PAGE_TIMEOUT_MS = 30_000;
const SETTINGS = '[role="dialog"][aria-label="設定"]';
const RESTORE = '[role="dialog"][aria-label="バックアップから復元"]';
const CONFIRM = '[role="dialog"][aria-modal="true"]:not([aria-label])';

/** `--base-url <url>`, or the URL as the first argument like the other e2e scripts. */
function getBaseUrl() {
  const argumentIndex = process.argv.indexOf('--base-url');
  const positional = process.argv.slice(2).find(argument => /^https?:\/\//.test(argument));
  const provided = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : positional ?? 'http://127.0.0.1:4173/';
  const url = new URL(provided);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** A small, valid v6 full backup (manifest counts match the sections). */
function createBackupFixture() {
  return {
    kind: 'diva-player-full-backup',
    version: 6,
    exportedAt: '2026-10-11T12:00:00.000Z',
    manifest: {
      schemaVersion: 6,
      historyEvents: 0,
      ratingCount: 1,
      playlistCount: 0,
      playlistSongCount: 0,
      folderCount: 0,
      favoriteProducerCount: 0,
      hiddenSongCount: 0,
    },
    sections: {
      history: { events: [] },
      ratings: { 424242: 5 },
      playlists: { folders: [], playlists: [] },
      hiddenSongs: {},
    },
  };
}

async function assertDialogFits(page, label, selector) {
  const layout = await page.$eval(`${selector} > div`, element => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      overflowY: getComputedStyle(element).overflowY,
    };
  });
  assert(layout.left >= 0 && layout.right <= layout.viewportWidth
    && layout.top >= 0 && layout.bottom <= layout.viewportHeight,
  `${label} does not fit the viewport: ${JSON.stringify(layout)}`);
  assert(['auto', 'scroll'].includes(layout.overflowY), `${label} is not scrollable: ${JSON.stringify(layout)}`);
}

/** Dialogs scale in for 150ms; measure sizes only after that. */
async function waitForDialogAnimations(page) {
  await page.waitForFunction(() => document.getAnimations().every(animation => {
    const target = animation.effect?.target;
    return animation.playState !== 'running' || !(target instanceof Element && target.closest('[role="dialog"]'));
  }));
}

/** Clicks the button whose trimmed text is exactly `text` inside `scope`. */
async function clickButton(page, scope, text) {
  const clicked = await page.$eval(scope, (root, label) => {
    const button = [...root.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  }, text);
  assert(clicked, `Button "${text}" is missing in ${scope}`);
}

/** Focuses the button by its text and presses Enter (keyboard path). */
async function pressButton(page, scope, text) {
  const focused = await page.$eval(scope, (root, label) => {
    const button = [...root.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.focus();
    return true;
  }, text);
  assert(focused, `Button "${text}" is missing or disabled in ${scope}`);
  await page.keyboard.press('Enter');
}

/** Text of the focused element, and whether it is an enabled control inside `scope`. */
async function focusedControl(page, scope) {
  return page.evaluate(selector => {
    const element = document.activeElement;
    return {
      text: element?.textContent?.trim() ?? '',
      inside: !!element && element !== document.body && !!document.querySelector(selector)?.contains(element),
      disabled: element instanceof HTMLButtonElement ? element.disabled : false,
    };
  }, scope);
}

async function buttonState(page, scope, text) {
  return page.$eval(scope, (root, label) => {
    const button = [...root.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
    return button ? { disabled: button.disabled } : null;
  }, text);
}

async function settingRowChecked(page, label) {
  return page.$$eval(`${SETTINGS} .setting-row`, (rows, text) => {
    const row = rows.find(element => element.textContent?.includes(text));
    return row?.querySelector('input[type="checkbox"]')?.checked ?? null;
  }, label);
}

async function clickSettingRow(page, label) {
  await page.$$eval(`${SETTINGS} .setting-row`, (rows, text) => {
    const input = rows.find(element => element.textContent?.includes(text))?.querySelector('input[type="checkbox"]');
    if (input instanceof HTMLInputElement) input.click();
  }, label);
}

async function runViewport(page, baseUrl, width, height, backupPath, { restore = false } = {}) {
  const label = `${width}x${height}`;
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  assert(response && response.status() < 400, `Home returned HTTP ${response?.status() ?? 'unknown'}`);
  await page.evaluate(() => localStorage.setItem('diva_uiLanguage', JSON.stringify('ja')));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[aria-label="設定"]');
  await page.click('button[aria-label="設定"]');
  await page.waitForSelector(SETTINGS, { visible: true });

  const tabs = await page.$$eval(`${SETTINGS} [role="tab"]`, elements => elements.map(element => ({
    controls: element.getAttribute('aria-controls'),
    selected: element.getAttribute('aria-selected'),
  })));
  assert(tabs.length === 3 && tabs.filter(tab => tab.selected === 'true').length === 1,
    `${label} settings tabs are invalid: ${JSON.stringify(tabs)}`);
  assert(tabs[0].controls === 'settings-panel-filter' && tabs[0].selected === 'true',
    `${label} settings should open on the filter tab: ${JSON.stringify(tabs)}`);
  await assertDialogFits(page, `${label} settings dialog`, SETTINGS);

  const vocalistFilterUi = await page.$eval(SETTINGS, dialog => ({
    hasTitle: dialog.textContent?.includes('フィルターを使う') ?? false,
    hasSearch: dialog.querySelector('input[role="combobox"][aria-label="ボーカルを検索"]') !== null,
  }));
  assert(vocalistFilterUi.hasTitle && vocalistFilterUi.hasSearch,
    `${label} global vocalist filter UI is incomplete: ${JSON.stringify(vocalistFilterUi)}`);

  // Filters are a draft: 「適用」 is enabled only with changes, and closing asks before discarding them.
  assert((await buttonState(page, SETTINGS, '適用'))?.disabled === true, `${label} 適用 should be disabled without changes`);

  // 「適用」「リセット」 become disabled once pressed; keyboard focus must not fall to <body>.
  await clickSettingRow(page, 'フィルターを使う');
  await pressButton(page, SETTINGS, '適用');
  await page.waitForFunction(() => document.querySelector('[data-testid="toast-host"]')?.textContent?.includes('フィルターを適用しました'));
  let focus = await focusedControl(page, SETTINGS);
  assert(focus.inside && !focus.disabled && focus.text === 'キャンセル', `${label} focus after 適用 should move to キャンセル: ${JSON.stringify(focus)}`);
  await pressButton(page, SETTINGS, 'リセット');
  await page.waitForFunction(() => document.querySelector('[data-testid="toast-host"]')?.textContent?.includes('フィルターをリセットしました'));
  focus = await focusedControl(page, SETTINGS);
  assert(focus.inside && !focus.disabled && focus.text === 'キャンセル', `${label} focus after リセット should move to キャンセル: ${JSON.stringify(focus)}`);
  assert((await buttonState(page, SETTINGS, '適用'))?.disabled === true && (await buttonState(page, SETTINGS, 'リセット'))?.disabled === true,
    `${label} 適用 and リセット should be disabled after resetting`);

  await clickSettingRow(page, 'フィルターを使う');
  assert((await buttonState(page, SETTINGS, '適用'))?.disabled === false, `${label} 適用 should be enabled after a change`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(selector => [...document.querySelectorAll(selector)]
    .some(dialog => dialog.textContent?.includes('変更を破棄しますか？')), {}, CONFIRM);
  await clickButton(page, CONFIRM, 'キャンセル');
  await page.waitForFunction(() => !document.body.textContent?.includes('変更を破棄しますか？'));
  assert(await page.$(SETTINGS), `${label} cancelling the discard prompt closed the settings`);
  await clickSettingRow(page, 'フィルターを使う');
  assert((await buttonState(page, SETTINGS, '適用'))?.disabled === true, `${label} reverting the change should disable 適用`);

  await page.click('#settings-tab-playback');
  await page.waitForSelector(`${SETTINGS} #settings-panel-playback`);
  assert(await settingRowChecked(page, 'おすすめの理由を表示') === false, `${label} recommendation hints should be hidden by default`);
  await clickSettingRow(page, 'おすすめの理由を表示');
  assert(await settingRowChecked(page, 'おすすめの理由を表示') === true, `${label} recommendation hints could not be enabled`);
  assert(await page.evaluate(() => localStorage.getItem('diva-player-recommendation-hints')) === '1',
    `${label} recommendation hint preference was not persisted`);
  await clickSettingRow(page, 'おすすめの理由を表示');
  const languageSelect = await page.$eval(`${SETTINGS} #settings-panel-playback select`, select => select.value);
  assert(languageSelect === 'ja', `${label} language select does not show the current language: ${languageSelect}`);

  await page.click('[role="tab"][aria-controls="settings-panel-data"]');
  await page.waitForSelector('#settings-panel-data');
  await waitForDialogAnimations(page);
  const dataActions = await page.$$eval('#settings-panel-data button', buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    return { text: button.textContent?.trim(), width: rect.width, height: rect.height, left: rect.left, right: rect.right };
  }));
  for (const action of ['バックアップを保存', 'ファイルから復元']) {
    const target = dataActions.find(item => item.text === action);
    assert(target && target.height >= 40 && target.left >= 0 && target.right <= width,
      `${label} data action "${action}" is missing or too small: ${JSON.stringify(dataActions)}`);
  }
  assert(await page.$('#settings-panel-data a[href$="/settings/hidden-songs"]'), `${label} hidden songs link is missing`);

  const fileInput = await page.$('#settings-panel-data input[type="file"]');
  assert(fileInput, `${label} backup file input is missing`);
  await fileInput.uploadFile(backupPath);
  await page.waitForSelector(RESTORE, { visible: true });
  assert(await page.$(SETTINGS), `${label} settings should stay open under the restore dialog`);
  await waitForDialogAnimations(page);
  await assertDialogFits(page, `${label} restore dialog`, RESTORE);
  const restoreUi = await page.$eval(RESTORE, dialog => ({
    title: dialog.querySelector('h2')?.textContent?.trim(),
    columns: [...dialog.querySelectorAll('thead th')].map(cell => cell.textContent?.trim()),
    rows: dialog.querySelectorAll('tbody tr').length,
    radios: dialog.querySelectorAll('input[type="radio"]').length,
  }));
  assert(restoreUi.title === '2026/10/11のバックアップ', `${label} restore title is wrong: ${JSON.stringify(restoreUi)}`);
  assert(restoreUi.columns.join('|') === '項目|このファイル|現在' && restoreUi.rows === 7 && restoreUi.radios === 2,
    `${label} restore comparison is incomplete: ${JSON.stringify(restoreUi)}`);
  assert((await buttonState(page, RESTORE, '復元'))?.disabled === false, `${label} 復元 should be enabled for a valid backup`);

  // Replacing asks first (no window.confirm).
  await page.$eval(`${RESTORE} input[type="radio"][value="replace"]`, input => input.click());
  await clickButton(page, RESTORE, '置き換える');
  await page.waitForFunction(selector => [...document.querySelectorAll(selector)]
    .some(dialog => dialog.textContent?.includes('今のデータを置き換えますか？')), {}, CONFIRM);
  await clickButton(page, CONFIRM, 'キャンセル');
  await page.waitForFunction(() => !document.body.textContent?.includes('今のデータを置き換えますか？'));
  await page.$eval(`${RESTORE} input[type="radio"][value="merge"]`, input => input.click());

  if (restore) {
    // A failed write: the details name the data in words (no storage keys, no raw exception text),
    // say the current data is unchanged, and focus goes back to「復元」.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      let failed = false;
      Storage.prototype.setItem = function setItem(key, value) {
        if (!failed && String(key) === 'diva_playlistFolders') {
          failed = true;
          Storage.prototype.setItem = original;
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        return original.call(this, key, value);
      };
    });
    await clickButton(page, RESTORE, '復元');
    await page.waitForSelector(`${RESTORE} [role="alert"]`, { visible: true });
    const failure = await page.$eval(`${RESTORE} [role="alert"]`, alert => ({
      head: alert.querySelector('p')?.textContent?.trim(),
      summary: alert.querySelector('summary')?.textContent?.trim(),
      items: [...alert.querySelectorAll('li')].map(item => item.textContent?.trim()),
    }));
    assert(failure.head === '復元できませんでした' && failure.summary === '詳細'
      && failure.items.join('|') === 'プレイリストとフォルダーを保存できませんでした|今のデータは変更されていません',
    `${label} restore failure details are wrong: ${JSON.stringify(failure)}`);
    assert(!/diva[_-]|Error|quota/i.test(JSON.stringify(failure)), `${label} restore failure shows internal text: ${JSON.stringify(failure)}`);
    const focusAfterFailure = await focusedControl(page, RESTORE);
    assert(focusAfterFailure.inside && focusAfterFailure.text === '復元', `${label} focus after a failed restore should be on 復元: ${JSON.stringify(focusAfterFailure)}`);

    await clickButton(page, RESTORE, '復元');
    await page.waitForSelector(RESTORE, { hidden: true });
    await page.waitForFunction(() => document.querySelector('[data-testid="toast-host"]')?.textContent?.includes('バックアップから復元しました'));
    const ratings = await page.evaluate(() => localStorage.getItem('diva-ratings'));
    assert(ratings?.includes('424242'), `${label} merged rating was not saved: ${ratings}`);
    assert(await page.$(`${SETTINGS} #settings-panel-data`), `${label} settings should stay open after restoring`);
  } else {
    await page.keyboard.press('Escape');
    await page.waitForSelector(RESTORE, { hidden: true });
    await page.waitForSelector(`${SETTINGS} #settings-panel-data`, { visible: true });
  }

  await page.keyboard.press('Escape');
  await page.waitForSelector(SETTINGS, { hidden: true });
  console.log(`PASS settings tabs, filter draft, data tab, and restore dialog ${label}`);
}

async function runTheme(page, baseUrl, browser) {
  const color = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim());
  const openGeneral = async () => {
    await page.waitForSelector('button[aria-label="設定"]');
    await page.click('button[aria-label="設定"]');
    await page.waitForSelector('#settings-tab-playback');
    await page.click('#settings-tab-playback');
    await page.waitForSelector('input[aria-label="カスタムカラー"]');
  };
  await page.setViewport({ width: 320, height: 568 });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await openGeneral();
  await page.click('button[aria-label="ピンク"]');
  assert(await color() === '#ff8fc7', 'Preset did not change the live accent');
  assert(await page.evaluate(() => JSON.parse(localStorage.getItem('diva_accentColor'))) === '#ff8fc7', 'Accent was not saved');
  await assertDialogFits(page, 'theme settings 320px', SETTINGS);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openGeneral();
  assert(await color() === '#ff8fc7', 'Accent did not survive reload');
  assert(await page.$eval('input[aria-label="カスタムカラー"]', input => input.value) === '#ff8fc7', 'Color control lost the saved choice');
  await page.$eval('input[aria-label="カスタムカラー"]', input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '#000000');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert(await color() !== '#000000', 'Dark custom accent was not brightened');
  assert(await page.evaluate(() => JSON.parse(localStorage.getItem('diva_accentColor'))) === '#000000', 'Custom color was not saved');
  await clickButton(page, SETTINGS, '初期色に戻す');
  assert(await color() === '#06d6a0', 'Reset did not restore the original accent');
  const other = await browser.newPage();
  try {
    await other.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await other.evaluate(() => localStorage.setItem('diva_accentColor', JSON.stringify('#6dbbff')));
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--color-brand') === '#6dbbff');
    assert(await page.$eval('input[aria-label="カスタムカラー"]', input => input.value) === '#6dbbff', 'Other-tab update did not reach open settings');
    await other.evaluate(() => localStorage.removeItem('diva_accentColor'));
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--color-brand') === '#06d6a0');
  } finally { await other.close(); }
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'diva_accentColor') {
        Storage.prototype.setItem = original;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await page.click('button[aria-label="レッド"]');
  await page.waitForFunction(() => document.body.textContent.includes('色は適用しましたが保存できませんでした'));
  assert(await color() === '#ff8585', 'Storage failure prevented the live accent');
  await clickButton(page, SETTINGS, '初期色に戻す');
  console.log('PASS accent presets, custom color readability, persistence, reset, cross-tab updates, and storage failure');
}

async function main() {
  const baseUrl = getBaseUrl();
  const fixtureDir = await mkdtemp(join(tmpdir(), 'diva-settings-e2e-'));
  const backupPath = join(fixtureDir, 'diva_full_backup_2026-10-11.json');
  await writeFile(backupPath, JSON.stringify(createBackupFixture()));
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=en-US'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await runViewport(page, baseUrl, 390, 844, backupPath);
    await runViewport(page, baseUrl, 320, 568, backupPath);
    await runViewport(page, baseUrl, 1280, 900, backupPath, { restore: true });
    await runTheme(page, baseUrl, browser);
    console.log('Settings browser E2E test passed.');
  } finally {
    await browser.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Settings browser E2E test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
