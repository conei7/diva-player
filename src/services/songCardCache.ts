import type { Song } from '../types/vocadb';
import { withDefaultSongName } from '../utils/entryNames';
// Song cards of the history, kept on the device so a restart does not wait for the network
// before Home can pick its seeds. A cache only: not part of backups, safe to drop at any time.
const SONG_CARD_DB_NAME = 'diva-song-card-cache';
const SONG_CARD_DB_VERSION = 1;
const SONG_CARD_STORE = 'cards';
const SONG_CARD_LIMIT = 3000;

export interface CachedSongCard {
  song: Song;
  savedAt: number;
}

let songCardDbPromise: Promise<IDBDatabase> | null = null;

function openSongCardDb(): Promise<IDBDatabase> {
  if (songCardDbPromise) return songCardDbPromise;
  songCardDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SONG_CARD_DB_NAME, SONG_CARD_DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(SONG_CARD_STORE, { keyPath: 'id' });
      store.createIndex('savedAt', 'savedAt', { unique: false });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        songCardDbPromise = null;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  }).catch(error => {
    songCardDbPromise = null;
    throw error;
  });
  return songCardDbPromise;
}

export async function loadCachedSongCards(ids: readonly number[]): Promise<Map<number, CachedSongCard>> {
  const cards = new Map<number, CachedSongCard>();
  if (ids.length === 0 || typeof indexedDB === 'undefined') return cards;
  const database = await openSongCardDb();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(SONG_CARD_STORE, 'readonly');
    const store = tx.objectStore(SONG_CARD_STORE);
    for (const id of ids) {
      const request = store.get(id);
      request.onsuccess = () => {
        const value = request.result as { id: number; song?: Song; savedAt?: number } | undefined;
        if (value?.song && value.song.id === id && typeof value.savedAt === 'number') {
          cards.set(id, { song: withDefaultSongName(value.song), savedAt: value.savedAt });
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return cards;
}

export async function saveCachedSongCards(songs: readonly Song[], savedAt = Date.now()): Promise<void> {
  if (songs.length === 0 || typeof indexedDB === 'undefined') return;
  const database = await openSongCardDb();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(SONG_CARD_STORE, 'readwrite');
    const store = tx.objectStore(SONG_CARD_STORE);
    for (const song of songs) store.put({ id: song.id, song, savedAt });
    const count = store.count();
    count.onsuccess = () => {
      let excess = count.result - SONG_CARD_LIMIT;
      if (excess <= 0) return;
      const cursor = store.index('savedAt').openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current || excess <= 0) return;
        current.delete();
        excess--;
        current.continue();
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
