import { describe, expect, it } from 'vitest';
import type { ArtistForSong, Song } from '../types/vocadb';
import { interleaveUniqueSongs, selectRecentProducerIds } from './recentProducers';

function artist(id: number, categories: ArtistForSong['categories'], roles = ''): ArtistForSong {
  return {
    id,
    artist: {
      id,
      name: `Artist ${id}`,
      artistType: categories === 'Band'
        ? 'Band'
        : categories === 'Circle'
          ? 'Circle'
          : categories === 'Vocalist'
            ? 'Vocalist'
            : 'Producer',
      additionalNames: '',
      deleted: false,
      status: 'Finished',
      version: 1,
    },
    categories,
    effectiveRoles: roles,
    isCustomName: false,
    isSupport: false,
    name: `Artist ${id}`,
    roles,
  };
}

function song(id: number, artists: ArtistForSong[] = []): Song {
  return {
    id,
    artists,
    artistString: '',
    createDate: '',
    defaultName: `Song ${id}`,
    defaultNameLanguage: 'Japanese',
    favoritedTimes: 0,
    lengthSeconds: 180,
    name: `Song ${id}`,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
  };
}

describe('selectRecentProducerIds', () => {
  it('uses multiple recent songs and includes producer-like groups and composers', () => {
    const ids = selectRecentProducerIds([
      { song: song(1, [artist(10, 'Producer')]) },
      { song: song(2, [artist(20, 'Band')]) },
      { song: song(3, [artist(30, 'Other', 'Composer')]) },
      { song: song(4, [artist(40, 'Vocalist')]) },
    ]);

    expect(ids).toEqual([10, 20, 30]);
  });

  it('does not let duplicate play events for one song dominate the producer list', () => {
    const ids = selectRecentProducerIds([
      { song: song(1, [artist(10, 'Producer')]) },
      { song: song(1, [artist(10, 'Producer')]) },
      { song: song(2, [artist(20, 'Producer')]) },
    ]);

    expect(ids).toEqual([10, 20]);
  });
});

describe('interleaveUniqueSongs', () => {
  it('round-robins producers while excluding recent and duplicate songs', () => {
    expect(interleaveUniqueSongs(
      [[song(1), song(2)], [song(3), song(2), song(4)]],
      new Set([1]),
      3,
    ).map(item => item.id)).toEqual([3, 2, 4]);
  });
});
