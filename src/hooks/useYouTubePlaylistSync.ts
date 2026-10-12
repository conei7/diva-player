import { useEffect } from 'react';
import { usePlaylistStore } from '../stores/playlistStore';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

// The sync services are only needed once the app is up; loading them on the first run keeps them
// out of the initial JavaScript (DESIGN_SPEC §1-12).
const loadSyncServices = () => Promise.all([
  import('../services/youtubePlaylistSync'),
  import('../services/nicoPlaylistSync'),
]);

export function useYouTubePlaylistSync(): void {
  const loadPlaylists = usePlaylistStore(state => state.loadPlaylists);

  useEffect(() => {
    loadPlaylists();
    let running = false;
    const run = async () => {
      if (running || !navigator.onLine) return;
      running = true;
      try {
        let services: Awaited<ReturnType<typeof loadSyncServices>>;
        try {
          services = await loadSyncServices();
        } catch {
          // The chunk could not be fetched (offline, new deploy): the next check retries.
          return;
        }
        const [{ syncDueYouTubePlaylists }, { syncDueNicoPlaylists }] = services;
        await syncDueYouTubePlaylists();
        await syncDueNicoPlaylists();
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
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [loadPlaylists]);
}
