import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { rerankRecommendationCandidates, rerankRecommendationCandidatesDetailed } from './recommendationReranking';

function song(id: number, producerId?: number): Song {
  return {
    id, name: `song-${id}`, defaultName: `song-${id}`, defaultNameLanguage: 'Japanese', artistString: '',
    createDate: '2026-01-01', favoritedTimes: 0, lengthSeconds: 180, pvServices: 'Youtube', ratingScore: 0,
    songType: 'Original', status: 'Finished', version: 1,
    artists: [
      {
        artist: { id: 999, name: 'vocaloid', additionalNames: '', artistType: 'Vocaloid', deleted: false, status: 'Finished', version: 1 },
        categories: 'Vocalist', effectiveRoles: 'Vocalist', id: 999, isCustomName: false, isSupport: false, name: 'vocaloid', roles: 'Vocalist',
      },
      ...(producerId ? [{
        artist: { id: producerId, name: `p-${producerId}`, additionalNames: '', artistType: 'Producer' as const, deleted: false, status: 'Finished', version: 1 },
        categories: 'Producer' as const, effectiveRoles: 'Producer', id: producerId, isCustomName: false, isSupport: false, name: `p-${producerId}`, roles: 'Producer',
      }] : []),
    ],
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

  it('keeps another producer near the top without excluding the same producer', () => {
    const result = rerankRecommendationCandidates({
      hybrid: [song(1, 10), song(2, 10), song(3, 20)],
    }, baseOptions);

    expect(result.map(item => item.song.id)).toEqual([1, 2, 3]);
  });

  it('explains a candidate supported by audio and hybrid signals', () => {
    const result = rerankRecommendationCandidates({
      hybrid: [song(1)],
      audio: [song(1)],
    }, { ...baseOptions, total: 1 });

    expect(result[0].reason).toContain('音響');
  });

  it('keeps the legacy ranking while exposing score contributions', () => {
    const pools = {
      hybrid: [song(1), song(2)],
      audio: [song(2), song(3)],
      popular: [song(3), song(1)],
    };
    const detailed = rerankRecommendationCandidatesDetailed(pools, { ...baseOptions, total: 3 });
    const legacy = rerankRecommendationCandidates(pools, { ...baseOptions, total: 3 });

    expect(detailed.ranked.map(item => item.song.id)).toEqual(legacy.map(item => item.song.id));
    expect(detailed.trace).toHaveLength(3);
    const dualSource = detailed.trace.find(item => item.songId === 2);
    expect(dualSource?.sources.map(source => source.source)).toEqual(['hybrid', 'audio']);
    expect(dualSource?.evidence).toBeCloseTo(
      dualSource?.sources.reduce((sum, source) => sum + source.evidenceContribution, 0) ?? 0,
    );
    expect(detailed.trace.filter(item => item.status === 'selected')).toHaveLength(3);
  });
});
