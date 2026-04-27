/**
 * Search Store - 検索状態管理
 */

import { create } from 'zustand';
import type { Song, SongSortRule } from '../types/vocadb';
import { findArtistByName, searchSongs } from '../api/vocadb';

interface SearchState {
  // 検索パラメータ
  query: string;
  sort: SongSortRule;

  // アーティスト検索モード時に使うアーティストID（null = 曲名検索）
  resolvedArtistId: number | null;

  // 結果
  results: Song[];
  totalCount: number;
  currentPage: number;

  // UI状態
  isLoading: boolean;
  error: string | null;
  hasSearched: boolean;

  // アクション
  setQuery: (query: string) => void;
  setSort: (sort: SongSortRule) => void;
  search: () => Promise<void>;
  loadMore: () => Promise<void>;
  reset: () => void;
}

const PAGE_SIZE = 24;

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  sort: 'FavoritedTimes',
  resolvedArtistId: null,
  results: [],
  totalCount: 0,
  currentPage: 0,
  isLoading: false,
  error: null,
  hasSearched: false,

  setQuery: (query: string) => set({ query }),
  setSort: (sort: SongSortRule) => set({ sort }),

  search: async () => {
    const { query, sort } = get();
    set({ isLoading: true, error: null, currentPage: 0, hasSearched: true, resolvedArtistId: null });

    try {
      // アーティスト検索と曲タイトル検索を並行実行して結果をマージ
      const [artist, titleResult] = await Promise.all([
        findArtistByName(query),
        searchSongs({
          query,
          sort,
          maxResults: PAGE_SIZE,
          start: 0,
          getTotalCount: true,
          onlyWithPVs: true,
        }),
      ]);

      if (artist) {
        // アーティストが見つかった場合: そのアーティストの曲を優先して表示
        const artistResult = await searchSongs({
          artistId: artist.id,
          sort,
          maxResults: PAGE_SIZE,
          start: 0,
          getTotalCount: true,
          onlyWithPVs: true,
        });

        // アーティストの曲を先頭に、タイトル検索の重複していない曲を末尾に追加
        const artistSongIds = new Set(artistResult.items.map(s => s.id));
        const merged = [
          ...artistResult.items,
          ...titleResult.items.filter(s => !artistSongIds.has(s.id)),
        ];

        set({
          results: merged,
          totalCount: artistResult.totalCount,
          resolvedArtistId: artist.id,
          isLoading: false,
        });
      } else {
        set({
          results: titleResult.items,
          totalCount: titleResult.totalCount,
          resolvedArtistId: null,
          isLoading: false,
        });
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '検索中にエラーが発生しました',
        isLoading: false,
        results: [],
      });
    }
  },

  loadMore: async () => {
    const { query, sort, results, currentPage, isLoading, totalCount, resolvedArtistId } = get();
    if (isLoading || results.length >= totalCount) return;

    const nextPage = currentPage + 1;
    set({ isLoading: true });

    try {
      const result = await searchSongs({
        query: resolvedArtistId ? undefined : query,
        artistId: resolvedArtistId ?? undefined,
        sort,
        maxResults: PAGE_SIZE,
        start: nextPage * PAGE_SIZE,
        getTotalCount: false,
        onlyWithPVs: true,
      });

      set({
        results: [...results, ...result.items],
        currentPage: nextPage,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '追加読み込み中にエラーが発生しました',
        isLoading: false,
      });
    }
  },

  reset: () => set({
    query: '',
    resolvedArtistId: null,
    results: [],
    totalCount: 0,
    currentPage: 0,
    isLoading: false,
    error: null,
    hasSearched: false,
  }),
}));
