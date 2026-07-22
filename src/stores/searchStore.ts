/**
 * Search Store - 検索状態管理
 */

import { create } from 'zustand';
import type { Song, SongSortRule, SongType, VocalistMatchMode } from '../types/vocadb';
import { findArtistByName, searchSongs } from '../api/vocadb';
import { getGlobalFilterSettings, type GlobalFilterSettings } from './globalFilterStore';
const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';

// VocaDB APIに存在しないローカルソート種別
export type LocalSortRule = 'YoutubeViews' | 'NicoViews' | 'TotalViews';
export type ExtendedSortRule = SongSortRule | LocalSortRule;

export const LOCAL_SORT_RULES = new Set<ExtendedSortRule>(['YoutubeViews', 'NicoViews', 'TotalViews']);
export type SortOrder = 'desc' | 'asc';

/** ローカルソートを適用する */
export function applyLocalSort(songs: Song[], sort: ExtendedSortRule, order: SortOrder = 'desc'): Song[] {
  const dir = order === 'asc' ? 1 : -1;
  if (LOCAL_SORT_RULES.has(sort)) {
    return [...songs].sort((a, b) => {
      if (sort === 'YoutubeViews') return dir * ((a.youtubeViews ?? 0) - (b.youtubeViews ?? 0));
      if (sort === 'NicoViews')   return dir * ((a.nicoViews ?? 0) - (b.nicoViews ?? 0));
      if (sort === 'TotalViews')  return dir * (((a.youtubeViews ?? 0) + (a.nicoViews ?? 0)) - ((b.youtubeViews ?? 0) + (b.nicoViews ?? 0)));
      return 0;
    });
  }
  // VocaDB APIソート: APIは常に降順なので昇順の場合は配列を反転
  if (order === 'asc') return [...songs].reverse();
  return songs;
}

export interface VocalistFilter {
  id: number;
  name: string;
  variantGroup?: string;
}

export interface AdvancedSearchFilters {
  publishYearFrom: string;
  publishYearTo: string;
  lengthMinSeconds: string;
  lengthMaxSeconds: string;
  pvService: 'any' | 'youtube' | 'niconico' | 'both';
  audioComputed: 'any' | 'yes' | 'no';
}

// PostgreSQLのdate型が扱える上限と、DBのlength_seconds(int)に合わせる。
export const ADVANCED_SEARCH_LIMITS = {
  publishYearMin: 1,
  publishYearMax: 5_874_896,
  lengthMinSeconds: 0,
  lengthMaxSeconds: 2_147_483_647,
} as const;

export const DEFAULT_ADVANCED_FILTERS: AdvancedSearchFilters = {
  publishYearFrom: '',
  publishYearTo: '',
  lengthMinSeconds: '',
  lengthMaxSeconds: '',
  pvService: 'any',
  audioComputed: 'any',
};

export function sanitizeAdvancedIntegerInput(value: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (!/^\d+$/.test(trimmed)) return '';
  const numeric = Number(trimmed);
  if (!Number.isSafeInteger(numeric)) return String(max);
  return String(Math.min(max, Math.max(min, numeric)));
}

function validateAdvancedInteger(value: string, label: string, min: number, max: number): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return `${label}は${min}以上${max.toLocaleString()}以下の整数で指定してください。`;
  const numeric = Number(trimmed);
  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
    return `${label}は${min}以上${max.toLocaleString()}以下の整数で指定してください。`;
  }
  return null;
}

export function validateAdvancedSearchFilters(filters: AdvancedSearchFilters): string | null {
  const yearFromError = validateAdvancedInteger(
    filters.publishYearFrom,
    '投稿年',
    ADVANCED_SEARCH_LIMITS.publishYearMin,
    ADVANCED_SEARCH_LIMITS.publishYearMax,
  );
  if (yearFromError) return yearFromError;
  const yearToError = validateAdvancedInteger(
    filters.publishYearTo,
    '投稿年',
    ADVANCED_SEARCH_LIMITS.publishYearMin,
    ADVANCED_SEARCH_LIMITS.publishYearMax,
  );
  if (yearToError) return yearToError;
  const lengthFromError = validateAdvancedInteger(
    filters.lengthMinSeconds,
    '曲の長さ',
    ADVANCED_SEARCH_LIMITS.lengthMinSeconds,
    ADVANCED_SEARCH_LIMITS.lengthMaxSeconds,
  );
  if (lengthFromError) return lengthFromError;
  const lengthToError = validateAdvancedInteger(
    filters.lengthMaxSeconds,
    '曲の長さ',
    ADVANCED_SEARCH_LIMITS.lengthMinSeconds,
    ADVANCED_SEARCH_LIMITS.lengthMaxSeconds,
  );
  if (lengthToError) return lengthToError;

  const yearFrom = filters.publishYearFrom.trim() ? Number(filters.publishYearFrom) : null;
  const yearTo = filters.publishYearTo.trim() ? Number(filters.publishYearTo) : null;
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) return '投稿年の開始値は終了値以下にしてください。';
  const lengthFrom = filters.lengthMinSeconds.trim() ? Number(filters.lengthMinSeconds) : null;
  const lengthTo = filters.lengthMaxSeconds.trim() ? Number(filters.lengthMaxSeconds) : null;
  if (lengthFrom !== null && lengthTo !== null && lengthFrom > lengthTo) return '曲の長さの開始値は終了値以下にしてください。';
  return null;
}

function hasAdvancedFilters(filters: AdvancedSearchFilters): boolean {
  return filters.publishYearFrom.trim() !== ''
    || filters.publishYearTo.trim() !== ''
    || filters.lengthMinSeconds.trim() !== ''
    || filters.lengthMaxSeconds.trim() !== ''
    || filters.pvService !== 'any'
    || filters.audioComputed !== 'any';
}

export function hasGlobalSongFilters(settings: GlobalFilterSettings): boolean {
  return settings.enabled
    && (settings.minYoutubeViews > 0
      || settings.minNicoViews > 0
      || settings.excludedSongTypes.length > 0);
}

function getSearchErrorMessage(error: unknown, requiresBackend: boolean): string {
  if (error instanceof Error && (error.message.includes('指定してください') || error.message.includes('以下にしてください'))) return error.message;
  if (requiresBackend) {
    return 'SBCのデータサービスに接続できないため、詳細検索と外部再生数順は現在利用できません。';
  }
  return error instanceof Error ? error.message : '検索中にエラーが発生しました';
}

interface SearchState {
  // 検索パラメータ
  query: string;
  sort: ExtendedSortRule;
  sortOrder: SortOrder;

  // アーティスト検索モード時に使うアーティストID（null = 曲名検索）
  resolvedArtistId: number | null;

  // ボーカリストフィルター
  vocalistFilters: VocalistFilter[];
  vocalistMatchMode: VocalistMatchMode;

  // 曲タイプフィルター（カバー・リミックスを除外するために使用）
  // 'All' = 全曲種, 'Original' = オリジナル曲のみ
  songTypeFilter: 'All' | 'Original';
  advancedFilters: AdvancedSearchFilters;

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
  setSort: (sort: ExtendedSortRule) => void;
  setSortOrder: (order: SortOrder) => void;
  setResolvedArtistId: (id: number | null) => void;
  addVocalistFilter: (vocalist: VocalistFilter) => void;
  setVocalistFilters: (vocalists: VocalistFilter[]) => void;
  removeVocalistFilter: (id: number) => void;
  setVocalistMatchMode: (mode: VocalistMatchMode) => void;
  setSongTypeFilter: (filter: 'All' | 'Original') => void;
  setAdvancedFilters: (filters: Partial<AdvancedSearchFilters>) => void;
  resetAdvancedFilters: () => void;
  search: () => Promise<void>;
  searchTitleOnly: (query: string) => Promise<void>;
  searchByArtistId: (artistId: number, artistName: string) => Promise<void>;
  loadMore: () => Promise<void>;
  reset: () => void;
}

const PAGE_SIZE = 24;

// ホームへ戻ったあと、古い非同期検索レスポンスが結果を復活させないための世代番号。
let searchGeneration = 0;

/** ローカルソートをVocaDB APIソートに変換 */
function toApiSort(sort: ExtendedSortRule): SongSortRule {
  if (LOCAL_SORT_RULES.has(sort)) return 'FavoritedTimes';
  return sort as SongSortRule;
}

/** バックエンドのカスタム検索APIを呼び出す */
export async function searchSongsBackend(params: {
  query?: string;
  artistIds?: number[];
  anyArtistIds?: number[];
  artistIdGroups?: number[][];
  songTypes?: SongType[];
  sort: ExtendedSortRule;
  sortOrder: SortOrder;
  start: number;
  maxResults: number;
  filters?: AdvancedSearchFilters;
  globalFilters?: GlobalFilterSettings;
}): Promise<{ items: Song[]; totalCount: number }> {
  const validationError = params.filters ? validateAdvancedSearchFilters(params.filters) : null;
  if (validationError) throw new Error(validationError);
  const qs = new URLSearchParams();
  if (params.query) qs.set('query', params.query);
  if (params.artistIds && params.artistIds.length > 0) qs.set('artistIds', params.artistIds.join(','));
  if (params.anyArtistIds && params.anyArtistIds.length > 0) qs.set('anyArtistIds', params.anyArtistIds.join(','));
  if (params.artistIdGroups && params.artistIdGroups.length > 0) {
    qs.set('artistIdGroups', params.artistIdGroups.map(group => group.join(',')).join('|'));
  }
  if (params.songTypes && params.songTypes.length > 0) qs.set('songTypes', params.songTypes.join(','));
  qs.set('sort', params.sort);
  qs.set('order', params.sortOrder);
  qs.set('start', params.start.toString());
  qs.set('maxResults', params.maxResults.toString());
  if (params.filters) {
    const f = params.filters;
    if (f.publishYearFrom.trim()) qs.set('publishYearFrom', f.publishYearFrom.trim());
    if (f.publishYearTo.trim()) qs.set('publishYearTo', f.publishYearTo.trim());
    if (f.lengthMinSeconds.trim()) qs.set('lengthMinSeconds', f.lengthMinSeconds.trim());
    if (f.lengthMaxSeconds.trim()) qs.set('lengthMaxSeconds', f.lengthMaxSeconds.trim());
    if (f.pvService !== 'any') qs.set('pvService', f.pvService);
    if (f.audioComputed !== 'any') qs.set('audioComputed', f.audioComputed);
  }
  if (params.globalFilters && hasGlobalSongFilters(params.globalFilters)) {
    const f = params.globalFilters;
    if (f.minYoutubeViews > 0) qs.set('minYoutubeViews', f.minYoutubeViews.toString());
    if (f.minNicoViews > 0) qs.set('minNicoViews', f.minNicoViews.toString());
    if (f.excludedSongTypes.length > 0) qs.set('excludeSongTypes', f.excludedSongTypes.join(','));
  }

  const res = await fetch(`${RECOMMENDER_API}/api/songs/search?${qs.toString()}`);
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}

/** ボーカリストIDを使った曲検索の共通ヘルパー */
async function fetchByArtistIds(
  producerArtistId: number | undefined,
  vocalistFilters: VocalistFilter[],
  vocalistMatchMode: VocalistMatchMode,
  sort: ExtendedSortRule,
  sortOrder: SortOrder,
  start: number,
  existingIds?: Set<number>,
  songTypes?: SongType[],
  filters?: AdvancedSearchFilters,
  globalFilters?: GlobalFilterSettings,
): Promise<{ items: Song[]; totalCount: number; nextApiStart?: number }> {
  const apiSort = toApiSort(sort);
  const producerIds = producerArtistId ? [producerArtistId] : [];
  const variantGroups = new Map<string, VocalistFilter[]>();
  const ungroupedFilters: VocalistFilter[] = [];
  for (const filter of vocalistFilters) {
    if (!filter.variantGroup) {
      ungroupedFilters.push(filter);
      continue;
    }
    const group = variantGroups.get(filter.variantGroup) ?? [];
    group.push(filter);
    variantGroups.set(filter.variantGroup, group);
  }
  const logicalFilterGroups = [
    ...ungroupedFilters.map(filter => [filter]),
    ...variantGroups.values(),
  ];

  if (vocalistMatchMode === 'Any' && vocalistFilters.length > 1) {
    // PostgreSQL側でボーカリストIDをOR結合し、重複除外・全体ソート・ページングを正しく行う。
    return searchSongsBackend({
      artistIds: producerIds.length > 0 ? producerIds : undefined,
      anyArtistIds: vocalistFilters.map(v => v.id),
      sort,
      sortOrder,
      start,
      maxResults: PAGE_SIZE,
      songTypes,
      filters,
      globalFilters,
    });
  }

  // AND (All / 1vocalist)
  if (vocalistMatchMode !== 'Exact') {
    const allIds = [...producerIds, ...ungroupedFilters.map(v => v.id)];
    const artistIdGroups = [...variantGroups.values()].map(group => group.map(filter => filter.id));
    if (artistIdGroups.length > 0) {
      return searchSongsBackend({
        artistIds: allIds.length > 0 ? allIds : undefined,
        artistIdGroups,
        sort,
        sortOrder,
        start,
        maxResults: PAGE_SIZE,
        songTypes,
        filters,
        globalFilters,
      });
    }
    const allRequiredIds = [...producerIds, ...vocalistFilters.map(v => v.id)];
    if (LOCAL_SORT_RULES.has(sort)
      || (filters ? hasAdvancedFilters(filters) : false)
      || (globalFilters ? hasGlobalSongFilters(globalFilters) : false)) {
      return searchSongsBackend({
        artistIds: allRequiredIds.length > 0 ? allRequiredIds : undefined,
        sort, sortOrder, start, maxResults: PAGE_SIZE, songTypes, filters, globalFilters
      });
    }
    const result = await searchSongs({
      artistIds: allRequiredIds.length > 0 ? allRequiredIds : undefined,
      sort: apiSort,
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
  const hasVariantGroups = variantGroups.size > 0;
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
    const batch = hasVariantGroups || LOCAL_SORT_RULES.has(sort)
      || (filters ? hasAdvancedFilters(filters) : false)
      || (globalFilters ? hasGlobalSongFilters(globalFilters) : false)
      ? await searchSongsBackend({
          artistIds: hasVariantGroups ? (producerIds.length > 0 ? producerIds : undefined) : (allIds.length > 0 ? allIds : undefined),
          anyArtistIds: hasVariantGroups ? vocalistFilters.map(v => v.id) : undefined,
          sort, sortOrder, start: apiOffset, maxResults: BATCH, songTypes, filters, globalFilters
        })
      : await searchSongs({
          artistIds: allIds.length > 0 ? allIds : undefined,
          sort: apiSort,
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
      const filterCovered = logicalFilterGroups.every(group =>
        group.some(f => songVocs.some(
          v => v.artist.id === f.id || (v.name || v.artist.name || '').startsWith(f.name),
        )),
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
  sort: 'FavoritedTimes' as ExtendedSortRule,
  sortOrder: 'desc' as SortOrder,
  resolvedArtistId: null,
  vocalistFilters: [],
  vocalistMatchMode: 'All',
  songTypeFilter: 'All',
  advancedFilters: DEFAULT_ADVANCED_FILTERS,
  results: [],
  totalCount: 0,
  currentPage: 0,
  exactApiOffset: 0,
  isLoading: false,
  error: null,
  hasSearched: false,

  setQuery: (query: string) => set({ query }),

  setSort: (sort: ExtendedSortRule) => set({ sort }),
  setSortOrder: (order: SortOrder) => set({ sortOrder: order }),

  setResolvedArtistId: (id: number | null) => set({ resolvedArtistId: id }),

  addVocalistFilter: (vocalist: VocalistFilter) => {
    const { vocalistFilters } = get();
    if (vocalistFilters.some(v => v.id === vocalist.id)) return;
    set({ vocalistFilters: [...vocalistFilters, vocalist] });
  },

  setVocalistFilters: (vocalists: VocalistFilter[]) => set({ vocalistFilters: vocalists }),

  removeVocalistFilter: (id: number) => {
    const { vocalistFilters } = get();
    set({ vocalistFilters: vocalistFilters.filter(v => v.id !== id) });
  },

  setVocalistMatchMode: (mode: VocalistMatchMode) => set({ vocalistMatchMode: mode }),

  setSongTypeFilter: (filter: 'All' | 'Original') => set({ songTypeFilter: filter }),
  setAdvancedFilters: (filters: Partial<AdvancedSearchFilters>) => set((state) => ({
    advancedFilters: { ...state.advancedFilters, ...filters },
  })),
  resetAdvancedFilters: () => set({ advancedFilters: DEFAULT_ADVANCED_FILTERS }),

  searchTitleOnly: async (query: string) => {
    const generation = ++searchGeneration;
    const { sort, sortOrder, songTypeFilter, advancedFilters } = get();
    const globalFilters = getGlobalFilterSettings();
    const trimmed = query.trim();
    set({
      query: trimmed,
      isLoading: true,
      error: null,
      currentPage: 0,
      hasSearched: true,
      resolvedArtistId: null,
      vocalistFilters: [],
      exactApiOffset: 0,
    });
    const songTypes = songTypeFilter === 'Original' ? ['Original' as const] : undefined;
    const apiSort = toApiSort(sort);
    const useBackend = LOCAL_SORT_RULES.has(sort)
      || hasAdvancedFilters(advancedFilters)
      || hasGlobalSongFilters(globalFilters);
    try {
      const result = useBackend
        ? await searchSongsBackend({ query: trimmed, sort, sortOrder, start: 0, maxResults: PAGE_SIZE, songTypes, filters: advancedFilters, globalFilters })
        : await searchSongs({
            query: trimmed,
            sort: apiSort,
            maxResults: PAGE_SIZE,
            start: 0,
            getTotalCount: true,
            onlyWithPVs: true,
            songTypes,
          });

      if (generation !== searchGeneration) return;
      set({
        results: useBackend ? result.items : applyLocalSort(result.items, sort, sortOrder),
        totalCount: result.totalCount,
        isLoading: false,
      });
    } catch (error) {
      if (generation !== searchGeneration) return;
      set({
        error: getSearchErrorMessage(error, useBackend),
        isLoading: false,
        results: [],
      });
    }
  },

  searchByArtistId: async (artistId: number, artistName: string) => {
    const generation = ++searchGeneration;
    const { sort, sortOrder, songTypeFilter, advancedFilters } = get();
    const globalFilters = getGlobalFilterSettings();
    set({ isLoading: true, error: null, currentPage: 0, hasSearched: true, resolvedArtistId: artistId, query: artistName });
    const songTypes = songTypeFilter === 'Original' ? ['Original' as const] : undefined;
    const useBackend = LOCAL_SORT_RULES.has(sort)
      || hasAdvancedFilters(advancedFilters)
      || hasGlobalSongFilters(globalFilters);
    try {
      if (useBackend) {
        const result = await searchSongsBackend({
          artistIds: [artistId],
          sort, sortOrder, start: 0, maxResults: PAGE_SIZE, songTypes, filters: advancedFilters, globalFilters
        });
        if (generation !== searchGeneration) return;
        set({ results: result.items, totalCount: result.totalCount, isLoading: false });
        return;
      }
      
      const result = await searchSongs({
        artistIds: [artistId],
        sort: toApiSort(sort),
        maxResults: PAGE_SIZE,
        start: 0,
        getTotalCount: true,
        onlyWithPVs: true,
        songTypes,
      });
      if (generation !== searchGeneration) return;
      set({ results: applyLocalSort(result.items, sort, sortOrder), totalCount: result.totalCount, isLoading: false });
    } catch (error) {
      if (generation !== searchGeneration) return;
      set({ error: getSearchErrorMessage(error, useBackend), isLoading: false, results: [] });
    }
  },

  search: async () => {
    const generation = ++searchGeneration;
    const { query, sort, sortOrder, vocalistFilters, vocalistMatchMode, songTypeFilter, advancedFilters } = get();
    const globalFilters = getGlobalFilterSettings();
    set({ isLoading: true, error: null, currentPage: 0, hasSearched: true, resolvedArtistId: null });
    const songTypes = songTypeFilter === 'Original' ? ['Original' as const] : undefined;
    const apiSort = toApiSort(sort);
    const requiresBackend = LOCAL_SORT_RULES.has(sort)
      || hasAdvancedFilters(advancedFilters)
      || hasGlobalSongFilters(globalFilters);
    try {
      const isLocal = requiresBackend;
      const [artist, titleResult] = await Promise.all([
        findArtistByName(query),
        isLocal
          ? searchSongsBackend({ query, sort, sortOrder, start: 0, maxResults: PAGE_SIZE, songTypes, filters: advancedFilters, globalFilters })
          : searchSongs({
              query,
              sort: apiSort,
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
          sortOrder,
          0,
          undefined,
          songTypes,
          advancedFilters,
          globalFilters,
        );
        if (generation !== searchGeneration) return;
        set({
          results: isLocal ? items : applyLocalSort(items, sort, sortOrder),
          totalCount,
          resolvedArtistId: producerArtistId ?? null,
          exactApiOffset: nextApiStart ?? 0,
          isLoading: false,
        });
      } else if (producerArtistId) {
        const artistResult = isLocal
          ? await searchSongsBackend({ artistIds: [producerArtistId], sort, sortOrder, start: 0, maxResults: PAGE_SIZE, songTypes, filters: advancedFilters, globalFilters })
          : await searchSongs({
              artistIds: [producerArtistId],
              sort: apiSort,
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
        if (generation !== searchGeneration) return;
        set({
          results: isLocal ? merged : applyLocalSort(merged, sort, sortOrder),
          totalCount: artistResult.totalCount,
          resolvedArtistId: producerArtistId,
          isLoading: false,
        });
      } else {
        if (generation !== searchGeneration) return;
        set({
          results: isLocal ? titleResult.items : applyLocalSort(titleResult.items, sort, sortOrder),
          totalCount: titleResult.totalCount,
          resolvedArtistId: null,
          isLoading: false,
        });
      }
    } catch (error) {
      if (generation !== searchGeneration) return;
      set({
        error: getSearchErrorMessage(error, requiresBackend),
        isLoading: false,
        results: [],
      });
    }
  },

  loadMore: async () => {
    const generation = searchGeneration;
    const {
      query, sort, sortOrder, results, currentPage, isLoading, totalCount,
      resolvedArtistId, vocalistFilters, vocalistMatchMode, exactApiOffset, songTypeFilter,
      advancedFilters,
    } = get();
    const globalFilters = getGlobalFilterSettings();
    if (isLoading || results.length >= totalCount) return;

    const nextPage = currentPage + 1;
    const songTypes = songTypeFilter === 'Original' ? ['Original' as const] : undefined;
    set({ isLoading: true });

    try {
      if (vocalistFilters.length > 0) {
        const existingIds = new Set(results.map(s => s.id));
        const apiStart = vocalistMatchMode === 'Exact'
          ? exactApiOffset
          : nextPage * PAGE_SIZE;
        const { items, nextApiStart } = await fetchByArtistIds(
          resolvedArtistId ?? undefined,
          vocalistFilters,
          vocalistMatchMode,
          sort,
          sortOrder,
          apiStart,
          existingIds,
          songTypes,
          advancedFilters,
          globalFilters,
        );
        if (generation !== searchGeneration) return;
        set({
          results: LOCAL_SORT_RULES.has(sort) ? [...results, ...items] : applyLocalSort([...results, ...items], sort, sortOrder),
          currentPage: nextPage,
          exactApiOffset: nextApiStart ?? exactApiOffset,
          isLoading: false,
        });
      } else {
        const useBackend = LOCAL_SORT_RULES.has(sort)
          || hasAdvancedFilters(advancedFilters)
          || hasGlobalSongFilters(globalFilters);
        const result = useBackend
          ? await searchSongsBackend({
              query: resolvedArtistId ? undefined : query,
              artistIds: resolvedArtistId ? [resolvedArtistId] : undefined,
              sort, sortOrder, start: nextPage * PAGE_SIZE, maxResults: PAGE_SIZE, songTypes, filters: advancedFilters, globalFilters
            })
          : await searchSongs({
              query: resolvedArtistId ? undefined : query,
              artistIds: resolvedArtistId ? [resolvedArtistId] : undefined,
              sort: toApiSort(sort),
              maxResults: PAGE_SIZE,
              start: nextPage * PAGE_SIZE,
              getTotalCount: false,
              onlyWithPVs: true,
              songTypes,
            });
        if (generation !== searchGeneration) return;
        set({
          results: useBackend ? [...results, ...result.items] : applyLocalSort([...results, ...result.items], sort, sortOrder),
          currentPage: nextPage,
          isLoading: false
        });
      }
    } catch (error) {
      if (generation !== searchGeneration) return;
      set({
        error: getSearchErrorMessage(error, LOCAL_SORT_RULES.has(sort) || hasAdvancedFilters(advancedFilters) || hasGlobalSongFilters(globalFilters)),
        isLoading: false,
      });
    }
  },

  reset: () => {
    searchGeneration += 1;
    set({
      query: '',
      resolvedArtistId: null,
      vocalistFilters: [],
      songTypeFilter: 'All',
      advancedFilters: DEFAULT_ADVANCED_FILTERS,
      results: [],
      totalCount: 0,
      currentPage: 0,
      exactApiOffset: 0,
      isLoading: false,
      error: null,
      hasSearched: false,
    });
  },
}));
