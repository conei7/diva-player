import { useEffect } from 'react';
import { syncDueYouTubePlaylists } from '../services/youtubePlaylistSync';
import { usePlaylistStore } from '../stores/playlistStore';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export function useYouTubePlaylistSync(): void {
  const loadPlaylists = usePlaylistStore(state => state.loadPlaylists);

  useEffect(() => {
    loadPlaylists();
    let running = false;
    const run = async () => {
      if (running || !navigator.onLine) return;
      running = true;
      try {
        await syncDueYouTubePlaylists();
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
