import { create } from 'zustand';
import {
  readRecommendationHintsEnabled,
  writeRecommendationHintsEnabled,
} from '../utils/recommendationDisplayPreferences';

interface RecommendationDisplayState {
  showHints: boolean;
  setShowHints: (showHints: boolean) => void;
}

export const useRecommendationDisplayStore = create<RecommendationDisplayState>((set) => ({
  showHints: readRecommendationHintsEnabled(),
  setShowHints: (showHints) => {
    writeRecommendationHintsEnabled(showHints);
    set({ showHints });
  },
}));
