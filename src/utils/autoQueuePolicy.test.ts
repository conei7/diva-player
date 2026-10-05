import { describe, expect, it } from 'vitest';
import {
  createAutoQueuePlan,
  getAutoQueueFamiliarityBias,
  getAutoQueueMixProgress,
  getAutoQueueStage,
} from './autoQueuePolicy';

describe('auto queue policy', () => {
  it('uses stable session stages rather than queue length', () => {
    expect(getAutoQueueStage(0)).toBe('early');
    expect(getAutoQueueStage(4)).toBe('early');
    expect(getAutoQueueStage(5)).toBe('middle');
    expect(getAutoQueueStage(11)).toBe('middle');
    expect(getAutoQueueStage(12)).toBe('late');
  });

  it('uses smooth progress and keeps familiarity positive instead of reserving slots', () => {
    expect(getAutoQueueMixProgress(0)).toBe(0);
    expect(getAutoQueueMixProgress(6)).toBeGreaterThan(getAutoQueueMixProgress(2));
    expect(getAutoQueueMixProgress(20)).toBeGreaterThan(getAutoQueueMixProgress(6));
    expect(getAutoQueueFamiliarityBias(0)).toBeGreaterThan(getAutoQueueFamiliarityBias(20));
    expect(getAutoQueueFamiliarityBias(20)).toBeGreaterThan(0);
  });

  it('moves smoothly toward familiarity after skips and discovery after sustained success', () => {
    const baseline = getAutoQueueFamiliarityBias(8);
    expect(getAutoQueueFamiliarityBias(8, {
      autoCompletedCount: 1,
      autoSkippedCount: 2,
      consecutiveSkips: 2,
    })).toBeGreaterThan(baseline);
    expect(getAutoQueueFamiliarityBias(8, {
      autoCompletedCount: 9,
      autoSkippedCount: 1,
      consecutiveSkips: 0,
    })).toBeLessThan(baseline);
  });

  it('refills only below the low watermark and targets a bounded queue', () => {
    expect(createAutoQueuePlan(4, 0)).toBeNull();
    expect(createAutoQueuePlan(3, 0)).toMatchObject({ requestedCount: 9, stage: 'early' });
    expect(createAutoQueuePlan(0, 20)).toMatchObject({ requestedCount: 12, stage: 'late' });
  });

  it('preserves the initial thirteen-song queue and expands it to a forty-row window after the delay', () => {
    expect(createAutoQueuePlan(12, 0)).toBeNull();
    expect(createAutoQueuePlan(12, 0, undefined, {
      backgroundPrefillReady: true,
      queueIndex: 0,
    })).toMatchObject({ requestedCount: 27 });
    expect(createAutoQueuePlan(39, 0, undefined, {
      backgroundPrefillReady: true,
      queueIndex: 0,
    })).toBeNull();
  });

  it('reduces the upcoming target as ten recent songs become visible history', () => {
    expect(createAutoQueuePlan(12, 0, undefined, {
      backgroundPrefillReady: true,
      queueIndex: 10,
    })).toMatchObject({ requestedCount: 17 });
    expect(createAutoQueuePlan(29, 0, undefined, {
      backgroundPrefillReady: true,
      queueIndex: 10,
    })).toBeNull();
    expect(createAutoQueuePlan(29, 0, undefined, {
      backgroundPrefillReady: true,
      queueIndex: 30,
    })).toBeNull();
  });

  it('returns continuous scores in the refill plan without known/unknown counts', () => {
    const plan = createAutoQueuePlan(0, 7);
    expect(plan).toMatchObject({ requestedCount: 12, stage: 'middle' });
    expect(plan?.mixProgress).toBeGreaterThan(0);
    expect(plan?.familiarityBias).toBeGreaterThan(0);
    expect(plan).not.toHaveProperty('target');
  });
});
