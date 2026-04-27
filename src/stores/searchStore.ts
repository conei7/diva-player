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
      // まずアーティスト名として解決を試みる
      // 一致するアーティストが見つかればそのIDで曲を検索（曲名検索よりも正確）
      const artist = query.trim() ? await findArtistByName(query) : null;
      const artistId = artist?.id ?? null;

      const result = await searchSongs({
        query: artistId ? undefined : query,  // アーティストIDがあれば曲名クエリは不要
        artistId: artistId ?? undefined,
        sort,
        maxResults: PAGE_SIZE,
        start: 0,
        getTotalCount: true,
        onlyWithPVs: true,
      });

      set({
        results: result.items,
        totalCount: result.totalCount,
        resolvedArtistId: artistId,
        isLoading: false,
      });
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
