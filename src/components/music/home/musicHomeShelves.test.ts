import { afterEach, describe, expect, it } from 'vitest';
import type { Playlist, Song } from '../../../types/vocadb';
import { DEFAULT_PLAYLIST_LIST_PREFERENCES } from '../../../utils/playlistListPreferences';
import {
  clearShelfCacheForTests,
  greetingPeriod,
  orderShelfPlaylists,
  peekShelfSongs,
  pendingShelfSongs,
  selectRecentShelfSongs,
  trackShelfSongs,
} from './musicHomeShelves';

const song = (id: number): Song => ({
  id,
  name: `曲${id}`,
  defaultName: `曲${id}`,
  defaultNameLanguage: 'Japanese',
  artistString: 'P',
  createDate: '2026-01-01',
  favoritedTimes: 0,
  lengthSeconds: 120,
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
} as Song);

const playlist = (id: string, name: string, updatedAt: number, songs: Song[] = [], isPinned = false): Playlist => ({
  id,
  name,
  songs,
  createdAt: 0,
  updatedAt,
  ...(isPinned ? { isPinned } : {}),
});

afterEach(() => clearShelfCacheForTests());

describe('selectRecentShelfSongs', () => {
  it('keeps one card per song in order of its latest play and leaves hidden songs out', () => {
    const entries = [
      { song: song(1), playedAt: 500 },
      { song: song(2), playedAt: 400 },
      { song: song(1), playedAt: 300 },
      { song: song(3), playedAt: 200 },
      { song: song(4), playedAt: 100 },
    ];
    expect(selectRecentShelfSongs(entries, { 3: { hiddenAt: 1 } }).map(item => item.id)).toEqual([1, 2, 4]);
  });

  it('stops at the limit after skipping hidden songs', () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({ song: song(index + 1), playedAt: 1000 - index }));
    const result = selectRecentShelfSongs(entries, { 1: { hiddenAt: 1 } }, 20);
    expect(result).toHaveLength(20);
    expect(result[0].id).toBe(2);
    expect(result.at(-1)?.id).toBe(21);
  });
});

describe('orderShelfPlaylists', () => {
  const watchLater = (songs: Song[]) => playlist('watch-later', '後で聴く', 1, songs, true);

  it('puts 後で聴く first when it has songs, then the library order (recently updated first)', () => {
    const lists = [
      playlist('a', 'A', 10),
      watchLater([song(1)]),
      playlist('b', 'B', 30),
      playlist('c', 'C', 20),
    ];
    expect(orderShelfPlaylists(lists, DEFAULT_PLAYLIST_LIST_PREFERENCES).map(item => item.id))
      .toEqual(['watch-later', 'b', 'c', 'a']);
  });

  it('leaves out an empty 後で聴く and follows the saved sort', () => {
    const lists = [watchLater([]), playlist('b', 'Beta', 30), playlist('a', 'Alpha', 10)];
    const byName = { ...DEFAULT_PLAYLIST_LIST_PREFERENCES, sortKey: 'name' as const, sortOrder: 'asc' as const };
    expect(orderShelfPlaylists(lists, byName).map(item => item.id)).toEqual(['a', 'b']);
  });

  it('shows at most the limit', () => {
    const lists = Array.from({ length: 30 }, (_, index) => playlist(`p${index}`, `P${index}`, index));
    expect(orderShelfPlaylists(lists, DEFAULT_PLAYLIST_LIST_PREFERENCES, 24)).toHaveLength(24);
  });
});

describe('greetingPeriod', () => {
  it('says good morning from 5:00, good afternoon from 11:00 and good evening from 18:00', () => {
    expect([4, 5, 10, 11, 17, 18, 23, 0].map(greetingPeriod)).toEqual([
      'evening', 'morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'evening',
    ]);
  });
});

describe('shelf cache', () => {
  it('keeps the result for its key and shares the running request', async () => {
    const request = trackShelfSongs('weekly', 'k1', Promise.resolve([song(1)]));
    expect(pendingShelfSongs('k1')).toBe(request);
    await request;
    expect(peekShelfSongs('weekly', 'k1')?.map(item => item.id)).toEqual([1]);
    expect(peekShelfSongs('weekly', 'k2')).toBeUndefined();
    expect(pendingShelfSongs('k1')).toBeUndefined();
  });

  it('expires after 30 minutes', async () => {
    await trackShelfSongs('weekly', 'k1', Promise.resolve([song(1)]));
    expect(peekShelfSongs('weekly', 'k1', Date.now() + 29 * 60 * 1000)).toBeDefined();
    expect(peekShelfSongs('weekly', 'k1', Date.now() + 31 * 60 * 1000)).toBeUndefined();
  });

  it('does not remember failures', async () => {
    const request = trackShelfSongs('surge', 'k1', Promise.reject(new Error('offline')));
    await expect(request).rejects.toThrow('offline');
    expect(peekShelfSongs('surge', 'k1')).toBeUndefined();
    expect(pendingShelfSongs('k1')).toBeUndefined();
  });
});
