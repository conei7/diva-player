import { describe, expect, it } from 'vitest';
import { formatRelativeDate, formatRelativeTime } from './relativeDate';

const now = Date.parse('2026-07-12T12:00:00Z');

describe('formatRelativeDate', () => {
  it('formats common YouTube-style intervals in Japanese', () => {
    expect(formatRelativeDate('2026-07-12T00:00:00Z', now)).toBe('今日');
    expect(formatRelativeDate('2026-07-09T12:00:00Z', now)).toBe('3日前');
    expect(formatRelativeDate('2026-06-28T12:00:00Z', now)).toBe('2週間前');
    expect(formatRelativeDate('2026-04-12T12:00:00Z', now)).toBe('3か月前');
    expect(formatRelativeDate('2024-07-12T12:00:00Z', now)).toBe('2年前');
  });

  it('formats common publication intervals in English', () => {
    expect(formatRelativeDate('2026-07-12T00:00:00Z', now, 'en')).toBe('today');
    expect(formatRelativeDate('2026-07-09T12:00:00Z', now, 'en')).toBe('3 days ago');
    expect(formatRelativeDate('2026-06-28T12:00:00Z', now, 'en')).toBe('2 weeks ago');
    expect(formatRelativeDate('2026-04-12T12:00:00Z', now, 'en')).toBe('3 months ago');
    expect(formatRelativeDate('2024-07-12T12:00:00Z', now, 'en')).toBe('2 years ago');
  });
});

describe('formatRelativeTime', () => {
  const minute = 60 * 1000;
  const hour = 60 * minute;

  it('formats minutes and hours before falling back to days', () => {
    expect(formatRelativeTime(now - 30 * 1000, now)).toBe('たった今');
    expect(formatRelativeTime(now - 5 * minute, now)).toBe('5分前');
    expect(formatRelativeTime(now - 59 * minute, now)).toBe('59分前');
    expect(formatRelativeTime(now - 3 * hour, now)).toBe('3時間前');
    expect(formatRelativeTime(now - 25 * hour, now)).toBe('1日前');
    expect(formatRelativeTime(now - 14 * 24 * hour, now)).toBe('2週間前');
  });

  it('formats the same steps in English', () => {
    expect(formatRelativeTime(now - 30 * 1000, now, 'en')).toBe('just now');
    expect(formatRelativeTime(now - 5 * minute, now, 'en')).toBe('5 min ago');
    expect(formatRelativeTime(now - 3 * hour, now, 'en')).toBe('3 hr ago');
    expect(formatRelativeTime(now - 25 * hour, now, 'en')).toBe('1 day ago');
    expect(formatRelativeTime(now - 400 * 24 * hour, now, 'en')).toBe('1 year ago');
  });

  it('treats future timestamps as just now and invalid ones as empty', () => {
    expect(formatRelativeTime(now + 10 * minute, now)).toBe('たった今');
    expect(formatRelativeTime(Number.NaN, now)).toBe('');
  });
});
