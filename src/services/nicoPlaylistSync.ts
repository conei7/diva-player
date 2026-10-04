import { fetchNicoPlaylistSongs } from '../api/nicoPlaylist';
import { PlaylistPersistenceError, usePlaylistStore } from '../stores/playlistStore';
import type { NicoPlaylistSync, Playlist } from '../types/vocadb';
import { withCrossTabLock } from '../utils/crossTabLock';

const LOCK_KEY = 'diva-nico-playlist-sync-lock';

export async function syncNicoPlaylist(
  playlist: Playlist,
  options: { refresh?: boolean } = {},
): Promise<'success' | 'partial' | 'skipped' | 'error'> {
  const sync = playlist.nicoSync;
  if (!sync?.enabled) return 'skipped';
  const now = Date.now();
  if (!options.refresh && sync.nextSyncAt && sync.nextSyncAt > now) return 'skipped';
  const result = await withCrossTabLock({
    name: 'diva-nico-playlist-sync',
    fallbackKey: LOCK_KEY,
  }, async () => {
    try {
      const initialSettings = { sourceKind: sync.sourceKind, sourceId: sync.sourceId, intervalHours: sync.intervalHours };
      const response = await fetchNicoPlaylistSongs({ kind: sync.sourceKind, id: sync.sourceId }, { refresh: options.refresh });
      const current = usePlaylistStore.getState().playlists.find(item => item.id === playlist.id);
      if (!current?.nicoSync?.enabled
        || current.nicoSync !== sync
        || current.nicoSync.sourceKind !== initialSettings.sourceKind
        || current.nicoSync.sourceId !== initialSettings.sourceId
        || current.nicoSync.intervalHours !== initialSettings.intervalHours) return 'skipped' as const;
      const next: NicoPlaylistSync = {
        ...sync,
        lastAttemptAt: Date.now(),
        lastSuccessfulAt: Date.now(),
        nextSyncAt: Date.now() + sync.intervalHours * 60 * 60 * 1000,
        lastStatus: response.unmatchedVideoIds.length > 0 || response.truncated ? 'partial' : 'success',
        lastVideoCount: response.videoCount,
        lastMatchedCount: response.matchedCount,
        lastUnmatchedCount: response.unmatchedVideoIds.length,
        lastError: undefined,
      };
      if (!usePlaylistStore.getState().applyNicoSync(playlist.id, response.songs, next)) return 'skipped' as const;
      return next.lastStatus === 'partial' ? 'partial' as const : 'success' as const;
    } catch (reason) {
      if (reason instanceof PlaylistPersistenceError) return 'error' as const;
      const failed: NicoPlaylistSync = {
        ...sync,
        lastAttemptAt: Date.now(),
        lastStatus: 'error',
        lastError: reason instanceof Error ? reason.message : '同期に失敗しました',
      };
      const current = usePlaylistStore.getState().playlists.find(item => item.id === playlist.id);
      if (!current?.nicoSync?.enabled
        || current.nicoSync !== sync
        || current.nicoSync.sourceKind !== sync.sourceKind
        || current.nicoSync.sourceId !== sync.sourceId
        || current.nicoSync.intervalHours !== sync.intervalHours) return 'skipped' as const;
      try {
        usePlaylistStore.getState().applyNicoSync(playlist.id, current.songs, failed);
      } catch {
        // The failed sync result cannot be persisted either; the store reports
        // the persistence failure to the user and leaves memory unchanged.
      }
      return 'error' as const;
    }
  });
  return result ?? 'skipped';
}

export async function syncDueNicoPlaylists(): Promise<void> {
  const playlists = usePlaylistStore.getState().playlists.filter(playlist => playlist.nicoSync?.enabled);
  for (const playlist of playlists) await syncNicoPlaylist(playlist);
}
