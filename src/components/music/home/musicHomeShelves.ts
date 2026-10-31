/**
 * Pure helpers of the music layout's Home shelves (no network, no React): which songs and
 * playlists a shelf shows, the shelf result cache and the greeting.
 */
import type { Playlist, Song } from '../../../types/vocadb';
import { latestPlayPerSong } from '../../library/historyGroups';
import {
  DEFAULT_PLAYLIST_LIST_PREFERENCES,
  getPlaylistLibrarySort,
  normalizePlaylistListPreferences,
  sortPlaylistsForDisplay,
  withPlaylistLibrarySort,
  type PlaylistListPreferences,
} from '../../../utils/playlistListPreferences';
import { storage } from '../../../utils/storage';

/** Cards per network shelf: HomeFeed's first page, so the requests are the same (shared API cache). */
export const SHELF_SONG_LIMIT = 24;
export const RECENT_SHELF_LIMIT = 20;
export const PLAYLIST_SHELF_LIMIT = 24;

/**
 * Width of a shelf card. Phones: about 2.3 cards per screen (12px page padding and 12px gaps:
 * (100vw − 12px) / 2.3 − 12px, ≈ 151px at 390px). Wider screens: 160px, 176px from 1024px.
 */
export const SHELF_CARD_WIDTH_CLASS = 'w-[calc((100vw_-_12px)_/_2.3_-_12px)] sm:w-40 lg:w-44';

/** The playlist library's saved order (PlaylistLibrary.tsx stores it under this key). */
const PLAYLIST_LIST_PREFERENCES_KEY = 'playlistListPreferences';

/** 最近再生した曲: one card per song (its latest play), newest first, without hidden songs. */
export function selectRecentShelfSongs(
  entries: readonly { song: Song; playedAt: number }[],
  hiddenSongs: Readonly<Record<string, unknown>>,
  limit = RECENT_SHELF_LIMIT,
): Song[] {
  const songs: Song[] = [];
  for (const row of latestPlayPerSong(entries)) {
    if (hiddenSongs[String(row.song.id)]) continue;
    songs.push(row.song);
    if (songs.length >= limit) break;
  }
  return songs;
}

export function readPlaylistListPreferences(): PlaylistListPreferences {
  return normalizePlaylistListPreferences(
    storage.get(PLAYLIST_LIST_PREFERENCES_KEY) ?? DEFAULT_PLAYLIST_LIST_PREFERENCES,
  );
}

/**
 * あなたのプレイリスト: the pinned 後で聴く first while it has songs, then the other playlists in the
 * order the library uses (PlaylistLibrary's 並べ替え).
 */
export function orderShelfPlaylists(
  playlists: readonly Playlist[],
  preferences: PlaylistListPreferences,
  limit = PLAYLIST_SHELF_LIMIT,
): Playlist[] {
  const pinned = playlists.filter(playlist => playlist.isPinned && playlist.songs.length > 0);
  const order = withPlaylistLibrarySort(preferences, getPlaylistLibrarySort(preferences));
  const rest = sortPlaylistsForDisplay(
    playlists.filter(playlist => !playlist.isPinned),
    order.sortKey,
    order.sortOrder,
  );
  return [...pinned, ...rest].slice(0, Math.max(0, limit));
}

export type GreetingPeriod = 'morning' | 'afternoon' | 'evening';

/** おはようございます 5:00–10:59, こんにちは 11:00–17:59, こんばんは otherwise. */
export function greetingPeriod(hour: number): GreetingPeriod {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 18) return 'afternoon';
  return 'evening';
}

/* ─── Shelf result cache ─────────────────────────────────────────────────── */

/**
 * The last result of each network shelf, kept for the session. Coming back to Home (Back, the
 * logo) shows the same cards in the same order on the first frame, so HomeFeed's scroll restore
 * below the shelves lands where it was and nothing visible is replaced later.
 */
const SHELF_CACHE_TTL_MS = 30 * 60 * 1000;

interface ShelfCacheEntry {
  key: string;
  songs: Song[];
  savedAt: number;
}

const resolvedShelves = new Map<string, ShelfCacheEntry>();
const pendingShelves = new Map<string, Promise<Song[]>>();

/** The cached songs of `shelfId` for `key` while they are fresh, else undefined. */
export function peekShelfSongs(shelfId: string, key: string, now = Date.now()): Song[] | undefined {
  const entry = resolvedShelves.get(shelfId);
  if (!entry || entry.key !== key || now - entry.savedAt >= SHELF_CACHE_TTL_MS) return undefined;
  return entry.songs;
}

/** The request already running for `key` (StrictMode's second effect run joins it). */
export function pendingShelfSongs(key: string): Promise<Song[]> | undefined {
  return pendingShelves.get(key);
}

/** Remembers a started request for `key`; its result replaces the shelf's cached songs. Failures are not cached. */
export function trackShelfSongs(shelfId: string, key: string, request: Promise<Song[]>): Promise<Song[]> {
  const tracked = request.then(songs => {
    resolvedShelves.set(shelfId, { key, songs, savedAt: Date.now() });
    return songs;
  });
  pendingShelves.set(key, tracked);
  const forget = () => {
    if (pendingShelves.get(key) === tracked) pendingShelves.delete(key);
  };
  tracked.then(forget, forget);
  return tracked;
}

/** Tests only. */
export function clearShelfCacheForTests(): void {
  resolvedShelves.clear();
  pendingShelves.clear();
}
