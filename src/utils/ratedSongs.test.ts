import { describe, expect, it } from 'vitest';
import {
  filterSongsByText,
  getDefaultRating,
  getRatedSongIds,
  getRatingCounts,
  getSongIdsForRating,
  isRatingValue,
  sortRatedSongs,
} from './ratedSongs';

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

  it('defaults to the highest star that has songs', () => {
    expect(getDefaultRating({ 1: 1, 2: 0, 3: 2, 4: 0, 5: 0 })).toBe(3);
    expect(getDefaultRating({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 4 })).toBe(5);
    expect(getDefaultRating({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })).toBe(5);
  });

  describe('sorting rated songs', () => {
    const songs = [
      { id: 10, name: 'ロウワー', artistString: 'ぬゆり' },
      { id: 20, name: 'アイドル', artistString: 'Ayase' },
      { id: 30, name: 'きゅうくらりん', artistString: 'いよわ' },
      { id: 40, name: 'シャルル', artistString: 'バルーン' },
    ];

    it('puts the most recently played songs first and never-played songs last in their order', () => {
      const lastPlayed = new Map([[30, 2_000], [20, 5_000]]);
      expect(sortRatedSongs(songs, 'recent', lastPlayed).map(song => song.id)).toEqual([20, 30, 10, 40]);
    });

    it('keeps the original order when nothing was played', () => {
      expect(sortRatedSongs(songs, 'recent', new Map()).map(song => song.id)).toEqual([10, 20, 30, 40]);
    });

    it('sorts by title and by artist', () => {
      expect(sortRatedSongs(songs, 'name', new Map()).map(song => song.id)).toEqual([20, 30, 40, 10]);
      expect(sortRatedSongs(songs, 'artist', new Map()).map(song => song.artistString))
        .toEqual(['Ayase', 'いよわ', 'ぬゆり', 'バルーン']);
    });
  });

  it('filters songs by title or artist without case sensitivity', () => {
    const songs = [
      { id: 1, name: 'Hello Song', artistString: 'Fixture P' },
      { id: 2, name: '別の曲', artistString: 'hello producer' },
      { id: 3, name: '無関係', artistString: undefined },
    ];
    expect(filterSongsByText(songs, '  HELLO ').map(song => song.id)).toEqual([1, 2]);
    expect(filterSongsByText(songs, '').map(song => song.id)).toEqual([1, 2, 3]);
  });
});
