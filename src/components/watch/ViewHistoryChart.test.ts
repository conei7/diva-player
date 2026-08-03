import { describe, expect, it } from 'vitest';
import {
  aggregateViewHistory,
  bucketForViewHistoryRange,
  filterViewHistoryByRange,
  formatExactViewCount,
  getViewHistoryYAxisRange,
  getObservedViewHistory,
  normalizeViewHistory,
  toGrowthViewHistory,
} from '../../utils/viewHistory';

describe('normalizeViewHistory', () => {
  it('keeps irregular dates and treats an initial zero as missing', () => {
    const result = normalizeViewHistory([
      { date: '2026-01-01', youtube: 0, nico: 10 },
      { date: '2026-01-03', youtube: 100, nico: 20 },
    ]);
    expect(result.map(item => item.date)).toEqual(['2026-01-01', '2026-01-03']);
    expect(result[0].youtube).toBeNull();
  });

  it('keeps a missing service distinct from an explicit zero', () => {
    const result = normalizeViewHistory([
      { date: '2026-01-01', youtube: 10, nico: 10 },
      { date: '2026-01-05', youtube: 20, nico: 0 },
      { date: '2026-01-06', youtube: 30 },
    ]);
    expect(result[0].nico).toBe(10);
    expect(result[1].nico).toBe(0);
    expect(result[2].nico).toBeNull();
  });

  it('corrects an isolated cumulative spike and leaves sustained decreases visible', () => {
    const spike = normalizeViewHistory([
      { date: '2026-01-01', youtube: 100, nico: 0 },
      { date: '2026-01-02', youtube: 5000, nico: 0 },
      { date: '2026-01-03', youtube: 120, nico: 0 },
    ]);
    expect(spike[1].youtube).toBe(120);
    expect(spike[1].correctedYoutube).toBe(true);

    const sustained = normalizeViewHistory([
      { date: '2026-01-01', youtube: 100, nico: 0 },
      { date: '2026-01-02', youtube: 80, nico: 0 },
      { date: '2026-01-03', youtube: 90, nico: 0 },
    ]);
    expect(sustained[1].youtube).toBe(80);
  });
});

describe('filterViewHistoryByRange', () => {
  it('uses the latest history date rather than the current wall clock', () => {
    const history = normalizeViewHistory([
      { date: '2026-01-01', youtube: 1 },
      { date: '2026-01-05', youtube: 2 },
      { date: '2026-01-06', youtube: 3 },
      { date: '2026-01-07', youtube: 4 },
    ]);
    expect(filterViewHistoryByRange(history, '7d')).toHaveLength(4);
    expect(filterViewHistoryByRange(history, 'all')).toEqual(history);
  });

  it('uses calendar cutoffs for gaps and preserves a single in-range point', () => {
    const history = normalizeViewHistory([
      { date: '2026-01-01', youtube: 1, nico: 0 },
      { date: '2026-01-04', youtube: 2, nico: 0 },
      { date: '2026-01-10', youtube: 3, nico: 0 },
    ]);
    expect(filterViewHistoryByRange(history, '7d').map(item => item.date)).toEqual(['2026-01-04', '2026-01-10']);
    expect(filterViewHistoryByRange(history, '7d').filter(item => item.youtube !== null)).toHaveLength(2);
  });
});

describe('view history display transforms', () => {
  it('formats tooltip values as exact integers instead of compact units', () => {
    expect(formatExactViewCount(62114)).toBe('62,114');
    expect(formatExactViewCount(100918518)).toBe('100,918,518');
  });

  it('selects a display bucket from the requested range', () => {
    expect(bucketForViewHistoryRange('7d')).toBe('day');
    expect(bucketForViewHistoryRange('90d')).toBe('week');
    expect(bucketForViewHistoryRange('all')).toBe('month');
  });

  it('keeps the latest cumulative value in each bucket', () => {
    const history = normalizeViewHistory([
      { date: '2026-01-01', youtube: 100 },
      { date: '2026-01-03', youtube: 130 },
      { date: '2026-01-06', youtube: 160 },
    ]);
    expect(aggregateViewHistory(history, 'week')).toEqual([
      expect.objectContaining({ date: '2026-01-03', youtube: 130 }),
      expect.objectContaining({ date: '2026-01-06', youtube: 160 }),
    ]);
  });

  it('uses the API baseline so the first growth point is not lost', () => {
    const history = normalizeViewHistory([
      { date: '2026-01-01', youtube: 100, nico: 20, baseline: true },
      { date: '2026-01-02', youtube: 130, nico: 25 },
      { date: '2026-01-03', youtube: 155, nico: 25 },
    ]);
    expect(toGrowthViewHistory(history).map(item => [item.youtube, item.nico])).toEqual([
      [30, 5],
      [25, 0],
    ]);
  });

  it('keeps a zero API baseline as a valid growth origin', () => {
    const history = normalizeViewHistory([
      { date: '2026-01-01', youtube: 0, baseline: true },
      { date: '2026-01-02', youtube: 25 },
    ]);
    expect(toGrowthViewHistory(history)[0].youtube).toBe(25);
  });

  it('preserves a real cumulative decrease as a negative growth value', () => {
    const history = normalizeViewHistory([
      { date: '2026-01-01', youtube: 100 },
      { date: '2026-01-02', youtube: 90 },
    ]);
    expect(toGrowthViewHistory(history)[1].youtube).toBe(-10);
  });

  it('keeps every daily cumulative point when no aggregation is requested', () => {
    const history = normalizeViewHistory([
      { date: '2026-01-01', youtube: 100 },
      { date: '2026-01-03', youtube: 130 },
      { date: '2026-01-06', youtube: 160 },
    ]);
    expect(aggregateViewHistory(history, 'day').map(item => item.date)).toEqual([
      '2026-01-01',
      '2026-01-03',
      '2026-01-06',
    ]);
  });

  it('connects measured cumulative points across temporary service gaps', () => {
    const history = normalizeViewHistory([
      { date: '2026-07-24', youtube: 80920, nico: 61967 },
      { date: '2026-07-29', youtube: 81004, nico: null },
      { date: '2026-07-31', youtube: 81017, nico: null },
      { date: '2026-08-01', youtube: 81030, nico: 62114 },
    ]);

    expect(getObservedViewHistory(history, 'nico').map(item => [item.date, item.nico])).toEqual([
      ['2026-07-24', 61967],
      ['2026-08-01', 62114],
    ]);
  });

  it('only opens a negative growth axis when a negative value exists', () => {
    expect(getViewHistoryYAxisRange([
      { date: '2026-01-01', youtube: 10, nico: null },
      { date: '2026-01-02', youtube: 20, nico: null },
    ], 'growth')).toEqual({ yMin: 0, yMax: 20 });
    expect(getViewHistoryYAxisRange([
      { date: '2026-01-01', youtube: -10, nico: null },
      { date: '2026-01-02', youtube: 20, nico: null },
    ], 'growth')).toEqual({ yMin: -20, yMax: 20 });
  });

  it('does not assign multiple missing days of growth to the next observed day', () => {
    const history = normalizeViewHistory([
      { date: '2026-07-13', youtube: 90, nico: 40, baseline: true },
      { date: '2026-07-14', youtube: 100, nico: 45 },
      { date: '2026-07-17', youtube: 130, nico: 60 },
      { date: '2026-07-18', youtube: 140, nico: 64 },
    ]);

    expect(toGrowthViewHistory(history, undefined, 'day').map(item => [item.youtube, item.nico])).toEqual([
      [10, 5],
      [null, null],
      [10, 4],
    ]);
  });
});
