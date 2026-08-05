import { describe, expect, it } from 'vitest';
import { getRatedSongIds, getRatingCounts, getSongIdsForRating, isRatingValue } from './ratedSongs';

const ratings = {
  10: 5,
  20: 4,
  30: 1,
  40: 5,
  invalid: 3,
  50: 0,
  60: 6,
};

describe('rated songs', () => {
  it('selects only songs with the exact requested rating', () => {
    expect(getSongIdsForRating(ratings, 5)).toEqual([10, 40]);
    expect(getSongIdsForRating(ratings, 4)).toEqual([20]);
    expect(getSongIdsForRating(ratings, 1)).toEqual([30]);
  });

  it('counts valid song ids separately for all five ratings', () => {
    expect(getRatingCounts(ratings)).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1, 5: 2 });
  });

  it('returns every positively identified song rated from one to five', () => {
    expect(getRatedSongIds({ ...ratings, '-1': 2, 0: 3, 70: 2, 80: 3 })).toEqual([10, 20, 30, 40, 70, 80]);
  });

  it('accepts only the five supported rating values', () => {
    expect([1, 2, 3, 4, 5].every(isRatingValue)).toBe(true);
    expect(isRatingValue(0)).toBe(false);
    expect(isRatingValue(6)).toBe(false);
  });
});
