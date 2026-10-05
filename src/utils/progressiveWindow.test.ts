import { describe, expect, it } from 'vitest';
import { getProgressiveWindow } from './progressiveWindow';

describe('getProgressiveWindow', () => {
  it('keeps the home first page and append page contiguous through 40 items', () => {
    expect(getProgressiveWindow(0)).toEqual({ start: 0, count: 12 });
    expect(getProgressiveWindow(1)).toEqual({ start: 12, count: 28 });
    expect(getProgressiveWindow(2)).toEqual({ start: 40, count: 28 });
  });

  it('continues watch recommendations in 40 item pages after the first 40', () => {
    expect(getProgressiveWindow(0, 12, 28, 40)).toEqual({ start: 0, count: 12 });
    expect(getProgressiveWindow(1, 12, 28, 40)).toEqual({ start: 12, count: 28 });
    expect(getProgressiveWindow(2, 12, 28, 40)).toEqual({ start: 40, count: 40 });
    expect(getProgressiveWindow(3, 12, 28, 40)).toEqual({ start: 80, count: 40 });
  });
});
