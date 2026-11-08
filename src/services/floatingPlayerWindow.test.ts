import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeFloatingPlayer,
  copyDocumentStyles,
  floatingArtworkCandidates,
  floatingPlayerShape,
  FLOATING_PLAYER_SIZE,
  getDocumentPictureInPicture,
  openFloatingPlayer,
  syncRootAttributes,
  toggleFloatingPlayer,
  useFloatingPlayerStore,
  type DocumentPictureInPictureApi,
} from './floatingPlayerWindow';
import {
  FLOATING_PLAYER_KEY,
  readFloatingPlayerEnabled,
  writeFloatingPlayerEnabled,
} from '../utils/playerInteractionPreferences';

/** Just enough of an element for attribute syncing and <head>/<body> appends. */
class FakeElement {
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  textContent = '';
  className = '';
  rel = '';
  href = '';
  media = '';
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  getAttributeNames() { return [...this.attributes.keys()]; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(child: FakeElement) { this.children.push(child); }
}

function fakeDocument(styleSheets: unknown[] = []) {
  return {
    styleSheets,
    title: 'DIVA Player',
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    createElement: (tag: string) => new FakeElement(tag),
  };
}

function fakeWindow() {
  const listeners = new Map<string, () => void>();
  return {
    document: fakeDocument(),
    closed: false,
    focus: vi.fn(),
    close: vi.fn(function (this: { closed: boolean }) { this.closed = true; }),
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
    fire: (type: string) => listeners.get(type)?.(),
  };
}

afterEach(() => {
  closeFloatingPlayer();
  useFloatingPlayerStore.setState({ window: null });
  vi.unstubAllGlobals();
});

describe('小窓プレイヤー window', () => {
  it('finds Document Picture-in-Picture only where the browser has it', () => {
    expect(getDocumentPictureInPicture({})).toBeNull();
    expect(getDocumentPictureInPicture({ documentPictureInPicture: {} })).toBeNull();
    const api = { requestWindow: vi.fn(), window: null };
    expect(getDocumentPictureInPicture({ documentPictureInPicture: api })).toBe(api);
  });

  it('tries the HD YouTube thumbnail before the page’s artwork candidates', () => {
    const urls = floatingArtworkCandidates({
      thumbUrl: '',
      pvs: [{ author: '', disabled: false, id: 1, length: 200, name: 'pv', pvId: 'abcdefghijk', service: 'Youtube', pvType: 'Original', url: '' }],
    });
    expect(urls[0]).toBe('https://img.youtube.com/vi/abcdefghijk/maxresdefault.jpg');
    expect(urls.slice(1)).toEqual(expect.arrayContaining([
      'https://img.youtube.com/vi/abcdefghijk/mqdefault.jpg',
      'https://img.youtube.com/vi/abcdefghijk/hqdefault.jpg',
    ]));
    expect(floatingArtworkCandidates({ thumbUrl: '', pvs: [] })).toEqual([]);
  });

  it('puts the artwork beside the controls only in a wide, low window', () => {
    expect(floatingPlayerShape(320, 320)).toBe('stacked');
    expect(floatingPlayerShape(480, 300)).toBe('row');
    expect(floatingPlayerShape(300, 480)).toBe('stacked');
  });

  it('copies readable stylesheets as rules and cross-origin ones as links', () => {
    const source = fakeDocument([
      { cssRules: [{ cssText: '.a { color: red; }' }, { cssText: '.b { color: blue; }' }], href: null, media: { mediaText: '' } },
      {
        get cssRules(): never { throw new DOMException('cross-origin', 'SecurityError'); },
        href: 'https://fonts.example/css',
        media: { mediaText: 'screen' },
      },
    ]);
    const target = fakeDocument();
    copyDocumentStyles(source as unknown as Document, target as unknown as Document);
    expect(target.head.children.map(child => child.tagName)).toEqual(['style', 'link']);
    expect(target.head.children[0].textContent).toBe('.a { color: red; }\n.b { color: blue; }');
    expect(target.head.children[1]).toMatchObject({ rel: 'stylesheet', href: 'https://fonts.example/css', media: 'screen' });
  });

  it('keeps the theme, accent colour and language of the page', () => {
    const page = new FakeElement('html');
    page.setAttribute('data-theme', 'light');
    page.setAttribute('style', '--color-brand: #ff0000;');
    page.setAttribute('lang', 'en');
    const pip = new FakeElement('html');
    pip.setAttribute('data-theme', 'dark');
    pip.setAttribute('data-stale', '1');
    syncRootAttributes(page as unknown as Element, pip as unknown as Element);
    expect(Object.fromEntries(pip.attributes)).toEqual({
      'data-theme': 'light',
      style: '--color-brand: #ff0000;',
      lang: 'en',
    });
  });

  it('opens one window for overlapping requests, focuses it when open, and forgets it once closed', async () => {
    vi.stubGlobal('document', fakeDocument());
    const pip = fakeWindow();
    const api: DocumentPictureInPictureApi = { requestWindow: vi.fn(async () => pip as unknown as Window), window: null };

    const [first, second] = await Promise.all([openFloatingPlayer(api), openFloatingPlayer(api)]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(api.requestWindow).toHaveBeenCalledTimes(1);
    expect(api.requestWindow).toHaveBeenCalledWith(FLOATING_PLAYER_SIZE);
    expect(useFloatingPlayerStore.getState().window).toBe(pip);

    await openFloatingPlayer(api);
    expect(pip.focus).toHaveBeenCalledTimes(1);
    expect(api.requestWindow).toHaveBeenCalledTimes(1);

    // Closed with the window's own ✕ (or Chrome's 「タブに戻る」).
    pip.fire('pagehide');
    expect(useFloatingPlayerStore.getState().window).toBeNull();
  });

  it('reports a refused window and does not keep it', async () => {
    vi.stubGlobal('document', fakeDocument());
    const api: DocumentPictureInPictureApi = {
      requestWindow: vi.fn(async () => { throw new DOMException('no user activation', 'NotAllowedError'); }),
      window: null,
    };
    await expect(openFloatingPlayer(api)).resolves.toBe(false);
    expect(useFloatingPlayerStore.getState().window).toBeNull();
    await expect(openFloatingPlayer(null)).resolves.toBe(false);
  });

  it('closes an open window from the toggle', async () => {
    const pip = fakeWindow();
    useFloatingPlayerStore.setState({ window: pip as unknown as Window });
    await expect(toggleFloatingPlayer()).resolves.toBe(false);
    expect(pip.close).toHaveBeenCalledTimes(1);
    expect(useFloatingPlayerStore.getState().window).toBeNull();
  });
});

describe('小窓プレイヤー setting', () => {
  function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: key => values.get(key) ?? null,
      key: index => [...values.keys()][index] ?? null,
      removeItem: key => { values.delete(key); },
      setItem: (key, value) => { values.set(key, value); },
    };
  }

  it('is on until turned off, per browser', () => {
    const storage = memoryStorage();
    expect(readFloatingPlayerEnabled(storage)).toBe(true);
    writeFloatingPlayerEnabled(false, storage);
    expect(storage.getItem(FLOATING_PLAYER_KEY)).toBe('0');
    expect(readFloatingPlayerEnabled(storage)).toBe(false);
    writeFloatingPlayerEnabled(true, storage);
    expect(readFloatingPlayerEnabled(storage)).toBe(true);
  });

  it('stays on when storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(readFloatingPlayerEnabled(broken)).toBe(true);
    expect(() => writeFloatingPlayerEnabled(false, broken)).not.toThrow();
  });
});
