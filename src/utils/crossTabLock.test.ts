import { describe, expect, it, vi } from 'vitest';
import { withCrossTabLock } from './crossTabLock';

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: key => data.get(key) ?? null,
    key: index => [...data.keys()][index] ?? null,
    removeItem: key => { data.delete(key); },
    setItem: (key, value) => { data.set(key, value); },
  };
}

describe('withCrossTabLock', () => {
  it('runs under a fallback lease and releases only its own lease', async () => {
    const storage = createStorage();
    const task = vi.fn(async () => 'done');
    const result = await withCrossTabLock({
      name: 'sync',
      fallbackKey: 'sync-lock',
      storage,
      lockManager: null,
      now: () => 1_000,
      createOwnerId: () => 'owner-a',
    }, task);

    expect(result).toBe('done');
    expect(task).toHaveBeenCalledOnce();
    expect(storage.getItem('sync-lock')).toBeNull();
  });

  it('skips while another non-expired fallback lease exists', async () => {
    const storage = createStorage();
    storage.setItem('sync-lock', JSON.stringify({ owner: 'owner-b', expiresAt: 2_000 }));
    const task = vi.fn(async () => 'done');

    const result = await withCrossTabLock({
      name: 'sync',
      fallbackKey: 'sync-lock',
      storage,
      lockManager: null,
      now: () => 1_000,
      createOwnerId: () => 'owner-a',
    }, task);

    expect(result).toBeNull();
    expect(task).not.toHaveBeenCalled();
  });

  it('takes over an expired lease', async () => {
    const storage = createStorage();
    storage.setItem('sync-lock', JSON.stringify({ owner: 'owner-b', expiresAt: 999 }));

    await expect(withCrossTabLock({
      name: 'sync',
      fallbackKey: 'sync-lock',
      storage,
      lockManager: null,
      now: () => 1_000,
      createOwnerId: () => 'owner-a',
    }, async () => 42)).resolves.toBe(42);
  });
});
