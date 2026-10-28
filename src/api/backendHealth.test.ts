import { describe, expect, it, vi } from 'vitest';
import { checkBackendHealth, resolveBackendConnectivityStatus } from './backendHealth';

describe('checkBackendHealth', () => {
  it('returns true for a healthy response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    await expect(checkBackendHealth({ fetchImpl, retryDelayMs: 0 })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/backend-api/api/ready', expect.any(Object));
  });

  it('retries a transient failure', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('temporary tunnel failure'))
      .mockResolvedValueOnce({ ok: true });

    await expect(checkBackendHealth({ fetchImpl, retryDelayMs: 0 })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a rate-limited response as reachable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });

    await expect(checkBackendHealth({ fetchImpl, retryDelayMs: 0 })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shares simultaneous banner and recommendation probes, then checks afresh', async () => {
    let finish!: (response: { ok: boolean }) => void;
    const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ ok: true });
    const banner = checkBackendHealth({ fetchImpl });
    const recommendation = checkBackendHealth({ fetchImpl, baseUrl: '/backend-api/' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    await expect(Promise.all([banner, recommendation])).resolves.toEqual([true, true]);
    await expect(checkBackendHealth({ fetchImpl })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares the complete retry and releases a failed probe for recovery', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(Promise.all([
      checkBackendHealth({ fetchImpl, retryDelayMs: 0 }),
      checkBackendHealth({ fetchImpl, retryDelayMs: 0 }),
    ])).resolves.toEqual([false, false]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    fetchImpl.mockResolvedValue({ ok: true });
    await expect(checkBackendHealth({ fetchImpl, retryDelayMs: 0 })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('keeps different origins and timeout policies independent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    await Promise.all([
      checkBackendHealth({ fetchImpl }),
      checkBackendHealth({ fetchImpl, baseUrl: '/another-api' }),
      checkBackendHealth({ fetchImpl, timeoutMs: 1000 }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not mix different request implementations', async () => {
    const first = vi.fn().mockResolvedValue({ ok: true });
    const second = vi.fn().mockResolvedValue({ ok: false });
    await expect(Promise.all([
      checkBackendHealth({ fetchImpl: first, attempts: 1 }),
      checkBackendHealth({ fetchImpl: second, attempts: 1 }),
    ])).resolves.toEqual([true, false]);
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
