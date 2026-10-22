import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { homeRecommendationPools } from './homeRecommendationPools';

const song = (id: number) => ({ id } as Song);

describe('home discovery candidates', () => {
  it('keeps highly rated songs from filling either the first or subsequent page via another source', () => {
    const known = Array.from({ length: 60 }, (_, i) => song(i + 1));
    const ids = new Set(known.map(item => item.id));
    for (const count of [24, 36]) {
      const pools = homeRecommendationPools(known, [...known, song(101)], [...known, song(102)], [...known, song(103)], ids, count);
      expect(pools.known).toHaveLength(count / 4);
      expect(pools.hybrid?.map(item => item.id)).toEqual([101]);
      expect(pools.audio?.map(item => item.id)).toEqual([102]);
      expect(pools.popular?.map(item => item.id)).toEqual([103]);
    }
  });

  it('keeps popular discovery available for a listener without history', () => {
    expect(homeRecommendationPools([], [], [], [song(1)], new Set(), 24).popular).toEqual([song(1)]);
  });
});
