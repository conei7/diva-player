import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { homeRecommendationPools, rerankHomeRecommendationsPreferringUnseen } from './homeRecommendationPools';

const song = (id: number) => ({ id } as Song);

describe('home discovery candidates', () => {
  it('keeps highly rated songs from filling either the first or subsequent page via another source', () => {
    const known = Array.from({ length: 60 }, (_, i) => song(i + 1));
    const ids = new Set(known.map(item => item.id));
    for (const count of [24, 36]) {
      const pools = homeRecommendationPools(known, [...known, song(101)], [...known, song(102)], [...known, song(103)], ids, count);
      expect(pools.known).toHaveLength(count / 2);
      expect(pools.hybrid?.map(item => item.id)).toEqual([101]);
      expect(pools.audio?.map(item => item.id)).toEqual([102]);
      expect(pools.popular?.map(item => item.id)).toEqual([103]);
    }
  });

  it('keeps popular discovery available for a listener without history', () => {
    expect(homeRecommendationPools([], [], [], [song(1)], new Set(), 24).popular).toEqual([song(1)]);
  });
});

function vocaloidSong(id: number): Song {
  return {
    id, name: `song-${id}`, defaultName: `song-${id}`, defaultNameLanguage: 'Japanese', artistString: '',
    createDate: '2026-01-01', favoritedTimes: 0, lengthSeconds: 180, pvServices: 'Youtube', ratingScore: 0,
    songType: 'Original', status: 'Finished', version: 1,
    artists: [
      {
        artist: { id: 999, name: 'vocaloid', additionalNames: '', artistType: 'Vocaloid', deleted: false, status: 'Finished', version: 1 },
        categories: 'Vocalist', effectiveRoles: 'Vocalist', id: 999, isCustomName: false, isSupport: false, name: 'vocaloid', roles: 'Vocalist',
      },
      {
        artist: { id: 2000 + id, name: `p-${id}`, additionalNames: '', artistType: 'Producer', deleted: false, status: 'Finished', version: 1 },
        categories: 'Producer', effectiveRoles: 'Producer', id: 2000 + id, isCustomName: false, isSupport: false, name: `p-${id}`, roles: 'Producer',
      },
    ],
  };
}

describe('rerankHomeRecommendationsPreferringUnseen', () => {
  const options = { historyEntries: [], playlists: [], ratings: {}, implicitFeedback: {}, rankingSeed: 5 };
  const pool = Array.from({ length: 10 }, (_, i) => vocaloidSong(i + 1));
  const pageIds = (result: ReturnType<typeof rerankHomeRecommendationsPreferringUnseen>) => result.ranked.map(item => item.song.id);

  it('chooses the page from songs not shown in the last few minutes', () => {
    const recentlyShown = new Map([[1, 1], [2, 1], [3, 1]]);
    const page = pageIds(rerankHomeRecommendationsPreferringUnseen({ hybrid: pool }, { ...options, total: 6 }, recentlyShown));

    expect(page).toHaveLength(6);
    expect(page.filter(id => recentlyShown.has(id))).toEqual([]);
  });

  it('fills the end of the page with recently shown songs only when unseen ones run out', () => {
    const recentlyShown = new Map(pool.slice(0, 7).map(song => [song.id, 1]));
    const result = rerankHomeRecommendationsPreferringUnseen({ hybrid: pool }, { ...options, total: 5 }, recentlyShown);
    const page = pageIds(result);

    expect(page.slice(0, 3).sort((a, b) => a - b)).toEqual([8, 9, 10]);
    expect(page.slice(3).every(id => recentlyShown.has(id))).toBe(true);
    expect(new Set(page).size).toBe(5);
    const selectedRanks = result.trace.filter(entry => entry.status === 'selected').map(entry => entry.selectedRank).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(selectedRanks).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the base exclusions in both passes', () => {
    const recentlyShown = new Map([[1, 1]]);
    const page = pageIds(rerankHomeRecommendationsPreferringUnseen(
      { hybrid: pool }, { ...options, total: 10, excludeIds: new Set([2, 3]) }, recentlyShown,
    ));

    expect(page).toHaveLength(8);
    expect(page).not.toContain(2);
    expect(page).not.toContain(3);
    expect(page.at(-1)).toBe(1);
  });
});
