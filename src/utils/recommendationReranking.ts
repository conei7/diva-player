import type { Song } from '../types/vocadb';
import type { HistoryLikeEntry, ImplicitSongFeedbackLike } from './recommendationScoring';
import {
  buildPlaylistSongSet,
  getArtistBucket,
  getVocalistIds,
  scoreQueueCandidates,
  type QueueCandidateScoreBreakdown,
} from './recommendationScoring';
import { filterVoiceSynthSongs } from './voiceSynthSongs';
import { rankingNoise, type RankingSeed } from './rankingRandomization';
import { calculateExposurePenalty, type RecommendationExposureEntry } from '../stores/recommendationExposureStore';

export type RecommendationSource = 'known' | 'hybrid' | 'audio' | 'popular';

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
  known: boolean;
  familiarityAdjustment: number;
  explorationAdjustment: number;
  baseScore: number | null;
  exposurePenalty: number;
  producerPenalty: number;
  vocalistPenalty: number;
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
}

const SOURCE_WEIGHT: Record<RecommendationSource, number> = {
  known: 1.0,
  hybrid: 1.0,
  audio: 1.0,
  popular: 0.55,
};

function sourceReason(sources: Set<RecommendationSource>, known: boolean): string {
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
  }).ranked;
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
  }: RecommendationRerankOptions,
): DetailedRerankResult {
  const entries = new Map<number, {
    song: Song;
    evidence: number;
    sources: Set<RecommendationSource>;
    sourceTraces: RecommendationSourceTrace[];
    finalScore: number | null;
    producerPenalty: number;
    vocalistPenalty: number;
    familiarityAdjustment: number;
    explorationAdjustment: number;
    baseScore: number | null;
    exposurePenalty: number;
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
        familiarityAdjustment: 0,
        explorationAdjustment: 0,
        baseScore: null,
        exposurePenalty: 0,
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
  while (remaining.length > 0 && result.length < total) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index++) {
      const entry = remaining[index];
      const known = knownIds.has(entry.song.id);
      const preference = preferenceScores.get(entry.song.id) ?? 1;
      const producerPenalty = (producerCounts.get(getArtistBucket(entry.song)) ?? 0) * 0.10;
      const vocalistPenalty = getVocalistIds(entry.song)
        .reduce((sum, vocalistId) => sum + (vocalistCounts.get(vocalistId) ?? 0), 0) * 0.12;
      const familiarityAdjustment = (known ? 1 : -1) * familiarityBias * 0.2;
      const exposurePenalty = calculateExposurePenalty(exposureEntries[String(entry.song.id)], exposureNow);
      
      // 音響情報あり（マイナー曲救済/有名曲加点）
      const audioBonus = entry.song.audioComputed ? 0.4 : 0;
      
      const baseScore = entry.evidence * 0.9 + Math.sqrt(Math.max(0, preference)) * 0.8
        + familiarityAdjustment - producerPenalty - vocalistPenalty - exposurePenalty + audioBonus;
      // The perturbation is deliberately small and deterministic. Hard filters,
      // user feedback, and diversity penalties are all applied before it.
      const explorationAdjustment = rankingSeed === 0
        ? 0
        : rankingNoise(rankingSeed, entry.song.id) * explorationStrength;
      const score = baseScore + explorationAdjustment;
      entry.finalScore = score;
      entry.baseScore = baseScore;
      entry.explorationAdjustment = explorationAdjustment;
      entry.exposurePenalty = exposurePenalty;
      entry.producerPenalty = producerPenalty;
      entry.vocalistPenalty = vocalistPenalty;
      entry.familiarityAdjustment = familiarityAdjustment;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const [selected] = remaining.splice(bestIndex, 1);
    const known = knownIds.has(selected.song.id);
    const primarySource = [...selected.sources].sort((a, b) => SOURCE_WEIGHT[b] - SOURCE_WEIGHT[a])[0];
    result.push({ song: selected.song, source: primarySource, reason: sourceReason(selected.sources, known) });
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
      known,
      familiarityAdjustment: entry.familiarityAdjustment,
      explorationAdjustment: entry.explorationAdjustment,
      baseScore: entry.baseScore,
      exposurePenalty: entry.exposurePenalty,
      producerPenalty: entry.producerPenalty,
      vocalistPenalty: entry.vocalistPenalty,
      finalScore: entry.finalScore,
      selectedRank: rankedIds.get(entry.song.id) ?? null,
      status: rankedIds.has(entry.song.id) ? 'selected' as const : 'not_selected' as const,
      reason: sourceReason(entry.sources, known),
    };
  });
  return { ranked: result, trace };
}
