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
