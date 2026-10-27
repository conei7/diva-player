import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';
import { getSongsRefreshedAt, LEGACY_DIG_PLAYLIST_ID, usePlaylistStore } from './playlistStore';
import { clearToasts, useToastStore } from './toastStore';
import { useUiStore } from './uiStore';

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

const song = (id: number): Song => ({
  id,
  name: `曲${id}`,
  defaultName: `曲${id}`,
  defaultNameLanguage: 'Japanese',
  artistString: 'P',
  createDate: '2026-01-01',
  favoritedTimes: 0,
  lengthSeconds: 120,
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
});

describe('playlist bulk save regression', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    usePlaylistStore.setState({ playlists: [], folders: [] });
    useUiStore.setState({ saveToPlaylistSongs: null });
  });

  it('creates a stable playlist and adds multiple songs with duplicate counts', async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const store = usePlaylistStore.getState();
    const playlist = (await store.createPlaylist('まとめ'));

    expect(playlist.id).toMatch(/^playlist-/);
    expect((await store.addSongs(playlist.id, [song(1), song(2), song(1)]))).toEqual({ success: true, added: 2, duplicates: 1 });
    expect(usePlaylistStore.getState().playlists.find(item => item.id === playlist.id)?.songs.map(item => item.id)).toEqual([1, 2]);
  });

  it('keeps the selected songs as one modal payload for bulk save', () => {
    const songs = [song(10), song(11)];
    useUiStore.getState().openSaveToPlaylist(songs);
    expect(useUiStore.getState().saveToPlaylistSongs).toEqual(songs);
  });

  it('creates a bulk playlist with unique songs and a first-song cover fallback', async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const first = { ...song(12), thumbUrl: 'https://example.test/cover.jpg' };

    const playlist = (await usePlaylistStore.getState().createPlaylistWithSongs(
      'インポート', [first, { ...first, name: '重複' }], undefined, { coverArtUrl: undefined },
    ));

    expect(playlist.songs).toEqual([first]);
    expect(playlist.coverArtUrl).toBe(first.thumbUrl);
    expect(usePlaylistStore.getState().playlists[0]?.songs).toEqual([first]);
  });

  it('does not update in-memory data when the second persisted key fails and rollback succeeds', async () => {
    const values = new Map<string, string>();
    let writes = 0;
    const localStorageMock = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes === 2) throw new DOMException('storage full', 'QuotaExceededError');
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    };
    vi.stubGlobal('localStorage', localStorageMock);
    vi.stubGlobal('alert', vi.fn());
    if (typeof window !== 'undefined') vi.spyOn(window, 'alert').mockImplementation(() => undefined);

    await expect(usePlaylistStore.getState().createPlaylist('保存できない')).rejects.toThrow(/保存できませんでした/);
    expect(usePlaylistStore.getState().playlists).toEqual([]);
    expect(values.has('diva_playlists')).toBe(false);
    expect(values.has('diva_playlistFolders')).toBe(false);
  });

  it('reports when a failed playlist save cannot restore the previous storage value', async () => {
    const values = new Map<string, string>([['diva_playlists', 'previous-value']]);
    let writes = 0;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes === 2 || writes === 3) throw new DOMException('storage full', 'QuotaExceededError');
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    });
    vi.stubGlobal('alert', vi.fn());
    if (typeof window !== 'undefined') vi.spyOn(window, 'alert').mockImplementation(() => undefined);

    let failure: unknown;
    try {
      (await usePlaylistStore.getState().createPlaylist('復旧できない'));
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ name: 'PlaylistPersistenceError', recoveryComplete: false });
    expect(usePlaylistStore.getState().playlists).toEqual([]);
    expect(values.has('diva_playlists')).toBe(true);
    expect(values.get('diva_playlists')).not.toBe('previous-value');

    // One short sentence, and the backup (settings › data) as the one action.
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.message).toBe('プレイリストを保存できませんでした');
    toast?.action?.onAction();
    expect(useUiStore.getState().settingsDialog).toEqual({ open: true, tab: 'data' });
    clearToasts();
    useUiStore.getState().closeSettings();
  });
});

describe('playlist undo snapshots', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    usePlaylistStore.setState({ playlists: [], folders: [] });
  });

  it('restores a deleted playlist at its original position', async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const first = (await usePlaylistStore.getState().createPlaylist('first'));
    const middle = (await usePlaylistStore.getState().createPlaylist('middle'));
    const last = (await usePlaylistStore.getState().createPlaylist('last'));

    const snapshot = (await usePlaylistStore.getState().deletePlaylist(middle.id));
    expect(snapshot?.index).toBe(1);
    expect(usePlaylistStore.getState().playlists.map(item => item.id)).toEqual([first.id, last.id]);
    expect((await usePlaylistStore.getState().restoreDeletedPlaylist(snapshot!))).toBe(true);
    expect(usePlaylistStore.getState().playlists.map(item => item.id)).toEqual([first.id, middle.id, last.id]);
  });

  it('restores removed songs in order without overwriting a later addition', async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const playlist = (await usePlaylistStore.getState().createPlaylist('songs'));
    (await usePlaylistStore.getState().addSongs(playlist.id, [song(1), song(2), song(3)]));

    const snapshot = (await usePlaylistStore.getState().removeSongs(playlist.id, [1]));
    (await usePlaylistStore.getState().addSong(playlist.id, song(4)));
    expect((await usePlaylistStore.getState().restoreRemovedSongs(snapshot!))).toBe(1);
    expect(usePlaylistStore.getState().playlists.find(item => item.id === playlist.id)?.songs.map(item => item.id))
      .toEqual([1, 2, 3, 4]);

    const second = (await usePlaylistStore.getState().removeSong(playlist.id, 1));
    (await usePlaylistStore.getState().addSong(playlist.id, song(2)));
    expect((await usePlaylistStore.getState().restoreRemovedSongs(second!))).toBe(0);
  });

  it('restores duplicate entries when the duplicate cleanup is undone', async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const playlist = (await usePlaylistStore.getState().createPlaylist('duplicates'));
    usePlaylistStore.setState({
      playlists: [{ ...playlist, songs: [song(1), song(2), song(1)] }],
    });

    const snapshot = (await usePlaylistStore.getState().removeDuplicateSongsWithUndo(playlist.id));
    expect(snapshot?.removed.map(item => item.index)).toEqual([2]);
    expect((await usePlaylistStore.getState().restoreRemovedSongs(snapshot!, { allowDuplicateIds: true }))).toBe(1);
    expect(usePlaylistStore.getState().playlists[0].songs.map(item => item.id)).toEqual([1, 2, 1]);
  });

  it('brings back a removed copy of a duplicated song', async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const playlist = (await usePlaylistStore.getState().createPlaylist('row undo'));
    usePlaylistStore.setState({ playlists: [{ ...playlist, songs: [song(1), song(2), song(1)] }] });

    const second = (await usePlaylistStore.getState().removeSong(playlist.id, 2));
    expect((await usePlaylistStore.getState().restoreRemovedSongs(second!))).toBe(1);
    expect(usePlaylistStore.getState().playlists[0].songs.map(item => item.id)).toEqual([1, 2, 1]);

    const first = (await usePlaylistStore.getState().removeSong(playlist.id, 0));
    expect((await usePlaylistStore.getState().restoreRemovedSongs(first!))).toBe(1);
    expect(usePlaylistStore.getState().playlists[0].songs.map(item => item.id)).toEqual([1, 2, 1]);
  });

  it('brings back every copy when all songs, duplicates included, are removed', async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const playlist = (await usePlaylistStore.getState().createPlaylist('select all'));
    usePlaylistStore.setState({ playlists: [{ ...playlist, songs: [song(1), song(2), song(1), song(3)] }] });

    const snapshot = (await usePlaylistStore.getState().removeSongs(playlist.id, [0, 1, 2, 3]));
    expect(usePlaylistStore.getState().playlists[0].songs).toEqual([]);
    expect((await usePlaylistStore.getState().restoreRemovedSongs(snapshot!))).toBe(4);
    expect(usePlaylistStore.getState().playlists[0].songs.map(item => item.id)).toEqual([1, 2, 1, 3]);
  });

  it('does not add more copies than there were when a song was added again before undo', async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const playlist = (await usePlaylistStore.getState().createPlaylist('re-added'));
    usePlaylistStore.setState({ playlists: [{ ...playlist, songs: [song(1), song(2), song(1)] }] });

    const snapshot = (await usePlaylistStore.getState().removeSongs(playlist.id, [0, 2]));
    (await usePlaylistStore.getState().addSong(playlist.id, song(1)));
    expect((await usePlaylistStore.getState().restoreRemovedSongs(snapshot!))).toBe(1);
    expect(usePlaylistStore.getState().playlists[0].songs.filter(item => item.id === 1)).toHaveLength(2);
  });

  it('does not delete a pinned playlist', async () => {
    const pinned = { id: 'pinned', name: 'pinned', songs: [], isPinned: true, createdAt: 1, updatedAt: 1 };
    usePlaylistStore.setState({ playlists: [pinned] });
    expect((await usePlaylistStore.getState().deletePlaylist(pinned.id))).toBeNull();
    expect(usePlaylistStore.getState().playlists).toEqual([pinned]);
  });
});

describe('YouTube linked playlists', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    usePlaylistStore.setState({ playlists: [], folders: [] });
  });

  it('keeps linked playlists read-only and applies sync atomically', async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const sync = {
      playlistId: 'PL1234567890',
      sourceUrl: 'https://www.youtube.com/playlist?list=PL1234567890',
      enabled: true,
      intervalHours: 24,
      lastStatus: 'success' as const,
    };
    const linked = (await usePlaylistStore.getState().createYouTubeLinkedPlaylist('linked', [song(1)], sync));
    expect((await usePlaylistStore.getState().addSong(linked.id, song(2)))).toEqual({ success: false, isDuplicate: false });
    expect((await usePlaylistStore.getState().removeSong(linked.id, 0))).toBeNull();
    expect((await usePlaylistStore.getState().reorderSongs(linked.id, 0, 0))).toBeUndefined();
    expect((await usePlaylistStore.getState().applyYouTubeSync(linked.id, [song(3)], { ...sync, lastStatus: 'partial' }))).toBe(true);
    expect(usePlaylistStore.getState().playlists.find(item => item.id === linked.id)?.songs.map(item => item.id)).toEqual([3]);
    expect((await usePlaylistStore.getState().unlinkYouTubeSync(linked.id))).toBe(true);
    expect(usePlaylistStore.getState().playlists.find(item => item.id === linked.id)?.youtubeSync).toBeUndefined();
  });
});

describe('NicoNico linked playlists', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    usePlaylistStore.setState({ playlists: [], folders: [] });
  });

  it('keeps linked playlists read-only, mirrors order, and preserves songs when unlinked', async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const sync = {
      sourceKind: 'mylist' as const,
      sourceId: '26375614',
      sourceUrl: 'https://www.nicovideo.jp/mylist/26375614',
      enabled: true,
      intervalHours: 24,
      lastStatus: 'success' as const,
    };
    const linked = (await usePlaylistStore.getState().createNicoLinkedPlaylist('linked', [song(1)], sync));
    expect((await usePlaylistStore.getState().addSong(linked.id, song(2)))).toEqual({ success: false, isDuplicate: false });
    expect((await usePlaylistStore.getState().removeSong(linked.id, 0))).toBeNull();
    expect((await usePlaylistStore.getState().applyNicoSync(linked.id, [song(3)], { ...sync, lastStatus: 'partial' }))).toBe(true);
    expect(usePlaylistStore.getState().playlists.find(item => item.id === linked.id)?.songs.map(item => item.id)).toEqual([3]);
    expect((await usePlaylistStore.getState().unlinkNicoSync(linked.id))).toBe(true);
    expect(usePlaylistStore.getState().playlists.find(item => item.id === linked.id)?.nicoSync).toBeUndefined();
    expect(usePlaylistStore.getState().playlists.find(item => item.id === linked.id)?.songs.map(item => item.id)).toEqual([3]);
  });
});

describe('automatic song refreshes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    usePlaylistStore.setState({ playlists: [], folders: [] });
  });

  it('records smart refreshes and syncs without changing the last user update', async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const sync = {
      playlistId: 'PL1234567890',
      sourceUrl: 'https://www.youtube.com/playlist?list=PL1234567890',
      enabled: true,
      intervalHours: 24,
    };
    usePlaylistStore.setState({
      playlists: [
        { id: 'smart', name: 'smart', songs: [], createdAt: 1, updatedAt: 1, smartRule: { minYoutubeViews: 0, minNicoViews: 0, excludedSongTypes: [] } },
        { id: 'linked', name: 'linked', songs: [], createdAt: 1, updatedAt: 1, youtubeSync: sync },
      ],
    });

    (await usePlaylistStore.getState().replacePlaylistSongs('smart', [song(1)]));
    (await usePlaylistStore.getState().applyYouTubeSync('linked', [song(2)], { ...sync, lastStatus: 'success' }));

    const [smart, linked] = usePlaylistStore.getState().playlists;
    expect(smart.songs.map(item => item.id)).toEqual([1]);
    expect(linked.songs.map(item => item.id)).toEqual([2]);
    expect(smart.updatedAt).toBe(1);
    expect(linked.updatedAt).toBe(1);
    expect(getSongsRefreshedAt(smart)).toBeGreaterThan(1);
    expect(getSongsRefreshedAt(linked)).toBeGreaterThan(1);
    expect(getSongsRefreshedAt({ id: 'x', name: 'x', songs: [], createdAt: 1, updatedAt: 1 })).toBeUndefined();
  });
});

describe('legacy generated playlist migration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    usePlaylistStore.setState({ playlists: [], folders: [] });
  });

  it('removes the old ephemeral Dig playlist while preserving user playlists', async () => {
    const localStorage = createLocalStorage();
    localStorage.setItem('diva_playlists', JSON.stringify([
      { id: LEGACY_DIG_PLAYLIST_ID, name: '発掘ミックス', songs: [song(7)], isPinned: true, createdAt: 1, updatedAt: 1 },
      { id: 'user-playlist', name: '保存曲', songs: [song(8)], createdAt: 2, updatedAt: 2 },
    ]));
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('crypto', undefined);
    await usePlaylistStore.getState().loadPlaylists();

    expect(usePlaylistStore.getState().playlists.some(item => item.id === LEGACY_DIG_PLAYLIST_ID)).toBe(false);
    expect(usePlaylistStore.getState().playlists.find(item => item.id === 'user-playlist')?.songs.map(item => item.id)).toEqual([8]);
    expect(JSON.parse(localStorage.getItem('diva_playlists') ?? '[]').some((item: { id: string }) => item.id === LEGACY_DIG_PLAYLIST_ID)).toBe(false);
  });
});
