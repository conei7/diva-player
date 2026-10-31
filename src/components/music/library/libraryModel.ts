/**
 * Pure helpers of the music layout's library column (MusicLibrary): which playlists it lists and in
 * which order, which entry the current location selects, and the shared row classes.
 */
import type { NavLocation } from '../../layout/navItems';
import { WATCH_LATER_ID } from '../../../stores/playlistStore';
import type { Playlist, PlaylistFolder } from '../../../types/vocadb';
import {
  getPlaylistLibrarySort,
  normalizePlaylistListPreferences,
  sortPlaylistsForDisplay,
  withPlaylistLibrarySort,
} from '../../../utils/playlistListPreferences';
import type { PlaylistListSortKey, PlaylistListSortOrder } from '../../../utils/playlistListPreferences';

export interface PlaylistOrder {
  sortKey: PlaylistListSortKey;
  sortOrder: PlaylistListSortOrder;
}

/**
 * The order the playlist library (/playlists) saved, read the way its 並べ替え menu reads it (an older
 * saved pair such as 名前 ↓ becomes the menu's choice), so the column and the page list the same order.
 */
export function playlistOrderOf(storedPreferences: unknown): PlaylistOrder {
  const preferences = normalizePlaylistListPreferences(storedPreferences);
  const { sortKey, sortOrder } = withPlaylistLibrarySort(preferences, getPlaylistLibrarySort(preferences));
  return { sortKey, sortOrder };
}

export interface LibraryFolderGroup {
  folder: PlaylistFolder;
  /** Never empty (folders without playlists are not listed: there is nothing to open in them). */
  playlists: Playlist[];
}

export interface LibraryModel {
  /** 後で聴く (a fixed entry of the column, not one of the listed playlists). */
  watchLater: Playlist | null;
  /** Other system playlists (isPinned), first, like the library page. */
  pinned: Playlist[];
  /** Folders in the store's order (the order of the library page's folder chips). */
  folders: LibraryFolderGroup[];
  /** Playlists outside any folder (also those whose folder no longer exists), after the folders. */
  unfiled: Playlist[];
  /** Listed playlists (pinned + in folders + unfiled). */
  count: number;
}

/**
 * The column's playlists: 後で聴く apart, pinned lists first, then each folder with its playlists,
 * then the playlists without a folder. Inside every group the saved library order applies.
 */
export function buildLibraryModel(
  playlists: readonly Playlist[],
  folders: readonly PlaylistFolder[],
  order: PlaylistOrder,
): LibraryModel {
  let watchLater: Playlist | null = null;
  const pinned: Playlist[] = [];
  const regular: Playlist[] = [];
  for (const playlist of playlists) {
    if (playlist.id === WATCH_LATER_ID) watchLater ??= playlist;
    else if (playlist.isPinned) pinned.push(playlist);
    else regular.push(playlist);
  }

  const knownFolderIds = new Set(folders.map(folder => folder.id));
  const byFolder = new Map<string, Playlist[]>();
  const unfiled: Playlist[] = [];
  for (const playlist of sortPlaylistsForDisplay(regular, order.sortKey, order.sortOrder)) {
    const folderId = playlist.folderId;
    if (folderId && knownFolderIds.has(folderId)) {
      const group = byFolder.get(folderId);
      if (group) group.push(playlist);
      else byFolder.set(folderId, [playlist]);
    } else {
      unfiled.push(playlist);
    }
  }

  const seenFolderIds = new Set<string>();
  const groups: LibraryFolderGroup[] = [];
  for (const folder of folders) {
    const group = byFolder.get(folder.id);
    if (!group || seenFolderIds.has(folder.id)) continue;
    seenFolderIds.add(folder.id);
    groups.push({ folder, playlists: group });
  }

  return { watchLater, pinned, folders: groups, unfiled, count: pinned.length + regular.length };
}

export interface LibrarySelection {
  /** The open playlist (`/playlists?list=<id>`), or null. */
  listId: string | null;
  /** The playlist library itself (`/playlists` without a list). */
  libraryPage: boolean;
}

/** Which playlist (or the library page) a location shows. */
export function librarySelectionOf(location: NavLocation): LibrarySelection {
  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  if (pathname !== '/playlists') return { listId: null, libraryPage: false };
  const listId = new URLSearchParams(location.search).get('list');
  return listId ? { listId, libraryPage: false } : { listId: null, libraryPage: true };
}

/** Whether a folder holds the open playlist (a closed folder is then shown as selected). */
export function folderHoldsList(group: LibraryFolderGroup, listId: string | null): boolean {
  return listId !== null && group.playlists.some(playlist => playlist.id === listId);
}

/**
 * In the rail, a playlist's or folder's name (any length, up to the tooltip's 240px) shows on the
 * right of the 72px column. Below this width that tooltip could reach the video card above the
 * player bar (360px wide, 16px from the right), so the names are only labels there.
 */
export const RAIL_NAME_TOOLTIP_MEDIA_QUERY = '(min-width: 720px)';

/** A row of the column: 8px corners, the music shell's hover / selected backgrounds. */
export const LIBRARY_ROW_CLASS =
  'flex w-full min-w-0 items-center rounded-lg text-left no-underline transition-colors duration-150 [-webkit-tap-highlight-color:transparent]';

/** Hover and selected backgrounds of a library row (selected rows are lighter). */
export function libraryRowStateClass(active: boolean): string {
  return active ? 'bg-yt-tonal text-yt-text hover:bg-yt-tonal-hover' : 'text-yt-text hover:bg-yt-tonal';
}

/** Top destinations (ホーム …): grey until selected or hovered, like a music app's main links. */
export function libraryNavStateClass(active: boolean): string {
  return active
    ? 'bg-yt-tonal font-semibold text-yt-text hover:bg-yt-tonal-hover'
    : 'font-medium text-yt-text-secondary hover:bg-yt-tonal hover:text-yt-text';
}
