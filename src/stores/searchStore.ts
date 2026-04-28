/**
 * Search Store - 検索状態管理
 */

import { create } from 'zustand';
import type { Song, SongSortRule, SongType, VocalistMatchMode } from '../types/vocadb';
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

  // 曲タイプフィルター（カバー・リミックスを除外するために使用）
  // 'All' = 全曲種, 'Original' = オリジナル曲のみ
  songTypeFilter: 'All' | 'Original';

  // 結果
  results: Song[];
  totalCount: number;
  currentPage: number;

  // 完全一致モード専用: 次のAPI取得開始位置
  exactApiOffset: number;

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
  setSongTypeFilter: (filter: 'All' | 'Original') => void;
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
  songTypes?: SongType[],
): Promise<{ items: Song[]; totalCount: number; nextApiStart?: number }> {
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
          songTypes,
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

  // AND (All / 1vocalist)
  if (vocalistMatchMode !== 'Exact') {
    const allIds = [...producerIds, ...vocalistFilters.map(v => v.id)];
    const result = await searchSongs({
      artistIds: allIds.length > 0 ? allIds : undefined,
      sort,
      maxResults: PAGE_SIZE,
      start,
      getTotalCount: true,
      onlyWithPVs: true,
      songTypes,
    });
    return result;
  }

  // === 完全一致 (Exact) ===
  // 指定したボーカリストのみが歌っている曲を検索。
  // VocaDB API にはネイティブの完全一致フィルターがないため、
  // バッチ取得→クライアントフィルターをループし、
  // PAGE_SIZE 件が揃うまで繰り返す。
  const filterIds = new Set(vocalistFilters.map(v => v.id));
  const filterNames = vocalistFilters.map(v => v.name);
  const allIds = [...producerIds, ...vocalistFilters.map(v => v.id)];
  const seen = new Set<number>(existingIds);
  const matched: Song[] = [];
  let apiOffset = start;
  const BATCH = 100;

  // バリアント（初音ミク V3 (Solid) 等）も含めて、
  // そのボーカリストが選択済みアーティストに属するか判定するヘルパー
  const vocBelongsToFilter = (vocId: number, vocDisplayName: string): boolean => {
    if (filterIds.has(vocId)) return true;
    // 表示名の前方一致でバリアントを判定（例: "初音ミク V3 (Solid)" → "初音ミク" に属する）
    return filterNames.some(fname => vocDisplayName.startsWith(fname));
  };

  // PAGE_SIZE 件見つかるまで、または API 結果が尽きるまでループ
  outer: while (matched.length < PAGE_SIZE) {
    const batch = await searchSongs({
      artistIds: allIds.length > 0 ? allIds : undefined,
      sort,
      maxResults: BATCH,
      start: apiOffset,
      getTotalCount: false,
      onlyWithPVs: true,
      songTypes,
    });

    if (batch.items.length === 0) break;

    for (const song of batch.items) {
      apiOffset++;

      if (seen.has(song.id)) continue;
      seen.add(song.id);

      // isSupport=true のサポートボーカルは「ソロ判定」から除外する
      const songVocs = song.artists?.filter(a => a.categories === 'Vocalist' && !a.isSupport) ?? [];

      // 曲の全ボーカリストがフィルターのいずれかのアーティスト（またはそのバリアント）に属する
      const allBelongToFilter = songVocs.every(v =>
        vocBelongsToFilter(v.artist.id, v.name || v.artist.name || ''),
      );

      // フィルターの各アーティストが、対応するボーカリストによって網羅されている
      const filterCovered = vocalistFilters.every(f =>
        songVocs.some(
          v => v.artist.id === f.id ||
            (v.name || v.artist.name || '').startsWith(f.name),
        ),
      );

      if (allBelongToFilter && filterCovered) {
        matched.push(song);
        if (matched.length >= PAGE_SIZE) break outer; // 24件揃ったら即終了
      }
    }

    if (batch.items.length < BATCH) break; // API の結果が尽きた
  }

  const exhausted = matched.length < PAGE_SIZE;
  return {
    items: matched,
    // まだ続きがある可能性がある場合は totalCount を大きく見積もることで
    // 「もっと読み込む」ボタンを表示し続ける
    totalCount: exhausted ? matched.length : apiOffset + 1,
    nextApiStart: apiOffset,
  };
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  sort: 'FavoritedTimes',
  resolvedArtistId: null,
  vocalistFilters: [],
  vocalistMatchMode: 'All',
  songTypeFilter: 'All',
  results: [],
  totalCount: 0,
  currentPage: 0,
  exactApiOffset: 0,
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

  setSongTypeFilter: (filter: 'All' | 'Original') => set({ songTypeFilter: filter }),

  search: async () => {
    const { query, sort, vocalistFilters, vocalistMatchMode, songTypeFilter } = get();
    set({ isLoading: true, error: null, currentPage: 0, hasSearched: true, resolvedArtistId: null });
    const songTypes = songTypeFilter === 'Original' ? ['Original' as const] : undefined;

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
          songTypes,
        }),
      ]);

      const producerArtistId = artist?.id;

      if (vocalistFilters.length > 0) {
        const { items, totalCount, nextApiStart } = await fetchByArtistIds(
          producerArtistId,
          vocalistFilters,
          vocalistMatchMode,
          sort,
          0,
          undefined,
          songTypes,
        );
        set({
          results: items,
          totalCount,
          resolvedArtistId: producerArtistId ?? null,
          exactApiOffset: nextApiStart ?? 0,
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
          songTypes,
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
      resolvedArtistId, vocalistFilters, vocalistMatchMode, exactApiOffset, songTypeFilter,
    } = get();
    if (isLoading || results.length >= totalCount) return;

    const nextPage = currentPage + 1;
    const songTypes = songTypeFilter === 'Original' ? ['Original' as const] : undefined;
    set({ isLoading: true });

    try {
      if (vocalistFilters.length > 0) {
        const existingIds = new Set(results.map(s => s.id));
        // 完全一致モードは正しいAPI offset から継続する
        const apiStart = vocalistMatchMode === 'Exact'
          ? exactApiOffset
          : nextPage * PAGE_SIZE;
        const { items, nextApiStart } = await fetchByArtistIds(
          resolvedArtistId ?? undefined,
          vocalistFilters,
          vocalistMatchMode,
          sort,
          apiStart,
          existingIds,
          songTypes,
        );
        set({
          results: [...results, ...items],
          currentPage: nextPage,
          exactApiOffset: nextApiStart ?? exactApiOffset,
          isLoading: false,
        });
      } else {
        const result = await searchSongs({
          query: resolvedArtistId ? undefined : query,
          artistIds: resolvedArtistId ? [resolvedArtistId] : undefined,
          sort,
          maxResults: PAGE_SIZE,
          start: nextPage * PAGE_SIZE,
          getTotalCount: false,
          onlyWithPVs: true,
          songTypes,
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
    songTypeFilter: 'All',
    results: [],
    totalCount: 0,
    currentPage: 0,
    exactApiOffset: 0,
    isLoading: false,
    error: null,
    hasSearched: false,
  }),
}));