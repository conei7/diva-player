import { emptyReportBucket, type ReportBucket, type ReportPeriod } from '../../services/historyStats';
import type { LibraryLanguage } from './historyGroups';

/** A report period: a month ('YYYY-MM'), a year ('YYYY') or all time ('all'). */
export interface ReportRange {
  period: ReportPeriod;
  key: string;
}

export type ReportPreset = 'thisMonth' | 'lastMonth' | 'thisYear' | 'lastYear' | 'all';

export const REPORT_PRESETS: readonly ReportPreset[] = ['thisMonth', 'lastMonth', 'thisYear', 'lastYear', 'all'];

export const ALL_TIME_RANGE: ReportRange = { period: 'all', key: 'all' };

/** The current month 'YYYY-MM' and year 'YYYY' in the given time zone. */
export function currentYearMonth(now: number, timeZone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' })
    .formatToParts(new Date(now));
  const year = Number(parts.find(part => part.type === 'year')?.value ?? new Date(now).getUTCFullYear());
  const month = Number(parts.find(part => part.type === 'month')?.value ?? new Date(now).getUTCMonth() + 1);
  return { year, month };
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function parseMonthKey(key: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null;
}

export function isValidMonthKey(key: string): boolean {
  return parseMonthKey(key) !== null;
}

export function isValidYearKey(key: string): boolean {
  return /^\d{4}$/.test(key) && Number(key) >= 2000 && Number(key) <= 2100;
}

export function presetRange(preset: ReportPreset, now: number, timeZone: string): ReportRange {
  const { year, month } = currentYearMonth(now, timeZone);
  switch (preset) {
    case 'thisMonth':
      return { period: 'month', key: monthKey(year, month) };
    case 'lastMonth':
      return month === 1 ? { period: 'month', key: monthKey(year - 1, 12) } : { period: 'month', key: monthKey(year, month - 1) };
    case 'thisYear':
      return { period: 'year', key: String(year) };
    case 'lastYear':
      return { period: 'year', key: String(year - 1) };
    default:
      return ALL_TIME_RANGE;
  }
}

export function matchPreset(range: ReportRange, now: number, timeZone: string): ReportPreset | null {
  return REPORT_PRESETS.find(preset => {
    const candidate = presetRange(preset, now, timeZone);
    return candidate.period === range.period && candidate.key === range.key;
  }) ?? null;
}

/** The previous (delta -1) or next (+1) month / year. All time has no neighbours. */
export function shiftReportRange(range: ReportRange, delta: number): ReportRange | null {
  if (range.period === 'month') {
    const parsed = parseMonthKey(range.key);
    if (!parsed) return null;
    const index = parsed.year * 12 + (parsed.month - 1) + delta;
    return { period: 'month', key: monthKey(Math.floor(index / 12), (index % 12) + 1) };
  }
  if (range.period === 'year') {
    const year = Number(range.key);
    return Number.isFinite(year) ? { period: 'year', key: String(year + delta) } : null;
  }
  return null;
}

/** True when the range starts after the current month / year (there can't be plays yet). */
export function isFutureRange(range: ReportRange, now: number, timeZone: string): boolean {
  const { year, month } = currentYearMonth(now, timeZone);
  if (range.period === 'month') return range.key > monthKey(year, month);
  if (range.period === 'year') return Number(range.key) > year;
  return false;
}

function localeOf(language: LibraryLanguage): string {
  return language === 'en' ? 'en-US' : 'ja-JP';
}

/** '2026年10月' / 'October 2026', '2026年' / '2026'. All time is labelled by the caller (translated). */
export function formatReportRangeLabel(range: ReportRange, language: LibraryLanguage): string {
  const locale = localeOf(language);
  if (range.period === 'month') {
    const parsed = parseMonthKey(range.key);
    if (!parsed) return range.key;
    return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'long' })
      .format(new Date(Date.UTC(parsed.year, parsed.month - 1, 1)));
  }
  if (range.period === 'year') {
    const year = Number(range.key);
    return Number.isFinite(year)
      ? new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric' }).format(new Date(Date.UTC(year, 0, 1)))
      : range.key;
  }
  return range.key;
}

/**
 * Every bucket of the period for the chart, including the ones without plays:
 * each day of the month, the 12 months of a year, or the years between the first and last play.
 */
export function fillReportBuckets(buckets: readonly ReportBucket[], range: ReportRange): ReportBucket[] {
  const byKey = new Map(buckets.map(bucket => [bucket.key, bucket]));
  let keys: string[];
  if (range.period === 'month') {
    const parsed = parseMonthKey(range.key);
    if (!parsed) return [...buckets];
    const days = new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate();
    keys = Array.from({ length: days }, (_, index) => `${range.key}-${String(index + 1).padStart(2, '0')}`);
  } else if (range.period === 'year') {
    keys = Array.from({ length: 12 }, (_, index) => `${range.key}-${String(index + 1).padStart(2, '0')}`);
  } else {
    const years = buckets.map(bucket => Number(bucket.key)).filter(Number.isFinite);
    if (years.length === 0) return [];
    const first = Math.min(...years);
    const last = Math.max(...years);
    keys = Array.from({ length: last - first + 1 }, (_, index) => String(first + index));
  }
  return keys.map(key => byKey.get(key) ?? emptyReportBucket(key));
}

/**
 * Bucket labels. 'axis' is the short tick text (day number / month / year),
 * 'full' is for screen readers and the hover label (10月3日 / Oct 3, 2026年1月 / Jan 2026, 2026年 / 2026).
 */
export function formatBucketLabel(
  key: string,
  period: ReportPeriod,
  language: LibraryLanguage,
  style: 'axis' | 'full',
): string {
  const locale = localeOf(language);
  const [year, month, day] = key.split('-').map(Number);
  if (period === 'month' && day) {
    if (style === 'axis') return String(day);
    return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short', day: 'numeric' })
      .format(new Date(Date.UTC(year, month - 1, day)));
  }
  if (period === 'year' && month) {
    return new Intl.DateTimeFormat(locale, style === 'axis'
      ? { timeZone: 'UTC', month: 'short' }
      : { timeZone: 'UTC', year: 'numeric', month: 'short' }).format(new Date(Date.UTC(year, month - 1, 1)));
  }
  if (style === 'axis' || !Number.isFinite(year)) return key;
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric' }).format(new Date(Date.UTC(year, 0, 1)));
}

/** Which axis ticks get a label: days 1, 5, 10, 15, 20, 25 and the last day; every month; years thinned out past 12. */
export function showsAxisLabel(index: number, total: number, period: ReportPeriod): boolean {
  if (period === 'month') {
    const day = index + 1;
    return day === 1 || day === total || (day % 5 === 0 && total - day >= 3);
  }
  if (period === 'year') return true;
  return total <= 12 || index % Math.ceil(total / 12) === 0 || index === total - 1;
}

/** How often you played something: '12回' / '12 plays' / '1 play'. */
export function formatPlays(count: number, language: LibraryLanguage): string {
  const value = Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
  const grouped = value.toLocaleString(localeOf(language));
  if (language === 'ja') return `${grouped}回`;
  return value === 1 ? '1 play' : `${grouped} plays`;
}
