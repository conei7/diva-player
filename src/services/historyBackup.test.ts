import { describe, expect, it } from 'vitest';
import {
  normalizeImportedEvent,
  parseHistoryBackup,
  playEventFingerprint,
} from './historyBackup';

describe('history backup format', () => {
  it('normalizes imported events and removes local database IDs', () => {
    expect(normalizeImportedEvent({ id: 99, s: 42, t: 1000, o: 1, p: 12.8, d: 60.3, c: 1, f: 1 })).toEqual({
      s: 42,
      t: 1000,
      o: 1,
      p: 13,
      d: 60,
      c: 1,
      f: 1,
    });
  });

  it('rejects unsupported or malformed backups', () => {
    expect(parseHistoryBackup({ kind: 'other', version: 1, events: [] })).toBeNull();
    expect(parseHistoryBackup({ kind: 'diva-player-history', version: 1, events: [{ s: 0, t: 1 }] })).toEqual([]);
  });

  it('uses playback fields for duplicate detection', () => {
    const first = { s: 42, t: 1000, o: 0 as const, p: 30, d: 120, c: 0 as const, f: 1 as const };
    expect(playEventFingerprint(first)).toBe(playEventFingerprint({ ...first, id: 5 }));
    expect(playEventFingerprint(first)).not.toBe(playEventFingerprint({ ...first, p: 31 }));
  });
});
