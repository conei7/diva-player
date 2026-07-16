import { describe, expect, it, vi } from 'vitest';
import { checkBackendHealth } from './backendHealth';

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
