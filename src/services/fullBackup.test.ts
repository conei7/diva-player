import { describe, expect, it } from 'vitest';
import { parseFullBackup } from './fullBackup';

describe('parseFullBackup', () => {
  it('validates all three user-data sections and reports counts', () => {
    const preview = parseFullBackup({
      kind: 'diva-player-full-backup',
      version: 1,
      exportedAt: '2026-07-13T00:00:00.000Z',
      sections: {
        history: { events: [{ s: 10, t: 1_000, o: 0, p: 30, d: 120, c: 0, f: 1 }] },
        ratings: { '10': 5 },
        playlists: {
          folders: [{ id: 'folder-1', name: '作業用', createdAt: 1, updatedAt: 1 }],
          playlists: [{
            id: 'playlist-1',
            name: 'お気に入り',
            songs: [{ id: 10, name: '曲', artistString: '', songType: 'Original' }],
            createdAt: 1,
            updatedAt: 1,
          }],
        },
      },
    });

    expect(preview).not.toBeNull();
    expect(preview).toMatchObject({ historyCount: 1, ratingCount: 1, playlistCount: 1, folderCount: 1, invalidItems: 0 });
    expect(preview?.parsed.sections.history.events[0].f).toBe(1);
  });

  it('keeps valid entries while counting malformed entries', () => {
    const preview = parseFullBackup({
      kind: 'diva-player-full-backup',
      version: 1,
      sections: {
        history: { events: [{ s: 1, t: 1 }, { s: -1, t: 2 }] },
        ratings: { '1': 4, invalid: 9 },
        playlists: { folders: [], playlists: [] },
      },
    });

    expect(preview?.historyCount).toBe(1);
    expect(preview?.ratingCount).toBe(1);
    expect(preview?.invalidItems).toBe(2);
  });

  it('accepts v2 preferences while preserving v1 compatibility', () => {
    const preview = parseFullBackup({
      kind: 'diva-player-full-backup',
      version: 2,
      sections: {
        history: { events: [] },
        ratings: {},
        playlists: { folders: [], playlists: [] },
        preferences: {
          globalFilters: {
            enabled: true,
            minYoutubeViews: 10_000,
            minNicoViews: 0,
            excludedSongTypes: ['Remix'],
            cooldownHours: 24,
            excludeRatedFromDiscovery: true,
          },
        },
      },
    });

    expect(preview?.preferencesIncluded).toBe(true);
    expect(preview?.parsed.sections.preferences?.globalFilters.minYoutubeViews).toBe(10_000);
  });

  it('accepts v3 favorite producer preferences', () => {
    const preview = parseFullBackup({
      kind: 'diva-player-full-backup',
      version: 3,
      sections: {
        history: { events: [] },
        ratings: {},
        playlists: { folders: [], playlists: [] },
        preferences: {
          globalFilters: { enabled: false, minYoutubeViews: 0, minNicoViews: 0, excludedSongTypes: [], cooldownHours: 0, excludeRatedFromDiscovery: false },
          favoriteProducers: [{ id: 42, name: 'MIMI', artistType: 'Producer', createdAt: 123 }],
        },
      },
    });

    expect(preview?.parsed.sections.preferences?.favoriteProducers).toEqual([
      { id: 42, name: 'MIMI', artistType: 'Producer', createdAt: 123 },
    ]);
  });
});
