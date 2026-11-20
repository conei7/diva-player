export const EXHIBITION_QUERY = 'exhibition';
export const EXHIBITION_TAB_KEY = 'diva-player:sofume-2026:tab';
export const EXHIBITION_COUNTS_KEY = 'diva-player:sofume-2026:counts';
export const EXHIBITION_DAYS = ['2026-11-21', '2026-11-22'] as const;

export type ExhibitionDay = typeof EXHIBITION_DAYS[number];
export type ExhibitionCounts = Record<ExhibitionDay, number>;

const boundaries = [...EXHIBITION_DAYS, '2026-11-23'].map(
  day => Date.parse(`${day}T00:00:00+09:00`),
);
const IDLE_MS = 3 * 60 * 1000;

export function exhibitionDay(now: number): ExhibitionDay | undefined {
  return EXHIBITION_DAYS.find((_, index) => now >= boundaries[index] && now < boundaries[index + 1]);
}

export function nextExhibitionBoundary(now: number): number | undefined {
  return boundaries.find(boundary => boundary > now);
}

export function isNewExhibitionVisit(now: number, lastActivity: number | null): boolean {
  return lastActivity === null || now - lastActivity >= IDLE_MS;
}

export function parseExhibitionCounts(raw: string | null): ExhibitionCounts {
  let data: unknown;
  try {
    data = raw === null ? null : JSON.parse(raw);
  } catch {
    data = null;
  }
  const readCount = (day: ExhibitionDay) => {
    if (!data || typeof data !== 'object' || !(day in data)) return 0;
    const count = (data as Record<string, unknown>)[day];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0;
  };
  return {
    '2026-11-21': readCount('2026-11-21'),
    '2026-11-22': readCount('2026-11-22'),
  };
}

export function readExhibitionCounts(): ExhibitionCounts | null {
  try {
    return parseExhibitionCounts(window.localStorage.getItem(EXHIBITION_COUNTS_KEY));
  } catch {
    return null;
  }
}

export function exhibitionMode(search: string): 'booth' | 'stats' | undefined {
  const value = new URLSearchParams(search).get(EXHIBITION_QUERY);
  if (value === 'stats') return 'stats';
  if (value === '1') return 'booth';
  try {
    return window.sessionStorage.getItem(EXHIBITION_TAB_KEY) === '1' ? 'booth' : undefined;
  } catch {
    return undefined;
  }
}
