import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeFullBackupImport, parseFullBackup, readPersistedPlaylistsForBackup } from './fullBackup';
import { usePlaylistStore } from '../stores/playlistStore';

function createLocalStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

describe('parseFullBackup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    usePlaylistStore.setState({ playlists: [], folders: [] });
  });

  it('hydrates persisted playlists before creating a backup snapshot', () => {
    vi.stubGlobal('localStorage', createLocalStorage({
      diva_playlists: JSON.stringify([{
        id: 'playlist-1',
        name: '保存済み',
        songs: [{ id: 10, name: '曲' }],
        createdAt: 1,
        updatedAt: 1,
      }]),
      diva_playlistFolders: JSON.stringify([{
        id: 'folder-1',
        name: 'フォルダ',
        createdAt: 1,
        updatedAt: 1,
      }]),
    }));
    usePlaylistStore.setState({ playlists: [], folders: [] });

    const snapshot = readPersistedPlaylistsForBackup();

    expect(snapshot.playlists.map(playlist => playlist.id)).toEqual(['watch-later', 'playlist-1']);
    expect(snapshot.folders.map(folder => folder.id)).toEqual(['folder-1']);
  });

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
            vocalistFilters: [
              { id: 1, name: '初音ミク', variantGroup: 'miku' },
              { id: 2, name: '初音ミク Append', variantGroup: 'miku' },
            ],
            vocalistMatchMode: 'Exact',
            cooldownHours: 24,
            excludeRatedFromDiscovery: true,
          },
        },
      },
    });

    expect(preview?.preferencesIncluded).toBe(true);
    expect(preview?.parsed.sections.preferences?.globalFilters.minYoutubeViews).toBe(10_000);
    expect(preview?.parsed.sections.preferences?.globalFilters.vocalistFilters).toEqual([
      { id: 1, name: '初音ミク', variantGroup: 'miku' },
      { id: 2, name: '初音ミク Append', variantGroup: 'miku' },
    ]);
    expect(preview?.parsed.sections.preferences?.globalFilters.vocalistMatchMode).toBe('Exact');
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

  it('requires a matching v4 manifest before restore', () => {
    const base = {
      kind: 'diva-player-full-backup' as const,
      version: 4 as const,
      exportedAt: '2026-07-18T00:00:00.000Z',
      sections: {
        history: { events: [] },
        ratings: { '10': 5 },
        playlists: {
          folders: [],
          playlists: [{
            id: 'playlist-1',
            name: 'お気に入り',
            songs: [{ id: 10, name: '曲' }],
            createdAt: 1,
            updatedAt: 1,
          }],
        },
      },
    };
    const valid = parseFullBackup({
      ...base,
      manifest: { schemaVersion: 4, historyEvents: 0, ratingCount: 1, playlistCount: 1, playlistSongCount: 1, folderCount: 0, favoriteProducerCount: 0 },
    });
    expect(valid?.canRestore).toBe(true);
    expect(valid?.manifestValid).toBe(true);

    const mismatch = parseFullBackup({
      ...base,
      manifest: { schemaVersion: 4, historyEvents: 0, ratingCount: 1, playlistCount: 1, playlistSongCount: 99, folderCount: 0, favoriteProducerCount: 0 },
    });
    expect(mismatch?.canRestore).toBe(false);
    expect(mismatch?.validationMessages).toContain('manifestと実データの件数が一致しません。');
  });

  it('validates and counts hidden songs in v6 backups', () => {
    const preview = parseFullBackup({
      kind: 'diva-player-full-backup',
      version: 6,
      exportedAt: '2026-08-04T00:00:00.000Z',
      manifest: {
        schemaVersion: 6,
        historyEvents: 0,
        ratingCount: 0,
        playlistCount: 0,
        playlistSongCount: 0,
        folderCount: 0,
        favoriteProducerCount: 0,
        hiddenSongCount: 1,
      },
      sections: {
        history: { events: [] },
        ratings: {},
        playlists: { folders: [], playlists: [] },
        hiddenSongs: {
          '42': { song: { id: 42, name: '表示しない曲' }, hiddenAt: 123 },
        },
      },
    });

    expect(preview?.canRestore).toBe(true);
    expect(preview?.hiddenSongCount).toBe(1);
    expect(preview?.parsed.sections.hiddenSongs['42'].song.name).toBe('表示しない曲');
  });

  it('rejects an invalid preview before reading or changing persisted data', async () => {
    const preview = {
      canRestore: false,
      parsed: { sections: {} },
    } as never;

    await expect(executeFullBackupImport(preview, { mode: 'replace', ratingPriority: 'backup' }))
      .rejects.toMatchObject({ name: 'FullBackupImportError', recoveryComplete: true });
    expect(usePlaylistStore.getState().playlists).toEqual([]);
  });

  it('revalidates the payload in the service instead of trusting a forged preview flag', async () => {
    const preview = { canRestore: true, parsed: {} } as never;

    await expect(executeFullBackupImport(preview, { mode: 'replace', ratingPriority: 'backup' }))
      .rejects.toMatchObject({ name: 'FullBackupImportError', recoveryComplete: true });
    expect(usePlaylistStore.getState().playlists).toEqual([]);
  });

  it('reports an incomplete rollback when playlist storage cannot be restored', async () => {
    const historyStores = ['plays', 'stats_pending', 'stats_applied', 'song_stats', 'year_stats', 'month_stats', 'stats_meta'];
    const database = {
      transaction: () => {
        let completedRequests = 0;
        const requests: Array<{ result: unknown[]; onsuccess: (() => void) | null }> = [];
        const transaction: { error: null; oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null; objectStore: () => { getAll: () => { result: unknown[]; onsuccess: (() => void) | null } } } = {
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore: () => ({
            getAll: () => {
              const request = { result: [], onsuccess: null as (() => void) | null };
              requests.push(request);
              queueMicrotask(() => {
                request.onsuccess?.();
                completedRequests += 1;
                if (completedRequests === historyStores.length) transaction.oncomplete?.();
              });
              return request;
            },
          }),
        };
        return transaction;
      },
    };
    const indexedDb = {
      open: () => {
        const request: { result: typeof database; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
          result: database,
          onsuccess: null,
          onerror: null,
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    };
    vi.stubGlobal('indexedDB', indexedDb);
    const values = new Map<string, string>([
      ['diva_playlists', 'previous-playlists'],
      ['diva_playlistFolders', 'previous-folders'],
    ]);
    let writes = 0;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (key === 'diva_playlistFolders' || writes >= 3) throw new DOMException('storage full', 'QuotaExceededError');
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    });
    usePlaylistStore.setState({ playlists: [], folders: [] });
    const preview = parseFullBackup({
      kind: 'diva-player-full-backup',
      version: 1,
      sections: {
        history: { events: [] },
        ratings: {},
        playlists: { folders: [], playlists: [] },
      },
    });

    expect(preview?.canRestore).toBe(true);
    await expect(executeFullBackupImport(preview!, { mode: 'replace', ratingPriority: 'backup' }))
      .rejects.toMatchObject({
        name: 'FullBackupImportError',
        recoveryComplete: false,
        rollbackErrors: expect.arrayContaining([expect.stringContaining('diva_playlists')]),
      });
    expect(usePlaylistStore.getState().playlists).toEqual([]);
    expect(values.get('diva_playlists')).not.toBe('previous-playlists');
  });
});
