/**
 * Loading contract of the music layout's Home: a shelf that will almost certainly have cards keeps
 * its place with a skeleton while it loads (so the shelves and the feed below do not jump when it
 * arrives), and a shelf with nothing to show takes no space.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateCreator } from 'zustand';
import { useHistoryStore } from '../../../stores/historyStore';
import { usePlaylistStore } from '../../../stores/playlistStore';
import MusicHome from './MusicHome';
import { clearShelfCacheForTests } from './musicHomeShelves';

// The same current-snapshot stores as shelfCards.test.tsx, so each test's store state is rendered.
vi.mock('zustand', async importOriginal => {
  const actual = await importOriginal<typeof import('zustand')>();
  const { useSyncExternalStore } = await import('react');
  const createWithCurrentSnapshot = (createState: StateCreator<unknown>) => {
    const api = actual.createStore<unknown>(createState);
    const useBoundStore = (selector: (state: unknown) => unknown = state => state) => useSyncExternalStore(
      api.subscribe,
      () => selector(api.getState()),
      () => selector(api.getState()),
    );
    return Object.assign(useBoundStore, api);
  };
  const create = (createState?: StateCreator<unknown>) => (
    createState ? createWithCurrentSnapshot(createState) : createWithCurrentSnapshot
  );
  return { ...actual, create };
});

const initialHistoryState = useHistoryStore.getState();
const initialPlaylistState = usePlaylistStore.getState();

function render(): string {
  return renderToStaticMarkup(<MemoryRouter><MusicHome /></MemoryRouter>);
}

function count(html: string, text: string): number {
  return html.split(text).length - 1;
}

afterEach(() => {
  useHistoryStore.setState(initialHistoryState, true);
  usePlaylistStore.setState(initialPlaylistState, true);
  clearShelfCacheForTests();
});

describe('MusicHome while the shelves load', () => {
  it('keeps the place of 最近再生した曲 and of each network shelf, with one loading label', () => {
    useHistoryStore.setState({ hasHydrated: false, storedPlayCount: 12, entries: [] });
    usePlaylistStore.setState({ hasHydrated: false });
    const html = render();
    // Recent + 週間ランキング, 急上昇 and 新着 (no favourite producers, so no お気に入りP shelf).
    expect(count(html, 'data-testid="music-shelf-loading"')).toBe(4);
    expect(html).not.toContain('data-testid="music-shelf"');
    expect(html).not.toContain('aspect-square');
    expect(count(html, '読み込み中…')).toBe(1);
    expect(html).toMatch(/<span class="sr-only hidden group-has-\[\[data-testid=music-shelf-loading\]\]\/shelves:block">読み込み中…<\/span>/);
  });

  it('reserves nothing for 最近再生した曲 when no play is stored', () => {
    useHistoryStore.setState({ hasHydrated: false, storedPlayCount: 0, entries: [] });
    expect(count(render(), 'data-testid="music-shelf-loading"')).toBe(3);
    useHistoryStore.setState({ hasHydrated: false, storedPlayCount: null });
    expect(count(render(), 'data-testid="music-shelf-loading"')).toBe(3);
  });

  it('hides 最近再生した曲 once the loaded history turns out empty', () => {
    useHistoryStore.setState({ hasHydrated: true, storedPlayCount: 0, entries: [] });
    const html = render();
    expect(count(html, 'data-testid="music-shelf-loading"')).toBe(3);
    expect(html).not.toContain('data-shelf="recent"');
  });
});
