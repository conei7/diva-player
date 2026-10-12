import { describe, expect, it } from 'vitest';
import type { Playlist } from '../types/vocadb';
import {
  DEFAULT_PLAYLIST_LIST_PREFERENCES,
  getPlaylistLibrarySort,
  normalizePlaylistListPreferences,
  sortPlaylistsForDisplay,
  withPlaylistLibrarySort,
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

  it('maps the library sort menu onto the stored key and order without touching density', () => {
    const compact = { ...DEFAULT_PLAYLIST_LIST_PREFERENCES, density: 'compact' as const };
    expect(withPlaylistLibrarySort(compact, 'oldest')).toEqual({ sortKey: 'updatedAt', sortOrder: 'asc', density: 'compact' });
    expect(withPlaylistLibrarySort(compact, 'name')).toEqual({ sortKey: 'name', sortOrder: 'asc', density: 'compact' });
    expect(withPlaylistLibrarySort(compact, 'songs')).toEqual({ sortKey: 'songCount', sortOrder: 'desc', density: 'compact' });
    expect(withPlaylistLibrarySort(compact, 'recent')).toEqual({ sortKey: 'updatedAt', sortOrder: 'desc', density: 'compact' });
    expect(getPlaylistLibrarySort({ sortKey: 'updatedAt', sortOrder: 'desc' })).toBe('recent');
    expect(getPlaylistLibrarySort({ sortKey: 'updatedAt', sortOrder: 'asc' })).toBe('oldest');
    // Older saved orders (name ↓, song count ↑) still land on a menu choice.
    expect(getPlaylistLibrarySort({ sortKey: 'name', sortOrder: 'desc' })).toBe('name');
    expect(getPlaylistLibrarySort({ sortKey: 'songCount', sortOrder: 'asc' })).toBe('songs');
  });

  it('normalizes persisted values and falls back safely', () => {
    expect(normalizePlaylistListPreferences({ sortKey: 'name', sortOrder: 'asc', density: 'compact' })).toEqual({ sortKey: 'name', sortOrder: 'asc', density: 'compact' });
    expect(normalizePlaylistListPreferences({ sortKey: 'unknown', density: 'large' })).toEqual({ sortKey: 'updatedAt', sortOrder: 'desc', density: 'comfortable' });
  });
});
