import { create } from 'zustand';
import { get as idbGet, del as idbDel } from 'idb-keyval';
import { getSongById } from '../api/vocadb';
import type { Song } from '../types/vocadb';

const DB_NAME = 'diva-listening-history';
const DB_VERSION = 1;
const PLAY_STORE = 'plays';
const LEGACY_HISTORY_KEY = 'diva-history';
const LEGACY_MIGRATED_KEY = 'diva-history-log-migrated-v1';
const RECENT_ENTRY_LIMIT = 300;
const DUPLICATE_PLAY_WINDOW_MS = 2000;

export interface HistoryEntry {
  song: Song;
  playedAt: number;
}

export interface ListeningPlayEvent {
  id?: number;
  s: number; // songId
  t: number; // playedAt ms
  o?: 0 | 1; // 0=manual, 1=auto
  p?: number; // listened seconds
  d?: number; // duration seconds
  c?: 0 | 1; // completed-ish
}

interface LegacyHistoryEntry {
  song?: Song;
  playedAt?: number;
}

interface LegacyPersistedHistory {
  state?: {
    entries?: LegacyHistoryEntry[];
  };
}

interface HistoryState {
  entries: HistoryEntry[];
  totalPlays: number;
  hasHydrated: boolean;
  initializeHistory: () => Promise<void>;
  addToHistory: (song: Song, source?: 'manual' | 'auto') => void;
  clearHistory: () => Promise<void>;
  setHasHydrated: (hasHydrated: boolean) => void;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let initializePromise: Promise<void> | null = null;

function openHistoryDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PLAY_STORE)) {
        const store = db.createObjectStore(PLAY_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('songId', 's', { unique: false });
        store.createIndex('playedAt', 't', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function appendPlayEvent(event: ListeningPlayEvent): Promise<void> {
  const db = await openHistoryDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PLAY_STORE, 'readwrite');
    tx.objectStore(PLAY_STORE).add(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function appendPlayEvents(events: ListeningPlayEvent[]): Promise<void> {
  if (events.length === 0) return;
  const db = await openHistoryDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PLAY_STORE, 'readwrite');
    const store = tx.objectStore(PLAY_STORE);
    for (const event of events) store.add(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function countPlayEvents(): Promise<number> {
  const db = await openHistoryDb();
  const tx = db.transaction(PLAY_STORE, 'readonly');
  return requestToPromise(tx.objectStore(PLAY_STORE).count());
}

async function readRecentPlayEvents(limit: number): Promise<ListeningPlayEvent[]> {
  const db = await openHistoryDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLAY_STORE, 'readonly');
    const store = tx.objectStore(PLAY_STORE);
    const request = store.openCursor(null, 'prev');
    const events: ListeningPlayEvent[] = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || events.length >= limit) {
        resolve(events);
        return;
      }

      events.push(cursor.value as ListeningPlayEvent);
      cursor.continue();
    };

    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function clearPlayEvents(): Promise<void> {
  const db = await openHistoryDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PLAY_STORE, 'readwrite');
    tx.objectStore(PLAY_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function loadEntriesFromEvents(events: ListeningPlayEvent[]): Promise<HistoryEntry[]> {
  const songIds = [...new Set(events.map(event => event.s))];
  const songPairs = await Promise.all(
    songIds.map(async id => {
      try {
        return [id, await getSongById(id)] as const;
      } catch {
        return [id, null] as const;
      }
    }),
  );
  const songMap = new Map(songPairs);

  return events.flatMap(event => {
    const song = songMap.get(event.s);
    return song ? [{ song, playedAt: event.t }] : [];
  });
}

function parseLegacyEntries(raw: string | null): LegacyHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as LegacyPersistedHistory;
    return parsed.state?.entries?.filter(entry => entry.song?.id && entry.playedAt) ?? [];
  } catch {
    return [];
  }
}

async function migrateLegacyHistory(): Promise<void> {
  if (localStorage.getItem(LEGACY_MIGRATED_KEY) === '1') return;

  const localEntries = parseLegacyEntries(localStorage.getItem(LEGACY_HISTORY_KEY));
  const idbEntries = parseLegacyEntries((await idbGet<string>(LEGACY_HISTORY_KEY)) ?? null);
  const legacyEntries = localEntries.length > 0 ? localEntries : idbEntries;

  const events = legacyEntries
    .filter(entry => entry.song?.id && entry.playedAt)
    .map(entry => ({
      s: entry.song!.id,
      t: entry.playedAt!,
      o: 0 as const,
    }));

  await appendPlayEvents(events);
  localStorage.removeItem(LEGACY_HISTORY_KEY);
  await idbDel(LEGACY_HISTORY_KEY);
  localStorage.setItem(LEGACY_MIGRATED_KEY, '1');
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  entries: [],
  totalPlays: 0,
  hasHydrated: false,

  initializeHistory: async () => {
    if (initializePromise) return initializePromise;

    initializePromise = (async () => {
      await migrateLegacyHistory();
      const events = await readRecentPlayEvents(RECENT_ENTRY_LIMIT);
      const entries = await loadEntriesFromEvents(events);
      const totalPlays = await countPlayEvents();
      set({ entries, totalPlays, hasHydrated: true });
    })().catch(error => {
      console.error('[History] Failed to initialize listening history', error);
      set({ hasHydrated: true });
    });

    return initializePromise;
  },

  addToHistory: (song, source = 'manual') => {
    const playedAt = Date.now();
    const { entries, totalPlays } = get();
    const recentEntry = entries[0];
    const isDuplicate = recentEntry?.song.id === song.id
      && playedAt - recentEntry.playedAt < DUPLICATE_PLAY_WINDOW_MS;
    const newEntry: HistoryEntry = { song, playedAt };

    if (isDuplicate) {
      set({ entries: [newEntry, ...entries.slice(1)] });
      return;
    }

    const event: ListeningPlayEvent = {
      s: song.id,
      t: playedAt,
      o: source === 'auto' ? 1 : 0,
    };

    void appendPlayEvent(event).catch(error => {
      console.error('[History] Failed to append play event', error);
    });

    const updated = entries[0]?.song.id === song.id
      ? [newEntry, ...entries.slice(1)]
      : [newEntry, ...entries];

    set({
      entries: updated.slice(0, RECENT_ENTRY_LIMIT),
      totalPlays: totalPlays + 1,
    });
  },

  clearHistory: async () => {
    await clearPlayEvents();
    set({ entries: [], totalPlays: 0 });
  },

  setHasHydrated: (hasHydrated) => set({ hasHydrated }),
}));

void useHistoryStore.getState().initializeHistory();
