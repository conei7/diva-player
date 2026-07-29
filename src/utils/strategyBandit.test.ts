import { describe, expect, it } from 'vitest';
import {
  adjustTargetForStrategy,
  createDefaultBanditStats,
  selectThompsonArm,
  simulateThompsonSampling,
  updateBanditStats,
} from './strategyBandit';

describe('autoplay strategy bandit', () => {
  it('updates the beta distribution from complete and skip outcomes', () => {
    const initial = createDefaultBanditStats();
    const completed = updateBanditStats(initial, 'balanced', 'complete');
    const skipped = updateBanditStats(completed, 'balanced', 'skip');

    expect(skipped.balanced).toEqual({ alpha: 2, beta: 2 });
  });

  it('always chooses the single supported balanced policy', () => {
    const stats = createDefaultBanditStats();
    expect(selectThompsonArm(stats, () => 0)).toBe('balanced');
  });

  it('does not shift known and unknown slots', () => {
    expect(adjustTargetForStrategy({ known: 6, unknown: 4 }, 'balanced')).toEqual({ known: 6, unknown: 4 });
  });

  it('keeps simulation on the balanced policy', () => {
    let state = 123456789;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const result = simulateThompsonSampling({ balanced: 0.8 }, 800, random);

    expect(result.selections.balanced).toBe(800);
  });
});
