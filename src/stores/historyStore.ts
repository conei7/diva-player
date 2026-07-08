/**
 * historyStore.ts - 視聴履歴のグローバル管理
 *
 * Zustand persist ミドルウェアと IndexedDB (idb-keyval) を使用して保存。
 * LocalStorageの5MB制限を回避し、履歴を無限に保持する。
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import { get, set, del } from 'idb-keyval';
import type { Song } from '../types/vocadb';

// IndexedDBを使ったカスタムストレージ
const storage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    // 古いLocalStorageのデータをマイグレーションする
    const localData = localStorage.getItem(name);
    if (localData) {
      await set(name, localData);
      localStorage.removeItem(name);
      return localData;
    }
    return (await get(name)) || null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await set(name, value);
  },
  removeItem: async (name: string): Promise<void> => {
    await del(name);
  },
};

export interface HistoryEntry {
  song: Song;
  playedAt: number; // Unix timestamp (ms)
}

interface HistoryState {
  entries: HistoryEntry[];
  hasHydrated: boolean;

  /**
   * 曲を履歴に追加する。
   * 先頭と同じ曲の場合はタイムスタンプのみ更新（重複連続追加防止）。
   * 最大件数の制限なし（無限保存）。
   */
  addToHistory: (song: Song) => void;

  /** 履歴を全件削除する */
  clearHistory: () => void;
  setHasHydrated: (hasHydrated: boolean) => void;
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set, get) => ({
      entries: [],
      hasHydrated: false,

      addToHistory: (song) => {
        const { entries } = get();
        const newEntry: HistoryEntry = { song, playedAt: Date.now() };

        let updated: HistoryEntry[];
        if (entries[0]?.song.id === song.id) {
          // 先頭と同じ曲 → タイムスタンプのみ更新
          updated = [newEntry, ...entries.slice(1)];
        } else {
          // 新しい曲を先頭に追加（無制限）
          updated = [newEntry, ...entries];
        }
        set({ entries: updated });
      },

      clearHistory: () => set({ entries: [] }),
      setHasHydrated: (hasHydrated) => set({ hasHydrated }),
    }),
    { 
      name: 'diva-history',
      storage: createJSONStorage(() => storage),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
