import type { Song, SongSortRule, SongType } from '../types/vocadb';
import type { GlobalFilterSettings } from '../stores/globalFilterStore';

export type LocalSortRule = 'YoutubeViews' | 'NicoViews' | 'TotalViews' | 'Random';
export type ExtendedSortRule = SongSortRule | LocalSortRule;
export type SortOrder = 'desc' | 'asc';

export const LOCAL_SORT_RULES = new Set<ExtendedSortRule>([
  'YoutubeViews',
  'NicoViews',
  'TotalViews',
  'Random',
]);

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
  bpmFrom: string;
  bpmTo: string;
  instrumentKeys: string[];
  instrumentMatchMode: 'all' | 'any';
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

export const ADVANCED_SEARCH_LIMITS = {
  publishYearMin: 1,
  publishYearMax: 5_874_896,
  lengthMinSeconds: 0,
  lengthMaxSeconds: 2_147_483_647,
  viewCountMin: 0,
  viewCountMax: Number.MAX_SAFE_INTEGER,
  favoriteCountMin: 0,
  favoriteCountMax: 2_147_483_647,
  bpmMin: 20,
  bpmMax: 400,
} as const;

export const DEFAULT_ADVANCED_FILTERS: AdvancedSearchFilters = {
  publishYearFrom: '',
  publishYearTo: '',
  lengthMinSeconds: '',
  lengthMaxSeconds: '',
  pvService: 'any',
  audioComputed: 'any',
  bpmFrom: '',
  bpmTo: '',
  instrumentKeys: [],
  instrumentMatchMode: 'all',
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

export function applyLocalSort(
  songs: Song[],
  sort: ExtendedSortRule,
  order: SortOrder = 'desc',
): Song[] {
  const direction = order === 'asc' ? 1 : -1;
  if (sort === 'TotalViews') {
    // The backend owns the learned YouTube/NicoNico conversion weight.
    return songs;
  }
  if (sort === 'YoutubeViews' || sort === 'NicoViews') {
    return [...songs].sort((left, right) => {
      if (sort === 'YoutubeViews') {
        return direction * ((left.youtubeViews ?? 0) - (right.youtubeViews ?? 0));
      }
      return direction * ((left.nicoViews ?? 0) - (right.nicoViews ?? 0));
    });
  }
  return order === 'asc' ? [...songs].reverse() : songs;
}

function normalizeExactSearchText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP');
}

export function hasExactSongTitleMatch(songs: readonly Song[], query: string): boolean {
  const normalizedQuery = normalizeExactSearchText(query);
  if (!normalizedQuery) return false;
  return songs.some(song => [song.name, song.defaultName]
    .some(title => normalizeExactSearchText(title) === normalizedQuery));
}

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
  if (!/^\d+$/.test(trimmed)) {
    return `${label}は${min}以上${max.toLocaleString()}以下の整数で指定してください。`;
  }
  const numeric = Number(trimmed);
  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
    return `${label}は${min}以上${max.toLocaleString()}以下の整数で指定してください。`;
  }
  return null;
}

export function validateAdvancedSearchFilters(filters: AdvancedSearchFilters): string | null {
  const boundedValues = [
    [filters.publishYearFrom, '投稿年', ADVANCED_SEARCH_LIMITS.publishYearMin, ADVANCED_SEARCH_LIMITS.publishYearMax],
    [filters.publishYearTo, '投稿年', ADVANCED_SEARCH_LIMITS.publishYearMin, ADVANCED_SEARCH_LIMITS.publishYearMax],
    [filters.lengthMinSeconds, '曲の長さ', ADVANCED_SEARCH_LIMITS.lengthMinSeconds, ADVANCED_SEARCH_LIMITS.lengthMaxSeconds],
    [filters.lengthMaxSeconds, '曲の長さ', ADVANCED_SEARCH_LIMITS.lengthMinSeconds, ADVANCED_SEARCH_LIMITS.lengthMaxSeconds],
    [filters.minYoutubeViews, 'YouTube再生数', 0, ADVANCED_SEARCH_LIMITS.viewCountMax],
    [filters.maxYoutubeViews, 'YouTube再生数', 0, ADVANCED_SEARCH_LIMITS.viewCountMax],
    [filters.minNicoViews, 'ニコニコ再生数', 0, ADVANCED_SEARCH_LIMITS.viewCountMax],
    [filters.maxNicoViews, 'ニコニコ再生数', 0, ADVANCED_SEARCH_LIMITS.viewCountMax],
    [filters.minFavoritedTimes, 'VocaDB支持数', 0, ADVANCED_SEARCH_LIMITS.favoriteCountMax],
    [filters.maxFavoritedTimes, 'VocaDB支持数', 0, ADVANCED_SEARCH_LIMITS.favoriteCountMax],
    [filters.bpmFrom, 'BPM', ADVANCED_SEARCH_LIMITS.bpmMin, ADVANCED_SEARCH_LIMITS.bpmMax],
    [filters.bpmTo, 'BPM', ADVANCED_SEARCH_LIMITS.bpmMin, ADVANCED_SEARCH_LIMITS.bpmMax],
  ] as const;
  for (const [value, label, min, max] of boundedValues) {
    const error = validateAdvancedInteger(value, label, min, max);
    if (error) return error;
  }

  const ranges = [
    [filters.publishYearFrom, filters.publishYearTo, '投稿年'],
    [filters.lengthMinSeconds, filters.lengthMaxSeconds, '曲の長さ'],
    [filters.minYoutubeViews, filters.maxYoutubeViews, 'YouTube再生数'],
    [filters.minNicoViews, filters.maxNicoViews, 'ニコニコ再生数'],
    [filters.minFavoritedTimes, filters.maxFavoritedTimes, 'VocaDB支持数'],
    [filters.bpmFrom, filters.bpmTo, 'BPM'],
  ] as const;
  for (const [from, to, label] of ranges) {
    if (from.trim() && to.trim() && Number(from) > Number(to)) {
      return `${label}の開始値は終了値以下にしてください。`;
    }
  }
  return null;
}

export function hasAdvancedFilters(filters: AdvancedSearchFilters): boolean {
  return filters.publishYearFrom.trim() !== ''
    || filters.publishYearTo.trim() !== ''
    || filters.lengthMinSeconds.trim() !== ''
    || filters.lengthMaxSeconds.trim() !== ''
    || filters.pvService !== 'any'
    || filters.audioComputed !== 'any'
    || filters.bpmFrom.trim() !== ''
    || filters.bpmTo.trim() !== ''
    || filters.instrumentKeys.length > 0
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

export function requestedSongTypes(
  songTypeFilter: 'All' | 'Original',
  filters: AdvancedSearchFilters,
): SongType[] | undefined {
  if (filters.includedSongTypes.length > 0) return filters.includedSongTypes;
  return songTypeFilter === 'Original' ? ['Original'] : undefined;
}

export function hasGlobalSongFilters(settings: GlobalFilterSettings): boolean {
  return settings.enabled
    && (settings.minYoutubeViews > 0
      || settings.minNicoViews > 0
      || settings.excludedSongTypes.length > 0
      || settings.vocalistFilters.length > 0);
}

export function getGlobalVocalistGroups(settings: GlobalFilterSettings): number[][] {
  if (!settings.enabled || settings.vocalistFilters.length === 0) return [];
  if (settings.vocalistMatchMode === 'Any') {
    return [[...new Set(settings.vocalistFilters.map(filter => filter.id))]];
  }
  const groups: number[][] = [];
  const variants = new Map<string, number[]>();
  for (const filter of settings.vocalistFilters) {
    if (!filter.variantGroup) {
      groups.push([filter.id]);
      continue;
    }
    const group = variants.get(filter.variantGroup) ?? [];
    group.push(filter.id);
    variants.set(filter.variantGroup, group);
  }
  groups.push(...variants.values());
  return groups;
}

export function getSearchErrorMessage(error: unknown, requiresBackend: boolean): string {
  if (error instanceof Error
    && (error.message.includes('指定してください') || error.message.includes('以下にしてください'))) {
    return error.message;
  }
  if (requiresBackend) {
    return 'SBCのデータサービスに接続できないため、詳細検索と外部再生数順は現在利用できません。';
  }
  return error instanceof Error ? error.message : '検索中にエラーが発生しました';
}
