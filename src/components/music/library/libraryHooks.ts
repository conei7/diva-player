import { useMemo, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import { create } from 'zustand';
import { activeNavId, toNavLocation } from '../../layout/navItems';
import type { NavId } from '../../layout/navItems';
import { useUiStore } from '../../../stores/uiStore';
import { storage } from '../../../utils/storage';
import { librarySelectionOf, playlistOrderOf } from './libraryModel';
import type { LibrarySelection, PlaylistOrder } from './libraryModel';

/** The key the playlist library page saves its 並べ替え / 表示 choice under (PlaylistLibrary.tsx). */
const PLAYLIST_LIST_PREFERENCES_KEY = 'playlistListPreferences';
/** Folders the user closed in the library column (all folders start open). */
const COLLAPSED_FOLDERS_KEY = 'musicLibraryCollapsedFolders';

function readPlaylistPreferencesSnapshot(): string {
  // A string snapshot: equal while the saved value is unchanged, so no extra renders.
  return JSON.stringify(storage.get<unknown>(PLAYLIST_LIST_PREFERENCES_KEY) ?? null);
}

/**
 * The library page writes its order to storage in an effect right after a menu choice, without an
 * event. Check again just after any press (and on changes from other tabs), so the column follows
 * the page while both are on screen. The check is one storage read; React renders only on a change.
 */
function subscribePlaylistPreferences(onChange: () => void): () => void {
  let timer: number | undefined;
  const checkSoon = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(onChange, 0);
  };
  window.addEventListener('storage', onChange);
  document.addEventListener('click', checkSoon, true);
  document.addEventListener('keydown', checkSoon, true);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('storage', onChange);
    document.removeEventListener('click', checkSoon, true);
    document.removeEventListener('keydown', checkSoon, true);
  };
}

/** The saved playlist library order (the same order as /playlists). */
export function useStoredPlaylistOrder(): PlaylistOrder {
  const snapshot = useSyncExternalStore(subscribePlaylistPreferences, readPlaylistPreferencesSnapshot, () => 'null');
  return useMemo(() => playlistOrderOf(JSON.parse(snapshot) as unknown), [snapshot]);
}

/**
 * The selected destination and playlist. While a page is still loading after a press, the pressed
 * destination is shown as selected (like useActiveNavId in the guide).
 */
export function useLibrarySelection(): LibrarySelection & { navId: NavId | null } {
  const location = useLocation();
  const pendingNavigation = useUiStore(state => state.pendingNavigation);
  const target = pendingNavigation ? toNavLocation(pendingNavigation) : location;
  return { navId: activeNavId(target), ...librarySelectionOf(target) };
}

function readCollapsedFolders(): string[] {
  const value = storage.get<unknown>(COLLAPSED_FOLDERS_KEY);
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

interface LibraryFolderState {
  collapsedFolderIds: readonly string[];
  toggleFolder: (folderId: string) => void;
}

/** Open / closed folders of the library column (saved, so they stay as the user left them). */
export const useLibraryFolderStore = create<LibraryFolderState>((set, get) => ({
  collapsedFolderIds: readCollapsedFolders(),
  toggleFolder: folderId => {
    const current = get().collapsedFolderIds;
    const next = current.includes(folderId) ? current.filter(id => id !== folderId) : [...current, folderId];
    storage.set(COLLAPSED_FOLDERS_KEY, next);
    set({ collapsedFolderIds: next });
  },
}));
