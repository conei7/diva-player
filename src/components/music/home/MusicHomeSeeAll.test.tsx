/**
 * 「すべて表示」 of the music layout's Home shelves: a network shelf that a HomeFeed chip continues in
 * the same order hands that chip to the feed below; お気に入りPの曲 (whose feed reranks) has none;
 * 最近再生した曲 and あなたのプレイリスト keep their page links.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateCreator } from 'zustand';
import { useFavoriteProducerStore } from '../../../stores/favoriteProducerStore';
import { useHistoryStore } from '../../../stores/historyStore';
import { usePlaylistStore } from '../../../stores/playlistStore';
import type { Song } from '../../../types/vocadb';
import MusicHome from './MusicHome';
import { networkShelfFeedCategory } from './musicHomeSources';
import type { SongShelfProps } from './SongShelf';

const fixtures = vi.hoisted(() => ({
  song: {
    id: 4242,
    name: 'Fixture song',
    defaultName: 'Fixture song',
    artistString: 'Fixture P feat. 初音ミク',
    artists: [],
    pvs: [],
    songType: 'Original',
  } as unknown as Song,
  shelves: [] as SongShelfProps[],
}));

// The shelves' props instead of their markup (SongShelf's markup is covered by shelfCards.test.tsx).
vi.mock('./SongShelf', () => ({
  default: (props: SongShelfProps) => {
    fixtures.shelves.push(props);
    return null;
  },
  SongShelfSkeleton: () => null,
}));

// Every network shelf has loaded one song.
vi.mock('./useShelfSongs', () => ({
  useShelfSongs: () => ({ songs: [fixtures.song], failed: false }),
}));

// The same current-snapshot stores as MusicHome.test.tsx, so each test's store state is rendered.
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

const initialFavoriteProducerState = useFavoriteProducerStore.getState();
const initialHistoryState = useHistoryStore.getState();
const initialPlaylistState = usePlaylistStore.getState();

function renderShelves(onShowFeedCategory?: (category: string) => void): Map<string, SongShelfProps> {
  fixtures.shelves.length = 0;
  renderToStaticMarkup(<MemoryRouter><MusicHome onShowFeedCategory={onShowFeedCategory} /></MemoryRouter>);
  return new Map(fixtures.shelves.map(shelf => [shelf.shelf, shelf]));
}

afterEach(() => {
  useFavoriteProducerStore.setState(initialFavoriteProducerState, true);
  useHistoryStore.setState(initialHistoryState, true);
  usePlaylistStore.setState(initialPlaylistState, true);
});

describe('networkShelfFeedCategory', () => {
  it('pairs each shelf with the chip whose feed starts with the same request in the same order', () => {
    expect(networkShelfFeedCategory('weekly')).toBe('ranking');
    expect(networkShelfFeedCategory('surge')).toBe('trending');
    expect(networkShelfFeedCategory('new')).toBe('recent');
    // The お気に入りP feed reranks with its own seed and asks for one producer more.
    expect(networkShelfFeedCategory('favoriteProducers')).toBeNull();
  });
});

describe('MusicHome すべて表示', () => {
  it('selects the matching feed chip from 週間ランキング, 急上昇 and 新着, not from お気に入りPの曲', () => {
    useFavoriteProducerStore.setState({ producers: [{ id: 77, name: 'Fixture P', artistType: 'Producer', createdAt: 0 }] });
    const onShowFeedCategory = vi.fn();
    const shelves = renderShelves(onShowFeedCategory);
    expect([...shelves.keys()]).toEqual(['weekly', 'surge', 'new', 'favoriteProducers']);

    for (const [shelf, category] of [['weekly', 'ranking'], ['surge', 'trending'], ['new', 'recent']] as const) {
      const props = shelves.get(shelf);
      expect(props?.seeAllTo).toBeUndefined();
      props?.onSeeAll?.();
      expect(onShowFeedCategory).toHaveBeenLastCalledWith(category);
    }
    expect(onShowFeedCategory).toHaveBeenCalledTimes(3);
    expect(shelves.get('favoriteProducers')?.onSeeAll).toBeUndefined();
    expect(shelves.get('favoriteProducers')?.seeAllTo).toBeUndefined();
  });

  it('has no feed button without a feed to hand the chip to', () => {
    const shelves = renderShelves();
    expect([...shelves.values()].some(shelf => shelf.onSeeAll)).toBe(false);
  });

  it('keeps the page links of 最近再生した曲 and あなたのプレイリスト', () => {
    useHistoryStore.setState({ hasHydrated: true, entries: [{ song: fixtures.song, playedAt: 1 }] });
    usePlaylistStore.setState({
      hasHydrated: true,
      playlists: [{ id: 'p1', name: 'Drive', songs: [fixtures.song], createdAt: 0, updatedAt: 0 }],
    });
    const shelves = renderShelves(vi.fn());
    for (const [shelf, page] of [['recent', '/history'], ['playlists', '/playlists']]) {
      expect(shelves.get(shelf)?.seeAllTo).toBe(page);
      expect(shelves.get(shelf)?.onSeeAll).toBeUndefined();
    }
  });
});
