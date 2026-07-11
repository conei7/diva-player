import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import {
  createAutoQueuePlan,
  getAutoQueueStage,
  getKnownUnknownTarget,
  selectKnownUnknownMix,
} from './autoQueuePolicy';

function song(id: number): Song {
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
  };
}

describe('auto queue policy', () => {
  it('uses stable session stages rather than queue length', () => {
    expect(getAutoQueueStage(0)).toBe('early');
    expect(getAutoQueueStage(4)).toBe('early');
    expect(getAutoQueueStage(5)).toBe('middle');
    expect(getAutoQueueStage(11)).toBe('middle');
    expect(getAutoQueueStage(12)).toBe('late');
  });

  it('uses the early, middle, and late known/unknown ratios', () => {
    expect(getKnownUnknownTarget('early', 10)).toEqual({ known: 8, unknown: 2 });
    expect(getKnownUnknownTarget('middle', 10)).toEqual({ known: 6, unknown: 4 });
    expect(getKnownUnknownTarget('late', 10)).toEqual({ known: 4, unknown: 6 });
  });

  it('reduces exploration after skips and increases it after sustained success', () => {
    expect(getKnownUnknownTarget('middle', 10, {
      autoCompletedCount: 1,
      autoSkippedCount: 2,
      consecutiveSkips: 2,
    })).toEqual({ known: 7, unknown: 3 });
    expect(getKnownUnknownTarget('middle', 10, {
      autoCompletedCount: 9,
      autoSkippedCount: 1,
      consecutiveSkips: 0,
    })).toEqual({ known: 5, unknown: 5 });
  });

  it('refills only below the low watermark and targets a bounded queue', () => {
    expect(createAutoQueuePlan(4, 0)).toBeNull();
    expect(createAutoQueuePlan(3, 0)).toMatchObject({ requestedCount: 9, stage: 'early' });
    expect(createAutoQueuePlan(0, 20)).toMatchObject({ requestedCount: 12, stage: 'late' });
  });

  it('selects the configured mix without duplicates or excluded songs', () => {
    const result = selectKnownUnknownMix(
      [song(1), song(2), song(3), song(4), song(5)],
      [song(6), song(7), song(8), song(9), song(10)],
      { known: 4, unknown: 3 },
      new Set([2]),
    );

    expect(result.map(item => item.id)).toEqual([1, 3, 4, 5, 6, 7, 8]);
  });

  it('fills from the other pool when one side is exhausted', () => {
    const result = selectKnownUnknownMix(
      [song(1)],
      [song(2), song(3), song(4), song(5), song(6)],
      { known: 4, unknown: 3 },
      new Set(),
    );

    expect(result.map(item => item.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
