const LONG_PRESS_SELECTION_KEY = 'diva-long-press-selection';

export function readLongPressSelectionEnabled(storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): boolean {
  try {
    return storage?.getItem(LONG_PRESS_SELECTION_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeLongPressSelectionEnabled(enabled: boolean, storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): void {
  try {
    storage?.setItem(LONG_PRESS_SELECTION_KEY, enabled ? '1' : '0');
  } catch {
    // Private browsing or a disabled storage backend should not block selection.
  }
}

export { LONG_PRESS_SELECTION_KEY };
