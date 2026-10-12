export const RATING_VALUES = [5, 4, 3, 2, 1] as const;

export type RatingValue = (typeof RATING_VALUES)[number];

export function isRatingValue(value: number): value is RatingValue {
  return RATING_VALUES.includes(value as RatingValue);
}

export function getSongIdsForRating(
  ratings: Readonly<Record<string, number>>,
  selectedRating: RatingValue,
): number[] {
  return Object.entries(ratings)
    .filter(([, rating]) => rating === selectedRating)
    .map(([id]) => Number(id))
    .filter(Number.isInteger);
}

export function getRatedSongIds(
  ratings: Readonly<Record<string, number>>,
): number[] {
  return Object.entries(ratings)
    .filter(([, rating]) => isRatingValue(rating))
    .map(([id]) => Number(id))
    .filter(id => Number.isInteger(id) && id > 0);
}

export function getRatingCounts(
  ratings: Readonly<Record<string, number>>,
): Record<RatingValue, number> {
  const counts: Record<RatingValue, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const [id, rating] of Object.entries(ratings)) {
    if (Number.isInteger(Number(id)) && isRatingValue(rating)) counts[rating] += 1;
  }
  return counts;
}

/** The highest star that has songs (5 when nothing is rated). Used when the URL has no ?rating=. */
export function getDefaultRating(counts: Readonly<Record<RatingValue, number>>): RatingValue {
  return RATING_VALUES.find(rating => counts[rating] > 0) ?? 5;
}

export type RatedSongSortMode = 'recent' | 'name' | 'artist';

interface SortableSong {
  id: number;
  name: string;
  artistString?: string;
}

/**
 * 'recent' = most recently played first (from the history's last-played map); songs that were
 * never played keep their relative order at the end. 'name' / 'artist' compare in Japanese order.
 */
export function sortRatedSongs<T extends SortableSong>(
  songs: readonly T[],
  mode: RatedSongSortMode,
  lastPlayedAtBySongId: ReadonlyMap<number, number>,
): T[] {
  if (mode === 'name') return [...songs].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  if (mode === 'artist') {
    return [...songs].sort((a, b) => (a.artistString ?? '').localeCompare(b.artistString ?? '', 'ja'));
  }
  return songs
    .map((song, index) => ({ song, index, playedAt: lastPlayedAtBySongId.get(song.id) }))
    .sort((a, b) => {
      if (a.playedAt === undefined || b.playedAt === undefined) {
        if (a.playedAt === b.playedAt) return a.index - b.index;
        return a.playedAt === undefined ? 1 : -1;
      }
      return b.playedAt - a.playedAt || a.index - b.index;
    })
    .map(item => item.song);
}

/** Case-insensitive match on the title or the artist line. An empty query keeps every song. */
export function filterSongsByText<T extends SortableSong>(songs: readonly T[], query: string): T[] {
  const normalized = query.trim().toLocaleLowerCase('ja');
  if (!normalized) return [...songs];
  return songs.filter(song => song.name.toLocaleLowerCase('ja').includes(normalized)
    || (song.artistString ?? '').toLocaleLowerCase('ja').includes(normalized));
}
