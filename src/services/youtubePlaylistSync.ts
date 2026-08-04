import { fetchYouTubePlaylistSongs } from '../api/youtubePlaylist';
import type { Playlist, YouTubePlaylistSync } from '../types/vocadb';
import { usePlaylistStore } from '../stores/playlistStore';
import { withCrossTabLock } from '../utils/crossTabLock';

const SYNC_LOCK_KEY = 'diva-youtube-playlist-sync-lock';

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

  const result = await withCrossTabLock({
    name: 'diva-youtube-playlist-sync',
    fallbackKey: SYNC_LOCK_KEY,
  }, async () => {
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
