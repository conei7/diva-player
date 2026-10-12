import { describe, expect, it } from 'vitest';
import { emptyReportBucket } from '../../services/historyStats';
import {
  fillReportBuckets,
  formatBucketLabel,
  formatPlays,
  formatReportRangeLabel,
  isFutureRange,
  isValidMonthKey,
  isValidYearKey,
  matchPreset,
  presetRange,
  shiftReportRange,
  showsAxisLabel,
} from './reportPeriod';

const TOKYO = 'Asia/Tokyo';
// 2026-01-01 00:30 JST (still 2025-12-31 in UTC)
const NEW_YEAR = Date.UTC(2025, 11, 31, 15, 30);

describe('report periods', () => {
  it('resolves the presets in Tokyo time', () => {
    expect(presetRange('thisMonth', NEW_YEAR, TOKYO)).toEqual({ period: 'month', key: '2026-01' });
    expect(presetRange('lastMonth', NEW_YEAR, TOKYO)).toEqual({ period: 'month', key: '2025-12' });
    expect(presetRange('thisYear', NEW_YEAR, TOKYO)).toEqual({ period: 'year', key: '2026' });
    expect(presetRange('lastYear', NEW_YEAR, TOKYO)).toEqual({ period: 'year', key: '2025' });
    expect(presetRange('all', NEW_YEAR, TOKYO)).toEqual({ period: 'all', key: 'all' });
    expect(matchPreset({ period: 'month', key: '2025-12' }, NEW_YEAR, TOKYO)).toBe('lastMonth');
    expect(matchPreset({ period: 'month', key: '2025-11' }, NEW_YEAR, TOKYO)).toBeNull();
  });

  it('moves to the previous and next month or year', () => {
    expect(shiftReportRange({ period: 'month', key: '2026-01' }, -1)).toEqual({ period: 'month', key: '2025-12' });
    expect(shiftReportRange({ period: 'month', key: '2025-12' }, 1)).toEqual({ period: 'month', key: '2026-01' });
    expect(shiftReportRange({ period: 'year', key: '2026' }, -1)).toEqual({ period: 'year', key: '2025' });
    expect(shiftReportRange({ period: 'all', key: 'all' }, -1)).toBeNull();
    expect(isFutureRange({ period: 'month', key: '2026-02' }, NEW_YEAR, TOKYO)).toBe(true);
    expect(isFutureRange({ period: 'month', key: '2026-01' }, NEW_YEAR, TOKYO)).toBe(false);
    expect(isFutureRange({ period: 'year', key: '2027' }, NEW_YEAR, TOKYO)).toBe(true);
  });

  it('validates picked months and years', () => {
    expect(isValidMonthKey('2026-10')).toBe(true);
    expect(isValidMonthKey('2026-13')).toBe(false);
    expect(isValidMonthKey('')).toBe(false);
    expect(isValidYearKey('2026')).toBe(true);
    expect(isValidYearKey('1999')).toBe(false);
  });

  it('labels months and years in both languages', () => {
    expect(formatReportRangeLabel({ period: 'month', key: '2026-10' }, 'ja')).toBe('2026年10月');
    expect(formatReportRangeLabel({ period: 'month', key: '2026-10' }, 'en')).toBe('October 2026');
    expect(formatReportRangeLabel({ period: 'year', key: '2026' }, 'ja')).toBe('2026年');
    expect(formatReportRangeLabel({ period: 'year', key: '2026' }, 'en')).toBe('2026');
  });
});

describe('report chart buckets', () => {
  const bucket = (key: string, starts: number) => ({
    ...emptyReportBucket(key), starts, qualifiedPlays: starts, listenedSeconds: starts * 60, uniqueSongs: starts,
  });

  it('fills every day of the month and every month of the year', () => {
    const days = fillReportBuckets([bucket('2026-02-03', 2)], { period: 'month', key: '2026-02' });
    expect(days).toHaveLength(28);
    expect(days[2]).toMatchObject({ key: '2026-02-03', starts: 2 });
    expect(days[0]).toMatchObject({ key: '2026-02-01', starts: 0 });

    const months = fillReportBuckets([bucket('2026-05', 1)], { period: 'year', key: '2026' });
    expect(months.map(item => item.key)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
      '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
    ]);
    expect(months[4].starts).toBe(1);
  });

  it('spans the years between the first and last play for all time', () => {
    const years = fillReportBuckets([bucket('2023', 1), bucket('2026', 4)], { period: 'all', key: 'all' });
    expect(years.map(item => [item.key, item.starts])).toEqual([['2023', 1], ['2024', 0], ['2025', 0], ['2026', 4]]);
    expect(fillReportBuckets([], { period: 'all', key: 'all' })).toEqual([]);
  });

  it('labels the axis sparsely and the bars fully', () => {
    const labelled = Array.from({ length: 31 }, (_, index) => index)
      .filter(index => showsAxisLabel(index, 31, 'month'))
      .map(index => index + 1);
    expect(labelled).toEqual([1, 5, 10, 15, 20, 25, 31]);
    expect(formatBucketLabel('2026-10-03', 'month', 'ja', 'axis')).toBe('3');
    expect(formatBucketLabel('2026-10-03', 'month', 'ja', 'full')).toBe('10月3日');
    expect(formatBucketLabel('2026-10-03', 'month', 'en', 'full')).toBe('Oct 3');
    expect(formatBucketLabel('2026-01', 'year', 'ja', 'axis')).toBe('1月');
    expect(formatBucketLabel('2026-01', 'year', 'en', 'axis')).toBe('Jan');
    expect(formatBucketLabel('2026', 'all', 'ja', 'full')).toBe('2026年');
  });

  it('counts plays with singular and plural forms', () => {
    expect(formatPlays(1234, 'ja')).toBe('1,234回');
    expect(formatPlays(1, 'en')).toBe('1 play');
    expect(formatPlays(12, 'en')).toBe('12 plays');
  });
});
