import { describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';
import type { ListeningPlayEvent } from './historyStore';

/*
 * The store hydrates on import: IndexedDB has to look available (the database itself is mocked)
 * and the legacy migration already done before the module loads.
 */
const state = vi.hoisted(() => {
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'diva-history-log-migrated-v1' ? '1' : null),
    setItem: () => {},
    removeItem: () => {},
  });
  let resolveMetadata: (songs: Song[]) => void = () => {};
  return {
    events: [{ id: 1, s: 10, t: 1000, f: 1 }, { id: 2, s: 20, t: 2000, f: 1 }] as ListeningPlayEvent[],
    metadataRequests: [] as number[][],
    metadata: new Promise<Song[]>(resolve => { resolveMetadata = resolve; }),
    resolveMetadata: (songs: Song[]) => resolveMetadata(songs),
  };
});
vi.mock('../services/historyDatabase', () => ({
  HISTORY_STORES: { plays: 'plays', pending: 'stats_pending' },
  openHistoryDb: async () => ({
    transaction: () => ({
      objectStore: () => ({
        getAll: () => {
          const request: { result: ListeningPlayEvent[]; onsuccess?: () => void } = { result: state.events };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        },
      }),
    }),
  }),
}));
vi.mock('../api/vocadb', () => ({
  getSongsByIds: (ids: number[]) => {
    state.metadataRequests.push(ids);
    return state.metadata;
  },
}));
vi.mock('idb-keyval', () => ({ get: vi.fn(), del: vi.fn() }));
import { useHistoryStore } from './historyStore';

describe('history hydration', () => {
  it('knows how many plays are stored before the song metadata arrives', async () => {
    await vi.waitFor(() => expect(state.metadataRequests).toEqual([[20, 10]]));
    expect(useHistoryStore.getState()).toMatchObject({ hasHydrated: false, storedPlayCount: 2, entries: [] });

    state.resolveMetadata([{ id: 10, name: 'a' } as Song, { id: 20, name: 'b' } as Song]);
    await useHistoryStore.getState().initializeHistory();
    expect(useHistoryStore.getState()).toMatchObject({ hasHydrated: true, storedPlayCount: 2, totalPlays: 2 });
    expect(useHistoryStore.getState().entries.map(entry => entry.song.id)).toEqual([20, 10]);
  });
});
