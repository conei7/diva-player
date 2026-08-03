import { beforeEach, describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { excludeHiddenSongs, normalizeHiddenSongs, useHiddenSongStore } from './hiddenSongStore';

const song = { id: 42, name: 'hidden fixture' } as Song;

describe('hidden song store', () => {
  beforeEach(() => useHiddenSongStore.setState({ hiddenSongs: {} }));

  it('hides and restores a song independently from star ratings', () => {
    useHiddenSongStore.getState().hideSong(song);
    expect(useHiddenSongStore.getState().isHidden(42)).toBe(true);
    expect(excludeHiddenSongs([song], useHiddenSongStore.getState().hiddenSongs)).toEqual([]);

    useHiddenSongStore.getState().restoreSong(42);
    expect(useHiddenSongStore.getState().isHidden(42)).toBe(false);
  });

  it('drops malformed persisted records', () => {
    expect(normalizeHiddenSongs({
      '42': { song, hiddenAt: 123 },
      bad: { song },
      '43': { song, hiddenAt: 123 },
    })).toEqual({ '42': { song, hiddenAt: 123 } });
  });
});
