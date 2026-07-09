/**
 * Player Store - 再生状態のグローバル管理
 * 
 * 曲の再生・停止・スキップ・キュー管理を担当。
 * YouTube/ニコニコの実際の制御は各プレイヤーコンポーネントが行い、
 * このストアは状態の「真実の情報源」として機能する。
 */

import { create } from 'zustand';
import type { Song, PV, PVService, PVType } from '../types/vocadb';
import { dedupeQueueBySongId } from '../utils/queueUtils';
import { storage } from '../utils/storage';
import { useProgressStore } from './progressStore';

type FailedPVMap = Record<string, string[]>;

const FAILED_PVS_KEY = 'failedPVs';
const VOLUME_KEY = 'volume';
const LOOP_MODE_KEY = 'loopMode';
const PLAYER_QUEUE_KEY = 'playerQueue';
const DEFAULT_VOLUME = 50;

type LoopMode = 'none' | 'all' | 'one';
export type PlaybackSource = 'manual' | 'auto';

interface StoredPlayerQueue {
  queue: Song[];
  queueIndex: number;
  currentSong: Song | null;
  queueSources?: PlaybackSource[];
  currentPlaybackSource?: PlaybackSource;
}

const pvPriorities: Array<{ service: PVService; pvType: PVType }> = [
  { service: 'Youtube', pvType: 'Original' },
  { service: 'Youtube', pvType: 'Reprint' },
  { service: 'Youtube', pvType: 'Other' },
  { service: 'NicoNicoDouga', pvType: 'Original' },
  { service: 'NicoNicoDouga', pvType: 'Reprint' },
  { service: 'NicoNicoDouga', pvType: 'Other' },
];

function getPVFailureKey(pv: PV): string {
  return `${pv.service}:${pv.pvId || pv.id}`;
}

function getFailedPVMap(): FailedPVMap {
  return storage.get<FailedPVMap>(FAILED_PVS_KEY) ?? {};
}

function getFailedPVKeys(songId: number): Set<string> {
  return new Set(getFailedPVMap()[String(songId)] ?? []);
}

function markPVFailed(songId: number, pv: PV): void {
  const songKey = String(songId);
  const failureKey = getPVFailureKey(pv);
  const failedMap = getFailedPVMap();
  const currentFailures = new Set(failedMap[songKey] ?? []);

  currentFailures.add(failureKey);
  storage.set(FAILED_PVS_KEY, {
    ...failedMap,
    [songKey]: Array.from(currentFailures),
  });
}

function choosePVByPriority(pvs: PV[]): PV | null {
  for (const { service, pvType } of pvPriorities) {
    const match = pvs.find(pv => pv.service === service && pv.pvType === pvType);
    if (match) return match;
  }

  return pvs.find(pv => pv.service === 'Youtube' || pv.service === 'NicoNicoDouga') || null;
}

function getEnabledPlayablePVs(song: Song): PV[] {
  return (song.pvs ?? []).filter(pv => !pv.disabled);
}

function clampVolume(volume: number): number {
  return Math.max(0, Math.min(100, volume));
}

function getStoredLoopMode(): LoopMode {
  const stored = storage.get<LoopMode>(LOOP_MODE_KEY);
  return stored === 'all' || stored === 'one' ? stored : 'none';
}

function getStoredPlayerQueue(): StoredPlayerQueue | null {
  const stored = storage.get<StoredPlayerQueue>(PLAYER_QUEUE_KEY);
  if (!stored || !Array.isArray(stored.queue)) return null;
  const queueIndex = Number.isInteger(stored.queueIndex) ? stored.queueIndex : -1;
  const queueSources = normalizeQueueSources(stored.queue, stored.queueSources);
  const currentPlaybackSource = stored.currentPlaybackSource === 'auto'
    ? 'auto'
    : queueSources[queueIndex] ?? 'manual';
  return {
    queue: stored.queue,
    queueIndex: queueIndex >= 0 && queueIndex < stored.queue.length ? queueIndex : -1,
    currentSong: stored.currentSong ?? stored.queue[queueIndex] ?? null,
    queueSources,
    currentPlaybackSource,
  };
}

function normalizeQueueSources(queue: Song[], queueSources?: PlaybackSource[]): PlaybackSource[] {
  return queue.map((_, index) => queueSources?.[index] === 'auto' ? 'auto' : 'manual');
}

function savePlayerQueue(
  queue: Song[],
  queueIndex: number,
  currentSong: Song | null,
  queueSources?: PlaybackSource[],
  currentPlaybackSource?: PlaybackSource,
): void {
  const normalizedSources = normalizeQueueSources(queue, queueSources);
  storage.set(PLAYER_QUEUE_KEY, {
    queue,
    queueIndex,
    currentSong,
    queueSources: normalizedSources,
    currentPlaybackSource: currentPlaybackSource ?? normalizedSources[queueIndex] ?? 'manual',
  });
}

function mapSourcesBySongId(
  nextQueue: Song[],
  previousQueue: Song[],
  previousSources: PlaybackSource[],
): PlaybackSource[] {
  const sourceBySongId = new Map<number, PlaybackSource>();
  previousQueue.forEach((song, index) => {
    if (!sourceBySongId.has(song.id)) {
      sourceBySongId.set(song.id, previousSources[index] === 'auto' ? 'auto' : 'manual');
    }
  });
  return nextQueue.map(song => sourceBySongId.get(song.id) ?? 'manual');
}

function clearStoredPlayerQueue(): void {
  storage.remove(PLAYER_QUEUE_KEY);
}

// 再生可能なPVを抽出するヘルパー
export function getPlayablePV(song: Song): PV | null {
  if (!song.pvs || song.pvs.length === 0) return null;

  const enabledPVs = getEnabledPlayablePVs(song);
  const failedPVKeys = getFailedPVKeys(song.id);
  const unfailedPVs = enabledPVs.filter(pv => !failedPVKeys.has(getPVFailureKey(pv)));

  return choosePVByPriority(unfailedPVs) || choosePVByPriority(enabledPVs);
}

export type MixMode = 'balanced' | 'deep' | 'producer';

interface PlayerState {
  // 現在の再生状態
  currentSong: Song | null;
  currentPV: PV | null;
  currentPlaybackSource: PlaybackSource;
  isPlaying: boolean;
  volume: number;

  // 再生キュー
  queue: Song[];
  queueIndex: number;
  queueSources: PlaybackSource[];

  // エラー状態
  error: string | null;

  // アクション
  playSong: (song: Song, isUserAction?: boolean) => void;
  pause: () => void;
  resume: () => void;
  next: () => void;
  previous: () => void;
  setVolume: (volume: number) => void;
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
  addToQueue: (song: Song, source?: PlaybackSource) => void;
  addManyToQueue: (songs: Song[], source?: PlaybackSource) => void;
  removeFromQueue: (index: number) => void;
  removeDuplicateQueueSongs: () => number;
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
  loopMode: LoopMode;
  toggleLoopMode: () => void;

  // ルートシード（Mix起点の曲）
  rootSeed: Song | null;
  setRootSeed: (song: Song | null) => void;

  // Mixモード
  mixMode: MixMode;
  setMixMode: (mode: MixMode) => void;
}

const storedPlayerQueue = getStoredPlayerQueue();
const initialCurrentSong = storedPlayerQueue?.currentSong ?? null;

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentSong: initialCurrentSong,
  currentPV: initialCurrentSong ? getPlayablePV(initialCurrentSong) : null,
  currentPlaybackSource: storedPlayerQueue?.currentPlaybackSource ?? 'manual',
  isPlaying: false,
  volume: clampVolume(storage.get<number>(VOLUME_KEY) ?? DEFAULT_VOLUME),
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
  queue: storedPlayerQueue?.queue ?? [],
  queueIndex: storedPlayerQueue?.queueIndex ?? -1,
  queueSources: storedPlayerQueue?.queueSources ?? [],
  error: null,

  playSong: (song: Song, isUserAction?: boolean) => {
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
    useProgressStore.getState().setDuration(song.lengthSeconds || pv.length || 0);
    useProgressStore.getState().setProgress(0);
    const { queue, queueIndex, queueSources } = get();
    const playbackSource: PlaybackSource = isUserAction
      ? 'manual'
      : queueSources[queueIndex] ?? 'manual';
    const nextQueueSources = isUserAction && queue[queueIndex]?.id === song.id
      ? queueSources.map((source, index) => index === queueIndex ? 'manual' : source)
      : queueSources;
    savePlayerQueue(queue, queueIndex, song, nextQueueSources, playbackSource);
    
    set({
      currentSong: song,
      currentPV: pv,
      currentPlaybackSource: playbackSource,
      queueSources: nextQueueSources,
      isPlaying: true,
      error: null,
      ...(isUserAction ? { rootSeed: song } : {}),
    });
  },

  pause: () => set({ isPlaying: false }),
  resume: () => set({ isPlaying: true }),

  next: () => {
    const { queue, queueIndex, loopMode } = get();
    if (loopMode === 'one') {
      // 1曲ループ: 同じ曲を再度再生
      useProgressStore.getState().setProgress(0);
      set({ seekTarget: 0 });
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
    const { queue, queueIndex } = get();
    const progress = useProgressStore.getState().progress;
    // 再生3秒以上なら曲頭に戻る
    if (progress > 3) {
      useProgressStore.getState().setProgress(0);
      return;
    }
    if (queueIndex > 0) {
      const prevIndex = queueIndex - 1;
      set({ queueIndex: prevIndex });
      get().playSong(queue[prevIndex], true);
    }
  },

  setVolume: (volume: number) => {
    const next = clampVolume(volume);
    storage.set(VOLUME_KEY, next);
    set({ volume: next });
  },
  setIsPlaying: (isPlaying: boolean) => set({ isPlaying }),
  setError: (error: string | null) => set({ error }),

  tryNextPV: () => {
    const { currentSong, currentPV } = get();
    if (!currentSong || !currentSong.pvs) { get().next(); return; }

    if (currentPV) {
      markPVFailed(currentSong.id, currentPV);
    }

    const failedPVKeys = getFailedPVKeys(currentSong.id);
    const enabledPVs = getEnabledPlayablePVs(currentSong).filter(pv => pv.id !== currentPV?.id);
    const unfailedPVs = enabledPVs.filter(pv => !failedPVKeys.has(getPVFailureKey(pv)));
    const nextPV = choosePVByPriority(unfailedPVs) || choosePVByPriority(enabledPVs);

    if (nextPV) {
      set({ currentPV: nextPV, error: null });
    } else {
      get().next();
    }
  },

  setQueue: (songs: Song[], startIndex = 0) => {
    const { shuffleEnabled } = get();
    const manualSources = songs.map(() => 'manual' as PlaybackSource);
    if (shuffleEnabled && songs.length > 0) {
      const current = songs[startIndex];
      const rest = songs.filter((_, i) => i !== startIndex);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      const shuffled = current ? [current, ...rest] : rest;
      const shuffledSources = shuffled.map(() => 'manual' as PlaybackSource);
      set({ queue: shuffled, queueIndex: 0, queueSources: shuffledSources, originalQueue: songs });
      savePlayerQueue(shuffled, 0, shuffled[0] ?? null, shuffledSources, 'manual');
      get().playSong(shuffled[0], true);
    } else {
      set({ queue: songs, queueIndex: startIndex, queueSources: manualSources, originalQueue: [] });
      savePlayerQueue(songs, startIndex, songs[startIndex] ?? null, manualSources, 'manual');
      if (songs.length > 0) get().playSong(songs[startIndex], true);
    }
  },

  replaceQueueList: (songs: Song[]) => {
    const { queue, queueSources } = get();
    const nextSources = mapSourcesBySongId(songs, queue, queueSources);
    const queueIndex = Math.min(get().queueIndex, songs.length - 1);
    const currentSong = queueIndex >= 0 ? songs[queueIndex] : null;
    set({ queue: songs, queueIndex, queueSources: nextSources });
    savePlayerQueue(songs, queueIndex, currentSong, nextSources);
  },

  addToQueue: (song: Song, source: PlaybackSource = 'manual') => {
    const { queue, queueIndex, queueSources, currentSong, currentPlaybackSource } = get();
    const nextQueue = [...queue, song];
    const nextSources = [...queueSources, source];
    set({ queue: nextQueue, queueSources: nextSources });
    savePlayerQueue(nextQueue, queueIndex, currentSong, nextSources, currentPlaybackSource);
  },

  addManyToQueue: (songs: Song[], source: PlaybackSource = 'manual') => {
    const { queue, queueIndex, queueSources, currentSong, currentPlaybackSource } = get();
    const nextQueue = [...queue, ...songs];
    const nextSources = [...queueSources, ...songs.map(() => source)];
    set({ queue: nextQueue, queueSources: nextSources });
    savePlayerQueue(nextQueue, queueIndex, currentSong, nextSources, currentPlaybackSource);
  },

  removeFromQueue: (index: number) => {
    const { queue, queueIndex, queueSources } = get();
    const newQueue = queue.filter((_, i) => i !== index);
    const newSources = queueSources.filter((_, i) => i !== index);
    let newIndex = queueIndex;
    if (index < queueIndex) newIndex--;
    if (index === queueIndex) {
      // 現在再生中の曲を削除
      set({ queue: newQueue, queueIndex: Math.min(newIndex, newQueue.length - 1), queueSources: newSources });
      if (newQueue.length > 0 && newIndex < newQueue.length) {
        const nextIndex = Math.min(newIndex, newQueue.length - 1);
        savePlayerQueue(newQueue, nextIndex, newQueue[nextIndex] ?? null, newSources);
        get().playSong(newQueue[newIndex]);
      } else {
        set({ currentSong: null, currentPV: null, currentPlaybackSource: 'manual', isPlaying: false });
        clearStoredPlayerQueue();
      }
      return;
    }
    set({ queue: newQueue, queueIndex: newIndex, queueSources: newSources });
    savePlayerQueue(newQueue, newIndex, get().currentSong, newSources, get().currentPlaybackSource);
  },

  removeDuplicateQueueSongs: () => {
    const { queue, queueIndex, queueSources, currentSong, currentPlaybackSource } = get();
    const { queue: newQueue, queueIndex: nextIndex, currentSong: nextCurrentSong, removed } =
      dedupeQueueBySongId(queue, queueIndex, currentSong);
    if (removed === 0) return 0;
    const nextSources = mapSourcesBySongId(newQueue, queue, queueSources);

    set({
      queue: newQueue,
      queueIndex: nextIndex,
      queueSources: nextSources,
      currentSong: nextCurrentSong,
      currentPV: nextCurrentSong ? getPlayablePV(nextCurrentSong) : null,
      isPlaying: nextCurrentSong ? get().isPlaying : false,
    });
    savePlayerQueue(newQueue, nextIndex, nextCurrentSong, nextSources, currentPlaybackSource);
    return removed;
  },

  clearQueue: () => {
    useProgressStore.getState().resetProgress();
    set({
      queue: [],
      queueIndex: -1,
      queueSources: [],
      currentSong: null,
      currentPV: null,
      currentPlaybackSource: 'manual',
      isPlaying: false,
    });
    clearStoredPlayerQueue();
  },

  jumpToIndex: (index: number) => {
    const { queue, queueSources } = get();
    if (index < 0 || index >= queue.length) return;
    const nextSources = queueSources.map((source, i) => i === index ? 'manual' : source);
    set({ queueIndex: index, queueSources: nextSources });
    savePlayerQueue(queue, index, queue[index], nextSources, 'manual');
    get().playSong(queue[index], true);
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
  loopMode: getStoredLoopMode(),
  toggleLoopMode: () => {
    const { loopMode } = get();
    const next: LoopMode =
      loopMode === 'none' ? 'all' : loopMode === 'all' ? 'one' : 'none';
    storage.set(LOOP_MODE_KEY, next);
    set({ loopMode: next });
  },

  // ─── ルートシード ──────────────────────────────────────────────────────────
  rootSeed: null,
  setRootSeed: (song) => set({ rootSeed: song }),

  // ─── Mixモード ─────────────────────────────────────────────────────────────
  mixMode: 'balanced',
  setMixMode: (mode) => set({ mixMode: mode }),

  toggleShuffle: () => {
    const { shuffleEnabled, queue, queueIndex, queueSources, currentSong, currentPlaybackSource, originalQueue } = get();

    if (shuffleEnabled) {
      // シャッフル解除: 元の順序に戻す
      const newIndex = currentSong
        ? originalQueue.findIndex(s => s.id === currentSong.id)
        : queueIndex;
      const restoredSources = mapSourcesBySongId(originalQueue, queue, queueSources);
      set({
        shuffleEnabled: false,
        queue: originalQueue,
        queueSources: restoredSources,
        originalQueue: [],
        queueIndex: newIndex < 0 ? 0 : newIndex,
      });
      savePlayerQueue(originalQueue, newIndex < 0 ? 0 : newIndex, currentSong, restoredSources, currentPlaybackSource);
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
      const shuffledSources = mapSourcesBySongId(shuffled, queue, queueSources);
      set({
        shuffleEnabled: true,
        originalQueue: queue,
        queue: shuffled,
        queueSources: shuffledSources,
        queueIndex: 0,
      });
      savePlayerQueue(shuffled, 0, currentSong, shuffledSources, currentPlaybackSource);
    }
  },
}));
