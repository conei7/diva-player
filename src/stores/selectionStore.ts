/**
 * selectionStore.ts - 複数選択モードの状態管理
 *
 * 複数選択モードのON/OFFと選択されたSongを管理する。
 * FABからのバルクアクションと、各SongCardの選択トグルで使用。
 */
import { create } from 'zustand';
import type { Song } from '../types/vocadb';
import { readLongPressSelectionEnabled, writeLongPressSelectionEnabled } from '../utils/selectionPreferences';

interface SelectionState {
  /** 複数選択モードのON/OFF */
  isSelectionMode: boolean;
  /** カード長押しで複数選択モードへ入るか */
  longPressSelectionEnabled: boolean;
  setLongPressSelectionEnabled: (enabled: boolean) => void;
  /** 選択されたSong IDのSet */
  selectedSongIds: Set<number>;
  /** 選択時点のSongオブジェクト。画面の表示内容が変わってもバルク操作に使う */
  selectedSongs: Map<number, Song>;
  /** 現在の画面で表示されている全曲（FABの全選択/フィルター対象） */
  visibleSongs: Song[];
  /** 表示中の曲リストを更新（各ページが呼び出す） */
  setVisibleSongs: (songs: Song[]) => void;
  /** 選択モードをONにする */
  enterSelectionMode: () => void;
  /** 選択モードをOFFにして選択をクリア */
  exitSelectionMode: () => void;
  /** 1曲をトグル（選択 ↔ 解除） */
  toggleSong: (song: Song) => void;
  /** 指定曲リストを全て選択に追加 */
  selectAll: (songs: Song[]) => void;
  /** 全選択を解除 */
  clearSelection: () => void;
  /** 指定IDが選択済みか確認 */
  isSelected: (id: number) => boolean;
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  isSelectionMode: false,
  longPressSelectionEnabled: readLongPressSelectionEnabled(),
  setLongPressSelectionEnabled: (enabled) => {
    writeLongPressSelectionEnabled(enabled);
    set({ longPressSelectionEnabled: enabled });
  },
  selectedSongIds: new Set<number>(),
  selectedSongs: new Map<number, Song>(),
  visibleSongs: [],
  setVisibleSongs: (songs) => set({ visibleSongs: songs }),

  enterSelectionMode: () => set({ isSelectionMode: true }),

  exitSelectionMode: () =>
    set({
      isSelectionMode: false,
      selectedSongIds: new Set<number>(),
      selectedSongs: new Map<number, Song>(),
    }),

  toggleSong: (song) => {
    const { selectedSongIds, selectedSongs } = get();
    const next = new Set(selectedSongIds);
    const nextSongs = new Map(selectedSongs);
    if (next.has(song.id)) {
      next.delete(song.id);
      nextSongs.delete(song.id);
    } else {
      next.add(song.id);
      nextSongs.set(song.id, song);
    }
    set({ selectedSongIds: next, selectedSongs: nextSongs });
  },

  selectAll: (songs) => {
    const { selectedSongIds, selectedSongs } = get();
    const next = new Set(selectedSongIds);
    const nextSongs = new Map(selectedSongs);
    songs.forEach((song) => {
      next.add(song.id);
      nextSongs.set(song.id, song);
    });
    set({ selectedSongIds: next, selectedSongs: nextSongs });
  },

  clearSelection: () => set({
    selectedSongIds: new Set<number>(),
    selectedSongs: new Map<number, Song>(),
  }),

  isSelected: (id) => get().selectedSongIds.has(id),
}));
