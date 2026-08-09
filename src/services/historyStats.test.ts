import { describe, expect, it, vi } from 'vitest';
import {
  applyHistoryEventToStats,
  buildHistoryCsv,
  buildHistoryReportCsv,
  compareHistoryStats,
  emptyHistorySongStats,
  enrichSongMetadata,
  enrichTopSongs,
  isFinalizedPlayEvent,
  isQualifiedPlay,
} from './historyStats';
import type { ListeningPlayEvent } from '../stores/historyStore';
import type { Song } from '../types/vocadb';

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

  it('treats legacy events as finalized and tracks their date range', () => {
    const stats = emptyHistorySongStats(42);
    applyHistoryEventToStats(stats, event({ t: 2_000, f: undefined }), 'Asia/Tokyo');
    applyHistoryEventToStats(stats, event({ t: 1_000, p: 40 }), 'Asia/Tokyo');

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

  it('exports finalized events with song metadata and escaped values', () => {
    const csv = buildHistoryCsv([
      event({ id: 2, t: 2_000, f: 0 }),
      event({ id: 1, t: 1_000, p: 30, c: 1 }),
    ], new Map([[42, { songName: '曲, "名前"', artistString: '作家' }]]));

    expect(csv).toContain('曲名');
    expect(csv).toContain('"曲, ""名前"""');
    expect(csv).toContain('はい');
    expect(csv).not.toContain(',2,');
    expect(csv.indexOf('\r\n1,')).toBeGreaterThan(-1);
    expect(csv.indexOf('\r\n2,')).toBe(-1);
  });

  it('exports report overview, buckets, and top songs even when sections are empty', () => {
    const csv = buildHistoryReportCsv({
      period: 'month',
      key: '2026-01',
      totalStarts: 0,
      manualPlayCount: 0,
      autoPlayCount: 0,
      uniqueSongCount: 0,
      totalQualifiedPlays: 0,
      totalCompletes: 0,
      totalListenedSeconds: 0,
      firstPlayedAt: null,
      lastPlayedAt: null,
      topSongs: [],
      topSongsWithMeta: [],
      buckets: [],
    });

    expect(csv).toContain('セクション');
    expect(csv).toContain('概要,month,2026-01');
    expect(csv).not.toContain('推移');
  });

  it('includes report bucket and top-song rows', () => {
    const csv = buildHistoryReportCsv({
      period: 'year',
      key: '2026',
      totalStarts: 2,
      manualPlayCount: 1,
      autoPlayCount: 1,
      uniqueSongCount: 1,
      totalQualifiedPlays: 1,
      totalCompletes: 1,
      totalListenedSeconds: 90,
      firstPlayedAt: 1_000,
      lastPlayedAt: 2_000,
      topSongs: [],
      topSongsWithMeta: [{
        songId: 42,
        songName: '曲名',
        artistString: '作者',
        startCount: 2,
        qualifiedPlayCount: 1,
        completeCount: 1,
        manualPlayCount: 1,
        autoPlayCount: 1,
        listenedSeconds: 90,
        firstPlayedAt: 1_000,
        lastPlayedAt: 2_000,
      }],
      buckets: [{ key: '2026-01', starts: 2, qualifiedPlays: 1, listenedSeconds: 90 }],
    });

    expect(csv).toContain('推移,year,2026-01');
    expect(csv).toContain('上位曲,year,2026,42,曲名,作者');
  });

  it('enriches report songs with one compact batch and keeps missing-song placeholders', async () => {
    const first = { ...emptyHistorySongStats(1), qualifiedPlayCount: 2 };
    const second = { ...emptyHistorySongStats(2), qualifiedPlayCount: 1 };
    const loadSongs = vi.fn(async () => ([{
      id: 2,
      name: '軽量曲',
      artistString: '作者',
      thumbUrl: 'thumb.jpg',
    }] as Song[]));

    const enriched = await enrichTopSongs([first, second], loadSongs);

    expect(loadSongs).toHaveBeenCalledOnce();
    expect(loadSongs).toHaveBeenCalledWith([1, 2]);
    expect(enriched).toMatchObject([
      { songId: 1, songName: '曲ID 1', artistString: '' },
      { songId: 2, songName: '軽量曲', artistString: '作者', thumbUrl: 'thumb.jpg' },
    ]);
  });

  it('deduplicates CSV metadata ids into one compact batch', async () => {
    const loadSongs = vi.fn(async () => ([{
      id: 4,
      name: 'CSV曲',
      artistString: 'CSV作者',
    }] as Song[]));

    const metadata = await enrichSongMetadata([3, 4, 3], loadSongs);

    expect(loadSongs).toHaveBeenCalledOnce();
    expect(loadSongs).toHaveBeenCalledWith([3, 4]);
    expect(metadata.get(3)).toEqual({ songName: '曲ID 3', artistString: '' });
    expect(metadata.get(4)).toEqual({ songName: 'CSV曲', artistString: 'CSV作者' });
  });
});
