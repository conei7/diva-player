import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { rerankRecommendationCandidates } from './recommendationReranking';

function song(id: number, producerId?: number): Song {
  return {
    id, name: `song-${id}`, defaultName: `song-${id}`, defaultNameLanguage: 'Japanese', artistString: '',
    createDate: '2026-01-01', favoritedTimes: 0, lengthSeconds: 180, pvServices: 'Youtube', ratingScore: 0,
    songType: 'Original', status: 'Finished', version: 1,
    artists: producerId ? [{
      artist: { id: producerId, name: `p-${producerId}`, additionalNames: '', artistType: 'Producer', deleted: false, status: 'Finished', version: 1 },
      categories: 'Producer', effectiveRoles: 'Producer', id, isCustomName: false, isSupport: false, name: `p-${producerId}`, roles: 'Producer',
    }] : [],
  };
}

const baseOptions = {
  historyEntries: [], playlists: [], ratings: {}, implicitFeedback: {}, total: 3,
};

describe('rerankRecommendationCandidates', () => {
  it('uses a recent skip as a penalty instead of reserving a fixed source slot', () => {
    const result = rerankRecommendationCandidates({
      hybrid: [song(1), song(2)],
      audio: [song(3)],
    }, {
      ...baseOptions,
      implicitFeedback: { 1: { skipCount: 1, completeCount: 0, removeCount: 0, lastSkippedAt: Date.now() } },
    });

    expect(result[0].song.id).not.toBe(1);
  });

  it('moves another producer ahead when a producer is already represented', () => {
    const result = rerankRecommendationCandidates({
      hybrid: [song(1, 10), song(2, 10), song(3, 20)],
    }, baseOptions);

    expect(result.slice(0, 2).map(item => item.song.id)).toEqual([1, 3]);
  });

  it('explains a candidate supported by audio and hybrid signals', () => {
    const result = rerankRecommendationCandidates({
      hybrid: [song(1)],
      audio: [song(1)],
    }, { ...baseOptions, total: 1 });

    expect(result[0].reason).toContain('音響');
  });
});
