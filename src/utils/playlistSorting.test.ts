import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { sortPlaylistEntries, sortPlaylistSongs } from './playlistSorting';

function song(id: number, name: string, artistString: string, publishDate: string): Song {
  return {
    id, name, artistString, publishDate,
    defaultName: name,
    defaultNameLanguage: 'Japanese',
    createDate: '2026-01-01',
    favoritedTimes: 0,
    lengthSeconds: 120,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
  };
}

describe('playlist display sorting', () => {
  const addedOrder = [
    song(1, 'C', 'P3', '2024-01-01'),
    song(2, 'A', 'P1', '2026-01-01'),
    song(3, 'B', 'P2', '2025-01-01'),
  ];

  it('can return to the stored addition order after another display sort', () => {
    expect(sortPlaylistSongs(addedOrder, 'name').map(item => item.id)).toEqual([2, 3, 1]);
    expect(sortPlaylistSongs(addedOrder, 'addedOrder').map(item => item.id)).toEqual([1, 2, 3]);
    expect(addedOrder.map(item => item.id)).toEqual([1, 2, 3]);
  });

  it('sorts publish dates newest first', () => {
    expect(sortPlaylistSongs(addedOrder, 'publishDate').map(item => item.id)).toEqual([2, 3, 1]);
  });

  it('keeps the saved position of each row, including both copies of a duplicate', () => {
    const entries = [...addedOrder, addedOrder[1]].map((item, index) => ({ song: item, index }));
    expect(sortPlaylistEntries(entries, 'name').map(entry => entry.index)).toEqual([1, 3, 2, 0]);
    expect(sortPlaylistEntries(entries, 'addedOrder').map(entry => entry.index)).toEqual([0, 1, 2, 3]);
  });
});
