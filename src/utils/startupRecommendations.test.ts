import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { selectRotatingStartupSongs } from './startupRecommendations';

function songs(count: number): Song[] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1 } as Song));
}

describe('selectRotatingStartupSongs', () => {
  it('keeps the strongest four songs and changes the remaining content', () => {
    const first = selectRotatingStartupSongs(songs(48), 0, 24);
    const second = selectRotatingStartupSongs(songs(48), 1, 24);

    expect(first.slice(0, 4).map(song => song.id)).toEqual([1, 2, 3, 4]);
    expect(second.slice(0, 4).map(song => song.id)).toEqual([1, 2, 3, 4]);
    expect(second.map(song => song.id)).not.toEqual(first.map(song => song.id));
    expect(second.slice(4).some(song => !first.some(candidate => candidate.id === song.id))).toBe(true);
  });

  it('changes ordering even when the pool contains exactly one page', () => {
    const first = selectRotatingStartupSongs(songs(24), 0, 24);
    const second = selectRotatingStartupSongs(songs(24), 1, 24);

    expect(new Set(second.map(song => song.id))).toEqual(new Set(first.map(song => song.id)));
    expect(second.map(song => song.id)).not.toEqual(first.map(song => song.id));
  });

  it('deduplicates malformed pools and rotates small pools', () => {
    const duplicated = [songs(3)[0], songs(3)[0], songs(3)[1], songs(3)[2]];
    expect(selectRotatingStartupSongs(duplicated, 1, 24).map(song => song.id)).toEqual([2, 3, 1]);
  });
});
