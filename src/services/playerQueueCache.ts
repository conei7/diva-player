import { createStore, get, set, del } from 'idb-keyval';
import type { Song } from '../types/vocadb';

const store = createStore('diva-player-queue-cache', 'snapshots');
let writes: Promise<unknown> = Promise.resolve();

/** Optional cache only: the small localStorage queue remains authoritative. */
export function cachePlayerQueue(songs: Song[]): Promise<void> {
  const next = writes.catch(() => undefined).then(() => set('queue', songs, store));
  writes = next;
  return next;
}

export async function readPlayerQueueCache(ids: number[]): Promise<Song[] | null> {
  const songs = await get<Song[]>('queue', store);
  return Array.isArray(songs) && songs.length === ids.length
    && songs.every((song, index) => song?.id === ids[index]) ? songs : null;
}

export function clearPlayerQueueCache(): Promise<void> {
  const next = writes.catch(() => undefined).then(() => del('queue', store));
  writes = next;
  return next;
}
