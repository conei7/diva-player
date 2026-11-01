/**
 * Markup contract of the song page's action row: on phones it scrolls sideways with its scrollbar
 * hidden, so a fade marks each side with more actions past it; from 640px it wraps beside the
 * producers exactly as before. Rendered to static HTML with the measured overflow stubbed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HorizontalOverflow } from '../../hooks/useHorizontalOverflow';
import type { Song } from '../../types/vocadb';

const measured = vi.hoisted(() => ({ overflow: { start: false, end: false } as HorizontalOverflow }));

vi.mock('../../hooks/useHorizontalOverflow', () => ({
  useHorizontalOverflow: () => [() => undefined, measured.overflow],
}));

let ActionBar: typeof import('./ActionBar').default;
const localStorageValues = new Map<string, string>();

const song = {
  id: 1501,
  name: 'Fixture song',
  artistString: 'Fixture P feat. 初音ミク',
  artists: [],
  defaultName: 'Fixture song',
  lengthSeconds: 225,
  pvs: [],
} as unknown as Song;

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
  ActionBar = (await import('./ActionBar')).default;
});

beforeEach(() => {
  measured.overflow = { start: false, end: false };
});

function render(overflow: HorizontalOverflow): string {
  measured.overflow = overflow;
  return renderToStaticMarkup(<ActionBar song={song} />);
}

/** The opening tag of the element with this attribute (e.g. `data-edge-fade="end"`). */
function tag(html: string, attribute: string): string | null {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.match(new RegExp(`<[a-z]+\\b[^>]*${escaped}[^>]*>`))?.[0] ?? null;
}

function classes(openingTag: string | null): string[] {
  return openingTag?.match(/class="([^"]*)"/)?.[1]?.split(' ') ?? [];
}

describe('ActionBar', () => {
  it('keeps the row itself as the sm+ flex item: the wrapper is `contents` from 640px', () => {
    const html = render({ start: false, end: false });
    const wrapper = classes(html.match(/^<div\b[^>]*>/)?.[0] ?? null);
    expect(wrapper).toEqual(expect.arrayContaining(['sm:contents', 'max-sm:relative', 'max-sm:-mx-3']));
    expect(wrapper).not.toContain('relative');

    // Phones: the row runs edge to edge inside the wrapper and scrolls; sm+: it wraps, unchanged.
    const row = classes(tag(html, 'data-testid="watch-action-bar"'));
    expect(row).toEqual(expect.arrayContaining(['flex', 'min-w-0', 'max-sm:overflow-x-auto', 'max-sm:px-3', 'sm:flex-wrap']));
    expect(row.some(name => name.includes('-mx-'))).toBe(false);
    // Tab stops an action clear of the fades (w-3 at the start, w-8 at the end).
    expect(row).toEqual(expect.arrayContaining(['max-sm:scroll-pl-3', 'max-sm:scroll-pr-8']));
    // The scroll box clips vertically too: 4px above and below for the focus rings, net height unchanged.
    expect(row).toEqual(expect.arrayContaining(['max-sm:-my-1', 'max-sm:py-1']));
  });

  it('shows no fade while the row fits or wraps', () => {
    const html = render({ start: false, end: false });
    expect(html).not.toContain('data-edge-fade');
  });

  it('fades only the end before scrolling, when most actions are off screen', () => {
    const html = render({ start: false, end: true });
    expect(tag(html, 'data-edge-fade="start"')).toBeNull();
    const fade = tag(html, 'data-edge-fade="end"');
    expect(fade).toContain('aria-hidden="true"');
    expect(classes(fade)).toEqual(expect.arrayContaining([
      'pointer-events-none', 'absolute', 'inset-y-0', 'right-0', 'bg-linear-to-l', 'from-yt-bg', 'to-transparent', 'sm:hidden',
    ]));
  });

  it('fades only the start once scrolled to the end, so 表示しない is clear', () => {
    const html = render({ start: true, end: false });
    expect(tag(html, 'data-edge-fade="end"')).toBeNull();
    const fade = tag(html, 'data-edge-fade="start"');
    expect(fade).toContain('aria-hidden="true"');
    expect(classes(fade)).toEqual(expect.arrayContaining([
      'pointer-events-none', 'absolute', 'inset-y-0', 'left-0', 'w-3', 'bg-linear-to-r', 'from-yt-bg', 'to-transparent', 'sm:hidden',
    ]));
  });

  it('puts the fades after the row, outside it: above the pills, not among the actions', () => {
    const html = render({ start: true, end: true });
    const lastAction = html.lastIndexOf('表示しない') + '表示しない'.length;
    expect(html.indexOf('data-testid="watch-action-bar"')).toBeGreaterThan(0);
    // 表示しない's label and button close, then the row closes, then the fades follow.
    expect(html.slice(lastAction, html.indexOf('data-edge-fade="start"')))
      .toBe('</span></button></div><div aria-hidden="true" ');
    expect(html.indexOf('data-edge-fade="end"')).toBeGreaterThan(html.indexOf('data-edge-fade="start"'));
    expect(html.endsWith('</div></div>')).toBe(true);
  });
});
