import { getPlaylistStorageSnapshot, usePlaylistStore } from '../stores/playlistStore';
import { useRatingStore } from '../stores/ratingStore';
import { useFavoriteProducerStore } from '../stores/favoriteProducerStore';
import { useHiddenSongStore } from '../stores/hiddenSongStore';
import { startHistoryFinalizationRecovery } from './historyFinalization';

export { syncDueYouTubePlaylists } from './youtubePlaylistSync';
export { syncDueNicoPlaylists } from './nicoPlaylistSync';

function reloadIfChanged<T>(store: {
  getState: () => T;
  persist: { getOptions: () => { name?: string }; rehydrate: () => void | Promise<void> };
}, field: keyof T, empty: unknown): void | Promise<void> {
  const name = store.persist.getOptions().name;
  if (!name) return;
  const raw = localStorage.getItem(name);
  const saved = raw ? JSON.parse(raw).state?.[field] ?? empty : empty;
  // Rehydrating equivalent objects would invalidate discovery requests at startup.
  if (JSON.stringify(store.getState()[field]) !== JSON.stringify(saved)) return store.persist.rehydrate();
}

/** Keep already-open tabs current without sharing playback ownership or writing data back. */
export function startSavedDataSync(): () => void {
  const stopHistoryRecovery = startHistoryFinalizationRecovery();
  const groups = [
    { keys: ['diva_playlists', 'diva_playlistFolders'], reload: () => usePlaylistStore.getState().loadPlaylists(), subscribe: usePlaylistStore.subscribe, savesBeforePublish: true },
    { keys: ['diva-ratings'], reload: () => reloadIfChanged(useRatingStore, 'ratings', {}), subscribe: useRatingStore.subscribe },
    { keys: ['diva-favorite-producers'], reload: () => reloadIfChanged(useFavoriteProducerStore, 'producers', []), subscribe: useFavoriteProducerStore.subscribe },
    { keys: ['diva-hidden-songs'], reload: () => reloadIfChanged(useHiddenSongStore, 'hiddenSongs', {}), subscribe: useHiddenSongStore.subscribe },
  ];
  const snapshots = new Map<string, string | null>();
  const published = getPlaylistStorageSnapshot();
  if (published) groups[0].keys.forEach((key, index) => snapshots.set(key, published[index]));
  const remember = (keys: string[]) => {
    for (const key of keys) snapshots.set(key, localStorage.getItem(key));
  };
  const refresh = (key?: string | null) => {
    for (const group of groups) {
      if (key != null && !group.keys.includes(key)) continue;
      try {
        if (group.keys.every(item => snapshots.has(item) && snapshots.get(item) === localStorage.getItem(item))) continue;
        // Read current storage, not event.newValue: queued events may describe an older write
        // or the first half of a multi-key save/rollback.
        const result = group.reload();
        if (result) void result.catch(error => console.error('[LibrarySync] Reload failed', error));
        remember(group.keys);
      } catch (error) {
        console.error('[LibrarySync] Reload failed', error);
      }
    }
  };
  refresh();
  const subscriptions = groups.map(group => group.subscribe(() => {
    // A local save is already reflected in memory. Do not reload it on the next focus:
    // replacing playlist objects would reset the user's current selection.
    try {
      if (group.savesBeforePublish) remember(group.keys);
      // Zustand persist notifies subscribers before it writes storage. Mark those snapshots
      // dirty instead of caching the old value (which could hide a subsequent remote deletion).
      else group.keys.forEach(key => snapshots.delete(key));
    } catch { /* Storage is temporarily unavailable. */ }
  }));
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage) refresh(event.key);
  };
  const onFocus = () => refresh();
  const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    stopHistoryRecovery();
    subscriptions.forEach(unsubscribe => unsubscribe());
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
