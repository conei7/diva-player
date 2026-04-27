/**
 * Playlist Store - プレイリストの永続管理
 * 
 * LocalStorage と同期し、プレイリストのCRUD操作を提供。
 * storage アダプターを経由して保存先を抽象化。
 */

import { create } from 'zustand';
import type { Playlist, Song } from '../types/vocadb';
import { storage } from '../utils/storage';

const PLAYLISTS_KEY = 'playlists';

interface PlaylistState {
  playlists: Playlist[];

  // アクション
  loadPlaylists: () => void;
  createPlaylist: (name: string) => Playlist;
  deletePlaylist: (id: string) => void;
  renamePlaylist: (id: string, name: string) => void;
  addSong: (playlistId: string, song: Song) => void;
  removeSong: (playlistId: string, songIndex: number) => void;
  reorderSongs: (playlistId: string, fromIndex: number, toIndex: number) => void;
}

function savePlaylists(playlists: Playlist[]): void {
  storage.set(PLAYLISTS_KEY, playlists);
}

export const usePlaylistStore = create<PlaylistState>((set, get) => ({
  playlists: [],

  loadPlaylists: () => {
    const saved = storage.get<Playlist[]>(PLAYLISTS_KEY);
    if (saved) {
      set({ playlists: saved });
    }
  },

  createPlaylist: (name: string) => {
    const newPlaylist: Playlist = {
      id: crypto.randomUUID(),
      name,
      songs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const updated = [...get().playlists, newPlaylist];
    set({ playlists: updated });
    savePlaylists(updated);
    return newPlaylist;
  },

  deletePlaylist: (id: string) => {
    const updated = get().playlists.filter(p => p.id !== id);
    set({ playlists: updated });
    savePlaylists(updated);
  },

  renamePlaylist: (id: string, name: string) => {
    const updated = get().playlists.map(p =>
      p.id === id ? { ...p, name, updatedAt: Date.now() } : p
    );
    set({ playlists: updated });
    savePlaylists(updated);
  },

  addSong: (playlistId: string, song: Song) => {
    const updated = get().playlists.map(p => {
      if (p.id !== playlistId) return p;
      // 重複チェック
      if (p.songs.some(s => s.id === song.id)) return p;
      return {
        ...p,
        songs: [...p.songs, song],
        updatedAt: Date.now(),
      };
    });
    set({ playlists: updated });
    savePlaylists(updated);
  },

  removeSong: (playlistId: string, songIndex: number) => {
    const updated = get().playlists.map(p => {
      if (p.id !== playlistId) return p;
      return {
        ...p,
        songs: p.songs.filter((_, i) => i !== songIndex),
        updatedAt: Date.now(),
      };
    });
    set({ playlists: updated });
    savePlaylists(updated);
  },

  reorderSongs: (playlistId: string, fromIndex: number, toIndex: number) => {
    const updated = get().playlists.map(p => {
      if (p.id !== playlistId) return p;
      const songs = [...p.songs];
      const [moved] = songs.splice(fromIndex, 1);
      songs.splice(toIndex, 0, moved);
      return { ...p, songs, updatedAt: Date.now() };
    });
    set({ playlists: updated });
    savePlaylists(updated);
  },
}));
