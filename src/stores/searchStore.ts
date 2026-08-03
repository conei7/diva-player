/**
 * Search Store - 検索状態管理
 */

import { create } from 'zustand';
import type { Song, SongSortRule, SongType, VocalistMatchMode } from '../types/vocadb';
import { findArtistByName, searchSongs } from '../api/vocadb';
import { getGlobalFilterSettings, type GlobalFilterSettings } from './globalFilterStore';
import { AsyncTtlCache } from '../utils/asyncTtlCache';
import { parseServerTiming, performanceNow, recordPerformanceMetric, type PerformanceSegment } from '../utils/performanceMetrics';
const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';
const BACKEND_SEARCH_CACHE_TTL = 60_000;
const backendSearchCache = new AsyncTtlCache(BACKEND_SEARCH_CACHE_TTL, 100);

// VocaDB APIに存在しないローカルソート種別
export type LocalSortRule = 'YoutubeViews' | 'NicoViews' | 'TotalViews' | 'Random';
export type ExtendedSortRule = SongSortRule | LocalSortRule;

export const LOCAL_SORT_RULES = new Set<ExtendedSortRule>(['YoutubeViews', 'NicoViews', 'TotalViews', 'Random']);
let searchRandomSeed = Math.floor(Math.random() * 2_147_483_647);
export type SortOrder = 'desc' | 'asc';

/** ローカルソートを適用する */
export function applyLocalSort(songs: Song[], sort: ExtendedSortRule, order: SortOrder = 'desc'): Song[] {
  const dir = order === 'asc' ? 1 : -1;
  if (sort === 'TotalViews') {
    // 月次学習したYouTube↔ニコニコ換算係数はAPI側だけが正本。
    // APIが返した重み付き合計順をブラウザで単純加算して上書きしない。
    return songs;
  }
  if (sort === 'YoutubeViews' || sort === 'NicoViews') {
    return [...songs].sort((a, b) => {
      if (sort === 'YoutubeViews') return dir * ((a.youtubeViews ?? 0) - (b.youtubeViews ?? 0));
      if (sort === 'NicoViews')   return dir * ((a.nicoViews ?? 0) - (b.nicoViews ?? 0));
      return 0;
    });
  }
  // VocaDB APIソート: APIは常に降順なので昇順の場合は配列を反転
  if (order === 'asc') return [...songs].reverse();
  return songs;
}

function normalizeExactSearchText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP');
}

/** 自動検索で、推測したP名より優先すべき完全一致の曲名があるかを判定する。 */
export function hasExactSongTitleMatch(songs: readonly Song[], query: string): boolean {
  const normalizedQuery = normalizeExactSearchText(query);
  if (!normalizedQuery) return false;
  return songs.some(song => [song.name, song.defaultName]
    .some(title => normalizeExactSearchText(title) === normalizedQuery));
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
  minYoutubeViews: string;
  maxYoutubeViews: string;
  minNicoViews: string;
  maxNicoViews: string;
  minFavoritedTimes: string;
  maxFavoritedTimes: string;
  includedSongTypes: SongType[];
  tagFilters: { id: number; name: string }[];
  tagMatchMode: 'all' | 'any';
  creditArtist: { id: number; name: string } | null;
  creditRole: string;
}

// PostgreSQLのdate型が扱える上限と、DBのlength_seconds(int)に合わせる。
export const ADVANCED_SEARCH_LIMITS = {
  publishYearMin: 1,
  publishYearMax: 5_874_896,
  lengthMinSeconds: 0,
  lengthMaxSeconds: 2_147_483_647,
  viewCountMin: 0,
  viewCountMax: Number.MAX_SAFE_INTEGER,
  favoriteCountMin: 0,
  favoriteCountMax: 2_147_483_647,
} as const;

export const DEFAULT_ADVANCED_FILTERS: AdvancedSearchFilters = {
  publishYearFrom: '',
  publishYearTo: '',
  lengthMinSeconds: '',
  lengthMaxSeconds: '',
  pvService: 'any',
  audioComputed: 'any',
  minYoutubeViews: '',
  maxYoutubeViews: '',
  minNicoViews: '',
  maxNicoViews: '',
  minFavoritedTimes: '',
  maxFavoritedTimes: '',
  includedSongTypes: [],
  tagFilters: [],
  tagMatchMode: 'all',
  creditArtist: null,
  creditRole: '',
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
  for (const [value, label, max] of [
    [filters.minYoutubeViews, 'YouTube再生数', ADVANCED_SEARCH_LIMITS.viewCountMax],
    [filters.maxYoutubeViews, 'YouTube再生数', ADVANCED_SEARCH_LIMITS.viewCountMax],
    [filters.minNicoViews, 'ニコニコ再生数', ADVANCED_SEARCH_LIMITS.viewCountMax],
    [filters.maxNicoViews, 'ニコニコ再生数', ADVANCED_SEARCH_LIMITS.viewCountMax],
    [filters.minFavoritedTimes, 'VocaDB支持数', ADVANCED_SEARCH_LIMITS.favoriteCountMax],
    [filters.maxFavoritedTimes, 'VocaDB支持数', ADVANCED_SEARCH_LIMITS.favoriteCountMax],
  ] as const) {
    const error = validateAdvancedInteger(value, label, 0, max);
    if (error) return error;
  }

  const yearFrom = filters.publishYearFrom.trim() ? Number(filters.publishYearFrom) : null;
  const yearTo = filters.publishYearTo.trim() ? Number(filters.publishYearTo) : null;
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) return '投稿年の開始値は終了値以下にしてください。';
  const lengthFrom = filters.lengthMinSeconds.trim() ? Number(filters.lengthMinSeconds) : null;
  const lengthTo = filters.lengthMaxSeconds.trim() ? Number(filters.lengthMaxSeconds) : null;
  if (lengthFrom !== null && lengthTo !== null && lengthFrom > lengthTo) return '曲の長さの開始値は終了値以下にしてください。';
  const ranges: [string, string, string][] = [
    [filters.minYoutubeViews, filters.maxYoutubeViews, 'YouTube再生数'],
    [filters.minNicoViews, filters.maxNicoViews, 'ニコニコ再生数'],
    [filters.minFavoritedTimes, filters.maxFavoritedTimes, 'VocaDB支持数'],
  ];
  for (const [from, to, label] of ranges) {
    if (from && to && Number(from) > Number(to)) return `${label}の開始値は終了値以下にしてください。`;
  }
  return null;
}

function hasAdvancedFilters(filters: AdvancedSearchFilters): boolean {
  return filters.publishYearFrom.trim() !== ''
    || filters.publishYearTo.trim() !== ''
    || filters.lengthMinSeconds.trim() !== ''
    || filters.lengthMaxSeconds.trim() !== ''
    || filters.pvService !== 'any'
    || filters.audioComputed !== 'any'
    || filters.minYoutubeViews !== ''
    || filters.maxYoutubeViews !== ''
    || filters.minNicoViews !== ''
    || filters.maxNicoViews !== ''
    || filters.minFavoritedTimes !== ''
    || filters.maxFavoritedTimes !== ''
    || filters.includedSongTypes.length > 0
    || filters.tagFilters.length > 0
    || filters.creditArtist !== null;
}

function requestedSongTypes(songTypeFilter: 'All' | 'Original', filters: AdvancedSearchFilters): SongType[] | undefined {
  if (filters.includedSongTypes.length > 0) return filters.includedSongTypes;
  return songTypeFilter === 'Original' ? ['Original'] : undefined;
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
  search: () => Promise<void>;
  searchTitleOnly: (query: string) => Promise<void>;
  searchByArtistId: (artistId: number, artistName: string, artistRole?: string) => Promise<void>;
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
  artistRole?: string;
  anyArtistIds?: number[];
  artistIdGroups?: number[][];
  songTypes?: SongType[];
  sort: ExtendedSortRule;
  sortOrder: SortOrder;
  start: number;
  maxResults: number;
  filters?: AdvancedSearchFilters;
  globalFilters?: GlobalFilterSettings;
  discoveryOnly?: boolean;
}): Promise<{ items: Song[]; totalCount: number }> {
  const startedAt = performanceNow();
  const validationError = params.filters ? validateAdvancedSearchFilters(params.filters) : null;
  if (validationError) throw new Error(validationError);
  const qs = new URLSearchParams();
  if (params.query) qs.set('query', params.query);
  if (params.artistIds && params.artistIds.length > 0) qs.set('artistIds', params.artistIds.join(','));
  if (params.artistRole) qs.set('artistRole', params.artistRole);
  if (params.anyArtistIds && params.anyArtistIds.length > 0) qs.set('anyArtistIds', params.anyArtistIds.join(','));
  if (params.artistIdGroups && params.artistIdGroups.length > 0) {
    qs.set('artistIdGroups', params.artistIdGroups.map(group => group.join(',')).join('|'));
  }
  if (params.songTypes && params.songTypes.length > 0) qs.set('songTypes', params.songTypes.join(','));
  qs.set('sort', params.sort);
  qs.set('order', params.sortOrder);
  qs.set('start', params.start.toString());
  qs.set('maxResults', params.maxResults.toString());
  qs.set('onlyWithPVs', 'true');
  if (params.discoveryOnly) qs.set('discoveryOnly', 'true');
  if (params.filters) {
    const f = params.filters;
    if (f.publishYearFrom.trim()) qs.set('publishYearFrom', f.publishYearFrom.trim());
    if (f.publishYearTo.trim()) qs.set('publishYearTo', f.publishYearTo.trim());
    if (f.lengthMinSeconds.trim()) qs.set('lengthMinSeconds', f.lengthMinSeconds.trim());
    if (f.lengthMaxSeconds.trim()) qs.set('lengthMaxSeconds', f.lengthMaxSeconds.trim());
    if (f.pvService !== 'any') qs.set('pvService', f.pvService);
    if (f.audioComputed !== 'any') qs.set('audioComputed', f.audioComputed);
    if (f.minYoutubeViews) qs.set('minYoutubeViews', f.minYoutubeViews);
    if (f.maxYoutubeViews) qs.set('maxYoutubeViews', f.maxYoutubeViews);
    if (f.minNicoViews) qs.set('minNicoViews', f.minNicoViews);
    if (f.maxNicoViews) qs.set('maxNicoViews', f.maxNicoViews);
    if (f.minFavoritedTimes) qs.set('minFavoritedTimes', f.minFavoritedTimes);
    if (f.maxFavoritedTimes) qs.set('maxFavoritedTimes', f.maxFavoritedTimes);
    if (f.tagFilters.length > 0) {
      qs.set('tagIds', f.tagFilters.map(tag => tag.id).join(','));
      qs.set('tagMatchMode', f.tagMatchMode);
    }
    if (f.creditArtist) {
      qs.set('creditArtistId', f.creditArtist.id.toString());
      if (f.creditRole) qs.set('creditArtistRole', f.creditRole);
    }
  }
  if (params.sort === 'Random') qs.set('randomSeed', searchRandomSeed.toString());
  if (params.globalFilters && hasGlobalSongFilters(params.globalFilters)) {
    const f = params.globalFilters;
    if (f.minYoutubeViews > 0) qs.set('minYoutubeViews', Math.max(Number(qs.get('minYoutubeViews') || 0), f.minYoutubeViews).toString());
    if (f.minNicoViews > 0) qs.set('minNicoViews', Math.max(Number(qs.get('minNicoViews') || 0), f.minNicoViews).toString());
    if (f.excludedSongTypes.length > 0) qs.set('excludeSongTypes', f.excludedSongTypes.join(','));
  }
  for (const [minimumKey, maximumKey] of [
    ['minYoutubeViews', 'maxYoutubeViews'],
    ['minNicoViews', 'maxNicoViews'],
  ] as const) {
    const minimum = Number(qs.get(minimumKey) || 0);
    const maximumText = qs.get(maximumKey);
    if (maximumText && minimum > Number(maximumText)) return { items: [], totalCount: 0 };
  }

  const url = `${RECOMMENDER_API}/api/songs/search?${qs.toString()}`;
  const segments: PerformanceSegment[] = [];
  const { value, status } = await backendSearchCache.get<{
    data: { items: Song[]; totalCount: number };
    serverTiming: PerformanceSegment[];
    serverCache?: string;
  }>(url, async () => {
    const fetchStartedAt = performanceNow();
    const res = await fetch(url);
    const responseAt = performanceNow();
    if (!res.ok) throw new Error('Search failed');
    const data: { items: Song[]; totalCount: number } = await res.json();
    const parsedAt = performanceNow();
    segments.push(
      { name: 'network', durationMs: responseAt - fetchStartedAt },
      { name: 'parse', durationMs: parsedAt - responseAt },
    );
    return {
      data,
      serverTiming: parseServerTiming(res.headers?.get?.('Server-Timing') ?? null),
      serverCache: res.headers?.get?.('X-Diva-Search-Cache') ?? undefined,
    };
  });
  recordPerformanceMetric({
    name: 'search.backend',
    startedAt,
    segments: [...segments, ...value.serverTiming],
    detail: {
      cache: status,
      serverCache: value.serverCache,
      query: params.query || '',
      start: params.start,
      count: value.data.items.length,
      totalCount: value.data.totalCount,
    },
  });
  return value.data;
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
  } catch {
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

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  sort: 'TotalViews' as ExtendedSortRule,
  sortOrder: 'desc' as SortOrder,
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
  setQuery: (query: string) => set({ query, resolvedArtistId: null, artistRole: null }),

  setSort: (sort: ExtendedSortRule) => {
    if (sort === 'Random') searchRandomSeed = Math.floor(Math.random() * 2_147_483_647);
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

  searchTitleOnly: async (query: string) => {
    const generation = ++searchGeneration;
    const { sort, sortOrder, songTypeFilter, advancedFilters } = get();
    const globalFilters = getGlobalFilterSettings();
    const trimmed = query.trim();
    set({
      query: trimmed,
      isLoading: true,
      error: null,
      results: [],
      totalCount: 0,
      currentPage: 0,
      hasSearched: true,
      resolvedArtistId: null,
      artistRole: null,
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
        error: getSearchErrorMessage(error, useBackend),
        isLoading: false,
        results: [],
      });
    }
  },

  searchByArtistId: async (artistId: number, artistName: string, artistRole?: string) => {
    const generation = ++searchGeneration;
    const { sort, sortOrder, songTypeFilter, advancedFilters } = get();
    const globalFilters = getGlobalFilterSettings();
    set({
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
      set({ error: getSearchErrorMessage(error, useBackend), isLoading: false, results: [] });
    }
  },

  search: async () => {
    const generation = ++searchGeneration;
    const { query, sort, sortOrder, resolvedArtistId, artistRole, vocalistFilters, vocalistMatchMode, songTypeFilter, advancedFilters } = get();
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
        );
        if (generation !== searchGeneration) return;
        set({
          results: isLocal ? items : applyLocalSort(items, sort, sortOrder),
          totalCount,
          resolvedArtistId: producerArtistId ?? null,
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
        error: getSearchErrorMessage(error, !!artistRole || LOCAL_SORT_RULES.has(sort) || hasAdvancedFilters(advancedFilters) || hasGlobalSongFilters(globalFilters)),
        isLoading: false,
      });
    }
  },

  reset: () => {
    searchGeneration += 1;
    set({
      query: '',
      sort: 'TotalViews' as ExtendedSortRule,
      sortOrder: 'desc' as SortOrder,
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
}));
