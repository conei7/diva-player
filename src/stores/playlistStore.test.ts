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
