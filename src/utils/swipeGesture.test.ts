import { describe, expect, it } from 'vitest';
import { getSwipeDirection } from './swipeGesture';

const start = { x: 100, y: 100, time: 0 };

describe('getSwipeDirection', () => {
  it('detects horizontal next and previous gestures', () => {
    expect(getSwipeDirection(start, { x: 20, y: 104, time: 180 })).toBe('left');
    expect(getSwipeDirection(start, { x: 185, y: 96, time: 180 })).toBe('right');
  });

  it('detects an upward gesture', () => {
    expect(getSwipeDirection(start, { x: 104, y: 20, time: 220 })).toBe('up');
  });

  it('ignores short, slow, diagonal, and downward gestures', () => {
    expect(getSwipeDirection(start, { x: 145, y: 102, time: 120 })).toBeNull();
    expect(getSwipeDirection(start, { x: 20, y: 20, time: 601 })).toBeNull();
    expect(getSwipeDirection(start, { x: 30, y: 20, time: 180 })).toBeNull();
    expect(getSwipeDirection(start, { x: 102, y: 190, time: 180 })).toBeNull();
  });
});
