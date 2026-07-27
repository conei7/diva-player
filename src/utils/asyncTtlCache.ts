export type AsyncCacheStatus = 'hit' | 'miss' | 'shared';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export interface AsyncCacheResult<T> {
  value: T;
  status: AsyncCacheStatus;
}

/**
 * 同一キーの処理を共有し、完了値を短時間だけ保持する小さなメモリキャッシュ。
 * API検索の連打やReact StrictModeによる重複要求を1本にまとめる。
 */
export class AsyncTtlCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    ttlMs: number,
    maxEntries = 100,
    now: () => number = Date.now,
  ) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  peek<T>(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    // Mapの末尾を最新アクセスとして扱い、上限超過時に古いものから捨てる。
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  async get<T>(key: string, loader: () => Promise<T>): Promise<AsyncCacheResult<T>> {
    const cached = this.peek<T>(key);
    if (cached !== null) return { value: cached, status: 'hit' };

    const existing = this.inFlight.get(key);
    if (existing) return { value: await existing as T, status: 'shared' };

    const request = loader()
      .then(value => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return { value: await request, status: 'miss' };
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}
