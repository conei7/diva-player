import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { Playlist, Song } from '../types/vocadb';

let values: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  values = new Map();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(id = 'large'): Playlist {
  return { id, name: 'Saved library', songs: [{ id: 7, name: 'song' } as Song], createdAt: 1, updatedAt: 1 };
}

describe('durable playlist migration and writes', () => {
  it('archives exact legacy bytes before freeing localStorage and survives a module reload', async () => {
    const raw = JSON.stringify([fixture()]);
    values.set('diva_playlists', raw);
    const { usePlaylistStore: store } = await import('../stores/playlistStore');
    await store.getState().loadPlaylists();
    expect(store.getState().playlists.find(item => item.id === 'large')?.songs[0].id).toBe(7);
    expect(values.has('diva_playlists')).toBe(false);
    const database = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('diva-playlists'); request.onsuccess = () => resolve(request.result);
    });
    const archived = await new Promise<{ playlists: string }>(resolve => {
      const request = database.transaction('meta').objectStore('meta').get('legacy-localStorage');
      request.onsuccess = () => resolve(request.result);
    });
    expect(archived.playlists).toBe(raw);
    database.close();
    vi.resetModules();
    const { usePlaylistStore: second } = await import('../stores/playlistStore');
    await second.getState().loadPlaylists();
    expect(second.getState().playlists.map(item => item.id)).toEqual(['watch-later', 'large']);
  });

  it('rejects migration failure without deleting or publishing the old data', async () => {
    const raw = JSON.stringify([fixture()]); values.set('diva_playlists', raw);
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'playlists') throw new DOMException('quota', 'QuotaExceededError');
      return original.apply(this, args as Parameters<typeof original>);
    });
    const { usePlaylistStore: store } = await import('../stores/playlistStore');
    await expect(store.getState().loadPlaylists()).rejects.toThrow();
    expect(values.get('diva_playlists')).toBe(raw);
    expect(store.getState().playlists).toEqual([]);
  });

  it('saves more than localStorage capacity and rewrites only the changed list', async () => {
    const { usePlaylistStore: store } = await import('../stores/playlistStore');
    await store.getState().loadPlaylists();
    const large = fixture();
    large.songs = Array.from({ length: 12000 }, (_, id) => ({ id: id + 1, name: 'song'.repeat(150) } as Song));
    await store.getState().replaceLibrary([large, fixture('other')], []);
    expect(JSON.stringify(large).length).toBeGreaterThan(5 * 1024 * 1024);
    const puts = vi.spyOn(IDBObjectStore.prototype, 'put');
    const before = store.getState().playlists;
    await store.getState().updatePlaylist('other', { name: 'renamed' });
    const listPuts = puts.mock.calls.filter((_, index) => (puts.mock.contexts[index] as IDBObjectStore)?.name === 'playlists');
    expect(listPuts).toHaveLength(1);
    expect(store.getState().playlists[0]).toBe(before[0]);
    const after = store.getState().playlists;
    await store.getState().loadPlaylists();
    expect(store.getState().playlists).toBe(after);
    expect(values.has('diva_playlists')).toBe(false);
  });

  it('does not publish a failed atomic edit and recovers for the next operation', async () => {
    const { usePlaylistStore: store } = await import('../stores/playlistStore');
    await store.getState().loadPlaylists();
    const playlist = await store.getState().createPlaylist('before');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new Error('write failed'); });
    await expect(store.getState().updatePlaylist(playlist.id, { name: 'failed' })).rejects.toThrow();
    expect(store.getState().playlists.find(item => item.id === playlist.id)?.name).toBe('before');
    put.mockRestore();
    await store.getState().updatePlaylist(playlist.id, { name: 'after' });
    const db = await import('./playlistDatabase');
    expect((await db.readPlaylistSnapshot())?.snapshot?.playlists.find(item => item.id === playlist.id)?.name).toBe('after');
  });

  it('serializes rapid local edits and reads a second tab’s committed data before editing', async () => {
    const { usePlaylistStore: first } = await import('../stores/playlistStore');
    await first.getState().loadPlaylists();
    await Promise.all([first.getState().createPlaylist('A'), first.getState().createPlaylist('B')]);
    vi.resetModules();
    const { usePlaylistStore: second } = await import('../stores/playlistStore');
    await second.getState().loadPlaylists();
    await second.getState().createPlaylist('C');
    await first.getState().createPlaylist('D');
    expect(first.getState().playlists.map(item => item.name)).toEqual(expect.arrayContaining(['A', 'B', 'C', 'D']));
  });

  it('rejects a stale writer instead of overwriting another tab without Web Locks', async () => {
    const db = await import('./playlistDatabase');
    const snapshot = { playlists: [fixture()], folders: [] };
    const revision = await db.writePlaylistSnapshot(snapshot, { playlists: [], folders: [] }, null);
    const next = { ...snapshot, playlists: [{ ...fixture(), name: 'latest' }] };
    await db.writePlaylistSnapshot(next, snapshot, revision);
    await expect(db.writePlaylistSnapshot(snapshot, snapshot, revision)).rejects.toThrow();
    expect((await db.readPlaylistSnapshot())?.snapshot?.playlists[0].name).toBe('latest');
  });
});
