import { describe, expect, it, vi } from 'vitest';
import { AsyncTtlCache } from './asyncTtlCache';

describe('AsyncTtlCache', () => {
  it('reuses a completed value until its TTL expires', async () => {
    let now = 1_000;
    const cache = new AsyncTtlCache(100, 10, () => now);
    const loader = vi.fn().mockResolvedValue({ value: 1 });

    expect((await cache.get('key', loader)).status).toBe('miss');
    expect((await cache.get('key', loader)).status).toBe('hit');
    expect(loader).toHaveBeenCalledTimes(1);

    now += 101;
    expect((await cache.get('key', loader)).status).toBe('miss');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight request for the same key', async () => {
    const cache = new AsyncTtlCache(100);
    let resolve!: (value: number) => void;
    const loader = vi.fn(() => new Promise<number>(done => { resolve = done; }));

    const first = cache.get('key', loader);
    const second = cache.get('key', loader);
    resolve(42);

    expect(await first).toEqual({ value: 42, status: 'miss' });
    expect(await second).toEqual({ value: 42, status: 'shared' });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used completed value', async () => {
    const cache = new AsyncTtlCache(1_000, 2);
    await cache.get('one', async () => 1);
    await cache.get('two', async () => 2);
    expect(cache.peek('one')).toBe(1);
    await cache.get('three', async () => 3);

    expect(cache.peek('one')).toBe(1);
    expect(cache.peek('two')).toBeNull();
  });
});
