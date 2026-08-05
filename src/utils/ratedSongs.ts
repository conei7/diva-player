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
