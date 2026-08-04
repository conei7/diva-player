import type { Song, SongType } from '../types/vocadb';
import type { GlobalFilterSettings } from '../stores/globalFilterStore';
import { AsyncTtlCache } from '../utils/asyncTtlCache';
import {
  parseServerTiming,
  performanceNow,
  recordPerformanceMetric,
  type PerformanceSegment,
} from '../utils/performanceMetrics';
import {
  getGlobalVocalistGroups,
  hasGlobalSongFilters,
  validateAdvancedSearchFilters,
  type AdvancedSearchFilters,
  type ExtendedSortRule,
  type SortOrder,
} from './searchModel';

const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';
const backendSearchCache = new AsyncTtlCache(60_000, 100);
let searchRandomSeed = createRandomSeed();

function createRandomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}

export function refreshSearchRandomSeed(): void {
  searchRandomSeed = createRandomSeed();
}

export interface BackendSearchParams {
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
  chorusOnly?: boolean;
}

function buildSearchQuery(params: BackendSearchParams): URLSearchParams {
  const validationError = params.filters ? validateAdvancedSearchFilters(params.filters) : null;
  if (validationError) throw new Error(validationError);
  const query = new URLSearchParams();
  if (params.query) query.set('query', params.query);
  if (params.artistIds?.length) query.set('artistIds', params.artistIds.join(','));
  if (params.artistRole) query.set('artistRole', params.artistRole);
  if (params.anyArtistIds?.length) query.set('anyArtistIds', params.anyArtistIds.join(','));
  const artistIdGroups = [
    ...(params.artistIdGroups ?? []),
    ...(params.globalFilters ? getGlobalVocalistGroups(params.globalFilters) : []),
  ];
  if (artistIdGroups.length > 0) {
    query.set('artistIdGroups', artistIdGroups.map(group => group.join(',')).join('|'));
  }
  if (params.globalFilters?.enabled
    && params.globalFilters.vocalistMatchMode === 'Exact'
    && params.globalFilters.vocalistFilters.length > 0) {
    query.set(
      'exactVocalistIds',
      [...new Set(params.globalFilters.vocalistFilters.map(filter => filter.id))].join(','),
    );
  }
  if (params.songTypes?.length) query.set('songTypes', params.songTypes.join(','));
  query.set('sort', params.sort);
  query.set('order', params.sortOrder);
  query.set('start', params.start.toString());
  query.set('maxResults', params.maxResults.toString());
  query.set('onlyWithPVs', 'true');
  if (params.discoveryOnly) query.set('discoveryOnly', 'true');
  if (params.chorusOnly) query.set('chorusOnly', 'true');

  if (params.filters) {
    const filters = params.filters;
    for (const [key, value] of [
      ['publishYearFrom', filters.publishYearFrom.trim()],
      ['publishYearTo', filters.publishYearTo.trim()],
      ['lengthMinSeconds', filters.lengthMinSeconds.trim()],
      ['lengthMaxSeconds', filters.lengthMaxSeconds.trim()],
      ['minYoutubeViews', filters.minYoutubeViews],
      ['maxYoutubeViews', filters.maxYoutubeViews],
      ['minNicoViews', filters.minNicoViews],
      ['maxNicoViews', filters.maxNicoViews],
      ['minFavoritedTimes', filters.minFavoritedTimes],
      ['maxFavoritedTimes', filters.maxFavoritedTimes],
      ['bpmFrom', filters.bpmFrom.trim()],
      ['bpmTo', filters.bpmTo.trim()],
    ] as const) {
      if (value) query.set(key, value);
    }
    if (filters.pvService !== 'any') query.set('pvService', filters.pvService);
    if (filters.audioComputed !== 'any') query.set('audioComputed', filters.audioComputed);
    if (filters.lyricsQuery.trim()) query.set('lyricsQuery', filters.lyricsQuery.trim());
    if (filters.selfCoverOnly) query.set('selfCover', 'true');
    if (filters.instrumentKeys.length > 0) {
      query.set('instrumentKeys', filters.instrumentKeys.join(','));
      query.set('instrumentMatchMode', filters.instrumentMatchMode);
    }
    if (filters.tagFilters.length > 0) {
      query.set('tagIds', filters.tagFilters.map(tag => tag.id).join(','));
      query.set('tagMatchMode', filters.tagMatchMode);
    }
    if (filters.creditArtist) {
      query.set('creditArtistId', filters.creditArtist.id.toString());
      if (filters.creditRole) query.set('creditArtistRole', filters.creditRole);
    }
  }

  if (params.sort === 'Random') query.set('randomSeed', searchRandomSeed.toString());
  if (params.globalFilters && hasGlobalSongFilters(params.globalFilters)) {
    const filters = params.globalFilters;
    if (filters.minYoutubeViews > 0) {
      query.set(
        'minYoutubeViews',
        Math.max(Number(query.get('minYoutubeViews') || 0), filters.minYoutubeViews).toString(),
      );
    }
    if (filters.minNicoViews > 0) {
      query.set(
        'minNicoViews',
        Math.max(Number(query.get('minNicoViews') || 0), filters.minNicoViews).toString(),
      );
    }
    if (filters.excludedSongTypes.length > 0) {
      query.set('excludeSongTypes', filters.excludedSongTypes.join(','));
    }
  }
  return query;
}

export async function searchSongsBackend(
  params: BackendSearchParams,
): Promise<{ items: Song[]; totalCount: number }> {
  const startedAt = performanceNow();
  const query = buildSearchQuery(params);
  for (const [minimumKey, maximumKey] of [
    ['minYoutubeViews', 'maxYoutubeViews'],
    ['minNicoViews', 'maxNicoViews'],
  ] as const) {
    const minimum = Number(query.get(minimumKey) || 0);
    const maximumText = query.get(maximumKey);
    if (maximumText && minimum > Number(maximumText)) return { items: [], totalCount: 0 };
  }

  const url = `${RECOMMENDER_API}/api/songs/search?${query.toString()}`;
  const segments: PerformanceSegment[] = [];
  const { value, status } = await backendSearchCache.get<{
    data: { items: Song[]; totalCount: number };
    serverTiming: PerformanceSegment[];
    serverCache?: string;
  }>(url, async () => {
    const fetchStartedAt = performanceNow();
    const response = await fetch(url);
    const responseAt = performanceNow();
    if (!response.ok) throw new Error('Search failed');
    const data: { items: Song[]; totalCount: number } = await response.json();
    const parsedAt = performanceNow();
    segments.push(
      { name: 'network', durationMs: responseAt - fetchStartedAt },
      { name: 'parse', durationMs: parsedAt - responseAt },
    );
    return {
      data,
      serverTiming: parseServerTiming(response.headers?.get?.('Server-Timing') ?? null),
      serverCache: response.headers?.get?.('X-Diva-Search-Cache') ?? undefined,
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
