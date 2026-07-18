import type { Song, SongType } from '../types/vocadb';
import type { GlobalFilterSettings } from '../stores/globalFilterStore';

export interface DiscoveryFilterContext {
  settings: GlobalFilterSettings;
  ratings?: Record<string, number>;
  lastPlayedAtBySongId?: ReadonlyMap<number, number | null>;
  now?: number;
}

export type SongFilterRejectionReason =
  | 'disabled'
  | 'excluded-song-type'
  | 'youtube-views-missing'
  | 'youtube-views-below-minimum'
  | 'nico-views-missing'
  | 'nico-views-below-minimum'
  | 'rated-song'
  | 'cooldown';

export interface SongFilterDecision {
  accepted: boolean;
  reason?: SongFilterRejectionReason;
}

export const SONG_TYPE_LABELS: Record<SongType, string> = {
  Original: 'オリジナル',
  Remaster: 'リマスター',
  Remix: 'リミックス',
  Cover: 'カバー',
  Arrangement: 'アレンジ',
  Instrumental: 'インスト',
  Mashup: 'マッシュアップ',
  MusicPV: '音楽PV',
  DramaPV: 'ドラマPV',
  Other: 'その他',
  Unspecified: '未分類',
};

/** 再生数・曲種フィルターに条件が入力されているか。クールダウン等は含めない。 */
export function hasConfiguredSongFilters(settings: GlobalFilterSettings): boolean {
  return settings.minYoutubeViews > 0
    || settings.minNicoViews > 0
    || settings.excludedSongTypes.length > 0;
}

/** 現在、再生数・曲種フィルターが実際に表示結果へ適用されているか。 */
export function isGlobalSongFilterActive(settings: GlobalFilterSettings): boolean {
  return settings.enabled && hasConfiguredSongFilters(settings);
}

/** 設定画面のドラフトと保存済み設定を、曲種の並び順に依存せず比較する。 */
export function areGlobalFilterSettingsEqual(
  first: GlobalFilterSettings,
  second: GlobalFilterSettings,
): boolean {
  if (first.enabled !== second.enabled
    || first.minYoutubeViews !== second.minYoutubeViews
    || first.minNicoViews !== second.minNicoViews
    || first.cooldownHours !== second.cooldownHours
    || first.excludeRatedFromDiscovery !== second.excludeRatedFromDiscovery
    || first.excludedSongTypes.length !== second.excludedSongTypes.length) {
    return false;
  }

  const secondTypes = new Set(second.excludedSongTypes);
  return first.excludedSongTypes.every(songType => secondTypes.has(songType));
}

export function getGlobalFilterSummary(settings: GlobalFilterSettings): string[] {
  if (!isGlobalSongFilterActive(settings)) return [];
  const summary: string[] = [];
  if (settings.minYoutubeViews > 0) summary.push(`YouTube ${settings.minYoutubeViews.toLocaleString()}以上`);
  if (settings.minNicoViews > 0) summary.push(`ニコニコ ${settings.minNicoViews.toLocaleString()}以上`);
  if (settings.excludedSongTypes.length > 0) {
    summary.push(`${settings.excludedSongTypes.map(type => SONG_TYPE_LABELS[type]).join('・')}を除外`);
  }
  return summary;
}

function meetsMinimumViews(
  minimum: number,
  value: number | undefined,
  missingReason: SongFilterRejectionReason,
  belowMinimumReason: SongFilterRejectionReason,
): SongFilterRejectionReason | undefined {
  if (minimum <= 0) return undefined;
  if (value === undefined || !Number.isFinite(value)) return missingReason;
  if (value < minimum) return belowMinimumReason;
  return undefined;
}

export function getGlobalSongFilterDecision(song: Song, settings: GlobalFilterSettings): SongFilterDecision {
  if (!settings.enabled) return { accepted: true };
  if (settings.excludedSongTypes.includes(song.songType)) {
    return { accepted: false, reason: 'excluded-song-type' };
  }
  const youtubeReason = meetsMinimumViews(
    settings.minYoutubeViews,
    song.youtubeViews,
    'youtube-views-missing',
    'youtube-views-below-minimum',
  );
  if (youtubeReason) return { accepted: false, reason: youtubeReason };
  const nicoReason = meetsMinimumViews(
    settings.minNicoViews,
    song.nicoViews,
    'nico-views-missing',
    'nico-views-below-minimum',
  );
  if (nicoReason) return { accepted: false, reason: nicoReason };
  return { accepted: true };
}

export function matchesGlobalSongFilter(song: Song, settings: GlobalFilterSettings): boolean {
  return getGlobalSongFilterDecision(song, settings).accepted;
}

export function applyGlobalSongFilter(songs: Song[], settings: GlobalFilterSettings): Song[] {
  return songs.filter(song => matchesGlobalSongFilter(song, settings));
}

export function matchesDiscoveryFilter(song: Song, context: DiscoveryFilterContext): boolean {
  const { settings, ratings, lastPlayedAtBySongId, now = Date.now() } = context;
  if (!matchesGlobalSongFilter(song, settings)) return false;

  if (settings.excludeRatedFromDiscovery && (ratings?.[String(song.id)] ?? 0) > 0) return false;

  if (settings.cooldownHours > 0) {
    const lastPlayedAt = lastPlayedAtBySongId?.get(song.id) ?? null;
    if (lastPlayedAt !== null && lastPlayedAt !== undefined) {
      const cooldownMs = settings.cooldownHours * 60 * 60 * 1000;
      if (now - lastPlayedAt < cooldownMs) return false;
    }
  }

  return true;
}

export function applyDiscoveryFilter(songs: Song[], context: DiscoveryFilterContext): Song[] {
  return songs.filter(song => matchesDiscoveryFilter(song, context));
}

export function requiresExternalViewCounts(settings: GlobalFilterSettings): boolean {
  return settings.enabled && (settings.minYoutubeViews > 0 || settings.minNicoViews > 0);
}

export function isSongType(value: string): value is SongType {
  return [
    'Original', 'Remaster', 'Remix', 'Cover', 'Arrangement', 'Instrumental',
    'Mashup', 'MusicPV', 'DramaPV', 'Other', 'Unspecified',
  ].includes(value as SongType);
}
