import { describe, expect, it } from 'vitest';
import type { Playlist, PlaylistFolder } from '../../../types/vocadb';
import { buildLibraryModel, folderHoldsList, librarySelectionOf, playlistOrderOf } from './libraryModel';

function playlist(id: string, patch: Partial<Playlist> = {}): Playlist {
  return { id, name: id, songs: [], createdAt: 1, updatedAt: 1, ...patch };
}

function folder(id: string): PlaylistFolder {
  return { id, name: `Folder ${id}`, createdAt: 1, updatedAt: 1 };
}

const RECENT = { sortKey: 'updatedAt', sortOrder: 'desc' } as const;

describe('buildLibraryModel', () => {
  it('keeps 後で聴く apart and lists pinned lists, folders, then playlists without a folder', () => {
    const model = buildLibraryModel([
      playlist('watch-later', { isPinned: true, updatedAt: 99 }),
      playlist('loose-old', { updatedAt: 1 }),
      playlist('in-b', { folderId: 'b', updatedAt: 5 }),
      playlist('system', { isPinned: true }),
      playlist('loose-new', { updatedAt: 9 }),
      playlist('in-a-old', { folderId: 'a', updatedAt: 2 }),
      playlist('in-a-new', { folderId: 'a', updatedAt: 8 }),
    ], [folder('a'), folder('b'), folder('empty')], RECENT);

    expect(model.watchLater?.id).toBe('watch-later');
    expect(model.pinned.map(item => item.id)).toEqual(['system']);
    expect(model.folders.map(group => [group.folder.id, group.playlists.map(item => item.id)])).toEqual([
      ['a', ['in-a-new', 'in-a-old']],
      ['b', ['in-b']],
    ]);
    expect(model.unfiled.map(item => item.id)).toEqual(['loose-new', 'loose-old']);
    expect(model.count).toBe(6);
  });

  it('treats a playlist whose folder no longer exists as one without a folder', () => {
    const model = buildLibraryModel([playlist('orphan', { folderId: 'gone' })], [folder('a')], RECENT);
    expect(model.folders).toEqual([]);
    expect(model.unfiled.map(item => item.id)).toEqual(['orphan']);
  });

  it('follows the saved order of the library page', () => {
    const playlists = [playlist('b', { name: 'Beta' }), playlist('a', { name: 'alpha' }), playlist('c', { name: 'Gamma' })];
    const byName = buildLibraryModel(playlists, [], playlistOrderOf({ sortKey: 'name', sortOrder: 'desc' }));
    // An older saved 名前 ↓ is read as the menu's 名前順 (A → Z), like the library page does.
    expect(byName.unfiled.map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(playlistOrderOf(null)).toEqual({ sortKey: 'updatedAt', sortOrder: 'desc' });
    expect(playlistOrderOf({ sortKey: 'songCount', sortOrder: 'asc' })).toEqual({ sortKey: 'songCount', sortOrder: 'desc' });
  });

  it('is empty without playlists of the user', () => {
    const model = buildLibraryModel([playlist('watch-later', { isPinned: true })], [], RECENT);
    expect(model.count).toBe(0);
  });
});

describe('librarySelectionOf', () => {
  it('reads the open playlist and the library page', () => {
    expect(librarySelectionOf({ pathname: '/playlists', search: '?list=abc' })).toEqual({ listId: 'abc', libraryPage: false });
    expect(librarySelectionOf({ pathname: '/playlists/', search: '' })).toEqual({ listId: null, libraryPage: true });
    expect(librarySelectionOf({ pathname: '/history', search: '?list=abc' })).toEqual({ listId: null, libraryPage: false });
  });

  it('knows which folder holds the open playlist', () => {
    const group = { folder: folder('a'), playlists: [playlist('x')] };
    expect(folderHoldsList(group, 'x')).toBe(true);
    expect(folderHoldsList(group, 'y')).toBe(false);
    expect(folderHoldsList(group, null)).toBe(false);
  });
});
