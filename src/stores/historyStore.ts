import { create } from 'zustand';
import { get as idbGet, del as idbDel } from 'idb-keyval';
import { getSongById } from '../api/vocadb';
import type { Song } from '../types/vocadb';
import { HISTORY_STORES, openHistoryDb } from '../services/historyDatabase';

const PLAY_STORE = HISTORY_STORES.plays;
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
  f?: 0 | 1; // finalized and eligible for statistics
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
  activePlayEventId?: number;
  activeSongId?: number;
  activePlayedAt?: number;
  activePlaybackSequence?: number;
  initializeHistory: () => Promise<void>;
  addToHistory: (song: Song, source?: 'manual' | 'auto', playbackSequence?: number) => void;
  finalizeHistoryEntry: (songId: number, progressSeconds: number, durationSeconds: number, playbackSequence?: number) => void;
  clearHistory: () => Promise<void>;
  setHasHydrated: (hasHydrated: boolean) => void;
}

let initializePromise: Promise<void> | null = null;
const pendingFinalizations = new Map<number, { progressSeconds: number; durationSeconds: number }>();

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function appendPlayEvent(event: ListeningPlayEvent): Promise<number | undefined> {
  const db = await openHistoryDb();
  return new Promise<number | undefined>((resolve, reject) => {
    const tx = db.transaction([PLAY_STORE, HISTORY_STORES.pending], 'readwrite');
    const request = tx.objectStore(PLAY_STORE).add(event);
    let generatedId: number | undefined;
    request.onsuccess = () => {
      generatedId = typeof request.result === 'number' ? request.result : Number(request.result);
    };
    tx.oncomplete = () => resolve(generatedId);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function buildPlayEventDetails(progressSeconds: number, durationSeconds: number): Pick<ListeningPlayEvent, 'p' | 'd' | 'c'> {
  const duration = Math.max(0, Math.round(Number.isFinite(durationSeconds) ? durationSeconds : 0));
  const rawProgress = Math.max(0, Math.round(Number.isFinite(progressSeconds) ? progressSeconds : 0));
  const progress = duration > 0 ? Math.min(rawProgress, duration) : rawProgress;

  return {
    p: progress,
    d: duration,
    c: duration > 0 && progress / duration >= 0.7 ? 1 : 0,
  };
}

async function updatePlayEventDetails(
  eventId: number,
  progressSeconds: number,
  durationSeconds: number,
): Promise<void> {
  const db = await openHistoryDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([PLAY_STORE, HISTORY_STORES.pending], 'readwrite');
    const store = tx.objectStore(PLAY_STORE);
    const request = store.get(eventId);

    request.onsuccess = () => {
      const event = request.result as ListeningPlayEvent | undefined;
      if (!event) return;
      store.put({
        ...event,
        ...buildPlayEventDetails(progressSeconds, durationSeconds),
        f: 1,
      });
      tx.objectStore(HISTORY_STORES.pending).put({ eventId });
    };

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
    for (const storeName of Object.values(HISTORY_STORES)) {
      tx.objectStore(storeName).clear();
    }
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
      f: 1 as const,
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
  activePlayEventId: undefined,
  activeSongId: undefined,
  activePlayedAt: undefined,
  activePlaybackSequence: undefined,

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

  addToHistory: (song, source = 'manual', playbackSequence) => {
    const playedAt = Date.now();
    const { entries, totalPlays, activePlaybackSequence } = get();
    if (playbackSequence !== undefined && activePlaybackSequence === playbackSequence) return;
    const recentEntry = entries[0];
    const isDuplicate = playbackSequence === undefined
      && recentEntry?.song.id === song.id
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
      f: 0,
    };

    void appendPlayEvent(event)
      .then(eventId => {
        if (!eventId) return;
        const state = get();
        if (state.activeSongId === song.id && state.activePlayedAt === playedAt) {
          set({ activePlayEventId: eventId });
        }

        const pending = pendingFinalizations.get(playedAt);
        if (pending) {
          pendingFinalizations.delete(playedAt);
          void updatePlayEventDetails(eventId, pending.progressSeconds, pending.durationSeconds).catch(error => {
            console.error('[History] Failed to finalize delayed play event', error);
          });
        }
      })
      .catch(error => {
        console.error('[History] Failed to append play event', error);
      });

    set({
      entries: [newEntry, ...entries].slice(0, RECENT_ENTRY_LIMIT),
      totalPlays: totalPlays + 1,
      activePlayEventId: undefined,
      activeSongId: song.id,
      activePlayedAt: playedAt,
      activePlaybackSequence: playbackSequence,
    });
  },

  finalizeHistoryEntry: (songId, progressSeconds, durationSeconds, playbackSequence) => {
    const { activePlayEventId, activeSongId, activePlayedAt, activePlaybackSequence } = get();
    if (activeSongId !== songId || !activePlayedAt) return;
    if (playbackSequence !== undefined && activePlaybackSequence !== playbackSequence) return;

    if (!activePlayEventId) {
      pendingFinalizations.set(activePlayedAt, { progressSeconds, durationSeconds });
      return;
    }

    void updatePlayEventDetails(activePlayEventId, progressSeconds, durationSeconds).catch(error => {
      console.error('[History] Failed to finalize play event', error);
    });
  },

  clearHistory: async () => {
    await clearPlayEvents();
    pendingFinalizations.clear();
    set({
      entries: [],
      totalPlays: 0,
      activePlayEventId: undefined,
      activeSongId: undefined,
      activePlayedAt: undefined,
      activePlaybackSequence: undefined,
    });
  },

  setHasHydrated: (hasHydrated) => set({ hasHydrated }),
}));

void useHistoryStore.getState().initializeHistory();
