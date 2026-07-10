import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { diversifyAwayFromSeedVocalist } from './recommendationScoring';

function song(id: number, vocalistIds: number[] = []): Song {
  return {
    id,
    name: `song-${id}`,
    defaultName: `song-${id}`,
    defaultNameLanguage: 'Japanese',
    artistString: '',
    createDate: '2026-01-01',
    favoritedTimes: 0,
    lengthSeconds: 180,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    artists: vocalistIds.map(id => ({
      artist: {
        id,
        name: `vocalist-${id}`,
        additionalNames: '',
        artistType: 'Vocaloid',
        deleted: false,
        status: 'Finished',
        version: 1,
      },
      categories: 'Vocalist',
      effectiveRoles: 'Vocalist',
      id,
      isCustomName: false,
      isSupport: false,
      name: `vocalist-${id}`,
      roles: 'Vocalist',
    })),
  };
}

describe('diversifyAwayFromSeedVocalist', () => {
  it('moves non-seed-vocalist songs ahead of overflow songs', () => {
    const seed = song(1, [10]);
    const candidates = [song(2, [10]), song(3, [10]), song(4), song(5)];

    const result = diversifyAwayFromSeedVocalist(seed, candidates, 1);

    expect(result.map(item => item.id)).toEqual([2, 4, 5, 3]);
  });

  it('deduplicates candidates while preserving their first occurrence', () => {
    const seed = song(1, [10]);
    const candidates = [song(2, [10]), song(2, [10]), song(3)];

    const result = diversifyAwayFromSeedVocalist(seed, candidates, 2);

    expect(result.map(item => item.id)).toEqual([2, 3]);
  });
});
