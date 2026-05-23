/**
 * selectionStore.ts - 複数選択モードの状態管理
 *
 * 複数選択モードのON/OFFと選択されたSong IDのSetを管理する。
 * FABからのバルクアクションと、各SongCardの選択トグルで使用。
 */
import { create } from 'zustand';
import type { Song } from '../types/vocadb';

interface SelectionState {
  /** 複数選択モードのON/OFF */
  isSelectionMode: boolean;
  /** 選択されたSong IDのSet */
  selectedSongIds: Set<number>;
  /** 現在の画面で表示されている全曲（FABの全選択/フィルター対象） */
  visibleSongs: Song[];
  /** 表示中の曲リストを更新（各ページが呼び出す） */
  setVisibleSongs: (songs: Song[]) => void;
  /** 選択モードをONにする */
  enterSelectionMode: () => void;
  /** 選択モードをOFFにして選択をクリア */
  exitSelectionMode: () => void;
  /** 1曲をトグル（選択 ↔ 解除） */
  toggleSong: (id: number) => void;
  /** 指定曲リストを全て選択に追加 */
  selectAll: (songs: Song[]) => void;
  /** 全選択を解除 */
  clearSelection: () => void;
  /** 指定IDが選択済みか確認 */
  isSelected: (id: number) => boolean;
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  isSelectionMode: false,
  selectedSongIds: new Set<number>(),
  visibleSongs: [],
  setVisibleSongs: (songs) => set({ visibleSongs: songs }),

  enterSelectionMode: () => set({ isSelectionMode: true }),

  exitSelectionMode: () =>
    set({ isSelectionMode: false, selectedSongIds: new Set<number>() }),

  toggleSong: (id) => {
    const { selectedSongIds } = get();
    const next = new Set(selectedSongIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    set({ selectedSongIds: next });
  },

  selectAll: (songs) => {
    const { selectedSongIds } = get();
    const next = new Set(selectedSongIds);
    songs.forEach((s) => next.add(s.id));
    set({ selectedSongIds: next });
  },

  clearSelection: () => set({ selectedSongIds: new Set<number>() }),

  isSelected: (id) => get().selectedSongIds.has(id),
}));
