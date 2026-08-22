import type { Song } from '../types/vocadb';
import { formatJapaneseViews } from './formatViews';

export function formatWeeklyRankingReason(song: Song): string | undefined {
  const average = Number(song.averageDailyGrowth);
  if (!Number.isFinite(average) || average <= 0) return undefined;

  return `1日平均 +${formatJapaneseViews(Math.round(average), { zeroIsMissing: false })}再生`;
}
