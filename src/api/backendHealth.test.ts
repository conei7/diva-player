import { describe, expect, it, vi } from 'vitest';
import { checkBackendHealth, resolveBackendConnectivityStatus } from './backendHealth';

describe('checkBackendHealth', () => {
  it('returns true for a healthy response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    await expect(checkBackendHealth({ fetchImpl, retryDelayMs: 0 })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('temporary tunnel failure'))
      .mockResolvedValueOnce({ ok: true });

    await expect(checkBackendHealth({ fetchImpl, retryDelayMs: 0 })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns false after all attempts fail', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false });

    await expect(checkBackendHealth({ fetchImpl, attempts: 2, retryDelayMs: 0 })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('resolveBackendConnectivityStatus', () => {
  it('prioritizes browser offline state', () => {
    expect(resolveBackendConnectivityStatus({ available: true, online: false })).toBe('offline');
  });

  it('distinguishes backend outage from a healthy backend', () => {
    expect(resolveBackendConnectivityStatus({ available: false, online: true })).toBe('unavailable');
    expect(resolveBackendConnectivityStatus({ available: true, online: true })).toBe('healthy');
  });

  it('keeps the initial state explicit', () => {
    expect(resolveBackendConnectivityStatus({ available: null, online: true })).toBe('checking');
  });
});
