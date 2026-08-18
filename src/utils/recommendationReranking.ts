import type { Song } from '../types/vocadb';
import type { HistoryLikeEntry, ImplicitSongFeedbackLike } from './recommendationScoring';
import {
  buildPlaylistSongSet,
  buildTasteAffinityProfile,
  explainTasteAffinity,
  getArtistBucket,
  getProducerIds,
  getVocalistIds,
  scoreQueueCandidates,
  type TasteAffinityBreakdown,
  type QueueCandidateScoreBreakdown,
} from './recommendationScoring';
import { filterVoiceSynthSongs } from './voiceSynthSongs';
import { rankingNoise, type RankingSeed } from './rankingRandomization';
import { calculateExposurePenalty, type RecommendationExposureEntry } from '../stores/recommendationExposureStore';

export type RecommendationSource = 'known' | 'hybrid' | 'audio' | 'popular' | 'rootVector' | 'rootProducer';

export interface RecommendationCandidate {
  song: Song;
  source: RecommendationSource;
}

export interface RankedRecommendation extends RecommendationCandidate {
  reason: string;
}

export interface RecommendationSourceTrace {
  source: RecommendationSource;
  sourceRank: number;
  sourceWeight: number;
  rankSignal: number;
  evidenceContribution: number;
}

export interface RecommendationCandidateTrace {
  songId: number;
  songName: string;
  sources: RecommendationSourceTrace[];
  evidence: number;
  preference?: QueueCandidateScoreBreakdown;
  tasteAffinity?: TasteAffinityBreakdown;
  known: boolean;
  familiarityAdjustment: number;
  explorationAdjustment: number;
  baseScore: number | null;
  exposurePenalty: number;
  tasteAffinityAdjustment: number;
  producerPenalty: number;
  vocalistPenalty: number;
  favoriteProducer: boolean;
  favoriteProducerAdjustment: number;
  rootProducerMatch: boolean;
  rootAffinityAdjustment: number;
  discoveryAdjustment: number;
  popularityAdjustment: number;
  finalScore: number | null;
  selectedRank: number | null;
  status: 'selected' | 'not_selected';
  reason: string;
}

export interface DetailedRerankResult {
  ranked: RankedRecommendation[];
  trace: RecommendationCandidateTrace[];
}

export interface RecommendationRerankOptions {
  total: number;
  historyEntries: HistoryLikeEntry[];
  playlists: { songs: Song[] }[];
  ratings: Record<string, number>;
  implicitFeedback: Record<string, ImplicitSongFeedbackLike>;
  excludeIds?: ReadonlySet<number>;
  recentSongs?: Song[];
  /** -1 favours discoveries, +1 favours familiar songs. This is a soft score only. */
  familiarityBias?: number;
  /** Per-view seed. Equal seeds produce equal orderings. */
  rankingSeed?: RankingSeed;
  /** Small score perturbation used only for near-ties. */
  explorationStrength?: number;
  /** Browser-local display history used as a soft repeat penalty. */
  exposureEntries?: Record<string, RecommendationExposureEntry>;
  exposureNow?: number;
  /** Producer/circle/band IDs the user explicitly marked as favorites. */
  favoriteProducerIds?: ReadonlySet<number>;
  /** The user-selected song that anchors this continuous mix. */
  rootSeed?: Song | null;
  /** Smooth 0..1 session position; it changes scores rather than reserving slots. */
  mixProgress?: number;
}

const SOURCE_WEIGHT: Record<RecommendationSource, number> = {
  known: 1.0,
  hybrid: 1.0,
  audio: 1.0,
  popular: 0.55,
  // These are supporting signals. A top root-vector hit should not by itself
  // outweigh a strongly rated familiar song, while overlap with the ordinary
  // hybrid pool and same-P affinity can still make the selected root audible.
  rootVector: 0.52,
  rootProducer: 0.38,
};

function sourceReason(
  sources: Set<RecommendationSource>,
  known: boolean,
  favoriteProducer: boolean,
  rootProducerMatch: boolean,
  tasteAffinityAdjustment: number,
): string {
  if (rootProducerMatch) return '最初に選んだ曲と同じPを反映したおすすめ';
  if (sources.has('rootVector')) return '最初に選んだ曲のベクトルに近いおすすめ';
  if (favoriteProducer) return 'お気に入りPの楽曲を優先したおすすめ';
  if (tasteAffinityAdjustment >= 0.08) return '評価・保存した曲の特徴に近いおすすめ';
  if (sources.has('audio') && sources.has('hybrid')) return '音響・タグ・アーティスト情報が重なるおすすめ';
  if (sources.has('audio')) return '音響的に近いおすすめ';
  if (sources.has('hybrid')) return 'タグ・アーティスト情報も近いおすすめ';
  if (known) return '完走・評価・プレイリストを反映したおすすめ';
  return '人気・話題性を加味した発見枠';
}

/**
 * Combines candidate sources without quotas. Source rank, personal feedback,
 * recency and sequential diversity all contribute to the score of every pick.
 */
export function rerankRecommendationCandidates(
  pools: Partial<Record<RecommendationSource, Song[]>>,
  {
    total,
    historyEntries,
    playlists,
    ratings,
    implicitFeedback,
    excludeIds = new Set<number>(),
    recentSongs = [],
    familiarityBias = 0,
    rankingSeed = 0,
    explorationStrength = 0.045,
    exposureEntries = {},
    exposureNow = Date.now(),
    favoriteProducerIds = new Set<number>(),
    rootSeed = null,
    mixProgress = 0,
  }: RecommendationRerankOptions,
): RankedRecommendation[] {
  return rerankRecommendationCandidatesDetailed(pools, {
    total,
    historyEntries,
    playlists,
    ratings,
    implicitFeedback,
    excludeIds,
    recentSongs,
    familiarityBias,
    rankingSeed,
    explorationStrength,
    exposureEntries,
    exposureNow,
    favoriteProducerIds,
    rootSeed,
    mixProgress,
  }).ranked;
}

function discoveryPopularityConfidence(song: Song): number {
  const favoriteSignal = Math.min(1, Math.log10(1 + Math.max(0, song.favoritedTimes ?? 0)) / 4);
  const externalViews = Math.max(0, song.youtubeViews ?? 0) + Math.max(0, song.nicoViews ?? 0) * 1.35;
  const viewSignal = Math.min(1, Math.log10(1 + externalViews) / 7);
  return externalViews > 0
    ? favoriteSignal * 0.35 + viewSignal * 0.65
    : favoriteSignal;
}

export function rerankRecommendationCandidatesDetailed(
  pools: Partial<Record<RecommendationSource, Song[]>>,
  {
    total,
    historyEntries,
    playlists,
    ratings,
    implicitFeedback,
    excludeIds = new Set<number>(),
    recentSongs = [],
    familiarityBias = 0,
    rankingSeed = 0,
    explorationStrength = 0.045,
    exposureEntries = {},
    exposureNow = Date.now(),
    favoriteProducerIds = new Set<number>(),
    rootSeed = null,
    mixProgress = 0,
  }: RecommendationRerankOptions,
): DetailedRerankResult {
  const normalizedMixProgress = Math.max(0, Math.min(1, mixProgress));
  const rootProducerIds = new Set(rootSeed ? getProducerIds(rootSeed) : []);
  const entries = new Map<number, {
    song: Song;
    evidence: number;
    sources: Set<RecommendationSource>;
    sourceTraces: RecommendationSourceTrace[];
    finalScore: number | null;
    producerPenalty: number;
    vocalistPenalty: number;
    favoriteProducer: boolean;
    favoriteProducerAdjustment: number;
    familiarityAdjustment: number;
    explorationAdjustment: number;
    baseScore: number | null;
    exposurePenalty: number;
    tasteAffinityAdjustment: number;
    rootProducerMatch: boolean;
    rootAffinityAdjustment: number;
    discoveryAdjustment: number;
    popularityAdjustment: number;
  }>();
  (Object.entries(pools) as Array<[RecommendationSource, Song[] | undefined]>).forEach(([source, songs]) => {
    filterVoiceSynthSongs(songs ?? []).forEach((song, index) => {
      if (excludeIds.has(song.id)) return;
      const rankSignal = 1 / Math.sqrt(index + 1);
      const sourceWeight = SOURCE_WEIGHT[source];
      const current = entries.get(song.id) ?? {
        song,
        evidence: 0,
        sources: new Set<RecommendationSource>(),
        sourceTraces: [],
        finalScore: null,
        producerPenalty: 0,
        vocalistPenalty: 0,
        favoriteProducer: false,
        favoriteProducerAdjustment: 0,
        familiarityAdjustment: 0,
        explorationAdjustment: 0,
        baseScore: null,
        exposurePenalty: 0,
        tasteAffinityAdjustment: 0,
        rootProducerMatch: false,
        rootAffinityAdjustment: 0,
        discoveryAdjustment: 0,
        popularityAdjustment: 0,
      };
      current.evidence += sourceWeight * rankSignal;
      current.sources.add(source);
      current.sourceTraces.push({
        source,
        sourceRank: index + 1,
        sourceWeight,
        rankSignal,
        evidenceContribution: sourceWeight * rankSignal,
      });
      entries.set(song.id, current);
    });
  });

  const playlistSongIds = buildPlaylistSongSet(playlists);
  const scoredPreferences = scoreQueueCandidates(
    [...entries.values()].map(entry => entry.song),
    historyEntries,
    playlistSongIds,
    ratings,
    new Set(excludeIds),
    implicitFeedback,
  );
  const scoredPreferenceMap = new Map(scoredPreferences.map(item => [item.song.id, item]));
  const preferenceScores = new Map(scoredPreferences.map(item => [item.song.id, item.score]));
  const tasteAffinityProfile = buildTasteAffinityProfile(historyEntries, playlists, ratings, implicitFeedback);
  const knownIds = new Set<number>([
    ...historyEntries.map(entry => entry.song.id),
    ...playlistSongIds,
    ...Object.keys(ratings).map(Number),
    ...Object.keys(implicitFeedback).map(Number),
  ]);
  const producerCounts = new Map<string, number>();
  const vocalistCounts = new Map<number, number>();
  const addDiversity = (song: Song) => {
    const producer = getArtistBucket(song);
    producerCounts.set(producer, (producerCounts.get(producer) ?? 0) + 1);
    for (const vocalistId of getVocalistIds(song)) {
      vocalistCounts.set(vocalistId, (vocalistCounts.get(vocalistId) ?? 0) + 1);
    }
  };
  recentSongs.forEach(addDiversity);

  const remaining = [...entries.values()];
  const result: RankedRecommendation[] = [];
  const favoriteLimit = favoriteProducerIds.size > 0
    ? Math.max(1, Math.floor(total * 0.3))
    : Number.POSITIVE_INFINITY;
  let favoriteCount = 0;
  while (remaining.length > 0 && result.length < total) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index++) {
      const entry = remaining[index];
      const favoriteProducer = (entry.song.artists ?? []).some(artist =>
        artist.artist?.id !== undefined && favoriteProducerIds.has(artist.artist.id)
        && (artist.categories === 'Producer' || artist.categories === 'Band' || artist.categories === 'Circle'),
      );
      if (favoriteCount >= favoriteLimit && favoriteProducer && remaining.some(candidate =>
        !(candidate.song.artists ?? []).some(artist =>
          artist.artist?.id !== undefined && favoriteProducerIds.has(artist.artist.id)
          && (artist.categories === 'Producer' || artist.categories === 'Band' || artist.categories === 'Circle'),
        ),
      )) continue;
      const known = knownIds.has(entry.song.id);
      const preference = preferenceScores.get(entry.song.id) ?? 1;
      const producerPenalty = (producerCounts.get(getArtistBucket(entry.song)) ?? 0) * 0.10;
      const vocalistPenalty = getVocalistIds(entry.song)
        .reduce((sum, vocalistId) => sum + (vocalistCounts.get(vocalistId) ?? 0), 0) * 0.03;
      const familiarityAdjustment = (known ? 1 : -1) * familiarityBias * 0.2;
      const exposurePenalty = calculateExposurePenalty(exposureEntries[String(entry.song.id)], exposureNow);
      const tasteAffinity = explainTasteAffinity(entry.song, tasteAffinityProfile);
      const rootProducerMatch = rootProducerIds.size > 0
        && getProducerIds(entry.song).some(producerId => rootProducerIds.has(producerId));
      // The anchor stays meaningful throughout the session, while sequential
      // diversity naturally moves repeated producers behind alternatives.
      const rootAffinityAdjustment = rootProducerMatch
        ? 0.42 - normalizedMixProgress * 0.12
        : 0;
      // Unknown songs become only slightly easier to select later. Vector rank
      // remains the main discovery signal; public popularity is a bounded
      // confidence hint and never an absolute cutoff.
      const discoveryAdjustment = known ? 0 : normalizedMixProgress * 0.035;
      const popularityAdjustment = known
        ? 0
        : discoveryPopularityConfidence(entry.song) * (0.015 + normalizedMixProgress * 0.025);
      const baseScore = entry.evidence * 0.9 + Math.sqrt(Math.max(0, preference)) * 0.8
        + familiarityAdjustment + tasteAffinity.adjustment
        + rootAffinityAdjustment + discoveryAdjustment + popularityAdjustment
        - producerPenalty - vocalistPenalty - exposurePenalty;
      const favoriteProducerAdjustment = favoriteProducer ? 0.45 : 0;
      // The perturbation is deliberately small and deterministic. Hard filters,
      // user feedback, and diversity penalties are all applied before it.
      const explorationAdjustment = rankingSeed === 0
        ? 0
        : rankingNoise(rankingSeed, entry.song.id) * explorationStrength;
      const score = baseScore + favoriteProducerAdjustment + explorationAdjustment;
      entry.finalScore = score;
      entry.baseScore = baseScore;
      entry.explorationAdjustment = explorationAdjustment;
      entry.exposurePenalty = exposurePenalty;
      entry.tasteAffinityAdjustment = tasteAffinity.adjustment;
      entry.producerPenalty = producerPenalty;
      entry.vocalistPenalty = vocalistPenalty;
      entry.familiarityAdjustment = familiarityAdjustment;
      entry.favoriteProducer = favoriteProducer;
      entry.favoriteProducerAdjustment = favoriteProducerAdjustment;
      entry.rootProducerMatch = rootProducerMatch;
      entry.rootAffinityAdjustment = rootAffinityAdjustment;
      entry.discoveryAdjustment = discoveryAdjustment;
      entry.popularityAdjustment = popularityAdjustment;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const [selected] = remaining.splice(bestIndex, 1);
    const known = knownIds.has(selected.song.id);
    if (selected.favoriteProducer) favoriteCount++;
    const primarySource = [...selected.sources].sort((a, b) => SOURCE_WEIGHT[b] - SOURCE_WEIGHT[a])[0];
    result.push({
      song: selected.song,
      source: primarySource,
      reason: sourceReason(
        selected.sources,
        known,
        selected.favoriteProducer,
        selected.rootProducerMatch,
        selected.tasteAffinityAdjustment,
      ),
    });
    addDiversity(selected.song);
  }
  const rankedIds = new Map(result.map((item, index) => [item.song.id, index + 1]));
  const trace = [...entries.values()].map(entry => {
    const known = knownIds.has(entry.song.id);
    const preferenceBreakdown = scoredPreferenceMap.get(entry.song.id)?.breakdown;
    return {
      songId: entry.song.id,
      songName: entry.song.name,
      sources: entry.sourceTraces,
      evidence: entry.evidence,
      ...(preferenceBreakdown ? { preference: preferenceBreakdown } : {}),
      tasteAffinity: explainTasteAffinity(entry.song, tasteAffinityProfile),
      known,
      familiarityAdjustment: entry.familiarityAdjustment,
      explorationAdjustment: entry.explorationAdjustment,
      baseScore: entry.baseScore,
      exposurePenalty: entry.exposurePenalty,
      tasteAffinityAdjustment: entry.tasteAffinityAdjustment,
      producerPenalty: entry.producerPenalty,
      vocalistPenalty: entry.vocalistPenalty,
      favoriteProducer: entry.favoriteProducer,
      favoriteProducerAdjustment: entry.favoriteProducerAdjustment,
      rootProducerMatch: entry.rootProducerMatch,
      rootAffinityAdjustment: entry.rootAffinityAdjustment,
      discoveryAdjustment: entry.discoveryAdjustment,
      popularityAdjustment: entry.popularityAdjustment,
      finalScore: entry.finalScore,
      selectedRank: rankedIds.get(entry.song.id) ?? null,
      status: rankedIds.has(entry.song.id) ? 'selected' as const : 'not_selected' as const,
      reason: sourceReason(
        entry.sources,
        known,
        entry.favoriteProducer,
        entry.rootProducerMatch,
        entry.tasteAffinityAdjustment,
      ),
    };
  });
  return { ranked: result, trace };
}
