const SWIPE_GESTURE_KEY = 'diva-player-swipe-gesture';

export function readSwipeGestureEnabled(storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): boolean {
  try {
    return storage?.getItem(SWIPE_GESTURE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeSwipeGestureEnabled(enabled: boolean, storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): void {
  try {
    storage?.setItem(SWIPE_GESTURE_KEY, enabled ? '1' : '0');
  } catch {
    // Private browsing or a disabled storage backend should not block playback.
  }
}

export { SWIPE_GESTURE_KEY };

/** 設定 > 全般 > 小窓プレイヤー (per browser and origin; on unless turned off). */
export const FLOATING_PLAYER_KEY = 'diva-player-floating-window';

export function readFloatingPlayerEnabled(storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): boolean {
  try {
    return storage?.getItem(FLOATING_PLAYER_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeFloatingPlayerEnabled(enabled: boolean, storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): void {
  try {
    storage?.setItem(FLOATING_PLAYER_KEY, enabled ? '1' : '0');
  } catch {
    // The choice still applies to this page view.
  }
}
