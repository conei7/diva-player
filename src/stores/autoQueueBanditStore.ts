import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AutoQueueStrategyArm } from '../types/autoplay';
import {
  createDefaultBanditStats,
  updateBanditStats,
  type StrategyBanditStats,
} from '../utils/strategyBandit';

interface AutoQueueBanditState {
  stats: StrategyBanditStats;
  selectArm: (decisionCount: number) => AutoQueueStrategyArm;
  recordOutcome: (arm: AutoQueueStrategyArm, outcome: 'complete' | 'skip' | 'neutral') => void;
  reset: () => void;
}

export const useAutoQueueBanditStore = create<AutoQueueBanditState>()(
  persist(
    (set) => ({
      stats: createDefaultBanditStats(),
      selectArm: () => 'balanced',
      recordOutcome: (arm, outcome) => set(state => ({ stats: updateBanditStats(state.stats, arm, outcome) })),
      reset: () => set({ stats: createDefaultBanditStats() }),
    }),
    { name: 'diva-autoplay-bandit-v1' },
  ),
);
