import type { Song } from '../types/vocadb';
import type { HistoryLikeEntry, ImplicitSongFeedbackLike } from './recommendationScoring';
import {
  buildPlaylistSongSet,
  getArtistBucket,
  getVocalistIds,
  scoreQueueCandidates,
} from './recommendationScoring';

export type RecommendationSource = 'known' | 'hybrid' | 'audio' | 'popular';

export interface RecommendationCandidate {
  song: Song;
  source: RecommendationSource;
}

export interface RankedRecommendation extends RecommendationCandidate {
  reason: string;
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
  }: RecommendationRerankOptions,
): RankedRecommendation[] {
  const entries = new Map<number, { song: Song; evidence: number; sources: Set<RecommendationSource> }>();
  (Object.entries(pools) as Array<[RecommendationSource, Song[] | undefined]>).forEach(([source, songs]) => {
    (songs ?? []).forEach((song, index) => {
      if (excludeIds.has(song.id)) return;
      const rankSignal = 1 / Math.sqrt(index + 1);
      const current = entries.get(song.id) ?? { song, evidence: 0, sources: new Set<RecommendationSource>() };
      current.evidence += SOURCE_WEIGHT[source] * rankSignal;
      current.sources.add(source);
      entries.set(song.id, current);
    });
  });

  const playlistSongIds = buildPlaylistSongSet(playlists);
  const preferenceScores = new Map(scoreQueueCandidates(
    [...entries.values()].map(entry => entry.song),
    historyEntries,
    playlistSongIds,
    ratings,
    new Set(excludeIds),
    implicitFeedback,
  ).map(item => [item.song.id, item.score]));
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
      const producerPenalty = (producerCounts.get(getArtistBucket(entry.song)) ?? 0) * 0.34;
      const vocalistPenalty = getVocalistIds(entry.song)
        .reduce((sum, vocalistId) => sum + (vocalistCounts.get(vocalistId) ?? 0), 0) * 0.09;
      const familiarityAdjustment = (known ? 1 : -1) * familiarityBias * 0.2;
      const score = entry.evidence * 0.9 + Math.sqrt(Math.max(0, preference)) * 0.8
        + familiarityAdjustment - producerPenalty - vocalistPenalty;
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
  return result;
}
