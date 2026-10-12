import { describe, expect, it } from 'vitest';
import type { Song } from '../../types/vocadb';
import {
  formatHistoryDayLabel,
  formatHistoryTime,
  getDayKey,
  groupHistoryByDay,
  latestPlayPerSong,
} from './historyGroups';

const TOKYO = 'Asia/Tokyo';

function song(id: number, name = `曲${id}`): Song {
  return { id, name, artistString: 'P' } as Song;
}

// 2026-10-12 12:00 JST (a Monday)
const NOW = Date.UTC(2026, 9, 12, 3, 0);

describe('history grouping', () => {
  it('uses the Tokyo calendar day', () => {
    expect(getDayKey(Date.UTC(2026, 9, 11, 15, 30), TOKYO)).toBe('2026-10-12');
    expect(getDayKey(Date.UTC(2026, 9, 11, 14, 30), TOKYO)).toBe('2026-10-11');
  });

  it('keeps one row per song and day with the latest play, newest day first', () => {
    const groups = groupHistoryByDay([
      { song: song(1), playedAt: Date.UTC(2026, 9, 12, 2, 0) },
      { song: song(2), playedAt: Date.UTC(2026, 9, 12, 1, 0) },
      { song: song(1), playedAt: Date.UTC(2026, 9, 12, 0, 0) },
      { song: song(1), playedAt: Date.UTC(2026, 9, 10, 5, 0) },
    ], TOKYO);

    expect(groups.map(group => group.dayKey)).toEqual(['2026-10-12', '2026-10-10']);
    expect(groups[0].items.map(item => item.key)).toEqual(['1:2026-10-12', '2:2026-10-12']);
    expect(groups[0].items[0].playedAt).toBe(Date.UTC(2026, 9, 12, 2, 0));
    expect(groups[1].items.map(item => item.key)).toEqual(['1:2026-10-10']);
  });

  it('collapses repeated plays into one row per song for title and artist sorting', () => {
    const rows = latestPlayPerSong([
      { song: song(1), playedAt: 100 },
      { song: song(2), playedAt: 300 },
      { song: song(1), playedAt: 500 },
    ]);
    expect(rows.map(row => [row.key, row.playedAt])).toEqual([['song:1', 500], ['song:2', 300]]);
  });
});

describe('history day labels', () => {
  it('names today, yesterday and the days of the last week', () => {
    expect(formatHistoryDayLabel('2026-10-12', NOW, TOKYO, 'ja')).toBe('今日');
    expect(formatHistoryDayLabel('2026-10-11', NOW, TOKYO, 'ja')).toBe('昨日');
    expect(formatHistoryDayLabel('2026-10-07', NOW, TOKYO, 'ja')).toBe('水曜日');
    expect(formatHistoryDayLabel('2026-10-12', NOW, TOKYO, 'en')).toBe('Today');
    expect(formatHistoryDayLabel('2026-10-11', NOW, TOKYO, 'en')).toBe('Yesterday');
    expect(formatHistoryDayLabel('2026-10-07', NOW, TOKYO, 'en')).toBe('Wednesday');
  });

  it('shows the date, with the year only for other years', () => {
    expect(formatHistoryDayLabel('2026-10-03', NOW, TOKYO, 'ja')).toBe('10月3日');
    expect(formatHistoryDayLabel('2025-10-03', NOW, TOKYO, 'ja')).toBe('2025年10月3日');
    expect(formatHistoryDayLabel('2026-10-03', NOW, TOKYO, 'en')).toBe('Oct 3');
    expect(formatHistoryDayLabel('2025-10-03', NOW, TOKYO, 'en')).toBe('Oct 3, 2025');
  });

  it('formats the clock time of a play', () => {
    const playedAt = Date.UTC(2026, 9, 12, 12, 4); // 21:04 JST
    expect(formatHistoryTime(playedAt, TOKYO, 'ja')).toBe('21:04');
    // ICU may put a narrow no-break space before "PM".
    expect(formatHistoryTime(playedAt, TOKYO, 'en')).toMatch(/^9:04\sPM$/u);
  });
});
