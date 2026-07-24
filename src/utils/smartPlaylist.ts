import type { Song, SongType, SmartPlaylistRule } from '../types/vocadb';
import { isVoiceSynthArtistType } from '../config/voiceSynthTypes';
import { applyGlobalSongFilter, SONG_TYPE_LABELS } from './globalFilters';

export const SMART_DERIVED_SONG_TYPES: SongType[] = ['Cover', 'Remix', 'Arrangement', 'Mashup'];

function formatViewThreshold(value: number): string {
  return value.toLocaleString('ja-JP');
}

export function formatSmartPlaylistRule(rule: SmartPlaylistRule): string[] {
  const summary: string[] = [];
  if (rule.producerName) summary.push(`P: ${rule.producerName}`);
  if (rule.minYoutubeViews > 0) summary.push(`YouTube ${formatViewThreshold(rule.minYoutubeViews)}以上`);
  if (rule.minNicoViews > 0) summary.push(`ニコニコ ${formatViewThreshold(rule.minNicoViews)}以上`);
  if (rule.excludedSongTypes.length > 0) {
    const labels = rule.excludedSongTypes.map(type => SONG_TYPE_LABELS[type] ?? type);
    summary.push(`除外: ${labels.join('・')}`);
  }
  return summary.length > 0 ? summary : ['条件なし'];
}

export function buildSmartPlaylistSearchParams(
  rule: SmartPlaylistRule,
  maxResults = 200,
): URLSearchParams {
  const params = new URLSearchParams({
    // 全楽曲DBには一般楽曲も含まれるため、VocaDB内で評価された曲を先に取得する。
    sort: 'FavoritedTimes',
    order: 'desc',
    start: '0',
    maxResults: String(maxResults),
    onlyWithPVs: 'true',
  });
  if (rule.producerId) params.set('artistIds', String(rule.producerId));
  if (rule.minYoutubeViews > 0) params.set('minYoutubeViews', String(rule.minYoutubeViews));
  if (rule.minNicoViews > 0) params.set('minNicoViews', String(rule.minNicoViews));
  if (rule.excludedSongTypes.length > 0) {
    params.set('excludeSongTypes', rule.excludedSongTypes.join(','));
  }
  return params;
}

/** DB検索結果にも同じ条件を再適用し、条件外の曲が入らないことを保証する。 */
export function filterSmartPlaylistSongs(songs: Song[], rule: SmartPlaylistRule): Song[] {
  const matchingConditions = applyGlobalSongFilter(songs, {
    enabled: true,
    minYoutubeViews: rule.minYoutubeViews,
    minNicoViews: rule.minNicoViews,
    excludedSongTypes: rule.excludedSongTypes,
    cooldownHours: 0,
    excludeRatedFromDiscovery: false,
  });
  return matchingConditions.filter(song => song.artists?.some(artist =>
    artist.categories?.includes('Vocalist')
      && isVoiceSynthArtistType(artist.artist?.artistType),
  ));
}
