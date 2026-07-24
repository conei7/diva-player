import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';
import { usePlaylistStore } from './playlistStore';
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

  it('creates a stable playlist and adds multiple songs with duplicate counts', () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const store = usePlaylistStore.getState();
    const playlist = store.createPlaylist('まとめ');

    expect(playlist.id).toMatch(/^playlist-/);
    expect(store.addSongs(playlist.id, [song(1), song(2), song(1)])).toEqual({ added: 2, duplicates: 1 });
    expect(usePlaylistStore.getState().playlists.find(item => item.id === playlist.id)?.songs.map(item => item.id)).toEqual([1, 2]);
  });

  it('keeps the selected songs as one modal payload for bulk save', () => {
    const songs = [song(10), song(11)];
    useUiStore.getState().openSaveToPlaylist(songs);
    expect(useUiStore.getState().saveToPlaylistSongs).toEqual(songs);
  });
});

describe('playlist undo snapshots', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    usePlaylistStore.setState({ playlists: [], folders: [] });
  });

  it('restores a deleted playlist at its original position', () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const first = usePlaylistStore.getState().createPlaylist('first');
    const middle = usePlaylistStore.getState().createPlaylist('middle');
    const last = usePlaylistStore.getState().createPlaylist('last');

    const snapshot = usePlaylistStore.getState().deletePlaylist(middle.id);
    expect(snapshot?.index).toBe(1);
    expect(usePlaylistStore.getState().playlists.map(item => item.id)).toEqual([first.id, last.id]);
    expect(usePlaylistStore.getState().restoreDeletedPlaylist(snapshot!)).toBe(true);
    expect(usePlaylistStore.getState().playlists.map(item => item.id)).toEqual([first.id, middle.id, last.id]);
  });

  it('restores removed songs in order without overwriting a later addition', () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const playlist = usePlaylistStore.getState().createPlaylist('songs');
    usePlaylistStore.getState().addSongs(playlist.id, [song(1), song(2), song(3)]);

    const snapshot = usePlaylistStore.getState().removeSongs(playlist.id, [1]);
    usePlaylistStore.getState().addSong(playlist.id, song(4));
    expect(usePlaylistStore.getState().restoreRemovedSongs(snapshot!)).toBe(1);
    expect(usePlaylistStore.getState().playlists.find(item => item.id === playlist.id)?.songs.map(item => item.id))
      .toEqual([1, 2, 3, 4]);

    const second = usePlaylistStore.getState().removeSong(playlist.id, 1);
    usePlaylistStore.getState().addSong(playlist.id, song(2));
    expect(usePlaylistStore.getState().restoreRemovedSongs(second!)).toBe(0);
  });

  it('restores duplicate entries when the duplicate cleanup is undone', () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', undefined);
    const playlist = usePlaylistStore.getState().createPlaylist('duplicates');
    usePlaylistStore.setState({
      playlists: [{ ...playlist, songs: [song(1), song(2), song(1)] }],
    });

    const snapshot = usePlaylistStore.getState().removeDuplicateSongsWithUndo(playlist.id);
    expect(snapshot?.removed.map(item => item.index)).toEqual([2]);
    expect(usePlaylistStore.getState().restoreRemovedSongs(snapshot!, { allowDuplicateIds: true })).toBe(1);
    expect(usePlaylistStore.getState().playlists[0].songs.map(item => item.id)).toEqual([1, 2, 1]);
  });

  it('does not delete a pinned playlist', () => {
    const pinned = { id: 'pinned', name: 'pinned', songs: [], isPinned: true, createdAt: 1, updatedAt: 1 };
    usePlaylistStore.setState({ playlists: [pinned] });
    expect(usePlaylistStore.getState().deletePlaylist(pinned.id)).toBeNull();
    expect(usePlaylistStore.getState().playlists).toEqual([pinned]);
  });
});
