import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AutoQueueDecision } from '../types/autoplay';

const MAX_DECISIONS = 1000;

interface AutoQueueDecisionState {
  decisions: AutoQueueDecision[];
  recordDecisions: (decisions: AutoQueueDecision[]) => void;
  clearDecisions: () => void;
}

export const useAutoQueueDecisionStore = create<AutoQueueDecisionState>()(
  persist(
    (set) => ({
      decisions: [],
      recordDecisions: (decisions) => set(state => ({
        decisions: [...state.decisions, ...decisions].slice(-MAX_DECISIONS),
      })),
      clearDecisions: () => set({ decisions: [] }),
    }),
    { name: 'diva-autoplay-decisions-v1' },
  ),
);
