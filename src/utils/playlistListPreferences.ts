import type { Playlist } from '../types/vocadb';

export type PlaylistListSortKey = 'updatedAt' | 'name' | 'songCount';
export type PlaylistListSortOrder = 'asc' | 'desc';
export type PlaylistListDensity = 'comfortable' | 'compact';

export interface PlaylistListPreferences {
  sortKey: PlaylistListSortKey;
  sortOrder: PlaylistListSortOrder;
  density: PlaylistListDensity;
}

export const DEFAULT_PLAYLIST_LIST_PREFERENCES: PlaylistListPreferences = {
  sortKey: 'updatedAt',
  sortOrder: 'desc',
  density: 'comfortable',
};

export function sortPlaylistsForDisplay(
  playlists: Playlist[],
  sortKey: PlaylistListSortKey,
  sortOrder: PlaylistListSortOrder,
): Playlist[] {
  const direction = sortOrder === 'asc' ? 1 : -1;
  return [...playlists].sort((left, right) => {
    const primaryComparison = sortKey === 'name'
      ? left.name.localeCompare(right.name, 'ja', { sensitivity: 'base' })
      : sortKey === 'songCount'
        ? left.songs.length - right.songs.length
        : left.updatedAt - right.updatedAt;
    if (primaryComparison !== 0) return primaryComparison * direction;
    let comparison = left.name.localeCompare(right.name, 'ja', { sensitivity: 'base' });
    if (comparison === 0) comparison = left.id.localeCompare(right.id);
    return comparison;
  });
}

export function normalizePlaylistListPreferences(value: unknown): PlaylistListPreferences {
  if (!value || typeof value !== 'object') return DEFAULT_PLAYLIST_LIST_PREFERENCES;
  const candidate = value as Partial<PlaylistListPreferences>;
  const sortKey: PlaylistListSortKey = candidate.sortKey === 'name' || candidate.sortKey === 'songCount' || candidate.sortKey === 'updatedAt'
    ? candidate.sortKey
    : DEFAULT_PLAYLIST_LIST_PREFERENCES.sortKey;
  const sortOrder: PlaylistListSortOrder = candidate.sortOrder === 'asc' || candidate.sortOrder === 'desc'
    ? candidate.sortOrder
    : DEFAULT_PLAYLIST_LIST_PREFERENCES.sortOrder;
  const density: PlaylistListDensity = candidate.density === 'compact' || candidate.density === 'comfortable'
    ? candidate.density
    : DEFAULT_PLAYLIST_LIST_PREFERENCES.density;
  return { sortKey, sortOrder, density };
}
