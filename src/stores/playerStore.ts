/**
 * Player Store - 再生状態のグローバル管理
 * 
 * 曲の再生・停止・スキップ・キュー管理を担当。
 * YouTube/ニコニコの実際の制御は各プレイヤーコンポーネントが行い、
 * このストアは状態の「真実の情報源」として機能する。
 */

import { create } from 'zustand';
import type { Song, PV } from '../types/vocadb';
import { storage } from '../utils/storage';

// 再生可能なPVを抽出するヘルパー
export function getPlayablePV(song: Song): PV | null {
  if (!song.pvs || song.pvs.length === 0) return null;

  const enabledPVs = song.pvs.filter(pv => !pv.disabled);

  // 優先順位: YouTube (Official/非公式問わず) > NicoNico
  // NicoNico は iframe 埋め込み制限があるため YouTube を最優先
  const priorities: Array<{ service: string; pvType: string }> = [
    { service: 'Youtube', pvType: 'Original' },      // 1. 公式YT
    { service: 'Youtube', pvType: 'Reprint' },        // 2. 非公式YT
    { service: 'Youtube', pvType: 'Other' },          // 2. 非公式YT
    { service: 'NicoNicoDouga', pvType: 'Original' }, // 3. 公式ニコ
    { service: 'NicoNicoDouga', pvType: 'Reprint' },  // 4. 非公式ニコ
    { service: 'NicoNicoDouga', pvType: 'Other' },    // 4. 非公式ニコ
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
  tryNextPV: () => void;

  // 詳細パネルのプレイヤー表示先DOM
  detailPanelEl: HTMLElement | null;
  setDetailPanelEl: (el: HTMLElement | null) => void;

  // Global Player Rect (WatchPageでのプレイヤーの位置とサイズ)
  playerRect: DOMRect | null;
  setPlayerRect: (rect: DOMRect | null) => void;

  // 隠しモード（サムネイル・動画を非表示）
  hiddenMode: boolean;
  toggleHiddenMode: () => void;

  // 自動キュー（常時ON）
  autoQueue: boolean;
  toggleAutoQueue: () => void;

  // シーク（プログレスバーから再生位置を変更）
  seekTarget: number | null;
  seekTo: (t: number) => void;
  clearSeekTarget: () => void;
  
  // キュー操作
  setQueue: (songs: Song[], startIndex?: number) => void;
  replaceQueueList: (songs: Song[]) => void;
  addToQueue: (song: Song) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  jumpToIndex: (index: number) => void;

  // キュードロワー
  queueDrawerOpen: boolean;
  toggleQueueDrawer: () => void;

  // 履歴ドロワー
  historyDrawerOpen: boolean;
  toggleHistoryDrawer: () => void;

  // シャッフル
  shuffleEnabled: boolean;
  originalQueue: Song[];   // シャッフル前の順序を保持
  toggleShuffle: () => void;

  // ループモード
  loopMode: 'none' | 'all' | 'one';
  toggleLoopMode: () => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentSong: null,
  currentPV: null,
  isPlaying: false,
  volume: 80,
  progress: 0,
  duration: 0,
  detailPanelEl: null,
  setDetailPanelEl: (el) => set({ detailPanelEl: el }),
  playerRect: null,
  setPlayerRect: (rect) => set({ playerRect: rect }),
  hiddenMode: storage.get<boolean>('hiddenMode') ?? false,
  toggleHiddenMode: () => set((state) => {
    const next = !state.hiddenMode;
    storage.set('hiddenMode', next);
    return { hiddenMode: next };
  }),
  autoQueue: true, // 常にON
  toggleAutoQueue: () => {}, // 廃止 (常時ON)

  seekTarget: null,
  seekTo: (t) => set({ seekTarget: t }),
  clearSeekTarget: () => set({ seekTarget: null }),
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
    const { queue, queueIndex, loopMode } = get();
    if (loopMode === 'one') {
      // 1曲ループ: 同じ曲を再度再生
      set({ progress: 0, seekTarget: 0 });
      get().playSong(queue[queueIndex]);
      return;
    }
    if (queueIndex < queue.length - 1) {
      const nextIndex = queueIndex + 1;
      set({ queueIndex: nextIndex });
      get().playSong(queue[nextIndex]);
    } else if (loopMode === 'all' && queue.length > 0) {
      // 全体ループ: 先頭に戻る
      set({ queueIndex: 0 });
      get().playSong(queue[0]);
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

  tryNextPV: () => {
    const { currentSong, currentPV } = get();
    if (!currentSong || !currentSong.pvs) { get().next(); return; }

    const enabledPVs = currentSong.pvs.filter(pv => !pv.disabled && (pv.service === 'Youtube' || pv.service === 'NicoNicoDouga'));
    const currentIndex = enabledPVs.findIndex(pv => pv.id === currentPV?.id);
    const nextPV = enabledPVs[currentIndex + 1];

    if (nextPV) {
      set({ currentPV: nextPV, error: null });
    } else {
      get().next();
    }
  },

  setQueue: (songs: Song[], startIndex = 0) => {
    const { shuffleEnabled } = get();
    if (shuffleEnabled && songs.length > 0) {
      const current = songs[startIndex];
      const rest = songs.filter((_, i) => i !== startIndex);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      const shuffled = current ? [current, ...rest] : rest;
      set({ queue: shuffled, queueIndex: 0, originalQueue: songs });
      get().playSong(shuffled[0]);
    } else {
      set({ queue: songs, queueIndex: startIndex, originalQueue: [] });
      if (songs.length > 0) get().playSong(songs[startIndex]);
    }
  },

  replaceQueueList: (songs: Song[]) => {
    set({ queue: songs });
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

  jumpToIndex: (index: number) => {
    const { queue } = get();
    if (index < 0 || index >= queue.length) return;
    set({ queueIndex: index });
    get().playSong(queue[index]);
  },

  queueDrawerOpen: false,
  // キュードロワーを開くときに履歴ドロワーを閉じる（排他制御）
  toggleQueueDrawer: () => set((state) => ({
    queueDrawerOpen: !state.queueDrawerOpen,
    historyDrawerOpen: false,
  })),

  historyDrawerOpen: false,
  // 履歴ドロワーを開くときにキュードロワーを閉じる（排他制御）
  toggleHistoryDrawer: () => set((state) => ({
    historyDrawerOpen: !state.historyDrawerOpen,
    queueDrawerOpen: false,
  })),

  // ─── シャッフル ──────────────────────────────────────────────────────────────
  shuffleEnabled: false,
  originalQueue: [],

  // ─── ループモード ──────────────────────────────────────────────────────────
  loopMode: 'none',
  toggleLoopMode: () => {
    const { loopMode } = get();
    const next: 'none' | 'all' | 'one' =
      loopMode === 'none' ? 'all' : loopMode === 'all' ? 'one' : 'none';
    set({ loopMode: next });
  },

  toggleShuffle: () => {
    const { shuffleEnabled, queue, queueIndex, currentSong, originalQueue } = get();

    if (shuffleEnabled) {
      // シャッフル解除: 元の順序に戻す
      const newIndex = currentSong
        ? originalQueue.findIndex(s => s.id === currentSong.id)
        : queueIndex;
      set({
        shuffleEnabled: false,
        queue: originalQueue,
        originalQueue: [],
        queueIndex: newIndex < 0 ? 0 : newIndex,
      });
    } else {
      // シャッフル有効化: 現在曲を先頭に置き残りをランダム化
      if (queue.length === 0) { set({ shuffleEnabled: true }); return; }
      const current = queue[queueIndex];
      const rest = queue.filter((_, i) => i !== queueIndex);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      const shuffled = current ? [current, ...rest] : rest;
      set({
        shuffleEnabled: true,
        originalQueue: queue,
        queue: shuffled,
        queueIndex: 0,
      });
    }
  },
}));
