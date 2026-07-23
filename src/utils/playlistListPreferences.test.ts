import { describe, expect, it } from 'vitest';
import type { Playlist } from '../types/vocadb';
import {
  normalizePlaylistListPreferences,
  sortPlaylistsForDisplay,
} from './playlistListPreferences';

const playlist = (id: string, name: string, updatedAt: number, songCount: number): Playlist => ({
  id,
  name,
  songs: Array.from({ length: songCount }, (_, index) => ({ id: index + 1, name: `曲${index + 1}` } as Playlist['songs'][number])),
  createdAt: updatedAt,
  updatedAt,
});

describe('playlist list preferences', () => {
  it('sorts without mutating the source and uses stable tie breakers', () => {
    const source = [playlist('b', '同じ', 2, 1), playlist('a', '同じ', 2, 1), playlist('c', '古い', 1, 3)];
    expect(sortPlaylistsForDisplay(source, 'updatedAt', 'desc').map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(source.map(item => item.id)).toEqual(['b', 'a', 'c']);
  });

  it('supports name and song count ordering', () => {
    const source = [playlist('a', 'Z', 1, 2), playlist('b', 'A', 2, 1)];
    expect(sortPlaylistsForDisplay(source, 'name', 'asc').map(item => item.id)).toEqual(['b', 'a']);
    expect(sortPlaylistsForDisplay(source, 'songCount', 'desc').map(item => item.id)).toEqual(['a', 'b']);
  });

  it('normalizes persisted values and falls back safely', () => {
    expect(normalizePlaylistListPreferences({ sortKey: 'name', sortOrder: 'asc', density: 'compact' })).toEqual({ sortKey: 'name', sortOrder: 'asc', density: 'compact' });
    expect(normalizePlaylistListPreferences({ sortKey: 'unknown', density: 'large' })).toEqual({ sortKey: 'updatedAt', sortOrder: 'desc', density: 'comfortable' });
  });
});
