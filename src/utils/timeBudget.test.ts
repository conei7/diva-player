import { describe, expect, it, vi } from 'vitest';
import { resolveWithin } from './timeBudget';

describe('resolveWithin', () => {
  it('returns a completed value before the budget expires', async () => {
    await expect(resolveWithin(Promise.resolve(42), 100, 0)).resolves.toEqual({
      value: 42,
      timedOut: false,
    });
  });

  it('returns the fallback when optional work exceeds the budget', async () => {
    vi.useFakeTimers();
    const pending = new Promise<number>(() => undefined);
    const result = resolveWithin(pending, 50, 7);
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toEqual({ value: 7, timedOut: true });
    vi.useRealTimers();
  });
});
