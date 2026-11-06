import type { RecommendationExposureEntry } from '../stores/recommendationExposureStore';

/**
 * A song on screen within this long (any recommendation surface, Home included) is put behind
 * unseen candidates when Home opens a new feed: reload, the logo and ホーム show other songs.
 */
export const RECENTLY_SHOWN_MS = 5 * 60 * 1000;

/** Song id → when it was last on screen, for the songs shown within `windowMs` of `now`. */
export function selectRecentlyShown(
  entries: Readonly<Record<string, RecommendationExposureEntry>>,
  now: number,
  windowMs = RECENTLY_SHOWN_MS,
): Map<number, number> {
  const recent = new Map<number, number>();
  for (const entry of Object.values(entries)) {
    if (!entry || !Number.isInteger(entry.songId) || !Number.isFinite(entry.lastSeenAt)) continue;
    const age = now - entry.lastSeenAt;
    // A time ahead of the clock (the clock was set back) is not "recent": it would defer the song
    // until the clock catches up.
    if (age >= 0 && age < windowMs) recent.set(entry.songId, entry.lastSeenAt);
  }
  return recent;
}

/**
 * Unseen songs keep their order and come first; recently shown ones follow, the longest ago first
 * (equal times keep their order). With `limit`, recently shown songs only fill what unseen ones leave.
 */
export function deferRecentlyShown<T extends { id: number }>(
  songs: readonly T[],
  recentlyShown: ReadonlyMap<number, number>,
  limit = songs.length,
): T[] {
  if (recentlyShown.size === 0) return songs.slice(0, limit);
  const unseen: T[] = [];
  const shown: T[] = [];
  for (const song of songs) (recentlyShown.has(song.id) ? shown : unseen).push(song);
  shown.sort((a, b) => (recentlyShown.get(a.id) ?? 0) - (recentlyShown.get(b.id) ?? 0));
  return [...unseen, ...shown].slice(0, limit);
}
