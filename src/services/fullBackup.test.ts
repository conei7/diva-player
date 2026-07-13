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
});
