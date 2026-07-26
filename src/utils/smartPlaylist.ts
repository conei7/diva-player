import type {
  Song,
  SongType,
  SmartPlaylistMaxSongs,
  SmartPlaylistRule,
  SmartPlaylistSortBy,
} from '../types/vocadb';
import { isVoiceSynthArtistType } from '../config/voiceSynthTypes';
import { applyGlobalSongFilter, SONG_TYPE_LABELS } from './globalFilters';

export const SMART_DERIVED_SONG_TYPES: SongType[] = ['Cover', 'Remix', 'Arrangement', 'Mashup'];
export const SMART_PLAYLIST_MAX_SONGS: SmartPlaylistMaxSongs[] = [50, 100, 200];
export const SMART_PLAYLIST_SORTS: Array<{ value: SmartPlaylistSortBy; label: string }> = [
  { value: 'FavoritedTimes', label: 'VocaDB支持順' },
  { value: 'YoutubeViews', label: 'YouTube再生数順' },
  { value: 'NicoViews', label: 'ニコニコ再生数順' },
  { value: 'PublishDate', label: '新着順' },
];

export const DEFAULT_SMART_PLAYLIST_MAX_SONGS: SmartPlaylistMaxSongs = 200;
export const DEFAULT_SMART_PLAYLIST_SORT: SmartPlaylistSortBy = 'FavoritedTimes';

export interface NormalizedSmartPlaylistRule extends Omit<SmartPlaylistRule, 'maxSongs' | 'sortBy'> {
  maxSongs: SmartPlaylistMaxSongs;
  sortBy: SmartPlaylistSortBy;
}

export function normalizeSmartPlaylistRule(rule?: Partial<SmartPlaylistRule> | null): NormalizedSmartPlaylistRule {
  const maxSongs = SMART_PLAYLIST_MAX_SONGS.includes(rule?.maxSongs as SmartPlaylistMaxSongs)
    ? rule?.maxSongs as SmartPlaylistMaxSongs
    : DEFAULT_SMART_PLAYLIST_MAX_SONGS;
  const sortBy = SMART_PLAYLIST_SORTS.some(option => option.value === rule?.sortBy)
    ? rule?.sortBy as SmartPlaylistSortBy
    : DEFAULT_SMART_PLAYLIST_SORT;
  const normalizeViews = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
  const excludedSongTypes = Array.isArray(rule?.excludedSongTypes)
    ? rule.excludedSongTypes.filter((type): type is SongType => typeof type === 'string' && type in SONG_TYPE_LABELS)
    : [];
  const producerId = typeof rule?.producerId === 'number' && Number.isInteger(rule.producerId) && rule.producerId > 0
    ? rule.producerId
    : undefined;
  return {
    minYoutubeViews: normalizeViews(rule?.minYoutubeViews),
    minNicoViews: normalizeViews(rule?.minNicoViews),
    excludedSongTypes,
    producerId,
    producerName: typeof rule?.producerName === 'string' ? rule.producerName : undefined,
    maxSongs,
    sortBy,
  };
}

function formatViewThreshold(value: number): string {
  return value.toLocaleString('ja-JP');
}

export function formatSmartPlaylistRule(rule: SmartPlaylistRule): string[] {
  const normalized = normalizeSmartPlaylistRule(rule);
  const summary: string[] = [];
  if (normalized.producerName) summary.push(`P: ${normalized.producerName}`);
  if (normalized.minYoutubeViews > 0) summary.push(`YouTube ${formatViewThreshold(normalized.minYoutubeViews)}以上`);
  if (normalized.minNicoViews > 0) summary.push(`ニコニコ ${formatViewThreshold(normalized.minNicoViews)}以上`);
  if (normalized.excludedSongTypes.length > 0) {
    const labels = normalized.excludedSongTypes.map(type => SONG_TYPE_LABELS[type] ?? type);
    summary.push(`除外: ${labels.join('・')}`);
  }
  if (summary.length === 0) summary.push('条件なし');
  const sortLabel = SMART_PLAYLIST_SORTS.find(option => option.value === normalized.sortBy)?.label ?? 'VocaDB支持順';
  summary.push(`上限 ${normalized.maxSongs}曲`);
  summary.push(sortLabel);
  return summary;
}

export function buildSmartPlaylistSearchParams(
  rule: SmartPlaylistRule,
  maxResults?: number,
): URLSearchParams {
  const normalized = normalizeSmartPlaylistRule(rule);
  const params = new URLSearchParams({
    // 全楽曲DBには一般楽曲も含まれるため、VocaDB内で評価された曲を先に取得する。
    sort: normalized.sortBy,
    order: 'desc',
    start: '0',
    maxResults: String(maxResults ?? normalized.maxSongs),
    onlyWithPVs: 'true',
    voiceSynthOnly: 'true',
  });
  if (normalized.producerId) params.set('artistIds', String(normalized.producerId));
  if (normalized.minYoutubeViews > 0) params.set('minYoutubeViews', String(normalized.minYoutubeViews));
  if (normalized.minNicoViews > 0) params.set('minNicoViews', String(normalized.minNicoViews));
  if (normalized.excludedSongTypes.length > 0) {
    params.set('excludeSongTypes', normalized.excludedSongTypes.join(','));
  }
  return params;
}

/** DB検索結果にも同じ条件を再適用し、条件外の曲が入らないことを保証する。 */
export function filterSmartPlaylistSongs(songs: Song[], rule: SmartPlaylistRule): Song[] {
  const normalized = normalizeSmartPlaylistRule(rule);
  const matchingConditions = applyGlobalSongFilter(songs, {
    enabled: true,
    minYoutubeViews: normalized.minYoutubeViews,
    minNicoViews: normalized.minNicoViews,
    excludedSongTypes: normalized.excludedSongTypes,
    cooldownHours: 0,
    excludeRatedFromDiscovery: false,
  });
  return matchingConditions.filter(song => song.artists?.some(artist =>
    artist.categories?.includes('Vocalist')
      && isVoiceSynthArtistType(artist.artist?.artistType),
  ));
}
