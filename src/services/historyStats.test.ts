import { describe, expect, it } from 'vitest';
import {
  applyHistoryEventToStats,
  emptyHistorySongStats,
  isQualifiedPlay,
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
    applyHistoryEventToStats(stats, event({ f: 0 }), 'Asia/Tokyo');
    expect(stats.startCount).toBe(0);
    expect(stats.qualifiedPlayCount).toBe(0);
  });

  it('separates manual and autoplay counts', () => {
    const stats = emptyHistorySongStats(42);
    applyHistoryEventToStats(stats, event({ o: 0, p: 90, c: 1 }), 'Asia/Tokyo');
    applyHistoryEventToStats(stats, event({ o: 1, p: 20 }), 'Asia/Tokyo');

    expect(stats.startCount).toBe(2);
    expect(stats.qualifiedPlayCount).toBe(1);
    expect(stats.completeCount).toBe(1);
    expect(stats.manualPlayCount).toBe(1);
    expect(stats.autoPlayCount).toBe(1);
    expect(stats.listenedSeconds).toBe(110);
  });
});
