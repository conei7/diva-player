export interface CrossTabLockOptions {
  name: string;
  fallbackKey: string;
  ttlMs?: number;
  storage?: Storage;
  lockManager?: LockManager | null;
  now?: () => number;
  createOwnerId?: () => string;
}

interface StoredLease {
  owner: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;

function defaultStorage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function defaultLockManager(): LockManager | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.locks;
}

function parseLease(raw: string | null): StoredLease | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLease>;
    return typeof parsed.owner === 'string' && typeof parsed.expiresAt === 'number'
      ? { owner: parsed.owner, expiresAt: parsed.expiresAt }
      : null;
  } catch {
    return null;
  }
}

export async function withCrossTabLock<T>(
  options: CrossTabLockOptions,
  task: () => Promise<T>,
): Promise<T | null> {
  const lockManager = options.lockManager === undefined
    ? defaultLockManager()
    : options.lockManager ?? undefined;
  if (lockManager?.request) {
    return lockManager.request(options.name, { ifAvailable: true }, async lock => (
      lock ? task() : null
    ));
  }

  const storage = options.storage ?? defaultStorage();
  if (!storage) return task();
  const now = options.now ?? Date.now;
  const owner = options.createOwnerId?.()
    ?? `${now()}-${Math.random().toString(36).slice(2)}`;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let acquired: boolean;

  try {
    const existing = parseLease(storage.getItem(options.fallbackKey));
    if (existing && existing.expiresAt > now() && existing.owner !== owner) return null;
    storage.setItem(options.fallbackKey, JSON.stringify({ owner, expiresAt: now() + ttlMs }));
    acquired = parseLease(storage.getItem(options.fallbackKey))?.owner === owner;
  } catch {
    // Storage can be unavailable in privacy modes. The task is still safe to run
    // in this tab; only the cross-tab fallback is unavailable.
    return task();
  }

  if (!acquired) return null;
  try {
    return await task();
  } finally {
    try {
      if (parseLease(storage.getItem(options.fallbackKey))?.owner === owner) {
        storage.removeItem(options.fallbackKey);
      }
    } catch {
      // The lease expires without an explicit release.
    }
  }
}
