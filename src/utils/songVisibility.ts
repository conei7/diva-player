import type { Song } from '../types/vocadb';
import { excludeHiddenSongs, type HiddenSongRecord } from '../stores/hiddenSongStore';

export type SongVisibilityIntent = 'search' | 'discovery';

/** Explicit searches can reveal songs hidden from passive discovery surfaces. */
export function filterSongsForVisibilityIntent(
  songs: Song[],
  hiddenSongs: Record<string, HiddenSongRecord>,
  intent: SongVisibilityIntent,
): Song[] {
  return intent === 'search' ? songs : excludeHiddenSongs(songs, hiddenSongs);
}
