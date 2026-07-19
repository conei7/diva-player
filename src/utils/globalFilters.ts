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

export type DiscoveryRelaxedCondition =
  | 'cooldown'
  | 'rated-songs'
  | 'view-thresholds-reduced'
  | 'view-thresholds-removed';

export interface DiscoveryFilterResult {
  items: Song[];
  relaxedConditions: DiscoveryRelaxedCondition[];
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

/**
 * 発見候補が不足したときだけ、明示的な曲種除外を維持したまま
 * クールダウン、評価済み除外、再生数条件の順に段階的に緩和する。
 * 検索結果には使用せず、候補を自動補充する表示面だけで使用する。
 */
export function applyDiscoveryFilterWithRelaxation(
  songs: Song[],
  context: DiscoveryFilterContext,
  minimumCount: number,
): DiscoveryFilterResult {
  const target = Math.max(0, Math.floor(minimumCount));
  const strictItems = applyDiscoveryFilter(songs, context);
  if (target === 0 || strictItems.length >= target) {
    return { items: strictItems, relaxedConditions: [] };
  }

  const stages: Array<{ settings: GlobalFilterSettings; relaxedConditions: DiscoveryRelaxedCondition[] }> = [];
  let settings = context.settings;
  let relaxedConditions: DiscoveryRelaxedCondition[] = [];

  if (settings.cooldownHours > 0) {
    settings = { ...settings, cooldownHours: 0 };
    relaxedConditions = [...relaxedConditions, 'cooldown'];
    stages.push({ settings, relaxedConditions });
  }
  if (settings.excludeRatedFromDiscovery) {
    settings = { ...settings, excludeRatedFromDiscovery: false };
    relaxedConditions = [...relaxedConditions, 'rated-songs'];
    stages.push({ settings, relaxedConditions });
  }

  const hasViewThresholds = settings.enabled
    && (settings.minYoutubeViews > 0 || settings.minNicoViews > 0);
  if (hasViewThresholds) {
    const reducedSettings = {
      ...settings,
      minYoutubeViews: settings.minYoutubeViews > 1 ? Math.max(1, Math.floor(settings.minYoutubeViews / 2)) : settings.minYoutubeViews,
      minNicoViews: settings.minNicoViews > 1 ? Math.max(1, Math.floor(settings.minNicoViews / 2)) : settings.minNicoViews,
    };
    if (reducedSettings.minYoutubeViews !== settings.minYoutubeViews
      || reducedSettings.minNicoViews !== settings.minNicoViews) {
      settings = reducedSettings;
      relaxedConditions = [...relaxedConditions, 'view-thresholds-reduced'];
      stages.push({ settings, relaxedConditions });
    }

    settings = { ...settings, minYoutubeViews: 0, minNicoViews: 0 };
    relaxedConditions = relaxedConditions.filter(condition => condition !== 'view-thresholds-reduced');
    relaxedConditions = [...relaxedConditions, 'view-thresholds-removed'];
    stages.push({ settings, relaxedConditions });
  }

  let best: DiscoveryFilterResult = { items: strictItems, relaxedConditions: [] };
  for (const stage of stages) {
    const items = applyDiscoveryFilter(songs, { ...context, settings: stage.settings });
    if (items.length > best.items.length) {
      best = { items, relaxedConditions: stage.relaxedConditions };
    }
    if (items.length >= target) return { items, relaxedConditions: stage.relaxedConditions };
  }
  return best;
}

export function getDiscoveryRelaxationMessage(conditions: DiscoveryRelaxedCondition[]): string | null {
  if (conditions.length === 0) return null;
  const labels: string[] = [];
  if (conditions.includes('cooldown')) labels.push('最近再生した曲を含める');
  if (conditions.includes('rated-songs')) labels.push('評価済みの曲を含める');
  if (conditions.includes('view-thresholds-reduced')) labels.push('再生数条件を半分にする');
  if (conditions.includes('view-thresholds-removed')) labels.push('再生数条件を一時解除する');
  return `候補不足のため、${labels.join('・')}調整を適用しています。曲種の除外設定は維持されます。`;
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
