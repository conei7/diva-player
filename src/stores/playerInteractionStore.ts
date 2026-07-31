import { create } from 'zustand';
import { readSwipeGestureEnabled, writeSwipeGestureEnabled } from '../utils/playerInteractionPreferences';

interface PlayerInteractionState {
  swipeGestureEnabled: boolean;
  setSwipeGestureEnabled: (enabled: boolean) => void;
}

export const usePlayerInteractionStore = create<PlayerInteractionState>((set) => ({
  swipeGestureEnabled: readSwipeGestureEnabled(),
  setSwipeGestureEnabled: (enabled) => {
    writeSwipeGestureEnabled(enabled);
    set({ swipeGestureEnabled: enabled });
  },
}));
