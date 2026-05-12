/**
 * historyStore.ts - 視聴履歴のグローバル管理
 *
 * Zustand persist ミドルウェアで LocalStorage (キー: "diva-history") に保存。
 * 最大200件を保持し、超過した場合は古いものから破棄する。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Song } from '../types/vocadb';

const MAX_HISTORY = 200;

export interface HistoryEntry {
  song: Song;
  playedAt: number; // Unix timestamp (ms)
}

interface HistoryState {
  entries: HistoryEntry[];

  /**
   * 曲を履歴に追加する。
   * 先頭と同じ曲の場合はタイムスタンプのみ更新（重複連続追加防止）。
   */
  addToHistory: (song: Song) => void;

  /** 履歴を全件削除する */
  clearHistory: () => void;
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set, get) => ({
      entries: [],

      addToHistory: (song) => {
        const { entries } = get();
        const newEntry: HistoryEntry = { song, playedAt: Date.now() };

        let updated: HistoryEntry[];
        if (entries[0]?.song.id === song.id) {
          // 先頭と同じ曲 → タイムスタンプのみ更新
          updated = [newEntry, ...entries.slice(1)];
        } else {
          // 新しい曲を先頭に追加し、最大件数を超えた分を切り捨て
          updated = [newEntry, ...entries].slice(0, MAX_HISTORY);
        }
        set({ entries: updated });
      },

      clearHistory: () => set({ entries: [] }),
    }),
    { name: 'diva-history' },
  ),
);
