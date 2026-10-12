/**
 * Search Store - 検索状態管理
 */

import { create } from 'zustand';
import type { ArtistType, Song, SongSortRule, SongType, VocalistMatchMode } from '../types/vocadb';
import {
  findArtistByName,
  resolveProducerByName,
  searchSongs,
  searchVocalistsByName,
  selectVocalistVariants,
} from '../api/vocadb';
import { getGlobalFilterSettings, type GlobalFilterSettings } from './globalFilterStore';
import { registerSearchReset } from './searchReset';
import { refreshSearchRandomSeed, searchSongsBackend } from '../search/searchBackendClient';
import type { SearchType } from '../utils/routes';
import {
  DEFAULT_ADVANCED_FILTERS,
  LOCAL_SORT_RULES,
  applyLocalSort,
  getSearchErrorMessage,
  hasAdvancedFilters,
  hasExactSongTitleMatch,
  hasGlobalSongFilters,
  requestedSongTypes,
  type AdvancedSearchFilters,
  type ExtendedSortRule,
  type SortOrder,
  type VocalistFilter,
} from '../search/searchModel';
export {
  ADVANCED_SEARCH_LIMITS,
  DEFAULT_ADVANCED_FILTERS,
  LOCAL_SORT_RULES,
  applyLocalSort,
  hasExactSongTitleMatch,
  hasGlobalSongFilters,
  sanitizeAdvancedIntegerInput,
  validateAdvancedSearchFilters,
} from '../search/searchModel';
export type {
  AdvancedSearchFilters,
  ExtendedSortRule,
  LocalSortRule,
  SortOrder,
  VocalistFilter,
} from '../search/searchModel';
export { searchSongsBackend } from '../search/searchBackendClient';

/**
 * Where the current results came from:
 * 'url' = `/?q=…&type=…` or `/?artistId=…` (HomePage resets it when the URL no longer has them),
 * 'advanced' = the advanced search dialog without a text query (tied to the history entry it opened),
 * 'direct' = a search started by calling the store directly (the legacy top-bar flow).
 */
export type SearchOrigin = 'url' | 'advanced' | 'direct';

/** The producer (or other artist) the results are limited to; shown as the producer header. */
export interface ResolvedSearchArtist {
  id: number;
  name: string;
  artistType?: ArtistType;
}

/** Identifies a URL-driven search so the same URL does not search twice. */
export function textSearchKey(query: string, type: SearchType = 'all'): string {
  return `q:${type}:${query.trim()}`;
}

export function artistSearchKey(artistId: number, artistRole?: string | null): string {
  return `artist:${artistId}:${artistRole ?? ''}`;
}

interface SearchState {
  // 検索パラメータ
  query: string;
  sort: ExtendedSortRule;
  sortOrder: SortOrder;
  /** すべて / 曲名 / ボカロP / ボーカル (the result-toolbar chips). */
  searchType: SearchType;
  searchOrigin: SearchOrigin | null;
  /** textSearchKey / artistSearchKey of the URL the current results belong to. */
  urlSearchKey: string | null;
  /** Router location key the URL search ran for (a new submit of the same URL searches again). */
  urlSearchLocationKey: string | null;
  resolvedArtist: ResolvedSearchArtist | null;
  /** Vocalists set by the ボーカル search mode itself (they are the query, not removable conditions). */
  modeVocalistIds: number[];

  // アーティスト検索モード時に使うアーティストID（null = 曲名検索）
  resolvedArtistId: number | null;
  artistRole: string | null;

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
  /** Clears vocalist, song-type and advanced conditions (sort and query stay). Does not search. */
  clearSearchConditions: () => void;
  search: () => Promise<void>;
  searchTitleOnly: (query: string) => Promise<void>;
  searchByArtistId: (artistId: number, artistName: string, artistRole?: string) => Promise<void>;
  /**
   * URL-driven text search (`/?q=…&type=…`): auto (title or producer), title only,
   * producer name → artist id (title search when no producer matches), or vocalist name → all of its
   * voicebank variants combined with Any (title search when no vocalist matches).
   */
  searchWithMode: (query: string, type?: SearchType, locationKey?: string) => Promise<void>;
  /** URL-driven song list of one artist (`/?artistId=…&artistName=…&artistRole=…`). */
  searchArtistFromUrl: (artistId: number, artistName: string, artistRole?: string, locationKey?: string) => Promise<void>;
  /** Re-runs the current search after the advanced search dialog applied its conditions. */
  applyAdvancedSearch: () => Promise<void>;
  loadMore: () => Promise<void>;
  reset: () => void;
}

const PAGE_SIZE = 24;

// ホームへ戻ったあと、古い非同期検索レスポンスが結果を復活させないための世代番号。
let searchGeneration = 0;
// P名・ボーカル名の解決は検索の前に走る。後から始まった検索を古い解決結果で上書きしないための世代番号。
let modeGeneration = 0;

type SearchMeta = Partial<Pick<
  SearchState,
  'searchType' | 'searchOrigin' | 'urlSearchKey' | 'urlSearchLocationKey' | 'resolvedArtist' | 'modeVocalistIds'
>>;

const DIRECT_SEARCH_META: SearchMeta = {
  searchOrigin: 'direct',
  urlSearchKey: null,
  urlSearchLocationKey: null,
  modeVocalistIds: [],
};

/**
 * Whether a failed search used advanced-search conditions (the dialog's filters and vocalists, or a
 * credit role): only then is the error 「いまは詳細検索を使えません」. A plain keyword search also goes
 * through the backend (for its default sort, for example) but just says 「検索できませんでした」.
 */
function usesAdvancedConditions(
  advancedFilters: AdvancedSearchFilters,
  artistRole: string | null | undefined,
  vocalistFilters: readonly VocalistFilter[] = [],
  modeVocalistIds: readonly number[] = [],
): boolean {
  return hasAdvancedFilters(advancedFilters)
    || Boolean(artistRole)
    // The ボーカル search mode's own vocalists are the query, not a condition.
    || vocalistFilters.some(filter => !modeVocalistIds.includes(filter.id));
}

/** ローカルソートをVocaDB APIソートに変換 */
function toApiSort(sort: ExtendedSortRule): SongSortRule {
  if (LOCAL_SORT_RULES.has(sort)) return 'FavoritedTimes';
  return sort as SongSortRule;
}

async function searchSongsPreferBackend(params: {
  query?: string;
  artistIds?: number[];
  artistRole?: string;
  sort: ExtendedSortRule;
  sortOrder: SortOrder;
  start: number;
  maxResults: number;
  songTypes?: SongType[];
  getTotalCount: boolean;
}): Promise<{ items: Song[]; totalCount: number }> {
  try {
    return await searchSongsBackend({
      query: params.query,
      artistIds: params.artistIds,
      artistRole: params.artistRole,
      sort: params.sort,
      sortOrder: params.sortOrder,
      start: params.start,
      maxResults: params.maxResults,
      songTypes: params.songTypes,
    });
  } catch (error) {
    if (params.artistRole) throw error;
    const fallback = await searchSongs({
      query: params.query,
      artistIds: params.artistIds,
      sort: toApiSort(params.sort),
      maxResults: params.maxResults,
      start: params.start,
      getTotalCount: params.getTotalCount,
      onlyWithPVs: true,
      songTypes: params.songTypes,
    });
    return {
      ...fallback,
      items: applyLocalSort(fallback.items, params.sort, params.sortOrder),
    };
  }
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
  artistRole?: string,
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
      artistRole,
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
        artistRole,
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
    if (artistRole
      || LOCAL_SORT_RULES.has(sort)
      || (filters ? hasAdvancedFilters(filters) : false)
      || (globalFilters ? hasGlobalSongFilters(globalFilters) : false)) {
      return searchSongsBackend({
        artistIds: allRequiredIds.length > 0 ? allRequiredIds : undefined,
        artistRole,
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
    const batch = hasVariantGroups || !!artistRole || LOCAL_SORT_RULES.has(sort)
      || (filters ? hasAdvancedFilters(filters) : false)
      || (globalFilters ? hasGlobalSongFilters(globalFilters) : false)
      ? await searchSongsBackend({
          artistIds: hasVariantGroups ? (producerIds.length > 0 ? producerIds : undefined) : (allIds.length > 0 ? allIds : undefined),
          anyArtistIds: hasVariantGroups ? vocalistFilters.map(v => v.id) : undefined,
          artistRole,
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
        vocBelongsToFilter(v.artist?.id ?? 0, v.name || v.artist?.name || ''),
      );

      // フィルターの各アーティストが、対応するボーカリストによって網羅されている
      const filterCovered = logicalFilterGroups.every(group =>
        group.some(f => songVocs.some(
          v => v.artist?.id === f.id || (v.name || v.artist?.name || '').startsWith(f.name),
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

export const useSearchStore = create<SearchState>((set, get) => {
  const runTitleOnly = async (query: string, meta: SearchMeta) => {
    const generation = ++searchGeneration;
    const { sort, sortOrder, songTypeFilter, advancedFilters } = get();
    const globalFilters = getGlobalFilterSettings();
    const trimmed = query.trim();
    set({
      ...meta,
      query: trimmed,
      isLoading: true,
      error: null,
      results: [],
      totalCount: 0,
      currentPage: 0,
      hasSearched: true,
      resolvedArtistId: null,
      artistRole: null,
      resolvedArtist: null,
      vocalistFilters: [],
      exactApiOffset: 0,
    });
    const songTypes = requestedSongTypes(songTypeFilter, advancedFilters);
    const useBackend = LOCAL_SORT_RULES.has(sort)
      || hasAdvancedFilters(advancedFilters)
      || hasGlobalSongFilters(globalFilters);
    try {
      const result = useBackend
        ? await searchSongsBackend({ query: trimmed, sort, sortOrder, start: 0, maxResults: PAGE_SIZE, songTypes, filters: advancedFilters, globalFilters })
        : await searchSongsPreferBackend({
            query: trimmed,
            sort,
            sortOrder,
            maxResults: PAGE_SIZE,
            start: 0,
            getTotalCount: true,
            songTypes,
          });

      if (generation !== searchGeneration) return;
      set({
        results: result.items,
        totalCount: result.totalCount,
        isLoading: false,
      });
    } catch (error) {
      if (generation !== searchGeneration) return;
      set({
        error: getSearchErrorMessage(error, usesAdvancedConditions(advancedFilters, null)),
        isLoading: false,
        results: [],
      });
    }
  };

  const runByArtistId = async (artistId: number, artistName: string, artistRole: string | undefined, meta: SearchMeta) => {
    const generation = ++searchGeneration;
    const { sort, sortOrder, songTypeFilter, advancedFilters } = get();
    const globalFilters = getGlobalFilterSettings();
    set({
      resolvedArtist: { id: artistId, name: artistName },
      ...meta,
      isLoading: true,
      error: null,
      results: [],
      totalCount: 0,
      currentPage: 0,
      hasSearched: true,
      resolvedArtistId: artistId,
      artistRole: artistRole || null,
      query: artistName,
      vocalistFilters: [],
      exactApiOffset: 0,
    });
    const songTypes = requestedSongTypes(songTypeFilter, advancedFilters);
    const useBackend = !!artistRole
      || LOCAL_SORT_RULES.has(sort)
      || hasAdvancedFilters(advancedFilters)
      || hasGlobalSongFilters(globalFilters);
    try {
      if (useBackend) {
        const result = await searchSongsBackend({
          artistIds: [artistId],
          artistRole,
          sort, sortOrder, start: 0, maxResults: PAGE_SIZE, songTypes, filters: advancedFilters, globalFilters
        });
        if (generation !== searchGeneration) return;
        set({ results: result.items, totalCount: result.totalCount, isLoading: false });
        return;
      }

      const result = await searchSongsPreferBackend({
        artistIds: [artistId],
        sort,
        sortOrder,
        maxResults: PAGE_SIZE,
        start: 0,
        getTotalCount: true,
        songTypes,
      });
      if (generation !== searchGeneration) return;
      set({ results: result.items, totalCount: result.totalCount, isLoading: false });
    } catch (error) {
      if (generation !== searchGeneration) return;
      set({ error: getSearchErrorMessage(error, usesAdvancedConditions(advancedFilters, artistRole)), isLoading: false, results: [] });
    }
  };

  const runSearch = async () => {
    const { query, searchType, resolvedArtistId, vocalistFilters } = get();
    // 曲名だけの検索は、並べ替えや詳細検索を変えた後も曲名だけで検索し直す。
    if (searchType === 'song' && !resolvedArtistId && vocalistFilters.length === 0 && query.trim()) {
      await runTitleOnly(query, {});
      return;
    }

    const generation = ++searchGeneration;
    const { sort, sortOrder, artistRole, vocalistMatchMode, songTypeFilter, advancedFilters, resolvedArtist } = get();
    const globalFilters = getGlobalFilterSettings();
    set({
      isLoading: true,
      error: null,
      results: [],
      totalCount: 0,
      currentPage: 0,
      hasSearched: true,
      resolvedArtistId,
    });
    const songTypes = requestedSongTypes(songTypeFilter, advancedFilters);
    const requiresBackend = !!artistRole
      || LOCAL_SORT_RULES.has(sort)
      || hasAdvancedFilters(advancedFilters)
      || hasGlobalSongFilters(globalFilters);
    try {
      const isLocal = requiresBackend;
      if (resolvedArtistId && vocalistFilters.length === 0) {
        const result = isLocal
          ? await searchSongsBackend({
              artistIds: [resolvedArtistId],
              artistRole: artistRole || undefined,
              sort,
              sortOrder,
              start: 0,
              maxResults: PAGE_SIZE,
              songTypes,
              filters: advancedFilters,
              globalFilters,
            })
          : await searchSongsPreferBackend({
              artistIds: [resolvedArtistId],
              sort,
              sortOrder,
              maxResults: PAGE_SIZE,
              start: 0,
              getTotalCount: true,
              songTypes,
            });
        if (generation !== searchGeneration) return;
        set({ results: result.items, totalCount: result.totalCount, isLoading: false });
        return;
      }

      const [artist, titleResult] = await Promise.all([
        findArtistByName(query),
        isLocal
          ? searchSongsBackend({ query, sort, sortOrder, start: 0, maxResults: PAGE_SIZE, songTypes, filters: advancedFilters, globalFilters })
          : searchSongsPreferBackend({
              query,
              sort,
              sortOrder,
              maxResults: PAGE_SIZE,
              start: 0,
              getTotalCount: true,
              songTypes,
            }),
      ]);

      // Keep an ID selected from a direct P/singer navigation when advanced
      // vocalist filters are added; name resolution is producer-only and can
      // otherwise drop a singer constraint.
      const producerArtistId = resolvedArtistId ?? artist?.id;
      const producerArtist: ResolvedSearchArtist | null = resolvedArtistId
        ? resolvedArtist
        : artist ? { id: artist.id, name: artist.name, artistType: artist.artistType } : null;
      const titleHasExactMatch = hasExactSongTitleMatch(titleResult.items, query);

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
          artistRole || undefined,
        );
        if (generation !== searchGeneration) return;
        set({
          results: isLocal ? items : applyLocalSort(items, sort, sortOrder),
          totalCount,
          resolvedArtistId: producerArtistId ?? null,
          resolvedArtist: producerArtist,
          exactApiOffset: nextApiStart ?? 0,
          isLoading: false,
        });
      } else if (producerArtistId && !titleHasExactMatch) {
        const artistResult = isLocal
          ? await searchSongsBackend({ artistIds: [producerArtistId], artistRole: artistRole || undefined, sort, sortOrder, start: 0, maxResults: PAGE_SIZE, songTypes, filters: advancedFilters, globalFilters })
          : await searchSongsPreferBackend({
              artistIds: [producerArtistId],
              sort,
              sortOrder,
              maxResults: PAGE_SIZE,
              start: 0,
              getTotalCount: true,
              songTypes,
            });
        // Once the query resolves to a producer, keep that producer search as
        // the authoritative result set. Merging a separate title page here
        // made results.length exceed artistResult.totalCount and stopped
        // pagination before all producer songs could be loaded.
        const merged = artistResult.items;
        if (generation !== searchGeneration) return;
        set({
          results: merged,
          totalCount: artistResult.totalCount,
          resolvedArtistId: producerArtistId,
          resolvedArtist: producerArtist,
          isLoading: false,
        });
      } else {
        // Auto mode is ambiguous when a query is both a song title and a
        // producer alias (for example シャルル / シャルルP). An exact song
        // title wins; users can still force the producer through P mode.
        if (generation !== searchGeneration) return;
        set({
          results: titleResult.items,
          totalCount: titleResult.totalCount,
          resolvedArtistId: null,
          resolvedArtist: null,
          isLoading: false,
        });
      }
    } catch (error) {
      if (generation !== searchGeneration) return;
      set({
        error: getSearchErrorMessage(
          error,
          usesAdvancedConditions(advancedFilters, artistRole, vocalistFilters, get().modeVocalistIds),
        ),
        isLoading: false,
        results: [],
      });
    }
  };

  return {
    query: '',
    sort: 'TotalViews' as ExtendedSortRule,
    sortOrder: 'desc' as SortOrder,
    searchType: 'all',
    searchOrigin: null,
    urlSearchKey: null,
    urlSearchLocationKey: null,
    resolvedArtist: null,
    modeVocalistIds: [],
    resolvedArtistId: null,
    artistRole: null,
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

    // Typing a new query leaves an artist-detail result behind otherwise; the
    // next submit would keep searching the previously resolved artist.
    setQuery: (query: string) => {
      modeGeneration += 1;
      set({
        ...DIRECT_SEARCH_META,
        query,
        searchType: 'all',
        resolvedArtistId: null,
        artistRole: null,
        resolvedArtist: null,
      });
    },

    setSort: (sort: ExtendedSortRule) => {
      if (sort === 'Random') refreshSearchRandomSeed();
      set({ sort });
    },
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

    clearSearchConditions: () => set(state => ({
      // The vocalists of the ボーカル search mode are the query itself, not a removable condition.
      vocalistFilters: state.vocalistFilters.filter(filter => state.modeVocalistIds.includes(filter.id)),
      songTypeFilter: 'All',
      advancedFilters: DEFAULT_ADVANCED_FILTERS,
    })),

    searchTitleOnly: async (query: string) => {
      modeGeneration += 1;
      await runTitleOnly(query, { ...DIRECT_SEARCH_META, searchType: 'song' });
    },

    searchByArtistId: async (artistId: number, artistName: string, artistRole?: string) => {
      modeGeneration += 1;
      await runByArtistId(artistId, artistName, artistRole, { ...DIRECT_SEARCH_META, searchType: 'producer' });
    },

    search: async () => {
      modeGeneration += 1;
      await runSearch();
    },

    searchWithMode: async (rawQuery: string, type: SearchType = 'all', locationKey?: string) => {
      const trimmed = rawQuery.trim();
      const generation = ++modeGeneration;
      const meta: SearchMeta = {
        searchOrigin: 'url',
        searchType: type,
        urlSearchKey: textSearchKey(trimmed, type),
        urlSearchLocationKey: locationKey ?? null,
        modeVocalistIds: [],
      };
      // Vocalists chosen by the ボーカル mode belong to that query; another mode starts without them.
      const previousModeVocalists = new Set(get().modeVocalistIds);
      const keptVocalists = get().vocalistFilters.filter(filter => !previousModeVocalists.has(filter.id));

      if (type === 'song') {
        await runTitleOnly(trimmed, meta);
        return;
      }

      if (type === 'producer' || type === 'vocalist') {
        // Show the loading state while the name resolves instead of the previous results.
        searchGeneration += 1;
        set({
          ...meta,
          query: trimmed,
          isLoading: true,
          error: null,
          results: [],
          totalCount: 0,
          currentPage: 0,
          hasSearched: true,
          resolvedArtistId: null,
          artistRole: null,
          resolvedArtist: null,
          vocalistFilters: keptVocalists,
          exactApiOffset: 0,
        });
        try {
          if (type === 'producer') {
            const producer = await resolveProducerByName(trimmed);
            if (generation !== modeGeneration) return;
            if (producer) {
              await runByArtistId(producer.id, producer.name, undefined, {
                ...meta,
                resolvedArtist: { id: producer.id, name: producer.name, artistType: producer.artistType },
              });
            } else {
              await runTitleOnly(trimmed, meta);
            }
            return;
          }

          const vocalists = selectVocalistVariants(await searchVocalistsByName(trimmed, 50), trimmed);
          if (generation !== modeGeneration) return;
          if (vocalists.length === 0) {
            await runTitleOnly(trimmed, meta);
            return;
          }
          const vocalistIds = new Set(vocalists.map(vocalist => vocalist.id));
          set({
            query: '',
            vocalistFilters: [
              ...keptVocalists.filter(filter => !vocalistIds.has(filter.id)),
              ...vocalists.map(vocalist => ({
                id: vocalist.id,
                name: vocalist.name,
                variantGroup: vocalists.length > 1 ? trimmed : undefined,
              })),
            ],
            vocalistMatchMode: vocalists.length > 1 ? 'Any' : 'All',
            modeVocalistIds: [...vocalistIds],
          });
          await runSearch();
        } catch (error) {
          if (generation !== modeGeneration) return;
          searchGeneration += 1;
          set({ error: getSearchErrorMessage(error, false), isLoading: false, results: [] });
        }
        return;
      }

      set({
        ...meta,
        query: trimmed,
        resolvedArtistId: null,
        artistRole: null,
        resolvedArtist: null,
        vocalistFilters: keptVocalists,
      });
      await runSearch();
    },

    searchArtistFromUrl: async (artistId: number, artistName: string, artistRole?: string, locationKey?: string) => {
      modeGeneration += 1;
      await runByArtistId(artistId, artistName, artistRole, {
        searchOrigin: 'url',
        searchType: 'all',
        urlSearchKey: artistSearchKey(artistId, artistRole),
        urlSearchLocationKey: locationKey ?? null,
        modeVocalistIds: [],
      });
    },

    applyAdvancedSearch: async () => {
      modeGeneration += 1;
      const { searchOrigin, hasSearched } = get();
      if (searchOrigin !== 'url' || !hasSearched) {
        set({ searchOrigin: 'advanced', urlSearchKey: null, urlSearchLocationKey: null });
      }
      await runSearch();
    },

    loadMore: async () => {
      const generation = searchGeneration;
      const {
        query, sort, sortOrder, results, currentPage, isLoading, totalCount,
        resolvedArtistId, artistRole, vocalistFilters, vocalistMatchMode, exactApiOffset, songTypeFilter,
        advancedFilters,
      } = get();
      const globalFilters = getGlobalFilterSettings();
      if (isLoading || results.length >= totalCount) return;

      const nextPage = currentPage + 1;
      const songTypes = requestedSongTypes(songTypeFilter, advancedFilters);
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
            artistRole || undefined,
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
            || !!artistRole
            || hasAdvancedFilters(advancedFilters)
            || hasGlobalSongFilters(globalFilters);
          const result = useBackend
            ? await searchSongsBackend({
                query: resolvedArtistId ? undefined : query,
                artistIds: resolvedArtistId ? [resolvedArtistId] : undefined,
                artistRole: resolvedArtistId ? (artistRole || undefined) : undefined,
                sort, sortOrder, start: nextPage * PAGE_SIZE, maxResults: PAGE_SIZE, songTypes, filters: advancedFilters, globalFilters
              })
            : await searchSongsPreferBackend({
                query: resolvedArtistId ? undefined : query,
                artistIds: resolvedArtistId ? [resolvedArtistId] : undefined,
                sort,
                sortOrder,
                maxResults: PAGE_SIZE,
                start: nextPage * PAGE_SIZE,
                getTotalCount: false,
                songTypes,
              });
          if (generation !== searchGeneration) return;
          set({
            results: [...results, ...result.items],
            currentPage: nextPage,
            isLoading: false
          });
        }
      } catch (error) {
        if (generation !== searchGeneration) return;
        set({
          error: getSearchErrorMessage(
            error,
            usesAdvancedConditions(advancedFilters, artistRole, vocalistFilters, get().modeVocalistIds),
          ),
          isLoading: false,
        });
      }
    },

    reset: () => {
      searchGeneration += 1;
      modeGeneration += 1;
      set({
        query: '',
        sort: 'TotalViews' as ExtendedSortRule,
        sortOrder: 'desc' as SortOrder,
        searchType: 'all',
        searchOrigin: null,
        urlSearchKey: null,
        urlSearchLocationKey: null,
        resolvedArtist: null,
        modeVocalistIds: [],
        resolvedArtistId: null,
        artistRole: null,
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
  };
});

// The frame resets the search through this without importing the store (see searchReset.ts).
registerSearchReset(() => useSearchStore.getState().reset());
