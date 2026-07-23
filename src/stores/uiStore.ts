/**
 * uiStore.ts - UI状態のグローバル管理
 *
 * サイドバーの開閉状態、楽曲詳細モーダル、レイアウト状態を管理する。
 */
import { create } from 'zustand';
import type { Song } from '../types/vocadb';

export interface SaveToPlaylistContext {
  source: 'default' | 'queue';
  queueIndex?: number;
}

interface UiState {
  /** 詳細モーダルに表示中の楽曲。null = モーダル閉じている */
  detailSong: Song | null;

  /** 指定楽曲の詳細モーダルを開く */
  openSongDetail: (song: Song) => void;

  /** 詳細モーダルを閉じる */
  closeSongDetail: () => void;

  /** 「プレイリストに保存」モーダルの対象曲。null = 閉じている */
  saveToPlaylistSongs: Song[] | null;
  saveToPlaylistContext: SaveToPlaylistContext;
  openSaveToPlaylist: (songOrSongs: Song | Song[], context?: SaveToPlaylistContext) => void;
  closeSaveToPlaylist: () => void;

  /** サイドバー展開状態 (デスクトップ) */
  sidebarExpanded: boolean;
  toggleSidebar: () => void;
  setSidebarExpanded: (v: boolean) => void;

  /** モバイルサイドバードロワー */
  mobileDrawerOpen: boolean;
  toggleMobileDrawer: () => void;
  closeMobileDrawer: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  detailSong: null,
  openSongDetail: (song) => set({ detailSong: song }),
  closeSongDetail: () => set({ detailSong: null }),

  saveToPlaylistSongs: null,
  saveToPlaylistContext: { source: 'default' },
  openSaveToPlaylist: (songOrSongs, context = { source: 'default' }) => set({
    saveToPlaylistSongs: Array.isArray(songOrSongs) ? [...songOrSongs] : [songOrSongs],
    saveToPlaylistContext: context,
  }),
  closeSaveToPlaylist: () => set({ saveToPlaylistSongs: null, saveToPlaylistContext: { source: 'default' } }),

  sidebarExpanded: true,
  toggleSidebar: () => set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),
  setSidebarExpanded: (v) => set({ sidebarExpanded: v }),

  mobileDrawerOpen: false,
  toggleMobileDrawer: () => set((s) => ({ mobileDrawerOpen: !s.mobileDrawerOpen })),
  closeMobileDrawer: () => set({ mobileDrawerOpen: false }),
}));
