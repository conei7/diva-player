import { describe, expect, it } from 'vitest';
import { exhibitionDay, nextExhibitionBoundary } from './exhibition';
import { exhibitionMode } from './exhibitionMode';

describe('exhibition dates and attendance', () => {
  it('starts and ends at midnight in Japan regardless of the kiosk timezone', () => {
    const start = Date.parse('2026-11-20T15:00:00Z');
    const secondDay = Date.parse('2026-11-21T15:00:00Z');
    const end = Date.parse('2026-11-22T15:00:00Z');
    expect(exhibitionDay(start - 1)).toBeUndefined();
    expect(exhibitionDay(start)).toBe('2026-11-21');
    expect(exhibitionDay(secondDay - 1)).toBe('2026-11-21');
    expect(exhibitionDay(secondDay)).toBe('2026-11-22');
    expect(exhibitionDay(end - 1)).toBe('2026-11-22');
    expect(exhibitionDay(end)).toBeUndefined();
    expect(nextExhibitionBoundary(start - 1)).toBe(start);
    expect(nextExhibitionBoundary(start)).toBe(secondDay);
    expect(nextExhibitionBoundary(secondDay)).toBe(end);
    expect(nextExhibitionBoundary(end)).toBeUndefined();
  });

  it('uses the ordinary home for the exhibit and still allows the QR landing and later totals', () => {
    const during = Date.parse('2026-11-21T12:00:00+09:00');
    const after = Date.parse('2026-11-23T00:00:00+09:00');
    expect(exhibitionMode('/', '', during)).toBe('home');
    expect(exhibitionMode('/', '?exhibition=1', during)).toBe('home');
    expect(exhibitionMode('/', '?from=sofume-qr', during)).toBeUndefined();
    expect(exhibitionMode('/', '?q=ミク', during)).toBeUndefined();
    expect(exhibitionMode('/', '?artistId=39', during)).toBeUndefined();
    expect(exhibitionMode('/watch', '?v=1', during)).toBeUndefined();
    expect(exhibitionMode('/', '', after)).toBeUndefined();
    expect(exhibitionMode('/', '?exhibition=stats', after)).toBe('stats');
  });
});
