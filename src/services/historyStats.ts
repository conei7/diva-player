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
  totalQualifiedPlays: number;
  totalCompletes: number;
  totalListenedSeconds: number;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  topSongs: HistorySongStats[];
}

export interface ReportProducerStats {
  id: number;
  name: string;
  count: number;
}
export interface ReportVocalistStats {
  id: number;
  name: string;
  count: number;
}

export interface HistoryReport {
  period: 'month' | 'year';
  key: string;
  overview: HistoryOverview;
  topSongsWithMeta: Array<HistorySongStats & {
    songName: string;
    artistString: string;
    thumbUrl?: string;
  }>;
  topProducers: ReportProducerStats[];
  topVocalists: ReportVocalistStats[];
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
  month: string; // YYYY-MM
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
  
  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  
  if (y && m) {
    return { year: Number(y), month: `${y}-${m}` };
  }
  const fallback = new Date(timestamp);
  return {
    year: fallback.getUTCFullYear(),
    month: `${fallback.getUTCFullYear()}-${String(fallback.getUTCMonth() + 1).padStart(2, '0')}`,
  };
}

export function isFinalizedPlayEvent(event: ListeningPlayEvent): boolean {
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
    applyHistoryEventToStats(song, event);
    songStats.set(event.s, song);

    const { year, month } = getYearAndMonth(event.t, timeZone);
    const yKey = `${year}:${event.s}`;
    const yearly = yearStats.get(yKey) ?? { ...emptyHistorySongStats(event.s), key: yKey, year };
    applyHistoryEventToStats(yearly, event);
    yearStats.set(yKey, yearly);

    const mKey = `${month}:${event.s}`;
    const monthly = monthStats.get(mKey) ?? { ...emptyHistorySongStats(event.s), key: mKey, month };
    applyHistoryEventToStats(monthly, event);
    monthStats.set(mKey, monthly);
  }

  const tx = db.transaction(
    [HISTORY_STORES.songStats, HISTORY_STORES.yearStats, HISTORY_STORES.monthStats, HISTORY_STORES.pending, HISTORY_STORES.applied, HISTORY_STORES.meta],
    'readwrite',
  );
  tx.objectStore(HISTORY_STORES.pending).clear();
  tx.objectStore(HISTORY_STORES.applied).clear();
  
  const songsStore = tx.objectStore(HISTORY_STORES.songStats);
  const yearsStore = tx.objectStore(HISTORY_STORES.yearStats);
  const monthsStore = tx.objectStore(HISTORY_STORES.monthStats);
  
  songsStore.clear();
  yearsStore.clear();
  monthsStore.clear();
  
  for (const stats of songStats.values()) songsStore.put(stats);
  for (const stats of yearStats.values()) yearsStore.put(stats);
  for (const stats of monthStats.values()) monthsStore.put(stats);
  
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
  
  const yKey = `${year}:${event.s}`;
  const existingYear = await readYearStat(db, yKey);
  
  const mKey = `${month}:${event.s}`;
  const existingMonth = await readMonthStat(db, mKey);

  const tx = db.transaction(
    [HISTORY_STORES.songStats, HISTORY_STORES.yearStats, HISTORY_STORES.monthStats, HISTORY_STORES.pending, HISTORY_STORES.applied],
    'readwrite',
  );
  
  const songStore = tx.objectStore(HISTORY_STORES.songStats);
  const song = existingSong ?? emptyHistorySongStats(event.s);
  applyHistoryEventToStats(song, event);
  songStore.put(song);

  const yearStore = tx.objectStore(HISTORY_STORES.yearStats);
  const yearly = existingYear ?? { ...emptyHistorySongStats(event.s), key: yKey, year };
  applyHistoryEventToStats(yearly, event);
  yearStore.put(yearly);
  
  const monthStore = tx.objectStore(HISTORY_STORES.monthStats);
  const monthly = existingMonth ?? { ...emptyHistorySongStats(event.s), key: mKey, month };
  applyHistoryEventToStats(monthly, event);
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

export async function readMonthStats(
  db: IDBDatabase,
  month: string, // YYYY-MM
): Promise<HistorySongStats[]> {
  const tx = db.transaction(HISTORY_STORES.monthStats, 'readonly');
  const all = await requestToPromise(tx.objectStore(HISTORY_STORES.monthStats).getAll()) as MonthSongStats[];
  return all
    .filter(item => item.month === month)
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

export async function getSongHistoryStats(songId: number): Promise<HistorySongStats> {
  const db = await ensureStats();
  const tx = db.transaction(HISTORY_STORES.songStats, 'readonly');
  const stats = await requestToPromise(tx.objectStore(HISTORY_STORES.songStats).get(songId)) as HistorySongStats | undefined;
  return stats ?? emptyHistorySongStats(songId);
}

// レポート生成機能
export async function getHistoryReport(
  { period, key }: { period: 'month' | 'year', key: string | number },
  timeZone = DEFAULT_TIME_ZONE
): Promise<HistoryReport> {
  const db = await ensureStats(timeZone);
  let stats: HistorySongStats[];
  
  if (period === 'year') {
    stats = await readYearStats(db, Number(key));
  } else {
    stats = await readMonthStats(db, String(key));
  }
  
  const overview: HistoryOverview = {
    totalStarts: stats.reduce((sum, item) => sum + item.startCount, 0),
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
    topSongs: [], // Will populate enriched below
  };
  
  const top100 = [...stats].sort(compareHistoryStats).slice(0, 100);
  
  const topSongsWithMeta: HistoryReport['topSongsWithMeta'] = [];
  const producerCounts = new Map<number, { count: number; name: string }>();
  const vocalistCounts = new Map<number, { count: number; name: string }>();

  // 並列フェッチ (同時実行数を制限するとより安全だが今回はPromise.all)
  await Promise.all(
    top100.map(async (stat) => {
      try {
        const songData = await getSongById(stat.songId);
        
        topSongsWithMeta.push({
          ...stat,
          songName: songData.name,
          artistString: songData.artistString,
          thumbUrl: songData.thumbUrl,
        });

        for (const artist of songData.artists || []) {
          if (artist.categories.includes('Producer')) {
            const p = producerCounts.get(artist.artist.id) ?? { count: 0, name: artist.artist.name };
            p.count += stat.qualifiedPlayCount;
            producerCounts.set(artist.artist.id, p);
          }
          if (artist.categories.includes('Vocalist')) {
            const v = vocalistCounts.get(artist.artist.id) ?? { count: 0, name: artist.artist.name };
            v.count += stat.qualifiedPlayCount;
            vocalistCounts.set(artist.artist.id, v);
          }
        }
      } catch {
        topSongsWithMeta.push({
          ...stat,
          songName: `Unknown (${stat.songId})`,
          artistString: '',
        });
      }
    })
  );

  topSongsWithMeta.sort(compareHistoryStats);
  overview.topSongs = topSongsWithMeta.slice(0, 20);

  const topProducers = Array.from(producerCounts.values())
    .sort((a, b) => b.count - a.count)
    .map(v => ({ id: 0 /* not needed strictly but interface requires */, name: v.name, count: v.count }))
    .slice(0, 10);
    
  // Fixed ID assignment
  for (const p of topProducers) {
    for (const [key, val] of producerCounts.entries()) {
      if (val.name === p.name) p.id = key;
    }
  }

  const topVocalists = Array.from(vocalistCounts.entries())
    .map(([id, val]) => ({ id, name: val.name, count: val.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    period,
    key: String(key),
    overview,
    topSongsWithMeta,
    topProducers,
    topVocalists,
  };
}
