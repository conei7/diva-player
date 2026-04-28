/**
 * Search Store - 検索状態管理
 */

import { create } from 'zustand';
import type { Song, SongSortRule, VocalistMatchMode } from '../types/vocadb';
import { findArtistByName, searchSongs } from '../api/vocadb';

export interface VocalistFilter {
  id: number;
  name: string;
}

interface SearchState {
  // 検索パラメータ
  query: string;
  sort: SongSortRule;

  // アーティスト検索モード時に使うアーティストID（null = 曲名検索）
  resolvedArtistId: number | null;

  // ボーカリストフィルター
  vocalistFilters: VocalistFilter[];
  vocalistMatchMode: VocalistMatchMode;

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
  addVocalistFilter: (vocalist: VocalistFilter) => void;
  removeVocalistFilter: (id: number) => void;
  setVocalistMatchMode: (mode: VocalistMatchMode) => void;
  search: () => Promise<void>;
  loadMore: () => Promise<void>;
  reset: () => void;
}

const PAGE_SIZE = 24;

/** ボーカリストIDを使った曲検索の共通ヘルパー */
async function fetchByArtistIds(
  producerArtistId: number | undefined,
  vocalistFilters: VocalistFilter[],
  vocalistMatchMode: VocalistMatchMode,
  sort: SongSortRule,
  start: number,
  existingIds?: Set<number>,
): Promise<{ items: Song[]; totalCount: number }> {
  const producerIds = producerArtistId ? [producerArtistId] : [];

  if (vocalistMatchMode === 'Any' && vocalistFilters.length > 1) {
    // OR: vocalist ごとに並行リクエストしてマージ
    const results = await Promise.all(
      vocalistFilters.map(v =>
        searchSongs({
          artistIds: [...producerIds, v.id],
          sort,
          maxResults: PAGE_SIZE,
          start,
          getTotalCount: true,
          onlyWithPVs: true,
        }),
      ),
    );
    const seen = new Set<number>(existingIds);
    const merged: Song[] = [];
    for (const r of results) {
      for (const s of r.items) {
        if (!seen.has(s.id)) { seen.add(s.id); merged.push(s); }
      }
    }
    return {
      items: merged.slice(0, PAGE_SIZE),
      totalCount: results.reduce((sum, r) => sum + r.totalCount, 0),
    };
  }

  // AND (All / Exact / 1vocalist)
  const allIds = [...producerIds, ...vocalistFilters.map(v => v.id)];
  const result = await searchSongs({
    artistIds: allIds.length > 0 ? allIds : undefined,
    sort,
    maxResults: vocalistMatchMode === 'Exact' ? Math.min(PAGE_SIZE * 4, 100) : PAGE_SIZE,
    start,
    getTotalCount: true,
    onlyWithPVs: true,
  });

  if (vocalistMatchMode === 'Exact' && vocalistFilters.length > 0) {
    const filterIds = new Set(vocalistFilters.map(v => v.id));
    const filtered = result.items.filter(song => {
      const songVocIds = new Set(
        song.artists
          ?.filter(a => a.categories === 'Vocalist')
          .map(a => a.artist.id) ?? [],
      );
      return (
        filterIds.size === songVocIds.size &&
        [...filterIds].every(id => songVocIds.has(id))
      );
    });
    return { items: filtered.slice(0, PAGE_SIZE), totalCount: filtered.length };
  }

  return result;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  sort: 'FavoritedTimes',
  resolvedArtistId: null,
  vocalistFilters: [],
  vocalistMatchMode: 'All',
  results: [],
  totalCount: 0,
  currentPage: 0,
  isLoading: false,
  error: null,
  hasSearched: false,

  setQuery: (query: string) => set({ query }),
  setSort: (sort: SongSortRule) => set({ sort }),

  addVocalistFilter: (vocalist: VocalistFilter) => {
    const { vocalistFilters } = get();
    if (vocalistFilters.some(v => v.id === vocalist.id)) return;
    set({ vocalistFilters: [...vocalistFilters, vocalist] });
  },

  removeVocalistFilter: (id: number) => {
    const { vocalistFilters } = get();
    set({ vocalistFilters: vocalistFilters.filter(v => v.id !== id) });
  },

  setVocalistMatchMode: (mode: VocalistMatchMode) => set({ vocalistMatchMode: mode }),

  search: async () => {
    const { query, sort, vocalistFilters, vocalistMatchMode } = get();
    set({ isLoading: true, error: null, currentPage: 0, hasSearched: true, resolvedArtistId: null });

    try {
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

      const producerArtistId = artist?.id;

      if (vocalistFilters.length > 0) {
        const { items, totalCount } = await fetchByArtistIds(
          producerArtistId,
          vocalistFilters,
          vocalistMatchMode,
          sort,
          0,
        );
        set({
          results: items,
          totalCount,
          resolvedArtistId: producerArtistId ?? null,
          isLoading: false,
        });
      } else if (producerArtistId) {
        const artistResult = await searchSongs({
          artistIds: [producerArtistId],
          sort,
          maxResults: PAGE_SIZE,
          start: 0,
          getTotalCount: true,
          onlyWithPVs: true,
        });
        const artistSongIds = new Set(artistResult.items.map(s => s.id));
        const merged = [
          ...artistResult.items,
          ...titleResult.items.filter(s => !artistSongIds.has(s.id)),
        ];
        set({
          results: merged,
          totalCount: artistResult.totalCount,
          resolvedArtistId: producerArtistId,
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
    const {
      query, sort, results, currentPage, isLoading, totalCount,
      resolvedArtistId, vocalistFilters, vocalistMatchMode,
    } = get();
    if (isLoading || results.length >= totalCount) return;

    const nextPage = currentPage + 1;
    set({ isLoading: true });

    try {
      if (vocalistFilters.length > 0) {
        const existingIds = new Set(results.map(s => s.id));
        const { items } = await fetchByArtistIds(
          resolvedArtistId ?? undefined,
          vocalistFilters,
          vocalistMatchMode,
          sort,
          nextPage * PAGE_SIZE,
          existingIds,
        );
        set({ results: [...results, ...items], currentPage: nextPage, isLoading: false });
      } else {
        const result = await searchSongs({
          query: resolvedArtistId ? undefined : query,
          artistIds: resolvedArtistId ? [resolvedArtistId] : undefined,
          sort,
          maxResults: PAGE_SIZE,
          start: nextPage * PAGE_SIZE,
          getTotalCount: false,
          onlyWithPVs: true,
        });
        set({ results: [...results, ...result.items], currentPage: nextPage, isLoading: false });
      }
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
    vocalistFilters: [],
    results: [],
    totalCount: 0,
    currentPage: 0,
    isLoading: false,
    error: null,
    hasSearched: false,
  }),
}));