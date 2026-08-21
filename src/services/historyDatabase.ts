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
const HOME_CACHE_BACKUP_KEY = 'home-previous';
export const STARTUP_RECOMMENDATION_CACHE_KEY = 'diva-startup-recommendations';
export const STARTUP_RECOMMENDATION_BACKUP_CACHE_KEY = 'diva-startup-recommendations-backup';
const LOCAL_CACHE_RECONCILIATION_MS = 75;

export interface StartupRecommendationSnapshot {
  version: 1 | 2 | 3;
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
  if ((candidate.version !== 1 && candidate.version !== 2 && candidate.version !== 3)
    || !Number.isFinite(candidate.savedAt)
    || Number(candidate.savedAt) <= 0
    || !Array.isArray(candidate.songs)
    || candidate.songs.length === 0) return null;
  return candidate as StartupRecommendationSnapshot;
}

function newerStartupSnapshot(
  first: StartupRecommendationSnapshot | null,
  second: StartupRecommendationSnapshot | null,
): StartupRecommendationSnapshot | null {
  if (!first) return second;
  if (!second) return first;
  return second.savedAt > first.savedAt ? second : first;
}

function strongerBackupSnapshot(
  first: StartupRecommendationSnapshot | null,
  second: StartupRecommendationSnapshot | null,
): StartupRecommendationSnapshot | null {
  if (!first) return second;
  if (!second) return first;
  if (second.songs.length !== first.songs.length) {
    return second.songs.length > first.songs.length ? second : first;
  }
  return newerStartupSnapshot(first, second);
}

function loadStartupRecommendationSnapshotFromLocalStorage(): StartupRecommendationSnapshot | null {
  if (typeof localStorage === 'undefined') return null;
  let snapshot: StartupRecommendationSnapshot | null = null;
  for (const key of [STARTUP_RECOMMENDATION_CACHE_KEY, STARTUP_RECOMMENDATION_BACKUP_CACHE_KEY]) {
    try {
      snapshot = newerStartupSnapshot(
        snapshot,
        validStartupRecommendationSnapshot(JSON.parse(localStorage.getItem(key) || 'null')),
      );
    } catch {
      // Keep checking the second copy if one record is malformed.
    }
  }
  return snapshot;
}

async function loadStartupRecommendationSnapshotFromDatabase(): Promise<StartupRecommendationSnapshot | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openStartupCacheDb();
  try {
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const transaction = database.transaction(STARTUP_CACHE_STORE, 'readonly');
      const store = transaction.objectStore(STARTUP_CACHE_STORE);
      const requests = [store.get(HOME_CACHE_KEY), store.get(HOME_CACHE_BACKUP_KEY)];
      transaction.oncomplete = () => resolve(requests.map(request => request.result?.snapshot ?? null));
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return values.reduce<StartupRecommendationSnapshot | null>(
      (snapshot, value) => newerStartupSnapshot(snapshot, validStartupRecommendationSnapshot(value)),
      null,
    );
  } finally {
    database.close();
  }
}

export async function loadStartupRecommendationSnapshot(): Promise<StartupRecommendationSnapshot | null> {
  const localSnapshot = loadStartupRecommendationSnapshotFromLocalStorage();
  const databasePromise = loadStartupRecommendationSnapshotFromDatabase().catch(() => null);
  if (!localSnapshot) return databasePromise;

  // localStorage gives the first frame synchronously. Give IndexedDB a short
  // chance to provide a newer/corruption-safe copy without turning startup
  // into an unbounded database wait.
  const databaseSnapshot = await Promise.race([
    databasePromise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), LOCAL_CACHE_RECONCILIATION_MS)),
  ]);
  return newerStartupSnapshot(localSnapshot, databaseSnapshot);
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
  if (typeof localStorage !== 'undefined') {
    try {
      const current = validStartupRecommendationSnapshot(
        JSON.parse(localStorage.getItem(STARTUP_RECOMMENDATION_CACHE_KEY) || 'null'),
      );
      const existingBackup = validStartupRecommendationSnapshot(
        JSON.parse(localStorage.getItem(STARTUP_RECOMMENDATION_BACKUP_CACHE_KEY) || 'null'),
      );
      const resilientBackup = strongerBackupSnapshot(current, existingBackup);
      if (resilientBackup) {
        localStorage.setItem(STARTUP_RECOMMENDATION_BACKUP_CACHE_KEY, JSON.stringify(resilientBackup));
      }
    } catch {
      // A valid IndexedDB backup may still be available.
    }
    try {
      localStorage.setItem(STARTUP_RECOMMENDATION_CACHE_KEY, JSON.stringify(snapshot));
    } catch {
      // IndexedDB is the primary copy when localStorage quota is exhausted.
    }
  }

  if (typeof indexedDB === 'undefined') return;
  const database = await openStartupCacheDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STARTUP_CACHE_STORE, 'readwrite');
      const store = transaction.objectStore(STARTUP_CACHE_STORE);
      const currentRequest = store.get(HOME_CACHE_KEY);
      const backupRequest = store.get(HOME_CACHE_BACKUP_KEY);
      let completedReads = 0;
      const writeSnapshots = () => {
        completedReads += 1;
        if (completedReads < 2) return;
        const current = validStartupRecommendationSnapshot(currentRequest.result?.snapshot);
        const existingBackup = validStartupRecommendationSnapshot(backupRequest.result?.snapshot);
        const resilientBackup = strongerBackupSnapshot(current, existingBackup);
        if (resilientBackup) store.put({ key: HOME_CACHE_BACKUP_KEY, snapshot: resilientBackup });
        store.put({ key: HOME_CACHE_KEY, snapshot });
      };
      currentRequest.onsuccess = writeSnapshots;
      backupRequest.onsuccess = writeSnapshots;
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
