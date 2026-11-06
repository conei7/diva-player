import type { Song } from '../types/vocadb';
import { rankingNoise, type RankingSeed } from './rankingRandomization';
import { deferRecentlyShown } from './recentlyShownSongs';

/**
 * How far the per-view seed can move a cached song, as a share of the saved pool (rankingNoise is
 * within ±2): about ±30% of the positions, so the strongest songs usually stay on the first screen
 * while the rest of the page changes from one reload to the next.
 */
const STARTUP_SHUFFLE = 0.15;

export interface StartupSongSelection {
  /** The new Home entry's seed: equal seeds give the same page. */
  seed: RankingSeed;
  /** Songs shown in the last few minutes (selectRecentlyShown): placed after unseen ones. */
  recentlyShown: ReadonlyMap<number, number>;
  limit: number;
}

/**
 * The first page shown from the saved personalized pool before the fresh mix arrives. The saved
 * order is the confidence; the seed shuffles it within a bounded distance, and songs shown in the
 * last few minutes only fill what unseen ones leave. Generic songs are never mixed in.
 */
export function selectStartupSongs(
  songs: readonly Song[],
  { seed, recentlyShown, limit }: StartupSongSelection,
): Song[] {
  const target = Math.max(0, Math.floor(limit));
  if (target === 0) return [];

  const seen = new Set<number>();
  const uniqueSongs = songs.filter(song => {
    if (!Number.isInteger(song.id) || seen.has(song.id)) return false;
    seen.add(song.id);
    return true;
  });
  const shuffled = uniqueSongs
    .map((song, index) => ({
      song,
      score: 1 - index / uniqueSongs.length + rankingNoise(seed, song.id) * STARTUP_SHUFFLE,
    }))
    .sort((a, b) => b.score - a.score)
    .map(item => item.song);
  return deferRecentlyShown(shuffled, recentlyShown, target);
}
