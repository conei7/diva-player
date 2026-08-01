import { describe, expect, it } from 'vitest';
import { getPVBadgeStyle } from './pvBadge';

describe('getPVBadgeStyle', () => {
  it('keeps SoundCloud original badges vivid and unofficial badges dark', () => {
    const original = getPVBadgeStyle('SoundCloud', 'Original');
    const unofficial = getPVBadgeStyle('SoundCloud', 'Reprint');
    expect(original.color).toBe('#fb923c');
    expect(unofficial.color).toBe('#a16207');
    expect(unofficial.background).toContain('90, 45, 15');
  });

  it('keeps Bilibili original badges vivid and unofficial badges dark', () => {
    const original = getPVBadgeStyle('Bilibili', 'Original');
    const unofficial = getPVBadgeStyle('Bilibili', 'Other');
    expect(original.color).toBe('#38bdf8');
    expect(unofficial.color).toBe('#326477');
    expect(unofficial.background).toContain('24, 65, 90');
  });
});
