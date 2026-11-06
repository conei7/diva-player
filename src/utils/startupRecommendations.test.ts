import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { selectStartupSongs } from './startupRecommendations';

function songs(count: number): Song[] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1 } as Song));
}

const ids = (items: Song[]) => items.map(song => song.id);
const NO_RECENT = new Map<number, number>();

describe('selectStartupSongs', () => {
  it('gives the same page for the same seed and another page for another seed', () => {
    const pool = songs(48);
    const first = selectStartupSongs(pool, { seed: 11, recentlyShown: NO_RECENT, limit: 24 });

    expect(ids(selectStartupSongs(pool, { seed: 11, recentlyShown: NO_RECENT, limit: 24 }))).toEqual(ids(first));
    const others = [12, 13, 14, 15].map(seed => ids(selectStartupSongs(pool, { seed, recentlyShown: NO_RECENT, limit: 24 })));
    expect(others.some(other => other.join() !== ids(first).join())).toBe(true);
    expect(others.some(other => other.some(id => !ids(first).includes(id)))).toBe(true);
  });

  it('keeps the strongest songs on the page and varies the middle of the pool', () => {
    const pool = songs(48);
    const pages = 500;
    const shownTimes = new Map<number, number>();
    for (let seed = 1; seed <= pages; seed++) {
      for (const id of ids(selectStartupSongs(pool, { seed: seed * 7919, recentlyShown: NO_RECENT, limit: 24 }))) {
        shownTimes.set(id, (shownTimes.get(id) ?? 0) + 1);
      }
    }
    const share = (id: number) => (shownTimes.get(id) ?? 0) / pages;

    for (const id of [1, 2, 3, 4, 5, 6, 7]) expect(share(id)).toBeGreaterThanOrEqual(0.98);
    for (const id of [43, 44, 45, 46, 47, 48]) expect(share(id)).toBeLessThanOrEqual(0.02);
    for (const id of [16, 20, 24, 28, 32]) {
      expect(share(id)).toBeGreaterThan(0.1);
      expect(share(id)).toBeLessThan(0.9);
    }
  });

  it('opens with songs not shown in the last few minutes', () => {
    const pool = songs(48);
    const before = ids(selectStartupSongs(pool, { seed: 21, recentlyShown: NO_RECENT, limit: 24 }));
    const recentlyShown = new Map(before.map(id => [id, 1]));
    const after = ids(selectStartupSongs(pool, { seed: 22, recentlyShown, limit: 24 }));

    expect(after).toHaveLength(24);
    expect(after.filter(id => recentlyShown.has(id))).toEqual([]);
  });

  it('fills with recently shown songs when the pool has nothing else', () => {
    const pool = songs(24);
    const recentlyShown = new Map(ids(pool).slice(0, 20).map(id => [id, 1]));
    const page = ids(selectStartupSongs(pool, { seed: 3, recentlyShown, limit: 24 }));

    expect(page.slice(0, 4).sort((a, b) => a - b)).toEqual([21, 22, 23, 24]);
    expect(new Set(page)).toEqual(new Set(ids(pool)));
  });

  it('deduplicates malformed pools', () => {
    const [a, b, c] = songs(3);
    expect(ids(selectStartupSongs([a, a, b, c, { id: Number.NaN } as Song], { seed: 1, recentlyShown: NO_RECENT, limit: 24 })).sort())
      .toEqual([1, 2, 3]);
  });
});
