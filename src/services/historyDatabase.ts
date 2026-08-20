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
const STARTUP_CACHE_DB_NAME = 'diva-startup-cache';
const STARTUP_CACHE_DB_VERSION = 1;
const STARTUP_CACHE_STORE = 'recommendations';
const HOME_CACHE_KEY = 'home';

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

/** Returns every song that has ever started playback in this browser. */
export async function getPlayedSongIds(): Promise<Set<number>> {
  if (typeof indexedDB === 'undefined') return new Set();
  const db = await openHistoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORES.plays, 'readonly');
    const index = tx.objectStore(HISTORY_STORES.plays).index('songId');
    // IDBIndex#getAllKeys returns the object-store primary keys (history event
    // ids), not the index keys. A unique key cursor yields the actual song ids
    // without loading every history event into memory.
    const request = index.openKeyCursor(null, 'nextunique');
    const ids = new Set<number>();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(ids);
        return;
      }
      const id = typeof cursor.key === 'number' ? cursor.key : Number(cursor.key);
      if (Number.isInteger(id) && id > 0) ids.add(id);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
  });
}

function openStartupCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STARTUP_CACHE_DB_NAME, STARTUP_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STARTUP_CACHE_STORE)) {
        database.createObjectStore(STARTUP_CACHE_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveStartupRecommendationSnapshot(snapshot: unknown): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const database = await openStartupCacheDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STARTUP_CACHE_STORE, 'readwrite');
    transaction.objectStore(STARTUP_CACHE_STORE).put({ key: HOME_CACHE_KEY, snapshot });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}
