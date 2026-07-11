import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { mixRecommendationSources, reasonForSource, type RecommendationSource, type SourcedRecommendation } from './recommendationMixing';

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

function entry(id: number, source: RecommendationSource, producerId?: number): SourcedRecommendation {
  return { song: song(id, producerId), source, reason: reasonForSource(source) };
}

describe('mixRecommendationSources', () => {
  it('uses configured source quotas when pools are sufficient', () => {
    const result = mixRecommendationSources({
      known: [entry(1, 'known'), entry(2, 'known')],
      hybrid: [entry(3, 'hybrid'), entry(4, 'hybrid')],
      audio: [entry(5, 'audio')],
      popular: [entry(6, 'popular')],
    }, { quotas: { known: 2, hybrid: 2, audio: 1, popular: 1 }, total: 6 });

    expect(result).toHaveLength(6);
    expect(result.filter(item => item.source === 'known')).toHaveLength(2);
    expect(result.filter(item => item.source === 'hybrid')).toHaveLength(2);
    expect(result.filter(item => item.source === 'audio')).toHaveLength(1);
    expect(result.filter(item => item.source === 'popular')).toHaveLength(1);
  });

  it('defers an overrepresented producer while varied candidates exist', () => {
    const result = mixRecommendationSources({
      hybrid: [entry(1, 'hybrid', 10), entry(2, 'hybrid', 10), entry(3, 'hybrid', 10)],
      audio: [entry(4, 'audio', 20), entry(5, 'audio', 30)],
    }, { quotas: { hybrid: 3, audio: 2 }, total: 4, maxPerProducer: 1 });

    expect(result.slice(0, 3).map(item => item.song.id)).toEqual([1, 4, 5]);
  });
});
