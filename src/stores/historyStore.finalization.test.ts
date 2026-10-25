import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListeningPlayEvent } from './historyStore';

const state = vi.hoisted(() => ({
  event: undefined as ListeningPlayEvent | undefined,
  writes: [] as ListeningPlayEvent[],
  pending: [] as { eventId: number }[],
}));
vi.mock('../services/historyDatabase', () => ({
  HISTORY_STORES: { plays: 'plays', pending: 'stats_pending' },
  openHistoryDb: async () => ({
    transaction: () => {
      const tx: { oncomplete?: () => void; objectStore: (name: string) => unknown } = {
        objectStore: name => ({
          get: () => {
            const request: { result: ListeningPlayEvent | undefined; onsuccess?: () => void } = { result: state.event };
            queueMicrotask(() => { request.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
            return request;
          },
          put: (value: ListeningPlayEvent | { eventId: number }) => {
            if (name === 'plays') state.writes.push(value as ListeningPlayEvent);
            else state.pending.push(value as { eventId: number });
          },
        }),
      };
      return tx;
    },
  }),
}));
import { updatePlayEventDetails } from './historyStore';

beforeEach(() => {
  state.event = { id: 7, s: 100, t: 1000, f: 0 };
  state.writes = [];
  state.pending = [];
});

describe('recovering the exact unfinished history event', () => {
  it('finalizes matching data and enqueues the same event for statistics', async () => {
    await updatePlayEventDetails(7, 200, 180, { s: 100, t: 1000 });
    expect(state.writes).toEqual([{ id: 7, s: 100, t: 1000, f: 1, p: 180, d: 180, c: 1 }]);
    expect(state.pending).toEqual([{ eventId: 7 }]);
  });

  it('does not overwrite an ID reused for a different song', async () => {
    await updatePlayEventDetails(7, 40, 180, { s: 200, t: 1000 });
    expect(state.writes).toEqual([]);
    expect(state.pending).toEqual([]);
  });

  it('does not overwrite another play of the same song', async () => {
    await updatePlayEventDetails(7, 40, 180, { s: 100, t: 2000 });
    expect(state.writes).toEqual([]);
  });

  it('keeps already-finalized data even when an old receipt matches the ID', async () => {
    state.event = { id: 7, s: 100, t: 1000, f: 1, p: 120, d: 180 };
    await updatePlayEventDetails(7, 40, 180, { s: 100, t: 1000 });
    expect(state.writes).toEqual([]);
    expect(state.pending).toEqual([]);
  });

  it('does not recreate a deleted history event', async () => {
    state.event = undefined;
    await updatePlayEventDetails(7, 40, 180, { s: 100, t: 1000 });
    expect(state.writes).toEqual([]);
  });
});
