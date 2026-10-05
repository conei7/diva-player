import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { filterSongsForVisibilityIntent } from './songVisibility';

const hiddenSong = { id: 42, name: 'Hidden song' } as Song;
const visibleSong = { id: 43, name: 'Visible song' } as Song;
const hiddenSongs = {
  '42': { song: hiddenSong, hiddenAt: 123 },
};

describe('filterSongsForVisibilityIntent', () => {
  it('includes hidden songs in explicit search results', () => {
    expect(filterSongsForVisibilityIntent([hiddenSong, visibleSong], hiddenSongs, 'search'))
      .toEqual([hiddenSong, visibleSong]);
  });

  it('keeps hidden songs out of passive discovery results', () => {
    expect(filterSongsForVisibilityIntent([hiddenSong, visibleSong], hiddenSongs, 'discovery'))
      .toEqual([visibleSong]);
  });
});
