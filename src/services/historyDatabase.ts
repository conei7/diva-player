import type { Song } from '../types/vocadb';

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
export const STARTUP_RECOMMENDATION_CACHE_KEY = 'diva-startup-recommendations';
const STARTUP_RECOMMENDATION_TTL_MS = 12 * 60 * 60 * 1000;

export interface StartupRecommendationSnapshot {
  version: 2;
  savedAt: number;
  songs: Song[];
}

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

function validStartupRecommendationSnapshot(value: unknown): StartupRecommendationSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StartupRecommendationSnapshot>;
  if (candidate.version !== 2
    || !Number.isFinite(candidate.savedAt)
    || Date.now() - Number(candidate.savedAt) > STARTUP_RECOMMENDATION_TTL_MS
    || !Array.isArray(candidate.songs)) return null;
  return candidate as StartupRecommendationSnapshot;
}

async function loadStartupRecommendationSnapshotFromDatabase(): Promise<StartupRecommendationSnapshot | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openStartupCacheDb();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(STARTUP_CACHE_STORE, 'readonly');
      const request = transaction.objectStore(STARTUP_CACHE_STORE).get(HOME_CACHE_KEY);
      request.onsuccess = () => resolve(request.result?.snapshot ?? null);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return validStartupRecommendationSnapshot(value);
  } finally {
    database.close();
  }
}

export async function loadStartupRecommendationSnapshot(): Promise<StartupRecommendationSnapshot | null> {
  let localSnapshot: StartupRecommendationSnapshot | null = null;
  try {
    localSnapshot = validStartupRecommendationSnapshot(
      JSON.parse(localStorage.getItem(STARTUP_RECOMMENDATION_CACHE_KEY) || 'null'),
    );
  } catch {
    // The dedicated IndexedDB cache remains authoritative when storage is full
    // or a previous browser version left malformed local data.
  }

  let databaseSnapshot: StartupRecommendationSnapshot | null = null;
  try {
    databaseSnapshot = await loadStartupRecommendationSnapshotFromDatabase();
  } catch {
    // Private browsing can disable IndexedDB while localStorage still works.
  }
  if (!localSnapshot) return databaseSnapshot;
  if (!databaseSnapshot) return localSnapshot;
  return databaseSnapshot.savedAt > localSnapshot.savedAt ? databaseSnapshot : localSnapshot;
}

export async function loadRecentPlayedAtBySongId(
  songIds: Iterable<number>,
  cutoff: number,
): Promise<Map<number, number>> {
  const candidates = new Set(Array.from(songIds).filter(Number.isInteger));
  const playedAtBySongId = new Map<number, number>();
  if (typeof indexedDB === 'undefined' || candidates.size === 0) return playedAtBySongId;

  const database = await openHistoryDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(HISTORY_STORES.plays, 'readonly');
    const index = transaction.objectStore(HISTORY_STORES.plays).index('playedAt');
    const request = index.openCursor(IDBKeyRange.lowerBound(cutoff), 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || playedAtBySongId.size >= candidates.size) {
        resolve();
        return;
      }
      const songId = Number(cursor.value?.s);
      const playedAt = Number(cursor.value?.t);
      if (candidates.has(songId) && !playedAtBySongId.has(songId) && Number.isFinite(playedAt)) {
        playedAtBySongId.set(songId, playedAt);
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return playedAtBySongId;
}

export async function saveStartupRecommendationSnapshot(snapshot: StartupRecommendationSnapshot): Promise<void> {
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
