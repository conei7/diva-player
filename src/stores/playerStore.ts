/**
 * Player Store - 再生状態のグローバル管理
 * 
 * 曲の再生・停止・スキップ・キュー管理を担当。
 * YouTube/ニコニコの実際の制御は各プレイヤーコンポーネントが行い、
 * このストアは状態の「真実の情報源」として機能する。
 */

import { create } from 'zustand';
import type { Song, PV } from '../types/vocadb';

// 再生可能なPVを抽出するヘルパー
export function getPlayablePV(song: Song): PV | null {
  if (!song.pvs || song.pvs.length === 0) return null;

  const enabledPVs = song.pvs.filter(pv => !pv.disabled);

  // 優先順位: YouTube (Official/非公式問わず) > NicoNico
  // NicoNico は iframe 埋め込み制限があるため YouTube を最優先
  const priorities: Array<{ service: string; pvType: string }> = [
    { service: 'Youtube', pvType: 'Original' },
    { service: 'Youtube', pvType: 'Reprint' },
    { service: 'NicoNicoDouga', pvType: 'Original' },
    { service: 'NicoNicoDouga', pvType: 'Reprint' },
  ];

  for (const { service, pvType } of priorities) {
    const match = enabledPVs.find(pv => pv.service === service && pv.pvType === pvType);
    if (match) return match;
  }

  // フォールバック: YouTube or NicoNico の任意のPV
  return enabledPVs.find(pv => pv.service === 'Youtube' || pv.service === 'NicoNicoDouga') || null;
}

interface PlayerState {
  // 現在の再生状態
  currentSong: Song | null;
  currentPV: PV | null;
  isPlaying: boolean;
  volume: number;
  progress: number;
  duration: number;

  // 再生キュー
  queue: Song[];
  queueIndex: number;

  // エラー状態
  error: string | null;

  // アクション
  playSong: (song: Song) => void;
  pause: () => void;
  resume: () => void;
  next: () => void;
  previous: () => void;
  setVolume: (volume: number) => void;
  setProgress: (progress: number) => void;
  setDuration: (duration: number) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setError: (error: string | null) => void;
  
  // キュー操作
  setQueue: (songs: Song[], startIndex?: number) => void;
  addToQueue: (song: Song) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentSong: null,
  currentPV: null,
  isPlaying: false,
  volume: 80,
  progress: 0,
  duration: 0,
  queue: [],
  queueIndex: -1,
  error: null,

  playSong: (song: Song) => {
    const pv = getPlayablePV(song);
    if (!pv) {
      set({ error: `再生可能な動画が見つかりません: ${song.name}` });
      // 自動スキップ
      const { queue, queueIndex } = get();
      if (queueIndex < queue.length - 1) {
        setTimeout(() => get().next(), 500);
      }
      return;
    }
    set({
      currentSong: song,
      currentPV: pv,
      isPlaying: true,
      progress: 0,
      duration: song.lengthSeconds || pv.length || 0,
      error: null,
    });
  },

  pause: () => set({ isPlaying: false }),
  resume: () => set({ isPlaying: true }),

  next: () => {
    const { queue, queueIndex } = get();
    if (queueIndex < queue.length - 1) {
      const nextIndex = queueIndex + 1;
      set({ queueIndex: nextIndex });
      get().playSong(queue[nextIndex]);
    } else {
      // キュー終端: 停止
      set({ isPlaying: false });
    }
  },

  previous: () => {
    const { queue, queueIndex, progress } = get();
    // 再生3秒以上なら曲頭に戻る
    if (progress > 3) {
      set({ progress: 0 });
      return;
    }
    if (queueIndex > 0) {
      const prevIndex = queueIndex - 1;
      set({ queueIndex: prevIndex });
      get().playSong(queue[prevIndex]);
    }
  },

  setVolume: (volume: number) => set({ volume: Math.max(0, Math.min(100, volume)) }),
  setProgress: (progress: number) => set({ progress }),
  setDuration: (duration: number) => set({ duration }),
  setIsPlaying: (isPlaying: boolean) => set({ isPlaying }),
  setError: (error: string | null) => set({ error }),

  setQueue: (songs: Song[], startIndex = 0) => {
    set({ queue: songs, queueIndex: startIndex });
    if (songs.length > 0) {
      get().playSong(songs[startIndex]);
    }
  },

  addToQueue: (song: Song) => {
    const { queue } = get();
    set({ queue: [...queue, song] });
  },

  removeFromQueue: (index: number) => {
    const { queue, queueIndex } = get();
    const newQueue = queue.filter((_, i) => i !== index);
    let newIndex = queueIndex;
    if (index < queueIndex) newIndex--;
    if (index === queueIndex) {
      // 現在再生中の曲を削除
      set({ queue: newQueue, queueIndex: Math.min(newIndex, newQueue.length - 1) });
      if (newQueue.length > 0 && newIndex < newQueue.length) {
        get().playSong(newQueue[newIndex]);
      } else {
        set({ currentSong: null, currentPV: null, isPlaying: false });
      }
      return;
    }
    set({ queue: newQueue, queueIndex: newIndex });
  },

  clearQueue: () => set({
    queue: [],
    queueIndex: -1,
    currentSong: null,
    currentPV: null,
    isPlaying: false,
    progress: 0,
    duration: 0,
  }),
}));
