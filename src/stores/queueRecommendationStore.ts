import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { QueueRecommendation } from '../types/autoplay';

interface StoredQueueRecommendation extends QueueRecommendation {
  songId: number;
}

interface QueueRecommendationState {
  recommendations: Record<string, StoredQueueRecommendation>;
  recordRecommendations: (entries: StoredQueueRecommendation[]) => void;
  clearRecommendations: () => void;
}

const MAX_RECOMMENDATIONS = 1000;

export const useQueueRecommendationStore = create<QueueRecommendationState>()(
  persist(
    (set) => ({
      recommendations: {},
      recordRecommendations: (entries) => set(state => {
        const next = { ...state.recommendations };
        for (const entry of entries) next[String(entry.songId)] = entry;
        const trimmed = Object.values(next)
          .sort((a, b) => b.generatedAt - a.generatedAt)
          .slice(0, MAX_RECOMMENDATIONS);
        return { recommendations: Object.fromEntries(trimmed.map(entry => [String(entry.songId), entry])) };
      }),
      clearRecommendations: () => set({ recommendations: {} }),
    }),
    { name: 'diva-queue-recommendations-v1' },
  ),
);
