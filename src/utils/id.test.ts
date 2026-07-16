import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStableId } from './id';

describe('createStableId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses crypto.randomUUID when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-test' });
    expect(createStableId('playlist')).toBe('uuid-test');
  });

  it('falls back to a unique HTTP-safe ID when UUID is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    const first = createStableId('playlist');
    const second = createStableId('playlist');
    expect(first).toMatch(/^playlist-/);
    expect(second).toMatch(/^playlist-/);
    expect(second).not.toBe(first);
  });
});
