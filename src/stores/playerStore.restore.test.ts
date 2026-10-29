import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Song } from '../types/vocadb';

const getSongById = vi.hoisted(() => vi.fn());
const getSongsByIds = vi.hoisted(() => vi.fn());

vi.mock('../api/vocadb', () => ({ getSongById, getSongsByIds }));

const song: Song = {
  id: 910001,
  name: 'Persisted queue fixture',
  artistString: 'Fixture producer',
  createDate: '2026-01-01T00:00:00Z',
  defaultName: 'Persisted queue fixture',
  defaultNameLanguage: 'English',
  favoritedTimes: 0,
  lengthSeconds: 30,
  pvs: [{
    author: '',
    disabled: false,
    id: 9100011,
    length: 30,
    name: 'fixture',
    pvId: 'fixture',
    service: 'Youtube',
    pvType: 'Original',
    url: 'https://youtu.be/fixture',
  }],
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
};

const rootSeed: Song = {
  ...song,
  id: song.id + 1,
  name: 'Deferred root seed',
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function installLocalStorage(storedQueue: unknown): void {
  const values = new Map<string, string>([
    ['diva_playerQueue', JSON.stringify(storedQueue)],
  ]);
  vi.stubGlobal('localStorage', {
    get length() { return values.size; },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
  });
}

async function resolveAndFlush<T>(pending: ReturnType<typeof deferred<T>>, value: T): Promise<void> {
  pending.resolve(value);
  await pending.promise;
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

describe('player queue startup restoration', () => {
  it('does not resurrect a closed legacy queue after root-seed resolution', async () => {
    const pendingRootSeed = deferred<Song>();
    getSongById.mockReturnValueOnce(pendingRootSeed.promise);
    installLocalStorage({
      queue: [song],
      queueIndex: 0,
      currentSong: song,
      currentSongId: song.id,
      queueSources: ['manual'],
      currentPlaybackSource: 'manual',
      rootSeedId: rootSeed.id,
    });

    const { usePlayerStore } = await import('./playerStore');
    await vi.waitFor(() => expect(getSongById).toHaveBeenCalledWith(rootSeed.id));

    usePlayerStore.getState().closePlayer();
    await resolveAndFlush(pendingRootSeed, rootSeed);

    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(usePlayerStore.getState().currentSong).toBeNull();
    expect(usePlayerStore.getState().rootSeed).toBeNull();
    expect(localStorage.getItem('diva_playerQueue')).toBeNull();
  });

  it('does not overwrite a closed compact queue after its final restore await', async () => {
    const pendingRootSeed = deferred<Song>();
    getSongById.mockImplementation((id: number) => (
      id === song.id ? Promise.resolve(song) : pendingRootSeed.promise
    ));
    installLocalStorage({
      songIds: [song.id],
      queueIndex: 0,
      currentSongId: song.id,
      queueSources: ['manual'],
      currentPlaybackSource: 'manual',
      rootSeedId: rootSeed.id,
    });

    const { usePlayerStore } = await import('./playerStore');
    await vi.waitFor(() => expect(getSongById).toHaveBeenCalledWith(rootSeed.id));

    usePlayerStore.getState().closePlayer();
    await resolveAndFlush(pendingRootSeed, rootSeed);

    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(usePlayerStore.getState().currentSong).toBeNull();
    expect(usePlayerStore.getState().rootSeed).toBeNull();
    expect(localStorage.getItem('diva_playerQueue')).toBeNull();
  });

  it('does not clear a replacement queue after a stale compact restore fails', async () => {
    const pendingSong = deferred<Song>();
    getSongById.mockReturnValueOnce(pendingSong.promise);
    installLocalStorage({
      songIds: [song.id],
      queueIndex: 0,
      currentSongId: song.id,
      queueSources: ['manual'],
      currentPlaybackSource: 'manual',
    });

    const { usePlayerStore } = await import('./playerStore');
    await vi.waitFor(() => expect(getSongById).toHaveBeenCalledWith(song.id));

    const replacement = { ...song, id: song.id + 10, name: 'Replacement queue fixture' };
    usePlayerStore.getState().setQueue([replacement], 0, false);
    pendingSong.reject(new Error('Deferred restore failed'));
    await pendingSong.promise.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(usePlayerStore.getState().queue.map(item => item.id)).toEqual([replacement.id]);
    expect(usePlayerStore.getState().currentSong?.id).toBe(replacement.id);
    const stored = JSON.parse(localStorage.getItem('diva_playerQueue') ?? '{}') as { songIds?: number[] };
    expect(stored.songIds).toEqual([replacement.id]);
  });
});


describe('large queue restoration', () => {
  it('allows nearby navigation before the last page, retaining all IDs and the latest duplicate index', async () => {
    const songs = Array.from({ length: 990 }, (_, index) => ({ ...song, id: song.id + index }));
    songs[501] = songs[500];
    const byId = new Map(songs.map(item => [item.id, item]));
    const later = deferred<Song[]>();
    getSongById.mockImplementation(async (id: number) => byId.get(id));
    getSongsByIds.mockImplementationOnce(async (ids: number[]) => ids.map(id => byId.get(id)))
      .mockImplementationOnce(() => later.promise)
      .mockImplementation(async (ids: number[]) => ids.map(id => byId.get(id)));
    installLocalStorage({ songIds: songs.map(item => item.id), queueIndex: 500,
      currentSongId: songs[500].id, rootSeed: songs[0], rootSeedId: songs[0].id });
    const { usePlayerStore } = await import('./playerStore');
    await vi.waitFor(() => expect(getSongsByIds).toHaveBeenCalledTimes(2));
    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(usePlayerStore.getState().restoringQueueWindow?.offset).toBe(490);
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().queueIndex).toBe(501);
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentSong?.id).toBe(songs[502].id);
    usePlayerStore.getState().previous();
    expect(usePlayerStore.getState().queueIndex).toBe(501);
    const stored = JSON.parse(localStorage.getItem('diva_playerQueue')!);
    expect(stored.songIds).toEqual(songs.map(item => item.id));
    expect(stored.queueIndex).toBe(501);
    expect(usePlayerStore.getState().queueRestoring).toBe(true);
    const appended = { ...song, id: 999999 };
    usePlayerStore.getState().addToQueue(appended);
    expect(JSON.parse(localStorage.getItem('diva_playerQueue')!).songIds).toEqual([...songs.map(item => item.id), appended.id]);
    usePlayerStore.getState().pause();
    later.resolve((getSongsByIds.mock.calls[1][0] as number[]).map(id => byId.get(id)!));
    await vi.waitFor(() => expect(usePlayerStore.getState().queue).toHaveLength(991));
    expect(usePlayerStore.getState().queue.at(-1)?.id).toBe(appended.id);
    expect(usePlayerStore.getState().queueIndex).toBe(501);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().playbackSequence).toBe(3);
    expect(usePlayerStore.getState().restoringQueueWindow).toBeNull();
    expect(usePlayerStore.getState().queueRestoring).toBe(false);
  });

  it('retains the full snapshot after navigation and a later failure; close cannot resurrect it', async () => {
    const songs = Array.from({ length: 201 }, (_, index) => ({ ...song, id: song.id + index }));
    const byId = new Map(songs.map(item => [item.id, item]));
    const later = deferred<Song[]>();
    getSongById.mockImplementation(async (id: number) => byId.get(id));
    getSongsByIds.mockImplementationOnce(async (ids: number[]) => ids.map(id => byId.get(id)))
      .mockImplementationOnce(() => later.promise);
    installLocalStorage({ songIds: songs.map(item => item.id), queueIndex: 0, currentSongId: song.id });
    const { usePlayerStore } = await import('./playerStore');
    await vi.waitFor(() => expect(getSongsByIds).toHaveBeenCalledTimes(2));
    usePlayerStore.getState().jumpToIndex(3);
    expect(usePlayerStore.getState().currentSong?.id).toBe(songs[3].id);
    later.resolve([]);
    await Promise.resolve(); await Promise.resolve();
    expect(JSON.parse(localStorage.getItem('diva_playerQueue')!).songIds).toHaveLength(201);
    expect(usePlayerStore.getState().queue).toEqual([]);
    usePlayerStore.getState().closePlayer();
    expect(usePlayerStore.getState().restoringQueueWindow).toBeNull();
    expect(localStorage.getItem('diva_playerQueue')).toBeNull();
  });

  it('restores 990 cached songs offline without detail or card requests, retaining a duplicate position', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const songs = Array.from({ length: 990 }, (_, index) => ({ ...song, id: song.id + index }));
    songs[600] = songs[0];
    const cache = await import('../services/playerQueueCache');
    await cache.cachePlayerQueue(songs);
    installLocalStorage({ songIds: songs.map(item => item.id), queueIndex: 600, currentSongId: songs[600].id,
      currentSong: songs[600], rootSeed: songs[0], rootSeedId: songs[0].id });
    const { usePlayerStore } = await import('./playerStore');
    await vi.waitFor(() => expect(usePlayerStore.getState().queue).toHaveLength(990));
    expect(usePlayerStore.getState().queueIndex).toBe(600);
    expect(getSongById).not.toHaveBeenCalled();
    expect(getSongsByIds).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it('restores the current song before a delayed compact batch and keeps requests bounded', async () => {
    const songs = Array.from({ length: 990 }, (_, index) => ({ ...song, id: song.id + index }));
    const byId = new Map(songs.map(item => [item.id, item]));
    const first = deferred<Song[]>();
    getSongById.mockImplementation(async (id: number) => byId.get(id));
    getSongsByIds.mockImplementationOnce(() => first.promise)
      .mockImplementation(async (ids: number[]) => ids.map(id => byId.get(id)));
    installLocalStorage({ songIds: songs.map(item => item.id), queueIndex: 500, currentSongId: songs[500].id });
    const { usePlayerStore } = await import('./playerStore');
    await vi.waitFor(() => expect(getSongsByIds).toHaveBeenCalledTimes(1));
    expect(usePlayerStore.getState().currentSong?.id).toBe(songs[500].id);
    expect(getSongsByIds.mock.calls[0][0].slice(0, 2)).toEqual([songs[501].id, songs[502].id]);
    expect(usePlayerStore.getState().queueRestoring).toBe(true);
    expect(usePlayerStore.getState().addManyToQueue([song], 'auto', {currentSongId: songs[500].id, playbackSequence: 0})).toBe(false);
    usePlayerStore.getState().resume();
    const firstIds = getSongsByIds.mock.calls[0][0] as number[];
    first.resolve(firstIds.map(id => byId.get(id)!));
    await vi.waitFor(() => expect(usePlayerStore.getState().queue).toHaveLength(990));
    expect(getSongsByIds).toHaveBeenCalledTimes(10);
    expect(getSongsByIds.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true);
    expect(getSongById).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it('does not lose the saved IDs when a cold batch is incomplete', async () => {
    getSongById.mockResolvedValue(song);
    getSongsByIds.mockResolvedValue([]);
    installLocalStorage({ songIds: [song.id, song.id + 1], queueIndex: 0, currentSongId: song.id });
    const before = localStorage.getItem('diva_playerQueue');
    const { usePlayerStore } = await import('./playerStore');
    await vi.waitFor(() => expect(getSongsByIds).toHaveBeenCalled());
    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(localStorage.getItem('diva_playerQueue')).toBe(before);
  });

  it('stops requesting later pages after the user replaces a cold restoring queue', async () => {
    const pending = deferred<Song[]>();
    getSongById.mockResolvedValue(song);
    getSongsByIds.mockReturnValue(pending.promise);
    installLocalStorage({ songIds: Array.from({ length: 990 }, (_, index) => song.id + index), queueIndex: 0, currentSongId: song.id });
    const { usePlayerStore } = await import('./playerStore');
    await vi.waitFor(() => expect(getSongsByIds).toHaveBeenCalledTimes(1));
    const replacement = { ...song, id: 77 };
    usePlayerStore.getState().setQueue([replacement], 0, false);
    pending.resolve([]);
    await Promise.resolve(); await Promise.resolve();
    expect(usePlayerStore.getState().queue).toEqual([replacement]);
    expect(getSongsByIds).toHaveBeenCalledTimes(1);
  });
});
