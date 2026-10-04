import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchYouTubePlaylistSongs } from '../api/youtubePlaylist';
import { fetchNicoPlaylistSongs } from '../api/nicoPlaylist';
import { usePlaylistStore } from '../stores/playlistStore';
import { syncYouTubePlaylist } from './youtubePlaylistSync';
import { syncNicoPlaylist } from './nicoPlaylistSync';

vi.mock('../api/youtubePlaylist', () => ({ fetchYouTubePlaylistSongs: vi.fn() }));
vi.mock('../api/nicoPlaylist', () => ({ fetchNicoPlaylistSongs: vi.fn() }));

function createLocalStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

const song = { id: 2, name: '同期後の曲' } as never;
const youtubeResponse = {
  playlistId: 'PL1234567890', title: 'YouTube', videoCount: 1, matchedCount: 1,
  unmatchedVideoIds: [], songs: [song], sourceFetchedAt: new Date().toISOString(), stale: false, truncated: false,
};
const nicoResponse = {
  sourceKind: 'mylist' as const, sourceId: '12345678', title: 'Nico', videoCount: 1, matchedCount: 1,
  unmatchedVideoIds: [], songs: [song], sourceFetchedAt: new Date().toISOString(), stale: false, truncated: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve: (value: T) => resolve(value) };
}

describe('external playlist sync race handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', createLocalStorage());
    usePlaylistStore.setState({ playlists: [], folders: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    usePlaylistStore.setState({ playlists: [], folders: [] });
  });

  it('skips a YouTube response after the link is removed', async () => {
    const pending = deferred<typeof youtubeResponse>();
    vi.mocked(fetchYouTubePlaylistSongs).mockReturnValue(pending.promise);
    const sync = {
      playlistId: 'PL1234567890', sourceUrl: 'https://www.youtube.com/playlist?list=PL1234567890',
      enabled: true, intervalHours: 24,
    } as const;
    const playlist = usePlaylistStore.getState().createYouTubeLinkedPlaylist('YT', [], sync);
    const result = syncYouTubePlaylist(playlist, { refresh: true });
    await vi.waitFor(() => expect(fetchYouTubePlaylistSongs).toHaveBeenCalledOnce());

    expect(usePlaylistStore.getState().unlinkYouTubeSync(playlist.id)).toBe(true);
    pending.resolve(youtubeResponse);

    await expect(result).resolves.toBe('skipped');
    expect(usePlaylistStore.getState().playlists.find(item => item.id === playlist.id)?.songs).toEqual([]);
    expect(usePlaylistStore.getState().playlists.find(item => item.id === playlist.id)?.youtubeSync).toBeUndefined();
  });

  it('skips an old YouTube response after the same source is linked again', async () => {
    const pending = deferred<typeof youtubeResponse>();
    vi.mocked(fetchYouTubePlaylistSongs).mockReturnValue(pending.promise);
    const sync = {
      playlistId: 'PL1234567890', sourceUrl: 'https://www.youtube.com/playlist?list=PL1234567890',
      enabled: true, intervalHours: 24,
    } as const;
    const playlist = usePlaylistStore.getState().createYouTubeLinkedPlaylist('YT', [], sync);
    const result = syncYouTubePlaylist(playlist, { refresh: true });
    await vi.waitFor(() => expect(fetchYouTubePlaylistSongs).toHaveBeenCalledOnce());

    expect(usePlaylistStore.getState().unlinkYouTubeSync(playlist.id)).toBe(true);
    usePlaylistStore.setState({ playlists: usePlaylistStore.getState().playlists.map(item => item.id === playlist.id
      ? { ...item, youtubeSync: { ...sync } }
      : item) });
    pending.resolve(youtubeResponse);

    await expect(result).resolves.toBe('skipped');
    expect(usePlaylistStore.getState().playlists.find(item => item.id === playlist.id)?.songs).toEqual([]);
  });

  it('skips a Nico response after the playlist is deleted', async () => {
    const pending = deferred<typeof nicoResponse>();
    vi.mocked(fetchNicoPlaylistSongs).mockReturnValue(pending.promise);
    const sync = {
      sourceKind: 'mylist', sourceId: '12345678', sourceUrl: 'https://www.nicovideo.jp/mylist/12345678',
      enabled: true, intervalHours: 24,
    } as const;
    const playlist = usePlaylistStore.getState().createNicoLinkedPlaylist('Nico', [], sync);
    const result = syncNicoPlaylist(playlist, { refresh: true });
    await vi.waitFor(() => expect(fetchNicoPlaylistSongs).toHaveBeenCalledOnce());

    expect(usePlaylistStore.getState().deletePlaylist(playlist.id)).not.toBeNull();
    pending.resolve(nicoResponse);

    await expect(result).resolves.toBe('skipped');
    expect(usePlaylistStore.getState().playlists.some(item => item.id === playlist.id)).toBe(false);
  });

  it('discards an old Nico response after its source settings change', async () => {
    const pending = deferred<typeof nicoResponse>();
    vi.mocked(fetchNicoPlaylistSongs).mockReturnValue(pending.promise);
    const sync = {
      sourceKind: 'mylist', sourceId: '12345678', sourceUrl: 'https://www.nicovideo.jp/mylist/12345678',
      enabled: true, intervalHours: 24,
    } as const;
    const playlist = usePlaylistStore.getState().createNicoLinkedPlaylist('Nico', [], sync);
    const result = syncNicoPlaylist(playlist, { refresh: true });
    await vi.waitFor(() => expect(fetchNicoPlaylistSongs).toHaveBeenCalledOnce());

    const current = usePlaylistStore.getState().playlists.find(item => item.id === playlist.id)!;
    usePlaylistStore.setState({ playlists: usePlaylistStore.getState().playlists.map(item => item.id === playlist.id
      ? { ...item, nicoSync: { ...item.nicoSync!, sourceId: '87654321' } }
      : item) });
    pending.resolve(nicoResponse);

    await expect(result).resolves.toBe('skipped');
    expect(usePlaylistStore.getState().playlists.find(item => item.id === current.id)?.songs).toEqual([]);
  });

  it('returns an error when fetched YouTube songs cannot be persisted', async () => {
    vi.mocked(fetchYouTubePlaylistSongs).mockResolvedValue(youtubeResponse);
    const sync = {
      playlistId: 'PL1234567890', sourceUrl: 'https://www.youtube.com/playlist?list=PL1234567890',
      enabled: true, intervalHours: 24,
    } as const;
    const playlist = usePlaylistStore.getState().createYouTubeLinkedPlaylist('YT', [], sync);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new DOMException('storage full', 'QuotaExceededError'); },
      removeItem: () => undefined,
      key: () => null,
      length: 0,
    });

    await expect(syncYouTubePlaylist(playlist, { refresh: true })).resolves.toBe('error');
    expect(usePlaylistStore.getState().playlists.find(item => item.id === playlist.id)?.songs).toEqual([]);
  });
});
