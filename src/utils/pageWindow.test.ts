import { describe, expect, it } from 'vitest';
import { selectRotatingWindow } from './pageWindow';

describe('selectRotatingWindow', () => {
  it('caps the initial request fan-out and rotates on later pages', () => {
    const items = [1, 2, 3, 4, 5, 6];
    expect(selectRotatingWindow(items, 0, 4)).toEqual([1, 2, 3, 4]);
    expect(selectRotatingWindow(items, 1, 4)).toEqual([5, 6, 1, 2]);
  });

  it('returns all items when the list is already within the limit', () => {
    expect(selectRotatingWindow([1, 2], 3, 4)).toEqual([1, 2]);
    expect(selectRotatingWindow([], 0, 4)).toEqual([]);
  });
});
