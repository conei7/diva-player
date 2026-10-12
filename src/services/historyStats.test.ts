import { describe, expect, it, vi } from 'vitest';
import {
  applyHistoryEventToStats,
  buildHistoryCsv,
  buildHistoryReportCsv,
  buildReportBuckets,
  compareHistoryStats,
  emptyHistorySongStats,
  emptyReportBucket,
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

  it('names the CSV columns like the metrics on screen, in the display language', () => {
    const events = [event({ id: 1, t: 1_000, p: 30, c: 1, o: 1 })];
    const japanese = buildHistoryCsv(events);
    const header = japanese.replace('\uFEFF', '').split('\r\n')[0];
    expect(header).toBe('イベントID,再生日時(ISO),再生日時(表示),曲ID,曲名,アーティスト,再生方式,再生時間(秒),曲の長さ(秒),再生率,再生回数に数える,最後まで聴いた');
    expect(japanese).toContain(',曲ID 42,,自動,30,120,0.25,はい,はい');

    const english = buildHistoryCsv(events, new Map(), 'Asia/Tokyo', 'en').replace('\uFEFF', '').split('\r\n');
    expect(english[0]).toBe('Event ID,Played at (ISO),Played at,Song ID,Title,Artist,Play type,Listening time (sec),Length (sec),Portion played,Counts as a play,Finished');
    // Same columns and value formats; only the words follow the language.
    expect(english[1]).toBe('1,1970-01-01T00:00:01.000Z,1970/01/01 09:00:01,42,Song ID 42,,Auto,30,120,0.25,Yes,Yes');
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
    expect(csv.replace('\uFEFF', '').split('\r\n')[0])
      .toBe('セクション,期間,キー,曲ID,曲名,アーティスト,再生開始,再生回数,最後まで聴いた,手動再生,自動再生,再生時間(秒),最初の再生日時(ISO),最後の再生日時(ISO)');
  });

  it('includes report bucket and top-song rows', () => {
    const report = {
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
      buckets: [{
        ...emptyReportBucket('2026-01'),
        starts: 2,
        qualifiedPlays: 1,
        listenedSeconds: 90,
        completes: 1,
        uniqueSongs: 1,
        autoStarts: 1,
        autoListenedSeconds: 10,
      }],
    } satisfies Parameters<typeof buildHistoryReportCsv>[0];
    const csv = buildHistoryReportCsv(report);

    expect(csv).toContain('推移,year,2026-01');
    expect(csv).toContain('推移,year,2026-01,,,,2,1,,,,90,,');
    expect(csv).toContain('上位曲,year,2026,42,曲名,作者');

    const english = buildHistoryReportCsv(report, 'en');
    expect(english.replace('\uFEFF', '').split('\r\n')[0])
      .toBe('Section,Period,Key,Song ID,Title,Artist,Starts,Plays,Finished,Manual starts,Auto starts,Listening time (sec),First played at (ISO),Last played at (ISO)');
    expect(english).toContain('Overview,year,2026,,,,2,1,1,1,1,90,');
    expect(english).toContain('Trend,year,2026-01,,,,2,1,,,,90,,');
    expect(english).toContain('Top songs,year,2026,42,曲名,作者');
  });

  it('buckets a month by Tokyo day with plays, completes, distinct songs and the autoplay share', () => {
    const buckets = buildReportBuckets([
      // 2026-01-31 23:30 JST and 2026-02-01 00:30 JST fall in different months.
      event({ s: 1, t: Date.UTC(2026, 0, 31, 14, 30), p: 60, d: 120, c: 1 }),
      event({ s: 1, t: Date.UTC(2026, 0, 31, 15, 30), p: 10, d: 120 }),
      event({ s: 2, t: Date.UTC(2026, 0, 3, 3, 0), p: 90, d: 120, c: 1 }),
      event({ s: 2, t: Date.UTC(2026, 0, 3, 4, 0), p: 40, d: 120, o: 1 }),
      event({ s: 3, t: Date.UTC(2026, 0, 3, 5, 0), p: 20, d: 120, o: 1 }),
      event({ s: 4, t: Date.UTC(2026, 0, 3, 6, 0), f: 0 }),
    ], 'month', '2026-01');

    expect(buckets).toEqual([
      {
        key: '2026-01-03',
        starts: 3,
        qualifiedPlays: 2,
        listenedSeconds: 150,
        completes: 1,
        uniqueSongs: 2,
        autoStarts: 2,
        autoQualifiedPlays: 1,
        autoListenedSeconds: 60,
        autoCompletes: 0,
      },
      { ...emptyReportBucket('2026-01-31'), starts: 1, qualifiedPlays: 1, listenedSeconds: 60, completes: 1, uniqueSongs: 1 },
    ]);
  });

  it('buckets a year by month and all time by year', () => {
    const events = [
      event({ s: 1, t: Date.UTC(2025, 11, 31, 16, 0) }), // 2026-01-01 01:00 JST
      event({ s: 2, t: Date.UTC(2026, 4, 10) }),
      event({ s: 3, t: Date.UTC(2024, 6, 1) }),
    ];

    expect(buildReportBuckets(events, 'year', 2026).map(bucket => [bucket.key, bucket.starts]))
      .toEqual([['2026-01', 1], ['2026-05', 1]]);
    expect(buildReportBuckets(events, 'all', 'all').map(bucket => [bucket.key, bucket.starts, bucket.uniqueSongs]))
      .toEqual([['2024', 1, 1], ['2026', 2, 2]]);
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
      { songId: 2, songName: '軽量曲', artistString: '作者', thumbUrl: 'thumb.jpg', song: { id: 2 } },
    ]);
    expect(enriched[0].song).toBeUndefined();
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

  it('loads large CSV metadata sequentially in isolated 100-song chunks', async () => {
    const ids = Array.from({ length: 205 }, (_, index) => index + 1);
    let activeLoads = 0;
    let maximumActiveLoads = 0;
    const loadSongs = vi.fn(async (chunk: number[]) => {
      activeLoads += 1;
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
      await Promise.resolve();
      activeLoads -= 1;
      if (chunk[0] === 101) throw new Error('one chunk failed');
      return chunk.map(id => ({ id, name: `曲${id}`, artistString: `作者${id}` })) as Song[];
    });

    const metadata = await enrichSongMetadata(ids, loadSongs);

    expect(loadSongs.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 5]);
    expect(maximumActiveLoads).toBe(1);
    expect(metadata.get(1)).toEqual({ songName: '曲1', artistString: '作者1' });
    expect(metadata.get(101)).toEqual({ songName: '曲ID 101', artistString: '' });
    expect(metadata.get(205)).toEqual({ songName: '曲205', artistString: '作者205' });
  });
});
