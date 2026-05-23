/**
 * uiStore.ts - UI状態のグローバル管理
 *
 * サイドバーの開閉状態、楽曲詳細モーダル、レイアウト状態を管理する。
 */
import { create } from 'zustand';
import type { Song } from '../types/vocadb';

interface UiState {
  /** 詳細モーダルに表示中の楽曲。null = モーダル閉じている */
  detailSong: Song | null;

  /** 指定楽曲の詳細モーダルを開く */
  openSongDetail: (song: Song) => void;

  /** 詳細モーダルを閉じる */
  closeSongDetail: () => void;

  /** 「プレイリストに保存」モーダルの対象曲。null = 閉じている */
  saveToPlaylistSongs: Song[] | null;
  openSaveToPlaylist: (songOrSongs: Song | Song[]) => void;
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
  openSaveToPlaylist: (songOrSongs) => set({ saveToPlaylistSongs: Array.isArray(songOrSongs) ? songOrSongs : [songOrSongs] }),
  closeSaveToPlaylist: () => set({ saveToPlaylistSongs: null }),

  sidebarExpanded: true,
  toggleSidebar: () => set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),
  setSidebarExpanded: (v) => set({ sidebarExpanded: v }),

  mobileDrawerOpen: false,
  toggleMobileDrawer: () => set((s) => ({ mobileDrawerOpen: !s.mobileDrawerOpen })),
  closeMobileDrawer: () => set({ mobileDrawerOpen: false }),
}));
