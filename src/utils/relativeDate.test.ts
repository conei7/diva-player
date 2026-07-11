import { describe, expect, it } from 'vitest';
import { formatRelativeDate } from './relativeDate';

const now = Date.parse('2026-07-12T12:00:00Z');

describe('formatRelativeDate', () => {
  it('formats common YouTube-style intervals in Japanese', () => {
    expect(formatRelativeDate('2026-07-12T00:00:00Z', now)).toBe('今日');
    expect(formatRelativeDate('2026-07-09T12:00:00Z', now)).toBe('3日前');
    expect(formatRelativeDate('2026-06-28T12:00:00Z', now)).toBe('2週間前');
    expect(formatRelativeDate('2026-04-12T12:00:00Z', now)).toBe('3か月前');
    expect(formatRelativeDate('2024-07-12T12:00:00Z', now)).toBe('2年前');
  });
});
