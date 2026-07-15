export interface FormatJapaneseViewsOptions {
  zeroIsMissing?: boolean;
  fallback?: string;
}

/** Format view counts consistently across cards, descriptions, and charts. */
export function formatJapaneseViews(
  value: number | null | undefined,
  { zeroIsMissing = true, fallback = '-' }: FormatJapaneseViewsOptions = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < 0 || (zeroIsMissing && rounded === 0)) return fallback;
  if (rounded >= 100_000_000) {
    return `${(rounded / 100_000_000).toFixed(1).replace(/\.0$/, '')}億`;
  }
  if (rounded >= 10_000) {
    return `${(rounded / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  }
  return rounded.toLocaleString('ja-JP');
}
