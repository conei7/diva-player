import { describe, expect, it } from 'vitest';
import { exhibitionDay, nextExhibitionBoundary } from './exhibition';

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
});
