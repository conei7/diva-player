import { create } from 'zustand';
import type { RecommendationDebugSnapshot } from '../types/recommendationDebug';

const MAX_SNAPSHOTS = 10;
export const RECOMMENDATION_DEBUG_STORAGE_KEY = 'diva-recommendation-debug-enabled';

interface RecommendationDebugState {
  enabled: boolean;
  snapshots: RecommendationDebugSnapshot[];
  setEnabled: (enabled: boolean) => void;
  recordSnapshot: (snapshot: RecommendationDebugSnapshot) => void;
  clearSnapshots: () => void;
}

function isDebugRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('recDebug') === '1'
    || window.sessionStorage.getItem(RECOMMENDATION_DEBUG_STORAGE_KEY) === '1';
}

export const useRecommendationDebugStore = create<RecommendationDebugState>((set, get) => ({
  enabled: isDebugRequested(),
  snapshots: [],
  setEnabled: (enabled) => set({ enabled }),
  recordSnapshot: (snapshot) => {
    if (!get().enabled) return;
    set(state => ({
      snapshots: [...state.snapshots, snapshot].slice(-MAX_SNAPSHOTS),
    }));
  },
  clearSnapshots: () => set({ snapshots: [] }),
}));
