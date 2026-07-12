import { beforeEach, describe, expect, it } from 'vitest';
import {
  calculateExposurePenalty,
  rerankDisplayedSongs,
  useRecommendationExposureStore,
} from './recommendationExposureStore';

describe('recommendation exposure', () => {
  beforeEach(() => {
    useRecommendationExposureStore.getState().clear();
  });

  it('records visible songs and increases the repeat penalty', () => {
    const now = Date.now();
    useRecommendationExposureStore.getState().recordVisible(10, 'home-recommended', 1);
    const entry = useRecommendationExposureStore.getState().entries['10'];
    expect(entry.seenCount).toBe(1);
    expect(calculateExposurePenalty(entry, now)).toBeGreaterThan(0);

    useRecommendationExposureStore.getState().recordVisible(10, 'home-recommended', 2);
    expect(useRecommendationExposureStore.getState().entries['10'].seenCount).toBe(2);
    expect(calculateExposurePenalty(useRecommendationExposureStore.getState().entries['10'], now)).toBeGreaterThanOrEqual(
      calculateExposurePenalty(entry, now),
    );
  });

  it('decays the penalty after time passes and lets interacted songs recover', () => {
    const now = Date.now();
    const entry = {
      songId: 10,
      firstSeenAt: now - 24 * 60 * 60 * 1000,
      lastSeenAt: now - 24 * 60 * 60 * 1000,
      seenCount: 3,
      lastSurface: 'home-recommended' as const,
      lastRank: 1,
      clickedCount: 0,
      playedCount: 0,
    };
    const recentPenalty = calculateExposurePenalty({ ...entry, lastSeenAt: now }, now);
    const oldPenalty = calculateExposurePenalty(entry, now);
    const playedPenalty = calculateExposurePenalty({ ...entry, lastSeenAt: now, playedCount: 1 }, now);
    expect(oldPenalty).toBeLessThan(recentPenalty);
    expect(playedPenalty).toBeLessThan(recentPenalty);
  });

  it('reorders an existing page softly without changing its candidates', () => {
    useRecommendationExposureStore.getState().recordVisible(1, 'home-recommended', 1);
    const songs = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = rerankDisplayedSongs(songs, 12);
    expect(result.map(song => song.id).sort()).toEqual([1, 2, 3]);
  });
});
