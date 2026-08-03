import type { Song } from '../types/vocadb';
import { formatJapaneseViews } from './formatViews';

export function formatTrendingReason(song: Song): string | undefined {
  const growth = Number(song.viewGrowth);
  if (!Number.isFinite(growth) || growth <= 0) return undefined;

  const windowDays = Number.isFinite(song.trendWindowDays) && Number(song.trendWindowDays) > 0
    ? Math.round(Number(song.trendWindowDays))
    : 7;
  const growthLabel = `${windowDays}日で+${formatJapaneseViews(Math.round(growth), { zeroIsMissing: false })}再生`;
  const surgeRate = Number(song.surgeRate);

  if (!Number.isFinite(surgeRate) || surgeRate < 1) return growthLabel;
  const rateLabel = surgeRate >= 10
    ? Math.round(surgeRate).toLocaleString('ja-JP')
    : surgeRate.toFixed(1);
  return `${growthLabel}・平常時の${rateLabel}倍`;
}
