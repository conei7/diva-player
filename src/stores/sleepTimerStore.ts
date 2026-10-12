/**
 * sleepTimerStore.ts - スリープタイマーの期限
 *
 * 期限（epoch ms）だけを持つ。期限の監視と一時停止は player の SleepTimerWatcher が行う。
 * 保存キーは従来どおり 'sleepTimerUntil'（utils/storage 経由で diva_sleepTimerUntil）。
 */
import { create } from 'zustand';
import { storage } from '../utils/storage';

export const SLEEP_TIMER_STORAGE_KEY = 'sleepTimerUntil';
export const SLEEP_TIMER_OPTIONS = [15, 30, 60, 90] as const;
export type SleepTimerMinutes = typeof SLEEP_TIMER_OPTIONS[number];

interface SleepTimerState {
  /** 停止する時刻（epoch ms）。null = タイマーなし */
  until: number | null;
  start: (minutes: SleepTimerMinutes) => void;
  clear: () => void;
}

function removeStoredUntil(): void {
  try {
    storage.remove(SLEEP_TIMER_STORAGE_KEY);
  } catch {
    // localStorage is unavailable (private mode, tests); the in-memory state is still cleared.
  }
}

/** A stored deadline that has already passed is dropped instead of pausing a fresh session. */
function readStoredUntil(now = Date.now()): number | null {
  const stored = storage.get<unknown>(SLEEP_TIMER_STORAGE_KEY);
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return null;
  if (stored <= now) {
    removeStoredUntil();
    return null;
  }
  return stored;
}

/** Milliseconds left before the timer fires (0 when there is no active timer). */
export function getSleepTimerRemainingMs(until: number | null, now = Date.now()): number {
  return until === null ? 0 : Math.max(0, until - now);
}

export const useSleepTimerStore = create<SleepTimerState>((set) => ({
  until: readStoredUntil(),
  start: (minutes) => {
    const until = Date.now() + minutes * 60 * 1000;
    storage.set(SLEEP_TIMER_STORAGE_KEY, until);
    set({ until });
  },
  clear: () => {
    removeStoredUntil();
    set({ until: null });
  },
}));
