/**
 * Markup contract of the top bar's ≡ on phones. The standard layout shows it on the song page only (the
 * bottom nav has its own). The music layout also renders it off the song page with `music-nav-menu`:
 * index.css (area:music) shows it only under 560px wide and 420px tall while a song is loaded, where the
 * bottom nav steps aside, so the CSS alone decides and navigation can never be lost. Rendered to static
 * HTML with the media queries and the layout stubbed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useMediaQuery';

const view = vi.hoisted(() => ({ musicLayout: false, matches: new Set<string>() }));

vi.mock('../../hooks/useMusicLayout', () => ({ useIsMusicLayout: () => view.musicLayout }));
// Static rendering never matches a media query; these tests pick the ones that match.
vi.mock('../../hooks/useMediaQuery', async importOriginal => ({
  ...await importOriginal<typeof import('../../hooks/useMediaQuery')>(),
  useMediaQuery: (query: string) => view.matches.has(query),
}));

let TopNav: typeof import('./TopNav').default;
const localStorageValues = new Map<string, string>();

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    get length() { return localStorageValues.size; },
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageValues.set(key, value); },
    removeItem: (key: string) => { localStorageValues.delete(key); },
    key: (index: number) => [...localStorageValues.keys()][index] ?? null,
  });
  const { useLanguageStore } = await import('../../stores/languageStore');
  Object.assign(useLanguageStore.getInitialState(), { language: 'ja' });
  TopNav = (await import('./TopNav')).default;
});

beforeEach(() => {
  view.musicLayout = false;
  view.matches = new Set();
});

/** The opening tag of the top bar's ≡, or null when it is not rendered. */
function menuButton(path: string): string | null {
  const html = renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><TopNav /></MemoryRouter>);
  return html.match(/<button\b[^>]*aria-label="メニュー"[^>]*>/)?.[0] ?? null;
}

describe('TopNav ≡', () => {
  it('standard layout: on phones only on the song page', () => {
    view.matches = new Set([MOBILE_MEDIA_QUERY]);
    expect(menuButton('/')).toBeNull();
    expect(menuButton('/history')).toBeNull();
    const watch = menuButton('/watch?v=1');
    expect(watch).not.toBeNull();
    expect(watch).not.toContain('music-nav-menu');
  });

  it('music layout: phones off the song page render it for index.css to show (music-nav-menu), opening the drawer', () => {
    view.musicLayout = true;
    view.matches = new Set([MOBILE_MEDIA_QUERY]);
    for (const path of ['/', '/history', '/sound-map']) {
      const button = menuButton(path);
      expect(button).toContain('music-nav-menu');
      expect(button).toContain('aria-haspopup="dialog"');
      expect(button).toContain('aria-expanded="false"');
    }
    const watch = menuButton('/watch?v=1');
    expect(watch).not.toBeNull();
    expect(watch).not.toContain('music-nav-menu');
  });

  it('from 640px it is always shown, without the class, in both layouts', () => {
    for (const musicLayout of [false, true]) {
      view.musicLayout = musicLayout;
      for (const path of ['/', '/watch?v=1']) {
        const button = menuButton(path);
        expect(button).not.toBeNull();
        expect(button).not.toContain('music-nav-menu');
      }
    }
  });
});
