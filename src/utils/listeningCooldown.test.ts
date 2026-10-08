import { describe, expect, it } from 'vitest';
import { latestPlayedAtBySongId } from './listeningCooldown';
import { matchesDiscoveryFilter } from './globalFilters';
import { DEFAULT_GLOBAL_FILTER_SETTINGS } from '../stores/globalFilterStore';
import type { Song } from '../types/vocadb';

describe('persistent listening cooldown', () => {
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const song = { id: 42, songType: 'Original' } as Song;
  const settings = { ...DEFAULT_GLOBAL_FILTER_SETTINGS, cooldownHours: 168 };

  it('retains a recent play outside the 300 metadata entries restored on startup', () => {
    const events = [{ s: 42, t: now - day }, ...Array.from({ length: 350 }, (_, i) => ({ s: 1000 + i, t: now - i }))];
    expect(events.slice(-300).some(event => event.s === 42)).toBe(false);
    expect(matchesDiscoveryFilter(song, { settings, now, lastPlayedAtBySongId: latestPlayedAtBySongId(events) })).toBe(false);
  });

  it('uses the newest play regardless of event order or a much older repeat', () => {
    for (const events of [
      [{ s: 42, t: now - day }, { s: 42, t: now - 8 * day }],
      [{ s: 42, t: now - 8 * day }, { s: 42, t: now - day }],
    ]) {
      const lastPlayedAtBySongId = latestPlayedAtBySongId(events);
      expect(lastPlayedAtBySongId.get(42)).toBe(now - day);
      expect(matchesDiscoveryFilter(song, { settings, now, lastPlayedAtBySongId })).toBe(false);
    }
  });

  it('allows a song after the chosen seven days and ignores invalid events', () => {
    const lastPlayedAtBySongId = latestPlayedAtBySongId([{ s: 42, t: now - 7 * day }, { s: 42, t: NaN }, { s: -1, t: now }]);
    expect(lastPlayedAtBySongId.size).toBe(1);
    expect(matchesDiscoveryFilter(song, { settings, now, lastPlayedAtBySongId })).toBe(true);
  });
});
