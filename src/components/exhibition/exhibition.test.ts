import { describe, expect, it } from 'vitest';
import { exhibitionDay, isNewExhibitionVisit, nextExhibitionBoundary, parseExhibitionCounts } from './exhibition';

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

  it('only counts a new automatic visit after three minutes without a control click', () => {
    expect(isNewExhibitionVisit(0, null)).toBe(true);
    expect(isNewExhibitionVisit(179_999, 0)).toBe(false);
    expect(isNewExhibitionVisit(180_000, 0)).toBe(true);
  });

  it('keeps valid daily counts even if another daily count is missing or malformed', () => {
    const empty = { '2026-11-21': 0, '2026-11-22': 0 };
    expect(parseExhibitionCounts(null)).toEqual(empty);
    expect(parseExhibitionCounts('{')).toEqual(empty);
    expect(parseExhibitionCounts('{"2026-11-21":5}')).toEqual({ ...empty, '2026-11-21': 5 });
    expect(parseExhibitionCounts('{"2026-11-21":-1,"2026-11-22":8}')).toEqual({ ...empty, '2026-11-22': 8 });
  });
});
