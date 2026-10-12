import type { ListeningPlayEvent } from '../stores/historyStore';
import type { AppLanguage } from '../stores/languageStore';
import type { Song } from '../types/vocadb';
import { HISTORY_STORES, openHistoryDb } from './historyDatabase';
import { getSongsByIds } from '../api/vocadb';
import { serializeCsv } from '../utils/csv';

const STATS_VERSION = 2;
/** Calendar days, months and years of the history and reports are counted in this time zone. */
export const DEFAULT_TIME_ZONE = 'Asia/Tokyo';
const HISTORY_METADATA_BATCH_SIZE = 100;

export interface HistorySongStats {
  songId: number;
  startCount: number;
  qualifiedPlayCount: number;
  completeCount: number;
  manualPlayCount: number;
  autoPlayCount: number;
  listenedSeconds: number;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
}

export interface HistoryOverview {
  totalStarts: number;
  manualPlayCount: number;
  autoPlayCount: number;
  uniqueSongCount: number;
  totalQualifiedPlays: number;
  totalCompletes: number;
  totalListenedSeconds: number;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  topSongs: HistorySongStats[];
}

interface StatsMeta {
  key: 'state';
  version: number;
}

interface PendingEvent {
  eventId: number;
}

interface YearSongStats extends HistorySongStats {
  key: string;
  year: number;
}

interface MonthSongStats extends HistorySongStats {
  key: string;
  month: string;
}

/** 'month' buckets by day, 'year' by month, 'all' (key 'all') by year. */
export type ReportPeriod = 'month' | 'year' | 'all';

export interface ReportBucket {
  key: string;
  starts: number;
  qualifiedPlays: number;
  listenedSeconds: number;
  /** Plays counted as listened to the end. */
  completes: number;
  /** Distinct songs with at least one play in the bucket. */
  uniqueSongs: number;
  /** The part of starts / qualifiedPlays / listenedSeconds / completes that autoplay started (the rest was played by hand). */
  autoStarts: number;
  autoQualifiedPlays: number;
  autoListenedSeconds: number;
  autoCompletes: number;
}

export interface HistoryReport extends HistoryOverview {
  period: ReportPeriod;
  key: string;
  /** `song` is the full metadata when it could be loaded (for thumbnails and links). */
  topSongsWithMeta: Array<HistorySongStats & { songName: string; artistString: string; thumbUrl?: string; song?: Song }>;
  buckets: ReportBucket[];
}

export interface HistorySongCsvMeta {
  songName: string;
  artistString: string;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function emptyHistorySongStats(songId: number): HistorySongStats {
  return {
    songId,
    startCount: 0,
    qualifiedPlayCount: 0,
    completeCount: 0,
    manualPlayCount: 0,
    autoPlayCount: 0,
    listenedSeconds: 0,
    firstPlayedAt: null,
    lastPlayedAt: null,
  };
}

export function getYearAndMonth(timestamp: number, timeZone: string): { year: number; month: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(timestamp));
  const year = parts.find(part => part.type === 'year')?.value ?? String(new Date(timestamp).getUTCFullYear());
  const month = parts.find(part => part.type === 'month')?.value ?? String(new Date(timestamp).getUTCMonth() + 1).padStart(2, '0');
  return { year: Number(year), month: `${year}-${month}` };
}

function getDateKey(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : new Date(timestamp).toISOString().slice(0, 10);
}

export function isFinalizedPlayEvent(event: ListeningPlayEvent): boolean {
  // Events without f are legacy records and are treated as finalized.
  return event.f !== 0;
}

export function isQualifiedPlay(event: ListeningPlayEvent): boolean {
  if (!isFinalizedPlayEvent(event) || event.p === undefined) return false;
  const progress = Math.max(0, event.p);
  if (event.d === undefined || event.d <= 0) return progress >= 30;
  return progress >= Math.min(30, event.d * 0.5);
}

export function applyHistoryEventToStats(
  stats: HistorySongStats,
  event: ListeningPlayEvent,
  timeZone?: string,
): void {
  if (!isFinalizedPlayEvent(event)) return;

  stats.startCount += 1;
  stats.manualPlayCount += event.o === 1 ? 0 : 1;
  stats.autoPlayCount += event.o === 1 ? 1 : 0;
  stats.listenedSeconds += Math.max(0, Math.round(event.p ?? 0));
  stats.qualifiedPlayCount += isQualifiedPlay(event) ? 1 : 0;
  stats.completeCount += event.c === 1 ? 1 : 0;
  stats.firstPlayedAt = stats.firstPlayedAt === null
    ? event.t
    : Math.min(stats.firstPlayedAt, event.t);
  stats.lastPlayedAt = stats.lastPlayedAt === null
    ? event.t
    : Math.max(stats.lastPlayedAt, event.t);
  void timeZone;
}

export function compareHistoryStats(a: HistorySongStats, b: HistorySongStats): number {
  return b.qualifiedPlayCount - a.qualifiedPlayCount
    || b.listenedSeconds - a.listenedSeconds
    || b.startCount - a.startCount
    || (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0);
}

async function getStatsMeta(db: IDBDatabase): Promise<StatsMeta | undefined> {
  const tx = db.transaction(HISTORY_STORES.meta, 'readonly');
  return requestToPromise(tx.objectStore(HISTORY_STORES.meta).get('state')) as Promise<StatsMeta | undefined>;
}

async function readAllEvents(db: IDBDatabase): Promise<ListeningPlayEvent[]> {
  const tx = db.transaction(HISTORY_STORES.plays, 'readonly');
  return requestToPromise(tx.objectStore(HISTORY_STORES.plays).getAll()) as Promise<ListeningPlayEvent[]>;
}

async function rebuildStats(db: IDBDatabase, timeZone: string): Promise<void> {
  const events = await readAllEvents(db);
  const songStats = new Map<number, HistorySongStats>();
  const yearStats = new Map<string, YearSongStats>();
  const monthStats = new Map<string, MonthSongStats>();

  for (const event of events) {
    if (!isFinalizedPlayEvent(event)) continue;
    const song = songStats.get(event.s) ?? emptyHistorySongStats(event.s);
    applyHistoryEventToStats(song, event, timeZone);
    songStats.set(event.s, song);

    const { year, month } = getYearAndMonth(event.t, timeZone);
    const key = `${year}:${event.s}`;
    const yearly = yearStats.get(key) ?? { ...emptyHistorySongStats(event.s), key, year };
    applyHistoryEventToStats(yearly, event, timeZone);
    yearStats.set(key, yearly);
    const monthKey = `${month}:${event.s}`;
    const monthly = monthStats.get(monthKey) ?? { ...emptyHistorySongStats(event.s), key: monthKey, month };
    applyHistoryEventToStats(monthly, event, timeZone);
    monthStats.set(monthKey, monthly);
  }

  const tx = db.transaction(
    [HISTORY_STORES.songStats, HISTORY_STORES.yearStats, HISTORY_STORES.monthStats, HISTORY_STORES.pending, HISTORY_STORES.applied, HISTORY_STORES.meta],
    'readwrite',
  );
  const songs = tx.objectStore(HISTORY_STORES.songStats);
  const years = tx.objectStore(HISTORY_STORES.yearStats);
  const months = tx.objectStore(HISTORY_STORES.monthStats);
  tx.objectStore(HISTORY_STORES.pending).clear();
  tx.objectStore(HISTORY_STORES.applied).clear();
  songs.clear();
  years.clear();
  months.clear();
  for (const stats of songStats.values()) songs.put(stats);
  for (const stats of yearStats.values()) years.put(stats);
  for (const stats of monthStats.values()) months.put(stats);
  tx.objectStore(HISTORY_STORES.meta).put({ key: 'state', version: STATS_VERSION } satisfies StatsMeta);
  await transactionToPromise(tx);
}

async function readPending(db: IDBDatabase): Promise<PendingEvent[]> {
  const tx = db.transaction(HISTORY_STORES.pending, 'readonly');
  return requestToPromise(tx.objectStore(HISTORY_STORES.pending).getAll()) as Promise<PendingEvent[]>;
}

async function readEvent(db: IDBDatabase, eventId: number): Promise<ListeningPlayEvent | undefined> {
  const tx = db.transaction(HISTORY_STORES.plays, 'readonly');
  return requestToPromise(tx.objectStore(HISTORY_STORES.plays).get(eventId)) as Promise<ListeningPlayEvent | undefined>;
}

async function readSongStat(db: IDBDatabase, songId: number): Promise<HistorySongStats | undefined> {
  const tx = db.transaction(HISTORY_STORES.songStats, 'readonly');
  return requestToPromise(tx.objectStore(HISTORY_STORES.songStats).get(songId)) as Promise<HistorySongStats | undefined>;
}

async function readYearStat(db: IDBDatabase, key: string): Promise<YearSongStats | undefined> {
  const tx = db.transaction(HISTORY_STORES.yearStats, 'readonly');
  return requestToPromise(tx.objectStore(HISTORY_STORES.yearStats).get(key)) as Promise<YearSongStats | undefined>;
}

async function readMonthStat(db: IDBDatabase, key: string): Promise<MonthSongStats | undefined> {
  const tx = db.transaction(HISTORY_STORES.monthStats, 'readonly');
  return requestToPromise(tx.objectStore(HISTORY_STORES.monthStats).get(key)) as Promise<MonthSongStats | undefined>;
}

async function wasEventApplied(db: IDBDatabase, eventId: number): Promise<boolean> {
  const tx = db.transaction(HISTORY_STORES.applied, 'readonly');
  return (await requestToPromise(tx.objectStore(HISTORY_STORES.applied).get(eventId))) !== undefined;
}

async function applyPendingEvent(db: IDBDatabase, eventId: number, timeZone: string): Promise<void> {
  const event = await readEvent(db, eventId);
  if (!event || !isFinalizedPlayEvent(event)) return;

  if (await wasEventApplied(db, eventId)) {
    const cleanupTx = db.transaction(HISTORY_STORES.pending, 'readwrite');
    cleanupTx.objectStore(HISTORY_STORES.pending).delete(eventId);
    await transactionToPromise(cleanupTx);
    return;
  }

  const existingSong = await readSongStat(db, event.s);
  const { year, month } = getYearAndMonth(event.t, timeZone);
  const key = `${year}:${event.s}`;
  const existingYear = await readYearStat(db, key);
  const monthKey = `${month}:${event.s}`;
  const existingMonth = await readMonthStat(db, monthKey);

  const tx = db.transaction(
    [HISTORY_STORES.songStats, HISTORY_STORES.yearStats, HISTORY_STORES.monthStats, HISTORY_STORES.pending, HISTORY_STORES.applied],
    'readwrite',
  );
  const songStore = tx.objectStore(HISTORY_STORES.songStats);
  const song = existingSong ?? emptyHistorySongStats(event.s);
  applyHistoryEventToStats(song, event, timeZone);
  songStore.put(song);

  const yearStore = tx.objectStore(HISTORY_STORES.yearStats);
  const yearly = existingYear ?? { ...emptyHistorySongStats(event.s), key, year };
  applyHistoryEventToStats(yearly, event, timeZone);
  yearStore.put(yearly);
  const monthStore = tx.objectStore(HISTORY_STORES.monthStats);
  const monthly = existingMonth ?? { ...emptyHistorySongStats(event.s), key: monthKey, month };
  applyHistoryEventToStats(monthly, event, timeZone);
  monthStore.put(monthly);
  tx.objectStore(HISTORY_STORES.applied).put({ eventId });
  tx.objectStore(HISTORY_STORES.pending).delete(eventId);
  await transactionToPromise(tx);
}

async function processPending(db: IDBDatabase, timeZone: string): Promise<void> {
  const pending = await readPending(db);
  for (const item of pending) await applyPendingEvent(db, item.eventId, timeZone);
}

async function ensureStats(timeZone = DEFAULT_TIME_ZONE): Promise<IDBDatabase> {
  const db = await openHistoryDb();
  const meta = await getStatsMeta(db);
  if (!meta || meta.version !== STATS_VERSION) await rebuildStats(db, timeZone);
  await processPending(db, timeZone);
  return db;
}

async function readSongStats(db: IDBDatabase): Promise<HistorySongStats[]> {
  const tx = db.transaction(HISTORY_STORES.songStats, 'readonly');
  return requestToPromise(tx.objectStore(HISTORY_STORES.songStats).getAll()) as Promise<HistorySongStats[]>;
}

export async function getHistoryOverview(
  year?: number,
  timeZone = DEFAULT_TIME_ZONE,
): Promise<HistoryOverview> {
  const db = await ensureStats(timeZone);
  const allStats = await readSongStats(db);
  const stats = year === undefined ? allStats : await readYearStats(db, year);
  return {
    totalStarts: stats.reduce((sum, item) => sum + item.startCount, 0),
    manualPlayCount: stats.reduce((sum, item) => sum + item.manualPlayCount, 0),
    autoPlayCount: stats.reduce((sum, item) => sum + item.autoPlayCount, 0),
    uniqueSongCount: stats.length,
    totalQualifiedPlays: stats.reduce((sum, item) => sum + item.qualifiedPlayCount, 0),
    totalCompletes: stats.reduce((sum, item) => sum + item.completeCount, 0),
    totalListenedSeconds: stats.reduce((sum, item) => sum + item.listenedSeconds, 0),
    firstPlayedAt: stats.reduce<number | null>((first, item) => {
      if (item.firstPlayedAt === null) return first;
      return first === null ? item.firstPlayedAt : Math.min(first, item.firstPlayedAt);
    }, null),
    lastPlayedAt: stats.reduce<number | null>((last, item) => {
      if (item.lastPlayedAt === null) return last;
      return last === null ? item.lastPlayedAt : Math.max(last, item.lastPlayedAt);
    }, null),
    topSongs: [...stats].sort(compareHistoryStats).slice(0, 20),
  };
}

export async function readYearStats(
  db: IDBDatabase,
  year: number,
): Promise<HistorySongStats[]> {
  const tx = db.transaction(HISTORY_STORES.yearStats, 'readonly');
  const all = await requestToPromise(tx.objectStore(HISTORY_STORES.yearStats).getAll()) as YearSongStats[];
  return all
    .filter(item => item.year === year)
    .map(item => ({
      songId: item.songId,
      startCount: item.startCount,
      qualifiedPlayCount: item.qualifiedPlayCount,
      completeCount: item.completeCount,
      manualPlayCount: item.manualPlayCount,
      autoPlayCount: item.autoPlayCount,
      listenedSeconds: item.listenedSeconds,
      firstPlayedAt: item.firstPlayedAt,
      lastPlayedAt: item.lastPlayedAt,
    }));
}

/** Returns the latest known play timestamp for every song without loading song metadata. */
export async function getLastPlayedAtMap(): Promise<Map<number, number>> {
  if (typeof indexedDB === 'undefined') return new Map();
  const db = await ensureStats();
  const stats = await readSongStats(db);
  return new Map(
    stats.flatMap(item => item.lastPlayedAt === null ? [] : [[item.songId, item.lastPlayedAt] as const]),
  );
}

export async function readMonthStats(db: IDBDatabase, month: string): Promise<HistorySongStats[]> {
  const tx = db.transaction(HISTORY_STORES.monthStats, 'readonly');
  const all = await requestToPromise(tx.objectStore(HISTORY_STORES.monthStats).getAll()) as MonthSongStats[];
  return all.filter(item => item.month === month).map(item => ({
    songId: item.songId,
    startCount: item.startCount,
    qualifiedPlayCount: item.qualifiedPlayCount,
    completeCount: item.completeCount,
    manualPlayCount: item.manualPlayCount,
    autoPlayCount: item.autoPlayCount,
    listenedSeconds: item.listenedSeconds,
    firstPlayedAt: item.firstPlayedAt,
    lastPlayedAt: item.lastPlayedAt,
  }));
}

export async function getSongHistoryStats(songId: number): Promise<HistorySongStats> {
  const db = await ensureStats();
  const tx = db.transaction(HISTORY_STORES.songStats, 'readonly');
  const stats = await requestToPromise(tx.objectStore(HISTORY_STORES.songStats).get(songId)) as HistorySongStats | undefined;
  return stats ?? emptyHistorySongStats(songId);
}

export function emptyReportBucket(key: string): ReportBucket {
  return {
    key,
    starts: 0,
    qualifiedPlays: 0,
    listenedSeconds: 0,
    completes: 0,
    uniqueSongs: 0,
    autoStarts: 0,
    autoQualifiedPlays: 0,
    autoListenedSeconds: 0,
    autoCompletes: 0,
  };
}

function addEventToBucket(bucket: ReportBucket, event: ListeningPlayEvent): void {
  const qualified = isQualifiedPlay(event) ? 1 : 0;
  const listened = Math.max(0, Math.round(event.p ?? 0));
  const completed = event.c === 1 ? 1 : 0;
  bucket.starts += 1;
  bucket.qualifiedPlays += qualified;
  bucket.listenedSeconds += listened;
  bucket.completes += completed;
  // Same split as the manual / auto counts of the song statistics: o === 1 is autoplay.
  if (event.o === 1) {
    bucket.autoStarts += 1;
    bucket.autoQualifiedPlays += qualified;
    bucket.autoListenedSeconds += listened;
    bucket.autoCompletes += completed;
  }
}

/**
 * Groups the finalized events of one report period into buckets: days of a month,
 * months of a year ('YYYY-MM') or years of all time ('YYYY'). Only buckets with plays are returned.
 */
export function buildReportBuckets(
  events: readonly ListeningPlayEvent[],
  period: ReportPeriod,
  key: string | number,
  timeZone = DEFAULT_TIME_ZONE,
): ReportBucket[] {
  const normalizedKey = String(key);
  const buckets = new Map<string, ReportBucket>();
  const songsByBucket = new Map<string, Set<number>>();
  for (const event of events) {
    if (!isFinalizedPlayEvent(event)) continue;
    const { year, month } = getYearAndMonth(event.t, timeZone);
    const matches = period === 'all'
      || (period === 'year' ? year === Number(normalizedKey) : month === normalizedKey);
    if (!matches) continue;
    const bucketKey = period === 'all'
      ? String(year)
      : period === 'year' ? getDateKey(event.t, timeZone).slice(0, 7) : getDateKey(event.t, timeZone);
    const bucket = buckets.get(bucketKey) ?? emptyReportBucket(bucketKey);
    addEventToBucket(bucket, event);
    buckets.set(bucketKey, bucket);
    const songs = songsByBucket.get(bucketKey) ?? new Set<number>();
    songs.add(event.s);
    songsByBucket.set(bucketKey, songs);
  }
  for (const [bucketKey, songs] of songsByBucket) {
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.uniqueSongs = songs.size;
  }
  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Words of the CSV exports, and the name used for a song whose details could not be loaded.
 * Both languages have the same columns in the same order and the same value formats;
 * the column names match the metric names on screen (再生回数 / 最後まで聴いた / 再生開始).
 */
const HISTORY_TEXT = {
  ja: {
    unknownSong: (songId: number) => `曲ID ${songId}`,
    yes: 'はい',
    no: 'いいえ',
    manual: '手動',
    auto: '自動',
    overview: '概要',
    trend: '推移',
    topSongs: '上位曲',
    historyHeaders: [
      'イベントID', '再生日時(ISO)', '再生日時(表示)', '曲ID', '曲名', 'アーティスト', '再生方式',
      '再生時間(秒)', '曲の長さ(秒)', '再生率', '再生回数に数える', '最後まで聴いた',
    ],
    reportHeaders: [
      'セクション', '期間', 'キー', '曲ID', '曲名', 'アーティスト', '再生開始', '再生回数', '最後まで聴いた',
      '手動再生', '自動再生', '再生時間(秒)', '最初の再生日時(ISO)', '最後の再生日時(ISO)',
    ],
  },
  en: {
    unknownSong: (songId: number) => `Song ID ${songId}`,
    yes: 'Yes',
    no: 'No',
    manual: 'Manual',
    auto: 'Auto',
    overview: 'Overview',
    trend: 'Trend',
    topSongs: 'Top songs',
    historyHeaders: [
      'Event ID', 'Played at (ISO)', 'Played at', 'Song ID', 'Title', 'Artist', 'Play type',
      'Listening time (sec)', 'Length (sec)', 'Portion played', 'Counts as a play', 'Finished',
    ],
    reportHeaders: [
      'Section', 'Period', 'Key', 'Song ID', 'Title', 'Artist', 'Starts', 'Plays', 'Finished',
      'Manual starts', 'Auto starts', 'Listening time (sec)', 'First played at (ISO)', 'Last played at (ISO)',
    ],
  },
} satisfies Record<AppLanguage, {
  unknownSong: (songId: number) => string;
  yes: string;
  no: string;
  manual: string;
  auto: string;
  overview: string;
  trend: string;
  topSongs: string;
  historyHeaders: string[];
  reportHeaders: string[];
}>;

export async function enrichTopSongs(
  stats: HistorySongStats[],
  loadSongs: typeof getSongsByIds = getSongsByIds,
  language: AppLanguage = 'ja',
): Promise<HistoryReport['topSongsWithMeta']> {
  const songs = await loadSongs(stats.map(stat => stat.songId)).catch(() => []);
  const songsById = new Map(songs.map(song => [song.id, song]));
  return stats.map(stat => {
    const song = songsById.get(stat.songId);
    return song
      ? { ...stat, songName: song.name, artistString: song.artistString, thumbUrl: song.thumbUrl, song }
      : { ...stat, songName: HISTORY_TEXT[language].unknownSong(stat.songId), artistString: '' };
  }).sort(compareHistoryStats);
}

export async function enrichSongMetadata(
  songIds: readonly number[],
  loadSongs: typeof getSongsByIds = getSongsByIds,
  language: AppLanguage = 'ja',
): Promise<Map<number, HistorySongCsvMeta>> {
  const uniqueIds = [...new Set(songIds)];
  const songs = [];
  for (let index = 0; index < uniqueIds.length; index += HISTORY_METADATA_BATCH_SIZE) {
    const chunk = uniqueIds.slice(index, index + HISTORY_METADATA_BATCH_SIZE);
    songs.push(...await loadSongs(chunk).catch(() => []));
  }
  const songsById = new Map(songs.map(song => [song.id, song]));
  const result = new Map<number, HistorySongCsvMeta>();
  for (const songId of uniqueIds) {
    const song = songsById.get(songId);
    result.set(songId, song
      ? { songName: song.name, artistString: song.artistString }
      : { songName: HISTORY_TEXT[language].unknownSong(songId), artistString: '' });
  }
  return result;
}

/**
 * `key` is 'YYYY-MM' for a month, the year for a year and 'all' for all time.
 * `language` only names the top songs whose details could not be loaded.
 */
export async function getHistoryReport(
  period: ReportPeriod,
  key: string | number,
  timeZone = DEFAULT_TIME_ZONE,
  language: AppLanguage = 'ja',
): Promise<HistoryReport> {
  const db = await ensureStats(timeZone);
  const normalizedKey = String(key);
  const stats = period === 'all'
    ? await readSongStats(db)
    : period === 'year'
      ? await readYearStats(db, Number(key))
      : await readMonthStats(db, normalizedKey);
  const overview: HistoryOverview = {
    totalStarts: stats.reduce((sum, item) => sum + item.startCount, 0),
    manualPlayCount: stats.reduce((sum, item) => sum + item.manualPlayCount, 0),
    autoPlayCount: stats.reduce((sum, item) => sum + item.autoPlayCount, 0),
    uniqueSongCount: stats.length,
    totalQualifiedPlays: stats.reduce((sum, item) => sum + item.qualifiedPlayCount, 0),
    totalCompletes: stats.reduce((sum, item) => sum + item.completeCount, 0),
    totalListenedSeconds: stats.reduce((sum, item) => sum + item.listenedSeconds, 0),
    firstPlayedAt: stats.reduce<number | null>((value, item) => item.firstPlayedAt === null ? value : value === null ? item.firstPlayedAt : Math.min(value, item.firstPlayedAt), null),
    lastPlayedAt: stats.reduce<number | null>((value, item) => item.lastPlayedAt === null ? value : value === null ? item.lastPlayedAt : Math.max(value, item.lastPlayedAt), null),
    topSongs: [...stats].sort(compareHistoryStats).slice(0, 20),
  };
  const events = await readAllEvents(db);
  return {
    ...overview,
    period,
    key: normalizedKey,
    topSongsWithMeta: await enrichTopSongs([...stats].sort(compareHistoryStats).slice(0, 20), getSongsByIds, language),
    buckets: buildReportBuckets(events, period, normalizedKey, timeZone),
  };
}

function formatCsvDate(timestamp: number | null, timeZone: string): string {
  if (timestamp === null) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

export function buildHistoryCsv(
  events: readonly ListeningPlayEvent[],
  songs: ReadonlyMap<number, HistorySongCsvMeta> = new Map(),
  timeZone = DEFAULT_TIME_ZONE,
  language: AppLanguage = 'ja',
): string {
  const text = HISTORY_TEXT[language];
  const rows = events
    .filter(isFinalizedPlayEvent)
    .slice()
    .sort((a, b) => a.t - b.t || (a.id ?? 0) - (b.id ?? 0))
    .map(event => {
      const metadata = songs.get(event.s) ?? { songName: text.unknownSong(event.s), artistString: '' };
      const progress = event.d && event.d > 0 && event.p !== undefined
        ? Number((Math.max(0, event.p) / event.d).toFixed(4))
        : '';
      return [
        event.id ?? '',
        new Date(event.t).toISOString(),
        formatCsvDate(event.t, timeZone),
        event.s,
        metadata.songName,
        metadata.artistString,
        event.o === 1 ? text.auto : text.manual,
        event.p === undefined ? '' : Math.max(0, Math.round(event.p)),
        event.d === undefined ? '' : Math.max(0, Math.round(event.d)),
        progress,
        isQualifiedPlay(event) ? text.yes : text.no,
        event.c === 1 ? text.yes : text.no,
      ];
    });
  return serializeCsv(text.historyHeaders, rows);
}

export async function createHistoryCsv(timeZone = DEFAULT_TIME_ZONE, language: AppLanguage = 'ja'): Promise<string> {
  const db = await ensureStats(timeZone);
  const events = await readAllEvents(db);
  const songIds = events.filter(isFinalizedPlayEvent).map(event => event.s);
  const songs = await enrichSongMetadata(songIds, getSongsByIds, language);
  return buildHistoryCsv(events, songs, timeZone, language);
}

export function buildHistoryReportCsv(report: HistoryReport, language: AppLanguage = 'ja'): string {
  const text = HISTORY_TEXT[language];
  const rows: unknown[][] = [[
    text.overview, report.period, report.key, '', '', '',
    report.totalStarts, report.totalQualifiedPlays, report.totalCompletes,
    report.manualPlayCount, report.autoPlayCount, report.totalListenedSeconds,
    report.firstPlayedAt === null ? '' : new Date(report.firstPlayedAt).toISOString(),
    report.lastPlayedAt === null ? '' : new Date(report.lastPlayedAt).toISOString(),
  ]];
  for (const bucket of report.buckets) {
    rows.push([text.trend, report.period, bucket.key, '', '', '', bucket.starts, bucket.qualifiedPlays, '', '', '', bucket.listenedSeconds, '', '']);
  }
  for (const song of report.topSongsWithMeta) {
    rows.push([
      text.topSongs, report.period, report.key, song.songId, song.songName, song.artistString,
      song.startCount, song.qualifiedPlayCount, song.completeCount, song.manualPlayCount,
      song.autoPlayCount, song.listenedSeconds,
      song.firstPlayedAt === null ? '' : new Date(song.firstPlayedAt).toISOString(),
      song.lastPlayedAt === null ? '' : new Date(song.lastPlayedAt).toISOString(),
    ]);
  }
  return serializeCsv(text.reportHeaders, rows);
}
