import { describe, expect, it } from 'vitest';
import {
  applyHistoryEventToStats,
  compareHistoryStats,
  emptyHistorySongStats,
  isFinalizedPlayEvent,
  isQualifiedPlay,
  getYearAndMonth,
} from './historyStats';
import type { ListeningPlayEvent } from '../stores/historyStore';

const event = (overrides: Partial<ListeningPlayEvent> = {}): ListeningPlayEvent => ({
  s: 42,
  t: Date.UTC(2026, 0, 1),
  o: 0,
  p: 60,
  d: 120,
  c: 0,
  f: 1,
  ...overrides,
});

describe('history statistics', () => {
  it('uses a 30-second or half-duration threshold for qualified plays', () => {
    expect(isQualifiedPlay(event({ p: 29, d: 120 }))).toBe(false);
    expect(isQualifiedPlay(event({ p: 30, d: 120 }))).toBe(true);
    expect(isQualifiedPlay(event({ p: 10, d: 20 }))).toBe(true);
    expect(isQualifiedPlay(event({ p: 9, d: 20 }))).toBe(false);
  });

  it('ignores an active event until it is finalized', () => {
    const stats = emptyHistorySongStats(42);
    applyHistoryEventToStats(stats, event({ f: 0 }));
    expect(stats.startCount).toBe(0);
    expect(stats.qualifiedPlayCount).toBe(0);
  });

  it('separates manual and autoplay counts', () => {
    const stats = emptyHistorySongStats(42);
    applyHistoryEventToStats(stats, event({ o: 0, p: 90, c: 1 }));
    applyHistoryEventToStats(stats, event({ o: 1, p: 20 }));

    expect(stats.startCount).toBe(2);
    expect(stats.qualifiedPlayCount).toBe(1);
    expect(stats.completeCount).toBe(1);
    expect(stats.manualPlayCount).toBe(1);
    expect(stats.autoPlayCount).toBe(1);
    expect(stats.listenedSeconds).toBe(110);
  });

  it('treats legacy events as finalized and tracks their date range', () => {
    const stats = emptyHistorySongStats(42);
    applyHistoryEventToStats(stats, event({ t: 2_000, f: undefined }));
    applyHistoryEventToStats(stats, event({ t: 1_000, p: 40 }));

    expect(isFinalizedPlayEvent(event({ f: undefined }))).toBe(true);
    expect(stats.firstPlayedAt).toBe(1_000);
    expect(stats.lastPlayedAt).toBe(2_000);
  });

  it('orders equally played songs by listened time and then recency', () => {
    const base = emptyHistorySongStats(1);
    const longer = { ...emptyHistorySongStats(2), listenedSeconds: 10 };
    const newer = { ...emptyHistorySongStats(3), listenedSeconds: 10, lastPlayedAt: 2_000 };

    expect(compareHistoryStats(longer, base)).toBeLessThan(0);
    expect(compareHistoryStats(newer, longer)).toBeLessThan(0);
  });

  it('calculates correct year and month based on timeZone', () => {
    // 2023-12-31 23:30:00 UTC = 2024-01-01 08:30:00 JST
    const ts = Date.UTC(2023, 11, 31, 23, 30, 0);
    
    const jst = getYearAndMonth(ts, 'Asia/Tokyo');
    expect(jst.year).toBe(2024);
    expect(jst.month).toBe('2024-01');

    const utc = getYearAndMonth(ts, 'UTC');
    expect(utc.year).toBe(2023);
    expect(utc.month).toBe('2023-12');
  });
});
