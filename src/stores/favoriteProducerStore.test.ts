import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let store: typeof import('./favoriteProducerStore');
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T12:00:00+09:00'));
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('window', { localStorage });
  store = await import('./favoriteProducerStore');
  store.useFavoriteProducerStore.setState({ producers: [7, 8].map(id => ({ id, name: `P${id}`, artistType: 'Producer', createdAt: 100 })) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('followed release acknowledgement', () => {
  it('unions same-day IDs, scopes producers, and rejects stale acknowledgements', () => {
    const state = store.useFavoriteProducerStore.getState();
    const first = Date.parse('2026-11-15T09:00:00+09:00');
    state.markReleasesChecked([7], first, [10]);
    state.markReleasesChecked([7], first + 1, [11]);
    state.markReleasesChecked([7], first - 1, [12]);
    const [updated, untouched] = store.useFavoriteProducerStore.getState().producers;
    expect(updated.checkedReleaseIds).toEqual([10, 11]);
    expect(updated.releasesCheckedAt).toBe(first + 1);
    expect(untouched.releasesCheckedAt).toBeUndefined();
  });
  it('compacts acknowledgement IDs on the next JST day and persists them', async () => {
    const state = store.useFavoriteProducerStore.getState();
    state.markReleasesChecked([7], Date.parse('2026-11-14T23:59:00+09:00'), [10]);
    state.markReleasesChecked([7], Date.parse('2026-11-15T00:01:00+09:00'), [11]);
    expect(store.useFavoriteProducerStore.getState().producers[0].checkedReleaseIds).toEqual([11]);
    await store.useFavoriteProducerStore.persist.rehydrate();
    expect(store.useFavoriteProducerStore.getState().producers[0].checkedReleaseIds).toEqual([11]);
  });
  it('preserves new fields during backup normalization while accepting old records', () => {
    const original = store.useFavoriteProducerStore.getState().producers;
    expect(store.normalizeFavoriteProducers(original)).toEqual(original);
    const checked = { ...original[0], releasesCheckedAt: Date.now(), checkedReleaseIds: [10, 10, -1] };
    expect(store.normalizeFavoriteProducers([checked])[0]).toEqual({ ...checked, checkedReleaseIds: [10] });
  });
});
