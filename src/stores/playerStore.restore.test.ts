import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';

const getSongById = vi.hoisted(() => vi.fn());

vi.mock('../api/vocadb', () => ({ getSongById }));

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
