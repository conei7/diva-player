import { describe, expect, it } from 'vitest';
import { DENSE_SERIES_POINTS, pointIndexForKey, showsPointDot } from './viewHistoryPoints';

describe('showsPointDot', () => {
  it('draws every dot of a short series', () => {
    const count = DENSE_SERIES_POINTS;
    expect(Array.from({ length: count }, (_, index) => showsPointDot(index, count, false)).every(Boolean)).toBe(true);
  });

  it('draws only the first, last and highlighted dot of a long series', () => {
    const count = 268;
    const drawn = Array.from({ length: count }, (_, index) => index).filter(index => showsPointDot(index, count, index === 100));
    expect(drawn).toEqual([0, 100, 267]);
  });
});

describe('pointIndexForKey', () => {
  it('moves one point with the arrows and stops at the ends', () => {
    expect(pointIndexForKey('ArrowLeft', 5, 10)).toBe(4);
    expect(pointIndexForKey('ArrowRight', 5, 10)).toBe(6);
    expect(pointIndexForKey('ArrowLeft', 0, 10)).toBe(0);
    expect(pointIndexForKey('ArrowRight', 9, 10)).toBe(9);
  });

  it('jumps to the first and last point with Home and End', () => {
    expect(pointIndexForKey('Home', 5, 10)).toBe(0);
    expect(pointIndexForKey('End', 5, 10)).toBe(9);
  });

  it('leaves other keys (Tab, Enter, Space) and empty series alone', () => {
    expect(pointIndexForKey('Tab', 5, 10)).toBeNull();
    expect(pointIndexForKey('Enter', 5, 10)).toBeNull();
    expect(pointIndexForKey(' ', 5, 10)).toBeNull();
    expect(pointIndexForKey('End', 0, 0)).toBeNull();
  });
});
