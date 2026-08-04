import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import {
  buildTasteAffinityProfile,
  diversifyAwayFromSeedVocalist,
  explainTasteAffinity,
  rerankForQueueDiversity,
} from './recommendationScoring';

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

describe('rerankForQueueDiversity', () => {
  it('moves producer-concentrated candidates behind a varied candidate', () => {
    const producerArtist = {
      id: 101, name: 'producer', additionalNames: '', artistType: 'Producer' as const,
      deleted: false, status: 'Finished' as const, version: 1,
    };
    const withProducer = (id: number): Song => ({
      ...song(id),
      artists: [{ artist: producerArtist, categories: 'Producer', effectiveRoles: 'Producer', id, isCustomName: false, isSupport: false, name: 'producer', roles: 'Producer' }],
    });
    const recent = [withProducer(1), withProducer(2)];
    const result = rerankForQueueDiversity([withProducer(3), song(4), withProducer(5)], { recentSongs: recent });

    expect(result.map(item => item.id)).toEqual([4, 3, 5]);
  });
});

describe('browser-local taste affinity', () => {
  const withAttributes = (id: number, producerId: number, vocalistId: number, tag: string): Song => ({
    ...song(id, [vocalistId]),
    artists: [
      ...(song(id, [vocalistId]).artists ?? []),
      {
        artist: {
          id: producerId, name: `producer-${producerId}`, additionalNames: '', artistType: 'Producer',
          deleted: false, status: 'Finished', version: 1,
        },
        categories: 'Producer', effectiveRoles: 'Producer', id: producerId,
        isCustomName: false, isSupport: false, name: `producer-${producerId}`, roles: 'Producer',
      },
    ],
    tags: [{ tag: { name: tag } }],
  });

  it('learns from ratings, playlists, manual completion, and negative feedback without treating passive history as a like', () => {
    const positive = withAttributes(1, 10, 20, 'rock');
    const negative = withAttributes(2, 30, 40, 'ambient');
    const passive = withAttributes(3, 50, 60, 'pop');
    const profile = buildTasteAffinityProfile(
      [
        { song: positive, playedAt: 1 },
        { song: negative, playedAt: 2 },
        { song: passive, playedAt: 3 },
      ],
      [{ songs: [positive] }],
      { '1': 5, '2': 1 },
      {
        '1': { skipCount: 0, completeCount: 2, manualCompleteCount: 2, removeCount: 0 },
        '2': { skipCount: 2, completeCount: 0, removeCount: 1 },
        '3': { skipCount: 0, completeCount: 1, discoveryCompleteCount: 1, removeCount: 0 },
      },
    );

    expect(profile.signalSongCount).toBe(2);
    expect(explainTasteAffinity(withAttributes(4, 10, 20, 'rock'), profile).adjustment).toBeGreaterThan(0);
    expect(explainTasteAffinity(withAttributes(5, 30, 40, 'ambient'), profile).adjustment).toBeLessThan(0);
    expect(explainTasteAffinity(withAttributes(6, 50, 60, 'pop'), profile).adjustment).toBe(0);
  });
});
