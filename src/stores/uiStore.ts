/**
 * uiStore.ts - UI状態のグローバル管理
 *
 * 楽曲詳細モーダルの開閉状態と表示対象の楽曲を管理する。
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
}

export const useUiStore = create<UiState>()((set) => ({
  detailSong: null,
  openSongDetail: (song) => set({ detailSong: song }),
  closeSongDetail: () => set({ detailSong: null }),
}));
