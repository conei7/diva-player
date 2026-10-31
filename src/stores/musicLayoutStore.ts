import { create } from 'zustand';
import { storage } from '../utils/storage';

const NOW_PLAYING_PANEL_KEY = 'musicNowPlayingOpen';

interface MusicLayoutState {
  /** The music layout's 再生中 panel (right column, from MUSIC_PANEL_MEDIA_QUERY). Open by default. */
  nowPlayingOpen: boolean;
  setNowPlayingOpen: (open: boolean) => void;
  toggleNowPlaying: () => void;
}

export const useMusicLayoutStore = create<MusicLayoutState>((set, get) => ({
  nowPlayingOpen: storage.get<unknown>(NOW_PLAYING_PANEL_KEY) !== false,
  setNowPlayingOpen: open => {
    storage.set(NOW_PLAYING_PANEL_KEY, open);
    set({ nowPlayingOpen: open });
  },
  toggleNowPlaying: () => get().setNowPlayingOpen(!get().nowPlayingOpen),
}));
