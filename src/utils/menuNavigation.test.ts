import { describe, expect, it } from 'vitest';
import { getMenuNextIndex } from './menuNavigation';

describe('getMenuNextIndex', () => {
  it('wraps arrow navigation in both directions', () => {
    expect(getMenuNextIndex('ArrowDown', 2, 3)).toBe(0);
    expect(getMenuNextIndex('ArrowUp', 0, 3)).toBe(2);
  });

  it('supports Home and End', () => {
    expect(getMenuNextIndex('Home', 2, 4)).toBe(0);
    expect(getMenuNextIndex('End', 0, 4)).toBe(3);
  });

  it('ignores non-navigation keys and empty menus', () => {
    expect(getMenuNextIndex('Enter', 0, 3)).toBeNull();
    expect(getMenuNextIndex('ArrowDown', 0, 0)).toBeNull();
  });
});
