import { fetchNicoPlaylistSongs } from '../api/nicoPlaylist';
import { usePlaylistStore } from '../stores/playlistStore';
import type { NicoPlaylistSync, Playlist } from '../types/vocadb';

const LOCK_KEY = 'diva-nico-playlist-sync-lock';
const LOCK_TTL_MS = 30_000;

async function withSyncLock<T>(task: () => Promise<T>): Promise<T | null> {
  if (navigator.locks?.request) {
    return navigator.locks.request('diva-nico-playlist-sync', { ifAvailable: true }, async lock => lock ? task() : null);
  }
  const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const now = Date.now();
    const current = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null') as { owner: string; expiresAt: number } | null;
    if (current && current.expiresAt > now && current.owner !== owner) return null;
    localStorage.setItem(LOCK_KEY, JSON.stringify({ owner, expiresAt: now + LOCK_TTL_MS }));
    const confirmed = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null') as { owner: string } | null;
    if (confirmed?.owner !== owner) return null;
    return await task();
  } finally {
    try {
      const current = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null') as { owner: string } | null;
      if (current?.owner === owner) localStorage.removeItem(LOCK_KEY);
    } catch { /* stale locks expire */ }
  }
}

export async function syncNicoPlaylist(
  playlist: Playlist,
  options: { refresh?: boolean } = {},
): Promise<'success' | 'partial' | 'skipped' | 'error'> {
  const sync = playlist.nicoSync;
  if (!sync?.enabled) return 'skipped';
  const now = Date.now();
  if (!options.refresh && sync.nextSyncAt && sync.nextSyncAt > now) return 'skipped';
  const result = await withSyncLock(async () => {
    try {
      const response = await fetchNicoPlaylistSongs({ kind: sync.sourceKind, id: sync.sourceId }, { refresh: options.refresh });
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
      usePlaylistStore.getState().applyNicoSync(playlist.id, response.songs, next);
      return next.lastStatus === 'partial' ? 'partial' as const : 'success' as const;
    } catch (reason) {
      const failed: NicoPlaylistSync = {
        ...sync,
        lastAttemptAt: Date.now(),
        lastStatus: 'error',
        lastError: reason instanceof Error ? reason.message : '同期に失敗しました',
      };
      const current = usePlaylistStore.getState().playlists.find(item => item.id === playlist.id);
      if (current) usePlaylistStore.getState().applyNicoSync(playlist.id, current.songs, failed);
      return 'error' as const;
    }
  });
  return result ?? 'skipped';
}

export async function syncDueNicoPlaylists(): Promise<void> {
  const playlists = usePlaylistStore.getState().playlists.filter(playlist => playlist.nicoSync?.enabled);
  for (const playlist of playlists) await syncNicoPlaylist(playlist);
}
