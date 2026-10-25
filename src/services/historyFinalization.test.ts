import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { update, reload, active } = vi.hoisted(() => ({
  update: vi.fn(async () => {}), reload: vi.fn(async () => {}),
  active: { activePlayEventId: 1, activeSongId: 100, activePlayedAt: 1000 },
}));
vi.mock('../stores/historyStore', () => ({
  updatePlayEventDetails: update,
  useHistoryStore: { getState: () => ({ ...active, reloadHistory: reload }) },
}));
import { rememberHistoryFinalization, recoverHistoryFinalizations, startHistoryFinalizationRecovery } from './historyFinalization';
import { useProgressStore } from '../stores/progressStore';

let values: Map<string, string>;
let events: EventTarget;
const record = { id: 1, s: 100, t: 1000, p: 40, d: 180 };
const key = 'diva-history-finalization-1-1000';

beforeEach(() => {
  vi.clearAllMocks();
  values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
    removeItem: (name: string) => { values.delete(name); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  });
  events = new EventTarget();
  vi.stubGlobal('window', events);
});
afterEach(() => vi.unstubAllGlobals());

describe('interrupted history finalization', () => {
  it('synchronously saves progress before unload and retains a newer receipt', () => {
    const removeOld = rememberHistoryFinalization(record);
    expect(JSON.parse(values.get(key)!)).toEqual(record);
    rememberHistoryFinalization({ ...record, p: 50 });
    removeOld();
    expect(JSON.parse(values.get(key)!).p).toBe(50);
  });

  it('replays with the exact original event identity and removes only a successful receipt', async () => {
    rememberHistoryFinalization(record);
    expect(await recoverHistoryFinalizations()).toBe(1);
    expect(update).toHaveBeenCalledWith(1, 40, 180, record);
    expect(values.has(key)).toBe(false);
    expect(await recoverHistoryFinalizations()).toBe(0);
  });

  it('retains evidence when the DB update fails so startup can retry', async () => {
    rememberHistoryFinalization(record);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await recoverHistoryFinalizations(async () => { throw new Error('transaction aborted'); })).toBe(0);
      expect(values.has(key)).toBe(true);
    } finally { log.mockRestore(); }
  });

  it('ignores invalid identities and unrelated storage', async () => {
    values.set(key, JSON.stringify({ ...record, id: -1 }));
    values.set('diva-history-finalization-2-1000', JSON.stringify(record));
    values.set('diva-ratings', '{}');
    expect(await recoverHistoryFinalizations()).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(values.size).toBe(3);
  });

  it('writes a receipt directly from pagehide and removes the listener on cleanup', () => {
    const stop = startHistoryFinalizationRecovery();
    useProgressStore.setState({ progress: 45.4, duration: 180 });
    events.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(values.get(key)!)).toEqual({ ...record, p: 45 });
    stop();
    values.clear();
    events.dispatchEvent(new Event('pagehide'));
    expect(values.size).toBe(0);
  });
});
