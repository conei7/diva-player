export const EXHIBITION_DAYS = ['2026-11-21', '2026-11-22'] as const;

export type ExhibitionDay = typeof EXHIBITION_DAYS[number];

const boundaries = [...EXHIBITION_DAYS, '2026-11-23'].map(
  day => Date.parse(`${day}T00:00:00+09:00`),
);

export function exhibitionDay(now: number): ExhibitionDay | undefined {
  return EXHIBITION_DAYS.find((_, index) => now >= boundaries[index] && now < boundaries[index + 1]);
}

export function nextExhibitionBoundary(now: number): number | undefined {
  return boundaries.find(boundary => boundary > now);
}
