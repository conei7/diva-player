export const HISTORY_DB_NAME = 'diva-listening-history';
export const HISTORY_DB_VERSION = 3;

export const HISTORY_STORES = {
  plays: 'plays',
  pending: 'stats_pending',
  applied: 'stats_applied',
  songStats: 'song_stats',
  yearStats: 'year_stats',
  monthStats: 'month_stats',
  meta: 'stats_meta',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openHistoryDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      const plays = db.objectStoreNames.contains(HISTORY_STORES.plays)
        ? request.transaction!.objectStore(HISTORY_STORES.plays)
        : db.createObjectStore(HISTORY_STORES.plays, { keyPath: 'id', autoIncrement: true });

      if (!plays.indexNames.contains('songId')) {
        plays.createIndex('songId', 's', { unique: false });
      }
      if (!plays.indexNames.contains('playedAt')) {
        plays.createIndex('playedAt', 't', { unique: false });
      }

      if (!db.objectStoreNames.contains(HISTORY_STORES.pending)) {
        db.createObjectStore(HISTORY_STORES.pending, { keyPath: 'eventId' });
      }
      if (!db.objectStoreNames.contains(HISTORY_STORES.applied)) {
        db.createObjectStore(HISTORY_STORES.applied, { keyPath: 'eventId' });
      }
      if (!db.objectStoreNames.contains(HISTORY_STORES.songStats)) {
        db.createObjectStore(HISTORY_STORES.songStats, { keyPath: 'songId' });
      }
      if (!db.objectStoreNames.contains(HISTORY_STORES.yearStats)) {
        db.createObjectStore(HISTORY_STORES.yearStats, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(HISTORY_STORES.monthStats)) {
        db.createObjectStore(HISTORY_STORES.monthStats, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(HISTORY_STORES.meta)) {
        db.createObjectStore(HISTORY_STORES.meta, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}
