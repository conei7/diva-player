import type { Song } from '../types/vocadb';

/**
 * The recommender ranks offset+count songs on every call. Pages ask once for the first 96 songs
 * of a seed and slice them, so Home, the song page and the edge cache share one answer per seed.
 */
export const RECOMMENDATION_WINDOW = 96;

export async function fetchRecommendationWindow(
  load: (window: { start: number; count: number }) => Promise<Song[]>,
  start: number,
  count: number,
): Promise<Song[]> {
  if (start + count > RECOMMENDATION_WINDOW) return load({ start, count });
  const songs = await load({ start: 0, count: RECOMMENDATION_WINDOW });
  return songs.slice(start, start + count);
}
