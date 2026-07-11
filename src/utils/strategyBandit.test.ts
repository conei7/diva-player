import { describe, expect, it } from 'vitest';
import {
  adjustTargetForStrategy,
  createDefaultBanditStats,
  selectThompsonArm,
  updateBanditStats,
} from './strategyBandit';

describe('autoplay strategy bandit', () => {
  it('updates the beta distribution from complete and skip outcomes', () => {
    const initial = createDefaultBanditStats();
    const completed = updateBanditStats(initial, 'explore', 'complete');
    const skipped = updateBanditStats(completed, 'explore', 'skip');

    expect(skipped.explore).toEqual({ alpha: 2, beta: 2 });
    expect(skipped.balanced).toEqual({ alpha: 1, beta: 1 });
  });

  it('chooses the arm with the best sampled reward', () => {
    const stats = createDefaultBanditStats();
    const samples = new Map([[stats.familiar, 0.2], [stats.balanced, 0.8], [stats.explore, 0.5]]);
    expect(selectThompsonArm(stats, distribution => samples.get(distribution) ?? 0)).toBe('balanced');
  });

  it('changes known and unknown slots without changing the total', () => {
    expect(adjustTargetForStrategy({ known: 6, unknown: 4 }, 'familiar')).toEqual({ known: 7, unknown: 3 });
    expect(adjustTargetForStrategy({ known: 6, unknown: 4 }, 'balanced')).toEqual({ known: 6, unknown: 4 });
    expect(adjustTargetForStrategy({ known: 6, unknown: 4 }, 'explore')).toEqual({ known: 5, unknown: 5 });
  });
});
