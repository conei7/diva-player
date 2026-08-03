import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { formatTrendingReason } from './trendingReason';

function song(overrides: Partial<Song>): Song {
  return overrides as Song;
}

describe('formatTrendingReason', () => {
  it('explains both the recent increase and acceleration', () => {
    expect(formatTrendingReason(song({
      viewGrowth: 12_345,
      surgeRate: 1.76,
      trendWindowDays: 7,
    }))).toBe('7日で+1.2万再生・平常時の1.8倍');
  });

  it('keeps a useful reason when acceleration is unavailable', () => {
    expect(formatTrendingReason(song({ viewGrowth: 980 }))).toBe('7日で+980再生');
  });

  it('does not manufacture a reason without measured growth', () => {
    expect(formatTrendingReason(song({ viewGrowth: 0, surgeRate: 2 }))).toBeUndefined();
  });
});
