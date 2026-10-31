import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';

let selectCanGoNext: typeof import('./useCanGoNext').selectCanGoNext;

beforeAll(async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() { return values.size; },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
  });
  ({ selectCanGoNext } = await import('./useCanGoNext'));
});

const songs = [1, 2, 3].map(id => ({ id, name: `Song ${id}` }) as Song);
const state = (overrides: Partial<Parameters<typeof selectCanGoNext>[0]>) => ({
  queue: songs,
  queueIndex: 0,
  loopMode: 'none' as const,
  restoringQueueWindow: null,
  ...overrides,
});

describe('selectCanGoNext', () => {
  it('is true while a next song follows', () => {
    expect(selectCanGoNext(state({ queueIndex: 1 }))).toBe(true);
  });

  it('is false at the end of the queue unless the queue repeats', () => {
    expect(selectCanGoNext(state({ queueIndex: 2 }))).toBe(false);
    expect(selectCanGoNext(state({ queue: songs.slice(0, 1) }))).toBe(false);
    expect(selectCanGoNext(state({ queueIndex: 2, loopMode: 'all' }))).toBe(true);
    expect(selectCanGoNext(state({ queueIndex: 2, loopMode: 'one' }))).toBe(true);
  });

  it('is false without a queue', () => {
    expect(selectCanGoNext(state({ queue: [], queueIndex: -1, loopMode: 'all' }))).toBe(false);
  });

  it('reads the loaded window during a cold restore', () => {
    const restoring = { songs: songs.slice(1), offset: 1 };
    expect(selectCanGoNext(state({ queue: [], queueIndex: 1, restoringQueueWindow: restoring }))).toBe(true);
    expect(selectCanGoNext(state({ queue: [], queueIndex: 2, restoringQueueWindow: restoring }))).toBe(false);
  });

  it('lets a repeating queue go on at the end of the window during a cold restore', () => {
    const restoring = { songs: songs.slice(1), offset: 1 };
    expect(selectCanGoNext(state({ queue: [], queueIndex: 2, loopMode: 'all', restoringQueueWindow: restoring }))).toBe(true);
    expect(selectCanGoNext(state({ queue: [], queueIndex: 2, loopMode: 'one', restoringQueueWindow: restoring }))).toBe(true);
  });
});
