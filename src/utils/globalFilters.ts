import type { Song, SongType } from '../types/vocadb';
import type { GlobalFilterSettings } from '../stores/globalFilterStore';
import type { AppLanguage } from '../stores/languageStore';
import { songTypeLabel } from './songMeta';

export interface DiscoveryFilterContext {
  settings: GlobalFilterSettings;
  ratings?: Record<string, number>;
  lastPlayedAtBySongId?: ReadonlyMap<number, number | null>;
  now?: number;
}

export type SongFilterRejectionReason =
  | 'disabled'
  | 'excluded-song-type'
  | 'excluded-vocalist'
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
  MusicPV: 'PV',
  DramaPV: 'ドラマPV',
  Other: 'その他',
  Unspecified: '未分類',
};

/** 再生数・曲種フィルターに条件が入力されているか。クールダウン等は含めない。 */
export function hasConfiguredSongFilters(settings: GlobalFilterSettings): boolean {
  return settings.minYoutubeViews > 0
    || settings.minNicoViews > 0
    || settings.excludedSongTypes.length > 0
    || settings.excludeSelfCovers
    || settings.vocalistFilters.length > 0;
}

/** 現在、再生数・曲種フィルターが実際に表示結果へ適用されているか。 */
export function isGlobalSongFilterActive(settings: GlobalFilterSettings): boolean {
  return settings.enabled && hasConfiguredSongFilters(settings);
}

export function isDiscoveryFilterActive(settings: GlobalFilterSettings): boolean {
  return isGlobalSongFilterActive(settings)
    || settings.cooldownHours > 0
    || settings.excludeRatedFromDiscovery;
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
    || first.excludeSelfCovers !== second.excludeSelfCovers
    || first.vocalistMatchMode !== second.vocalistMatchMode
    || first.vocalistFilters.length !== second.vocalistFilters.length
    || first.excludedSongTypes.length !== second.excludedSongTypes.length) {
    return false;
  }

  const secondTypes = new Set(second.excludedSongTypes);
  if (!first.excludedSongTypes.every(songType => secondTypes.has(songType))) return false;
  const secondVocalists = new Map(second.vocalistFilters.map(filter => [filter.id, filter]));
  return first.vocalistFilters.every(filter => {
    const other = secondVocalists.get(filter.id);
    return other?.name === filter.name && other.variantGroup === filter.variantGroup;
  });
}

/** 「最近聴いた曲を除く」の期間: 1時間 / 24時間 / 3日 / 7日（英語 1 hour / 1 day / 3 days / 7 days）。 */
export function formatCooldownDuration(hours: number, language: AppLanguage = 'ja'): string {
  const value = Number.isFinite(hours) ? Math.max(0, Math.round(hours)) : 0;
  if (language === 'en') {
    if (value > 0 && value % 24 === 0) {
      const days = value / 24;
      return days === 1 ? '1 day' : `${days} days`;
    }
    return value === 1 ? '1 hour' : `${value} hours`;
  }
  return value >= 48 && value % 24 === 0 ? `${value / 24}日` : `${value}時間`;
}

/** Vocalist names as the user picked them (voicebank variants collapse into their group). */
function summarizedVocalistNames(settings: GlobalFilterSettings): string[] {
  return settings.vocalistFilters
    .filter((filter, index, all) => (
      !filter.variantGroup
      || all.findIndex(candidate => candidate.variantGroup === filter.variantGroup) === index
    ))
    .map(filter => filter.variantGroup ?? filter.name);
}

const VOCALIST_MATCH_LABELS: Record<GlobalFilterSettings['vocalistMatchMode'], { ja: string; en: string }> = {
  Any: { ja: 'いずれかを含む', en: 'Any of these' },
  All: { ja: 'すべて含む', en: 'All of these' },
  Exact: { ja: 'このボーカルだけ', en: 'Only these' },
};

/** 表示フィルターの要約（設定・上部バーで共通）。言語ごとの文はこの関数の中で作る。 */
export function getGlobalFilterSummary(settings: GlobalFilterSettings, language: AppLanguage = 'ja'): string[] {
  const en = language === 'en';
  const summary: string[] = [];
  if (settings.enabled && settings.minYoutubeViews > 0) {
    summary.push(en
      ? `YouTube ≥ ${settings.minYoutubeViews.toLocaleString('en-US')} views`
      : `YouTube ${settings.minYoutubeViews.toLocaleString('ja-JP')}以上`);
  }
  if (settings.enabled && settings.minNicoViews > 0) {
    summary.push(en
      ? `Niconico ≥ ${settings.minNicoViews.toLocaleString('en-US')} views`
      : `ニコニコ ${settings.minNicoViews.toLocaleString('ja-JP')}以上`);
  }
  if (settings.enabled && (settings.excludedSongTypes.length > 0 || settings.excludeSelfCovers)) {
    // 設定の「除外する種類」のチップと同じ名前（songTypeLabel）・同じ並びにそろえる
    const labels = settings.excludedSongTypes.map(type => songTypeLabel(type, language));
    if (settings.excludeSelfCovers) labels.push(en ? 'Self-cover' : 'セルフカバー');
    summary.push(en ? `${labels.join(', ')} excluded` : `${labels.join('・')}を除外`);
  }
  if (settings.enabled && settings.vocalistFilters.length > 0) {
    const names = summarizedVocalistNames(settings);
    // 1人の時は一致方法に意味がないので付けない
    const mode = names.length > 1 ? VOCALIST_MATCH_LABELS[settings.vocalistMatchMode] ?? VOCALIST_MATCH_LABELS.Any : null;
    if (en) {
      summary.push(`${names.length > 1 ? 'Vocalists' : 'Vocalist'}: ${names.join(', ')}${mode ? ` (${mode.en})` : ''}`);
    } else {
      summary.push(`ボーカル: ${names.join('・')}${mode ? `（${mode.ja}）` : ''}`);
    }
  }
  if (settings.cooldownHours > 0) {
    const duration = formatCooldownDuration(settings.cooldownHours, language);
    summary.push(en ? `Skip recently played (${duration})` : `最近聴いた曲を除く（${duration}）`);
  }
  if (settings.excludeRatedFromDiscovery) summary.push(en ? 'Skip rated songs' : '評価した曲を除く');
  return summary;
}

function matchesVocalistFilter(song: Song, settings: GlobalFilterSettings): boolean {
  if (settings.vocalistFilters.length === 0) return true;
  const vocalistIds = new Set((song.artists ?? [])
    .filter(artist => artist.categories?.includes('Vocalist'))
    .map(artist => artist.artist?.id)
    .filter((id): id is number => id !== undefined));
  if (vocalistIds.size === 0) return false;

  const variantGroups = new Map<string, number[]>();
  const logicalGroups: number[][] = [];
  for (const filter of settings.vocalistFilters) {
    if (!filter.variantGroup) {
      logicalGroups.push([filter.id]);
      continue;
    }
    const group = variantGroups.get(filter.variantGroup) ?? [];
    group.push(filter.id);
    variantGroups.set(filter.variantGroup, group);
  }
  logicalGroups.push(...variantGroups.values());
  const groupMatches = logicalGroups.map(group => group.some(id => vocalistIds.has(id)));
  if (settings.vocalistMatchMode === 'Any') return groupMatches.some(Boolean);
  if (!groupMatches.every(Boolean)) return false;
  if (settings.vocalistMatchMode !== 'Exact') return true;
  const allowedIds = new Set(settings.vocalistFilters.map(filter => filter.id));
  return [...vocalistIds].every(id => allowedIds.has(id));
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
  if (settings.excludedSongTypes.includes(song.songType) || (settings.excludeSelfCovers && song.isSelfCover)) {
    return { accepted: false, reason: 'excluded-song-type' };
  }
  if (!matchesVocalistFilter(song, settings)) {
    return { accepted: false, reason: 'excluded-vocalist' };
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

export function filterDiscoverySourcePage(
  songs: Song[],
  context: DiscoveryFilterContext,
  minimumCount: number,
  sourceExhausted: boolean,
): DiscoveryFilterResult {
  return sourceExhausted
    ? applyDiscoveryFilterWithRelaxation(songs, context, minimumCount)
    : { items: applyDiscoveryFilter(songs, context), relaxedConditions: [] };
}

const RELAXATION_LABELS: Record<DiscoveryRelaxedCondition, { ja: string; en: string }> = {
  cooldown: { ja: '最近再生した曲を含める', en: 'including recently played songs' },
  'rated-songs': { ja: '評価した曲を含める', en: 'including rated songs' },
  'view-thresholds-reduced': { ja: '再生数の条件を半分にする', en: 'halving the minimum views' },
  'view-thresholds-removed': { ja: '再生数の条件を一時的に外す', en: 'ignoring the minimum views for now' },
};

const RELAXATION_ORDER: DiscoveryRelaxedCondition[] = [
  'cooldown',
  'rated-songs',
  'view-thresholds-reduced',
  'view-thresholds-removed',
];

/** 緩和の詳細（InfoTip などに出す文）。緩和が無ければ null。 */
export function getDiscoveryRelaxationMessage(
  conditions: DiscoveryRelaxedCondition[],
  language: AppLanguage = 'ja',
): string | null {
  if (conditions.length === 0) return null;
  const labels = RELAXATION_ORDER
    .filter(condition => conditions.includes(condition))
    .map(condition => RELAXATION_LABELS[condition][language === 'en' ? 'en' : 'ja']);
  if (language === 'en') {
    return `Not enough songs matched, so some filters were relaxed (${labels.join(', ')}). Song type and vocalist filters still apply.`;
  }
  return `候補が足りないため、条件をゆるめています（${labels.join('・')}）。曲の種類とボーカルの条件はそのままです。`;
}

/** ホーム・再生ページで1行に出す短い表示（詳細は getDiscoveryRelaxationMessage）。 */
export function getDiscoveryRelaxationShortLabel(language: AppLanguage = 'ja'): string {
  return language === 'en' ? 'Some filters were relaxed' : '一部の条件をゆるめて表示しています';
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
