import type { Song } from '../types/vocadb';
import { formatJapaneseViews } from './formatViews';

export function formatTrendingReason(song: Song, language: 'ja' | 'en' = 'ja'): string | undefined {
  const growth = Number(song.viewGrowth);
  if (!Number.isFinite(growth) || growth <= 0) return undefined;

  const windowDays = Number.isFinite(song.trendWindowDays) && Number(song.trendWindowDays) > 0
    ? Math.round(Number(song.trendWindowDays))
    : 7;
  const growthCount = Math.round(growth);
  const growthLabel = language === 'en'
    ? `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(growthCount)} more views in ${windowDays} days`
    : `${windowDays}日で+${formatJapaneseViews(growthCount, { zeroIsMissing: false })}再生`;
  const surgeRate = Number(song.surgeRate);

  if (!Number.isFinite(surgeRate) || surgeRate < 1) return growthLabel;
  const rateLabel = surgeRate >= 10
    ? Math.round(surgeRate).toLocaleString(language === 'en' ? 'en-US' : 'ja-JP')
    : surgeRate.toFixed(1);
  return language === 'en'
    ? `${growthLabel} · ${rateLabel}× usual`
    : `${growthLabel}・平常時の${rateLabel}倍`;
}
