import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
    clear: () => values.clear(),
    values,
  };
}

async function loadStore(initial: Record<string, string> = {}) {
  const localStorage = memoryStorage(initial);
  vi.stubGlobal('localStorage', localStorage);
  vi.resetModules();
  const module = await import('./sleepTimerStore');
  return { ...module, localStorage };
}

describe('sleepTimerStore', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts, persists, and clears the deadline under the existing key', async () => {
    const { useSleepTimerStore, getSleepTimerRemainingMs, localStorage } = await loadStore();
    useSleepTimerStore.getState().start(30);
    const until = useSleepTimerStore.getState().until;
    expect(until).toBe(now + 30 * 60 * 1000);
    expect(localStorage.values.get('diva_sleepTimerUntil')).toBe(String(until));
    expect(getSleepTimerRemainingMs(until, now + 60_000)).toBe(29 * 60 * 1000);

    useSleepTimerStore.getState().clear();
    expect(useSleepTimerStore.getState().until).toBeNull();
    expect(localStorage.values.has('diva_sleepTimerUntil')).toBe(false);
    expect(getSleepTimerRemainingMs(null)).toBe(0);
  });

  it('restores a pending deadline and drops an expired one', async () => {
    const pending = await loadStore({ diva_sleepTimerUntil: String(now + 5 * 60 * 1000) });
    expect(pending.useSleepTimerStore.getState().until).toBe(now + 5 * 60 * 1000);

    const expired = await loadStore({ diva_sleepTimerUntil: String(now - 1_000) });
    expect(expired.useSleepTimerStore.getState().until).toBeNull();
    expect(expired.localStorage.values.has('diva_sleepTimerUntil')).toBe(false);
  });

  it('offers the existing timer lengths', async () => {
    const { SLEEP_TIMER_OPTIONS } = await loadStore();
    expect(SLEEP_TIMER_OPTIONS).toEqual([15, 30, 60, 90]);
  });
});
