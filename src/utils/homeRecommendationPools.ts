import type { Song } from '../types/vocadb';
import type { RecommendationSource } from './recommendationReranking';

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
