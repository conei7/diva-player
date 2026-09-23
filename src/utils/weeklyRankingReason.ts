import type { Song } from '../types/vocadb';
import { formatJapaneseViews } from './formatViews';

export function formatWeeklyRankingReason(song: Song, language: 'ja' | 'en' = 'ja'): string | undefined {
  const average = Number(song.averageDailyGrowth);
  if (!Number.isFinite(average) || average <= 0) return undefined;

  const count = Math.round(average);
  return language === 'en'
    ? `Average +${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count)} views/day`
    : `1日平均 +${formatJapaneseViews(count, { zeroIsMissing: false })}再生`;
}
