import { describe, expect, it } from 'vitest';
import {
  normalizeImportedEvent,
  parseHistoryBackup,
  playEventFingerprint,
  dedupeHistoryEvents,
  MAX_IMPORT_EVENTS,
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

  it('always restores events as finalized and deduplicates against existing data', () => {
    const active = normalizeImportedEvent({ s: 42, t: 2000, f: 0 });
    expect(active?.f).toBe(1);
    const first = normalizeImportedEvent({ s: 42, t: 1000, f: 0 });
    const second = normalizeImportedEvent({ s: 43, t: 1000, f: 0 });
    expect(first && second).toBeTruthy();
    const result = dedupeHistoryEvents([first!], [first!, first!, second!]);
    expect(result.duplicates).toBe(2);
    expect(result.eventsToAdd).toEqual([second]);
  });

  it('rejects backups that exceed the import safety cap before parsing', () => {
    expect(parseHistoryBackup({ kind: 'diva-player-history', version: 1, events: new Array(MAX_IMPORT_EVENTS + 1) })).toBeNull();
  });
});
