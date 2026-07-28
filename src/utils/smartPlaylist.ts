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
export const SMART_PLAYLIST_PRESETS: Array<{ id: string; label: string; rule: Partial<SmartPlaylistRule> }> = [
  {
    id: 'classics',
    label: '定番の原曲',
    rule: { minYoutubeViews: 10_000, minNicoViews: 1_000, excludedSongTypes: [...SMART_DERIVED_SONG_TYPES], sortBy: 'FavoritedTimes' },
  },
  {
    id: 'niconico',
    label: 'ニコニコ中心',
    rule: { minNicoViews: 10_000, pvService: 'niconico', sortBy: 'NicoViews' },
  },
  {
    id: 'audio',
    label: '音響データあり',
    rule: { audioComputed: 'yes', sortBy: 'FavoritedTimes' },
  },
];

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
  const normalizeText = (value: unknown) => typeof value === 'string' && /^\d*$/.test(value) ? value : '';
  const pvService = rule?.pvService === 'youtube' || rule?.pvService === 'niconico' || rule?.pvService === 'both' ? rule.pvService : 'any';
  const audioComputed = rule?.audioComputed === 'yes' || rule?.audioComputed === 'no' ? rule.audioComputed : 'any';
  return {
    minYoutubeViews: normalizeViews(rule?.minYoutubeViews),
    minNicoViews: normalizeViews(rule?.minNicoViews),
    excludedSongTypes,
    producerId,
    producerName: typeof rule?.producerName === 'string' ? rule.producerName : undefined,
    publishYearFrom: normalizeText(rule?.publishYearFrom),
    publishYearTo: normalizeText(rule?.publishYearTo),
    lengthMinSeconds: normalizeText(rule?.lengthMinSeconds),
    lengthMaxSeconds: normalizeText(rule?.lengthMaxSeconds),
    pvService,
    audioComputed,
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
  if (normalized.publishYearFrom || normalized.publishYearTo) summary.push('公開年 ' + (normalized.publishYearFrom || '指定なし') + '〜' + (normalized.publishYearTo || '指定なし'));
  if (normalized.lengthMinSeconds || normalized.lengthMaxSeconds) summary.push('長さ ' + (normalized.lengthMinSeconds || '0') + '〜' + (normalized.lengthMaxSeconds || '∞') + '秒');
  if (normalized.pvService !== 'any') summary.push('PV: ' + (normalized.pvService === 'both' ? 'YouTube＋ニコニコ' : normalized.pvService === 'youtube' ? 'YouTube' : 'ニコニコ'));
  if (normalized.audioComputed !== 'any') summary.push('音響データ: ' + (normalized.audioComputed === 'yes' ? 'あり' : 'なし'));
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
  if (normalized.publishYearFrom) params.set('publishYearFrom', String(normalized.publishYearFrom));
  if (normalized.publishYearTo) params.set('publishYearTo', String(normalized.publishYearTo));
  if (normalized.lengthMinSeconds) params.set('lengthMinSeconds', String(normalized.lengthMinSeconds));
  if (normalized.lengthMaxSeconds) params.set('lengthMaxSeconds', String(normalized.lengthMaxSeconds));
  if (normalized.pvService && normalized.pvService !== 'any') params.set('pvService', normalized.pvService);
  if (normalized.audioComputed && normalized.audioComputed !== 'any') params.set('audioComputed', normalized.audioComputed);
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
  )).filter(song => {
    const from = Number(normalized.publishYearFrom);
    const to = Number(normalized.publishYearTo);
    const year = song.publishDate ? Number(song.publishDate.slice(0, 4)) : 0;
    if (normalized.publishYearFrom && (!year || year < from)) return false;
    if (normalized.publishYearTo && (!year || year > to)) return false;
    const length = song.lengthSeconds ?? 0;
    if (normalized.lengthMinSeconds && length < Number(normalized.lengthMinSeconds)) return false;
    if (normalized.lengthMaxSeconds && length > Number(normalized.lengthMaxSeconds)) return false;
    const services = new Set((song.pvs ?? []).filter(pv => !pv.disabled).map(pv => pv.service));
    if (normalized.pvService === 'youtube' && !services.has('Youtube')) return false;
    if (normalized.pvService === 'niconico' && !services.has('NicoNicoDouga')) return false;
    if (normalized.pvService === 'both' && (!services.has('Youtube') || !services.has('NicoNicoDouga'))) return false;
    if (normalized.audioComputed === 'yes' && song.audioComputed !== true) return false;
    if (normalized.audioComputed === 'no' && song.audioComputed === true) return false;
    return true;
  });
}
