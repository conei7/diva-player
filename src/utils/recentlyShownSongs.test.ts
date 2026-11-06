import { describe, expect, it } from 'vitest';
import type { RecommendationExposureEntry } from '../stores/recommendationExposureStore';
import { deferRecentlyShown, RECENTLY_SHOWN_MS, selectRecentlyShown } from './recentlyShownSongs';

const NOW = 1_800_000_000_000;

function entry(songId: number, lastSeenAt: number): RecommendationExposureEntry {
  return {
    songId, firstSeenAt: lastSeenAt, lastSeenAt, seenCount: 1, lastSurface: 'home-recommended', lastRank: 1,
    clickedCount: 0, playedCount: 0,
  };
}

const ids = (songs: { id: number }[]) => songs.map(song => song.id);

describe('selectRecentlyShown', () => {
  it('keeps only the songs shown within five minutes', () => {
    const recent = selectRecentlyShown({
      1: entry(1, NOW - 1_000),
      2: entry(2, NOW - RECENTLY_SHOWN_MS + 1),
      3: entry(3, NOW - RECENTLY_SHOWN_MS),
      4: entry(4, NOW - 60 * 60 * 1000),
    }, NOW);

    expect([...recent.keys()].sort()).toEqual([1, 2]);
    expect(recent.get(1)).toBe(NOW - 1_000);
  });

  it('ignores times ahead of the clock and malformed entries', () => {
    const recent = selectRecentlyShown({
      1: entry(1, NOW + 60_000),
      2: { ...entry(2, NOW), lastSeenAt: Number.NaN },
      3: entry(3, NOW),
    }, NOW);

    expect([...recent.keys()]).toEqual([3]);
  });
});

describe('deferRecentlyShown', () => {
  const songs = [1, 2, 3, 4, 5].map(id => ({ id }));

  it('moves recently shown songs after unseen ones, the longest ago first', () => {
    const recent = new Map([[1, NOW - 10], [3, NOW - 200], [4, NOW - 10]]);
    expect(ids(deferRecentlyShown(songs, recent))).toEqual([2, 5, 3, 1, 4]);
  });

  it('fills a limited page with recently shown songs only when unseen ones run out', () => {
    const recent = new Map([[1, NOW], [2, NOW]]);
    expect(ids(deferRecentlyShown(songs, recent, 3))).toEqual([3, 4, 5]);
    expect(ids(deferRecentlyShown(songs, recent, 4))).toEqual([3, 4, 5, 1]);
  });

  it('keeps the order when nothing was shown recently', () => {
    expect(ids(deferRecentlyShown(songs, new Map(), 3))).toEqual([1, 2, 3]);
  });
});
