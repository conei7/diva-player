import { fetchYouTubePlaylistSongs } from '../api/youtubePlaylist';
import type { Playlist, YouTubePlaylistSync } from '../types/vocadb';
import { usePlaylistStore } from '../stores/playlistStore';

const SYNC_LOCK_KEY = 'diva-youtube-playlist-sync-lock';
const LOCK_TTL_MS = 30_000;

interface SyncLock {
  owner: string;
  expiresAt: number;
}

function createOwnerId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function acquireFallbackLock(owner: string): boolean {
  try {
    const now = Date.now();
    const existing = JSON.parse(localStorage.getItem(SYNC_LOCK_KEY) || 'null') as SyncLock | null;
    if (existing && existing.expiresAt > now && existing.owner !== owner) return false;
    localStorage.setItem(SYNC_LOCK_KEY, JSON.stringify({ owner, expiresAt: now + LOCK_TTL_MS }));
    const confirmed = JSON.parse(localStorage.getItem(SYNC_LOCK_KEY) || 'null') as SyncLock | null;
    return confirmed?.owner === owner;
  } catch {
    return true;
  }
}

function releaseFallbackLock(owner: string): void {
  try {
    const current = JSON.parse(localStorage.getItem(SYNC_LOCK_KEY) || 'null') as SyncLock | null;
    if (current?.owner === owner) localStorage.removeItem(SYNC_LOCK_KEY);
  } catch {
    // A stale lock expires on its own.
  }
}

async function withSyncLock<T>(task: () => Promise<T>): Promise<T | null> {
  const owner = createOwnerId();
  if (navigator.locks?.request) {
    return navigator.locks.request('diva-youtube-playlist-sync', { ifAvailable: true }, async lock => (
      lock ? task() : null
    ));
  }
  if (!acquireFallbackLock(owner)) return null;
  try {
    return await task();
  } finally {
    releaseFallbackLock(owner);
  }
}

function buildSyncState(
  current: YouTubePlaylistSync,
  response: Awaited<ReturnType<typeof fetchYouTubePlaylistSongs>>,
  now: number,
): YouTubePlaylistSync {
  return {
    ...current,
    lastAttemptAt: now,
    lastSuccessfulAt: now,
    nextSyncAt: now + current.intervalHours * 60 * 60 * 1000,
    lastStatus: response.unmatchedVideoIds.length > 0 || response.truncated ? 'partial' : 'success',
    lastVideoCount: response.videoCount,
    lastMatchedCount: response.matchedCount,
    lastUnmatchedCount: response.unmatchedVideoIds.length,
    lastError: undefined,
  };
}

export async function syncYouTubePlaylist(
  playlist: Playlist,
  options: { refresh?: boolean } = {},
): Promise<'success' | 'partial' | 'skipped' | 'error'> {
  const sync = playlist.youtubeSync;
  if (!sync?.enabled) return 'skipped';
  const now = Date.now();
  if (!options.refresh && sync.nextSyncAt && sync.nextSyncAt > now) return 'skipped';

  const result = await withSyncLock(async () => {
    try {
      const response = await fetchYouTubePlaylistSongs(sync.playlistId, { refresh: options.refresh });
      const nextSync = buildSyncState(sync, response, Date.now());
      usePlaylistStore.getState().applyYouTubeSync(playlist.id, response.songs, nextSync);
      return nextSync.lastStatus === 'partial' ? 'partial' as const : 'success' as const;
    } catch (error) {
      const failedSync: YouTubePlaylistSync = {
        ...sync,
        lastAttemptAt: Date.now(),
        lastStatus: 'error',
        lastError: error instanceof Error ? error.message : '同期に失敗しました',
      };
      const current = usePlaylistStore.getState().playlists.find(item => item.id === playlist.id);
      if (current) usePlaylistStore.getState().applyYouTubeSync(playlist.id, current.songs, failedSync);
      return 'error' as const;
    }
  });
  return result ?? 'skipped';
}

export async function syncDueYouTubePlaylists(options: { refresh?: boolean } = {}): Promise<Record<string, 'success' | 'partial' | 'skipped' | 'error'>> {
  const playlists = usePlaylistStore.getState().playlists.filter(playlist => playlist.youtubeSync?.enabled);
  const results: Record<string, 'success' | 'partial' | 'skipped' | 'error'> = {};
  for (const playlist of playlists) {
    results[playlist.id] = await syncYouTubePlaylist(playlist, options);
  }
  return results;
}
