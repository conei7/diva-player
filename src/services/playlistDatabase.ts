import type { Playlist, PlaylistFolder } from '../types/vocadb';
import { createStableId } from '../utils/id';

export const PLAYLIST_DB_NAME = 'diva-playlists';
export const PLAYLIST_REVISION_KEY = 'diva_playlistRevision';
export interface PlaylistSnapshot { playlists: Playlist[]; folders: PlaylistFolder[] }
interface Metadata { revision: string; folders: PlaylistFolder[]; ids: string[] }
let connection: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PLAYLIST_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('playlists', { keyPath: 'id' });
      request.result.createObjectStore('meta');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Playlist database upgrade blocked'));
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = undefined; };
      resolve(request.result);
    };
  }).catch(error => { connection = undefined; throw error; });
  return connection;
}

function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Playlist transaction aborted'));
    tx.onerror = () => { /* onabort settles the transaction, including quota failures. */ };
  });
}

export async function readPlaylistSnapshot(knownRevision?: string): Promise<{ revision: string; snapshot?: PlaylistSnapshot } | null> {
  const db = await open();
  const tx = db.transaction(['playlists', 'meta'], 'readonly');
  const done = completed(tx);
  let result: { revision: string; snapshot?: PlaylistSnapshot } | null = null;
  const meta = tx.objectStore('meta').get('current');
  meta.onsuccess = () => {
    const value = meta.result as Metadata | undefined;
    if (!value) return;
    result = { revision: value.revision };
    if (value.revision === knownRevision) return;
    const all = tx.objectStore('playlists').getAll();
    all.onsuccess = () => {
      const byId = new Map((all.result as Playlist[]).map(item => [item.id, item]));
      const playlists = value.ids.map(id => byId.get(id));
      if (playlists.some(item => !item)) { tx.abort(); return; }
      result = { revision: value.revision, snapshot: { playlists: playlists as Playlist[], folders: value.folders } };
    };
  };
  await done;
  return result;
}

/** One atomic transaction; unchanged lists are not cloned or rewritten. CAS also protects browsers without Web Locks. */
export async function writePlaylistSnapshot(
  snapshot: PlaylistSnapshot, previous: PlaylistSnapshot, expectedRevision: string | null,
  legacy?: { playlists: string | null; folders: string | null },
): Promise<string> {
  const db = await open();
  const tx = db.transaction(['playlists', 'meta'], 'readwrite');
  const done = completed(tx);
  const revision = createStableId('revision');
  const meta = tx.objectStore('meta');
  const read = meta.get('current');
  read.onsuccess = () => {
    try {
      if (((read.result as Metadata | undefined)?.revision ?? null) !== expectedRevision) { tx.abort(); return; }
      const store = tx.objectStore('playlists');
      const before = new Map(previous.playlists.map(item => [item.id, item]));
      const ids = new Set(snapshot.playlists.map(item => item.id));
      for (const item of snapshot.playlists) if (before.get(item.id) !== item) store.put(item);
      for (const id of before.keys()) if (!ids.has(id)) store.delete(id);
      if (legacy) meta.put(legacy, 'legacy-localStorage');
      meta.put({ revision, folders: snapshot.folders, ids: [...ids] } satisfies Metadata, 'current');
    } catch { tx.abort(); }
  };
  await done;
  return revision;
}

export function withPlaylistLock<T>(task: () => Promise<T>): Promise<T> {
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request('diva-playlist-write', task) : task();
}

export function notifyPlaylistWrite(revision: string): void {
  try { localStorage.setItem(PLAYLIST_REVISION_KEY, revision); } catch { /* IDB is already committed. */ }
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('diva-playlists');
      channel.postMessage(revision);
      channel.close();
    }
  } catch { /* Notification failure must never turn a committed save into a reported failure. */ }
}
