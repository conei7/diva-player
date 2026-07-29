import { describe, expect, it } from 'vitest';
import { readLongPressSelectionEnabled, writeLongPressSelectionEnabled } from './selectionPreferences';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } as unknown as Storage;
}

describe('long-press selection preference', () => {
  it('defaults to enabled and persists the off state', () => {
    const saved = storage();
    expect(readLongPressSelectionEnabled(saved)).toBe(true);
    writeLongPressSelectionEnabled(false, saved);
    expect(readLongPressSelectionEnabled(saved)).toBe(false);
    writeLongPressSelectionEnabled(true, saved);
    expect(readLongPressSelectionEnabled(saved)).toBe(true);
  });
});
