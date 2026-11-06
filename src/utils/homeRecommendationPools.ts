import type { Song } from '../types/vocadb';
import {
  rerankRecommendationCandidatesDetailed,
  type DetailedRerankResult,
  type RecommendationRerankOptions,
  type RecommendationSource,
} from './recommendationReranking';

/** Saved/listened songs support discovery without turning later pages into a rating list. */
export function homeRecommendationPools(
  known: Song[], hybrid: Song[], audio: Song[], popular: Song[], knownIds: ReadonlySet<number>, count: number,
): Partial<Record<RecommendationSource, Song[]>> {
  const discoveries = (items: Song[]) => items.filter(song => !knownIds.has(song.id));
  return {
    known: known.slice(0, Math.max(1, Math.floor(count / 2))),
    hybrid: discoveries(hybrid),
    audio: discoveries(audio),
    popular: discoveries(popular),
  };
}

/**
 * The page is chosen from candidates not shown in the last few minutes; only when they run out do
 * recently shown ones fill the rest (ranked after them, with the page's diversity carried over).
 */
export function rerankHomeRecommendationsPreferringUnseen(
  pools: Partial<Record<RecommendationSource, Song[]>>,
  options: RecommendationRerankOptions,
  recentlyShown: ReadonlyMap<number, number>,
): DetailedRerankResult {
  const excludeIds = options.excludeIds ?? new Set<number>();
  if (recentlyShown.size === 0) return rerankRecommendationCandidatesDetailed(pools, options);

  const unseen = rerankRecommendationCandidatesDetailed(pools, {
    ...options,
    excludeIds: new Set([...excludeIds, ...recentlyShown.keys()]),
  });
  const missing = options.total - unseen.ranked.length;
  if (missing <= 0) return unseen;

  const chosen = unseen.ranked.map(item => item.song);
  const fill = rerankRecommendationCandidatesDetailed(pools, {
    ...options,
    total: missing,
    excludeIds: new Set([...excludeIds, ...chosen.map(song => song.id)]),
    recentSongs: [...(options.recentSongs ?? []), ...chosen].slice(-12),
  });
  const offset = unseen.ranked.length;
  return {
    ranked: [...unseen.ranked, ...fill.ranked],
    trace: [
      ...unseen.trace,
      ...fill.trace.map(entry => ({
        ...entry,
        selectedRank: entry.selectedRank === null ? null : entry.selectedRank + offset,
      })),
    ],
  };
}
