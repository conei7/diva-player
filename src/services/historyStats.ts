import type { ListeningPlayEvent } from '../stores/historyStore';
import { HISTORY_STORES, openHistoryDb } from './historyDatabase';
import { getSongById } from '../api/vocadb';

const STATS_VERSION = 2;
const DEFAULT_TIME_ZONE = 'Asia/Tokyo';

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

export interface ReportBucket {
  key: string;
  starts: number;
  qualifiedPlays: number;
  listenedSeconds: number;
}

export interface HistoryReport extends HistoryOverview {
  period: 'month' | 'year';
  key: string;
  topSongsWithMeta: Array<HistorySongStats & { songName: string; artistString: string; thumbUrl?: string }>;
  buckets: ReportBucket[];
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

function emptyBucket(key: string): ReportBucket {
  return { key, starts: 0, qualifiedPlays: 0, listenedSeconds: 0 };
}

function addEventToBucket(bucket: ReportBucket, event: ListeningPlayEvent): void {
  bucket.starts += 1;
  bucket.qualifiedPlays += isQualifiedPlay(event) ? 1 : 0;
  bucket.listenedSeconds += Math.max(0, Math.round(event.p ?? 0));
}

async function enrichTopSongs(stats: HistorySongStats[]): Promise<HistoryReport['topSongsWithMeta']> {
  const result: HistoryReport['topSongsWithMeta'] = [];
  const queue = [...stats];
  const worker = async () => {
    while (queue.length > 0) {
      const stat = queue.shift();
      if (!stat) return;
      try {
        const song = await getSongById(stat.songId);
        result.push({ ...stat, songName: song.name, artistString: song.artistString, thumbUrl: song.thumbUrl });
      } catch {
        result.push({ ...stat, songName: `曲ID ${stat.songId}`, artistString: '' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, stats.length) }, () => worker()));
  return result.sort(compareHistoryStats);
}

export async function getHistoryReport(
  period: 'month' | 'year',
  key: string | number,
  timeZone = DEFAULT_TIME_ZONE,
): Promise<HistoryReport> {
  const db = await ensureStats(timeZone);
  const normalizedKey = String(key);
  const stats = period === 'year'
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
  const buckets = new Map<string, ReportBucket>();
  for (const event of events) {
    if (!isFinalizedPlayEvent(event)) continue;
    const { year, month } = getYearAndMonth(event.t, timeZone);
    const matches = period === 'year' ? year === Number(key) : month === normalizedKey;
    if (!matches) continue;
    const bucketKey = period === 'year' ? getDateKey(event.t, timeZone).slice(0, 7) : getDateKey(event.t, timeZone);
    const bucket = buckets.get(bucketKey) ?? emptyBucket(bucketKey);
    addEventToBucket(bucket, event);
    buckets.set(bucketKey, bucket);
  }
  return {
    ...overview,
    period,
    key: normalizedKey,
    topSongsWithMeta: await enrichTopSongs([...stats].sort(compareHistoryStats).slice(0, 20)),
    buckets: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}
