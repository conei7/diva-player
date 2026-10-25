import { useEffect } from 'react';
import { usePlaylistStore } from '../stores/playlistStore';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

// The sync services are only needed once the app is up; loading them on the first run keeps them
// out of the initial JavaScript (DESIGN_SPEC §1-12).
const loadSyncServices = () => import('../services/librarySync');

export function useYouTubePlaylistSync(): void {
  const loadPlaylists = usePlaylistStore(state => state.loadPlaylists);

  useEffect(() => {
    loadPlaylists();
    let running = false;
    let disposed = false;
    let stopSavedDataSync: (() => void) | undefined;
    const run = async () => {
      if (running || disposed) return;
      running = true;
      try {
        let services: Awaited<ReturnType<typeof loadSyncServices>>;
        try {
          services = await loadSyncServices();
        } catch {
          // The chunk could not be fetched (offline, new deploy): the next check retries.
          return;
        }
        if (disposed) return;
        stopSavedDataSync ??= services.startSavedDataSync();
        if (!navigator.onLine) return;
        const { syncDueYouTubePlaylists, syncDueNicoPlaylists } = services;
        await syncDueYouTubePlaylists();
        if (!disposed) await syncDueNicoPlaylists();
      } finally {
        running = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    const onOnline = () => void run();
    void run();
    const timer = window.setInterval(() => void run(), CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      disposed = true;
      stopSavedDataSync?.();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [loadPlaylists]);
}
