import { create } from 'zustand';
import {
  readFloatingPlayerEnabled,
  readSwipeGestureEnabled,
  writeFloatingPlayerEnabled,
  writeSwipeGestureEnabled,
} from '../utils/playerInteractionPreferences';

interface PlayerInteractionState {
  swipeGestureEnabled: boolean;
  setSwipeGestureEnabled: (enabled: boolean) => void;
  /** 小窓プレイヤー: its buttons and the browser's automatic opening (components/player/FloatingPlayerHost). */
  floatingPlayerEnabled: boolean;
  setFloatingPlayerEnabled: (enabled: boolean) => void;
}

export const usePlayerInteractionStore = create<PlayerInteractionState>((set) => ({
  swipeGestureEnabled: readSwipeGestureEnabled(),
  setSwipeGestureEnabled: (enabled) => {
    writeSwipeGestureEnabled(enabled);
    set({ swipeGestureEnabled: enabled });
  },
  floatingPlayerEnabled: readFloatingPlayerEnabled(),
  setFloatingPlayerEnabled: (enabled) => {
    writeFloatingPlayerEnabled(enabled);
    set({ floatingPlayerEnabled: enabled });
  },
}));
