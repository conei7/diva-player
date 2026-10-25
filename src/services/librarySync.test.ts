import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let stop: (() => void) | undefined;
let values: Map<string, string>;
let writes: ReturnType<typeof vi.fn>;
let windowEvents: EventTarget;
let documentEvents: EventTarget;
let library: typeof import('./librarySync');
let playlists: typeof import('../stores/playlistStore');
let ratings: typeof import('../stores/ratingStore');
let producers: typeof import('../stores/favoriteProducerStore');
let hidden: typeof import('../stores/hiddenSongStore');

function storageEvent(key: string | null, storageArea = localStorage) {
  const event = new Event('storage');
  Object.assign(event, { key, storageArea, newValue: 'obsolete event payload' });
  windowEvents.dispatchEvent(event);
}

beforeEach(async () => {
  vi.resetModules();
  values = new Map();
  writes = vi.fn((key: string, value: string) => values.set(key, value));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: writes, removeItem: (key: string) => values.delete(key), clear: () => values.clear(),
  });
  windowEvents = new EventTarget();
  Object.assign(windowEvents, { localStorage });
  documentEvents = new EventTarget();
  Object.assign(documentEvents, { visibilityState: 'visible' });
  vi.stubGlobal('window', windowEvents);
  vi.stubGlobal('document', documentEvents);
  [library, playlists, ratings, producers, hidden] = await Promise.all([
    import('./librarySync'), import('../stores/playlistStore'), import('../stores/ratingStore'),
    import('../stores/favoriteProducerStore'), import('../stores/hiddenSongStore'),
  ]);
  stop = library.startSavedDataSync();
});

afterEach(() => { stop?.(); vi.unstubAllGlobals(); });

describe('saved library data across tabs', () => {
  it('does not publish equivalent hydrated objects again at startup', () => {
    const ratingState = ratings.useRatingStore.getState();
    const hiddenState = hidden.useHiddenSongStore.getState();
    const producerState = producers.useFavoriteProducerStore.getState();
    const playlistState = playlists.usePlaylistStore.getState();
    const another = library.startSavedDataSync();
    another();
    expect(ratings.useRatingStore.getState()).toBe(ratingState);
    expect(hidden.useHiddenSongStore.getState()).toBe(hiddenState);
    expect(producers.useFavoriteProducerStore.getState()).toBe(producerState);
    expect(playlists.usePlaylistStore.getState()).toBe(playlistState);
  });
  it('reads the latest ratings before another rating is saved, without echoing the remote write', () => {
    values.set('diva-ratings', JSON.stringify({ state: { ratings: { 100: 4 } }, version: 0 }));
    writes.mockClear();
    storageEvent('diva-ratings');
    expect(ratings.useRatingStore.getState().ratings).toEqual({ 100: 4 });
    expect(writes).not.toHaveBeenCalled();
    ratings.useRatingStore.getState().setRating(200, 5);
    expect(JSON.parse(values.get('diva-ratings')!).state.ratings).toEqual({ 100: 4, 200: 5 });
  });

  it('reads both current playlist keys and preserves another tab’s saved playlist on a subsequent save', () => {
    const first = playlists.usePlaylistStore.getState().createPlaylist('A');
    const remote = { ...first, id: 'remote', name: 'B', folderId: 'folder' };
    const saved = JSON.parse(values.get('diva_playlists')!);
    values.set('diva_playlists', JSON.stringify([...saved, remote]));
    values.set('diva_playlistFolders', JSON.stringify([{ id: 'folder', name: 'remote folder', createdAt: 1, updatedAt: 1 }]));
    writes.mockClear();
    storageEvent('diva_playlists');
    expect(writes).not.toHaveBeenCalled();
    expect(playlists.usePlaylistStore.getState().folders[0].id).toBe('folder');
    playlists.usePlaylistStore.getState().createPlaylist('C');
    expect(JSON.parse(values.get('diva_playlists')!).map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    const current = playlists.usePlaylistStore.getState().playlists;
    storageEvent('diva_playlistFolders');
    expect(playlists.usePlaylistStore.getState().playlists).toBe(current);
  });

  it('catches missed events on focus/visibility and leaves unchanged selections alone', () => {
    const playlist = playlists.usePlaylistStore.getState().createPlaylist('local');
    windowEvents.dispatchEvent(new Event('focus'));
    expect(playlists.usePlaylistStore.getState().playlists.find(item => item.id === playlist.id)).toBe(playlist);
    values.set('diva-ratings', JSON.stringify({ state: { ratings: { 123: 3 } }, version: 0 }));
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    expect(ratings.useRatingStore.getState().ratings).toEqual({ 123: 3 });
    const state = playlists.usePlaylistStore.getState().playlists;
    windowEvents.dispatchEvent(new Event('focus'));
    expect(playlists.usePlaylistStore.getState().playlists).toBe(state);
  });

  it('updates favorites and hidden songs, and handles removed keys without resurrecting old data', () => {
    values.set('diva-favorite-producers', JSON.stringify({ version: 1, state: { producers: [{ id: 7, name: 'P', artistType: 'Producer', createdAt: 1 }] } }));
    values.set('diva-hidden-songs', JSON.stringify({ version: 0, state: { hiddenSongs: { 100: { song: { id: 100, name: 'song' }, hiddenAt: 1 } } } }));
    storageEvent(null);
    expect(producers.useFavoriteProducerStore.getState().isFavoriteProducer(7)).toBe(true);
    expect(hidden.useHiddenSongStore.getState().isHidden(100)).toBe(true);
    ratings.useRatingStore.getState().setRating(100, 5);
    for (const key of ['diva-ratings', 'diva-favorite-producers', 'diva-hidden-songs']) values.delete(key);
    writes.mockClear();
    storageEvent(null);
    expect(ratings.useRatingStore.getState().ratings).toEqual({});
    expect(producers.useFavoriteProducerStore.getState().producers).toEqual([]);
    expect(hidden.useHiddenSongStore.getState().hiddenSongs).toEqual({});
    expect(writes).not.toHaveBeenCalled();
  });

  it('ignores unrelated storage/queue events and removes subscriptions on cleanup', () => {
    const state = playlists.usePlaylistStore.getState().playlists;
    values.set('diva-ratings', JSON.stringify({ state: { ratings: { 100: 4 } }, version: 0 }));
    storageEvent('diva-ratings', {} as Storage);
    storageEvent('diva_playerQueue');
    expect(ratings.useRatingStore.getState().ratings).toEqual({});
    expect(playlists.usePlaylistStore.getState().playlists).toBe(state);
    stop?.(); stop = undefined;
    storageEvent('diva-ratings');
    windowEvents.dispatchEvent(new Event('focus'));
    expect(ratings.useRatingStore.getState().ratings).toEqual({});
  });
});
