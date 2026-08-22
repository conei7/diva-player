import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { formatWeeklyRankingReason } from './weeklyRankingReason';

function song(overrides: Partial<Song>): Song {
  return overrides as Song;
}

describe('formatWeeklyRankingReason', () => {
  it('shows the measured average daily playback increase', () => {
    expect(formatWeeklyRankingReason(song({ averageDailyGrowth: 12_345.4 })))
      .toBe('1日平均 +1.2万再生');
  });

  it('does not manufacture a metric without positive growth', () => {
    expect(formatWeeklyRankingReason(song({ averageDailyGrowth: 0 }))).toBeUndefined();
    expect(formatWeeklyRankingReason(song({}))).toBeUndefined();
  });
});
