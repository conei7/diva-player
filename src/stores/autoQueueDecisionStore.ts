import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AutoQueueDecision } from '../types/autoplay';

const MAX_DECISIONS = 1000;

interface AutoQueueDecisionState {
  decisions: AutoQueueDecision[];
  recordDecisions: (decisions: AutoQueueDecision[]) => void;
  getLatestDecisionForSong: (songId: number) => AutoQueueDecision | undefined;
  clearDecisions: () => void;
}

export const useAutoQueueDecisionStore = create<AutoQueueDecisionState>()(
  persist(
    (set, get) => ({
      decisions: [],
      recordDecisions: (decisions) => set(state => ({
        decisions: [...state.decisions, ...decisions].slice(-MAX_DECISIONS),
      })),
      getLatestDecisionForSong: (songId) => get().decisions
        .filter(decision => decision.songId === songId)
        .sort((a, b) => b.generatedAt - a.generatedAt)[0],
      clearDecisions: () => set({ decisions: [] }),
    }),
    { name: 'diva-autoplay-decisions-v1' },
  ),
);
