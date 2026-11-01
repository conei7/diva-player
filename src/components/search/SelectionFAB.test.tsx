/**
 * The global selection bar (home / search, history, rated songs, song page) chooses its text or icon
 * actions by the bar's own width (a container query on SelectionBar), not the viewport: in the music
 * layout the bar is only the space between the library and the 再生中 panel. Static HTML, no DOM.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Song } from '../../types/vocadb';

let SelectionFAB: typeof import('./SelectionFAB').default;
let useSelectionStore: typeof import('../../stores/selectionStore').useSelectionStore;
let useLanguageStore: typeof import('../../stores/languageStore').useLanguageStore;
let ensureEnglishTranslations: typeof import('../../stores/languageStore').ensureEnglishTranslations;
const localStorageValues = new Map<string, string>();

function makeSong(id: number): Song {
  return { id, name: `Fixture song ${id}`, artistString: 'Fixture P', pvs: [] } as unknown as Song;
}

/** Server rendering reads zustand's initial state, so the fixtures are written into it as well. */
function setStore<T extends object>(store: { setState: (state: Partial<T>) => void; getInitialState: () => T }, state: Partial<T>) {
  store.setState(state);
  Object.assign(store.getInitialState(), state);
}

function select(songs: Song[]) {
  setStore(useSelectionStore, {
    isSelectionMode: true,
    selectedSongIds: new Set(songs.map(song => song.id)),
    selectedSongs: new Map(songs.map(song => [song.id, song])),
  });
}

const ICON_SET = /<div class="flex items-center sm:gap-2 @min-\[(\d+(?:\.\d+)?)rem\]:hidden">/;
const TEXT_SET = /<div class="hidden items-center gap-2 @min-\[(\d+(?:\.\d+)?)rem\]:flex">/;

/** The two action sets in the bar's HTML (neither has a nested <div>; the ⋮ comes after both). */
function sets(html: string) {
  const icon = html.match(ICON_SET);
  const text = html.match(TEXT_SET);
  if (!icon || icon.index === undefined || !text || text.index === undefined) throw new Error('No action sets');
  return {
    iconThreshold: Number(icon[1]),
    textThreshold: Number(text[1]),
    icon: html.slice(icon.index, text.index),
    text: html.slice(text.index, html.indexOf('</div>', text.index)),
  };
}

/**
 * Label widths in px measured in Chrome with the app's fonts (Inter + Noto Sans JP, weight 500):
 * the count at 16px with tabular digits and a 5-digit number, the button labels at 14px.
 */
const LABEL_WIDTHS = {
  ja: { count: 131.9, selectAll: 68.5, queue: 84, save: 126 },
  en: { count: 121.4, selectAll: 60.6, queue: 89.6, save: 100.7 },
};

/**
 * Content width of the text set from the classes: × (size-10), the count, すべて選択 (sm: px-3),
 * the two md Buttons with an icon (pl-3 + 20px icon + gap-1.5 + label + pr-4) and ⋮ (size-10),
 * gap-2 between them all. The bar's px-4 is outside the content box the container query reads.
 */
function textSetWidth({ count, selectAll, queue, save }: typeof LABEL_WIDTHS.ja): number {
  const gap = 8;
  return 40 + gap + count + gap + (24 + selectAll) + gap + (54 + queue) + gap + (54 + save) + gap + 40;
}

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    get length() { return localStorageValues.size; },
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageValues.set(key, value); },
    removeItem: (key: string) => { localStorageValues.delete(key); },
    key: (index: number) => [...localStorageValues.keys()][index] ?? null,
  });
  ({ useSelectionStore } = await import('../../stores/selectionStore'));
  ({ useLanguageStore, ensureEnglishTranslations } = await import('../../stores/languageStore'));
  setStore(useLanguageStore, { language: 'ja' });
  SelectionFAB = (await import('./SelectionFAB')).default;
});

afterEach(() => {
  setStore(useLanguageStore, { language: 'ja' });
  setStore(useSelectionStore, { isSelectionMode: false, selectedSongIds: new Set(), selectedSongs: new Map() });
});

describe('SelectionFAB', () => {
  it('renders nothing outside selection mode', () => {
    expect(renderToStaticMarkup(<SelectionFAB visibleSongs={[]} />)).toBe('');
  });

  it('switches between icon and text actions at one bar width, with a single ⋮', () => {
    const songs = [makeSong(1), makeSong(2)];
    select(songs);
    const html = renderToStaticMarkup(<SelectionFAB visibleSongs={songs} />);
    expect(html).toMatch(/^<div[^>]*class="@container fixed /);
    expect(html).toContain('2曲を選択中');

    const { iconThreshold, textThreshold, icon, text } = sets(html);
    // One threshold: exactly one set is shown at any width (display:none takes the other out of the tab order).
    expect(iconThreshold).toBe(textThreshold);
    expect(icon).toContain('aria-label="キューに追加"');
    expect(icon).toContain('aria-label="プレイリストに保存"');
    expect(icon).not.toMatch(/<span class="min-w-0 truncate">/);
    expect(text).toContain('<span class="min-w-0 truncate">キューに追加</span>');
    expect(text).toContain('<span class="min-w-0 truncate">プレイリストに保存</span>');
    expect(text).not.toContain('aria-label=');
    expect(html.match(/aria-label="その他の操作"/g)).toHaveLength(1);
    expect(html).not.toContain('disabled=""');
  });

  it('shows the text set only where all of it fits, and never on phones', () => {
    select([makeSong(1)]);
    const { textThreshold } = sets(renderToStaticMarkup(<SelectionFAB visibleSongs={[]} />));
    const thresholdPx = textThreshold * 16;
    for (const widths of Object.values(LABEL_WIDTHS)) expect(thresholdPx).toBeGreaterThanOrEqual(textSetWidth(widths));
    // Below 640px the bar spans the viewport with px-1, so its content box is at most 631px.
    expect(thresholdPx).toBeGreaterThan(639 - 8);
  });

  it('disables both sets while nothing is selected', () => {
    select([]);
    const { icon, text } = sets(renderToStaticMarkup(<SelectionFAB visibleSongs={[]} />));
    expect(icon.match(/<button\b[^>]*disabled=""/g)).toHaveLength(2);
    expect(text.match(/<button\b[^>]*disabled=""/g)).toHaveLength(2);
  });

  it('translates both sets in English', async () => {
    await ensureEnglishTranslations();
    setStore(useLanguageStore, { language: 'en' });
    select([makeSong(1), makeSong(2)]);
    const html = renderToStaticMarkup(<SelectionFAB visibleSongs={[]} />);
    const { icon, text } = sets(html);
    expect(html).toContain('2 selected');
    expect(icon).toContain('aria-label="Add to queue"');
    expect(icon).toContain('aria-label="Save to playlist"');
    expect(text).toContain('>Add to queue</span>');
    expect(text).toContain('>Save to playlist</span>');
  });
});
