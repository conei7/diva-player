import { useEffect, useEffectEvent, useState } from 'react';
import type { Song } from '../../../types/vocadb';
import { peekShelfSongs, pendingShelfSongs, trackShelfSongs } from './musicHomeShelves';

interface ShelfState {
  key: string;
  /** null: the request for `key` failed. */
  songs: Song[] | null;
}

export interface ShelfSongsResult {
  /** The songs for the current key, or null while they load or after a failure. */
  songs: Song[] | null;
  /** The request for the current key failed (only logged): the shelf hides instead of waiting. */
  failed: boolean;
}

/**
 * The songs of a network shelf for `key`. A failure never blocks the page: it is logged and
 * reported as `failed`, so the shelf can tell loading (keep its place) from gone (hide). A result
 * cached this session is shown on the first render.
 */
export function useShelfSongs(shelfId: string, key: string, load: () => Promise<Song[]>): ShelfSongsResult {
  const [state, setState] = useState<ShelfState | null>(() => {
    const songs = peekShelfSongs(shelfId, key);
    return songs ? { key, songs } : null;
  });
  // A failure belongs to its key like a result, so a new key loads again from scratch.
  const settled = state?.key === key;
  const startLoad = useEffectEvent(() => load());

  useEffect(() => {
    if (settled) return undefined;
    const cached = peekShelfSongs(shelfId, key);
    if (cached) {
      setState({ key, songs: cached });
      return undefined;
    }
    let cancelled = false;
    const request = pendingShelfSongs(key) ?? trackShelfSongs(shelfId, key, startLoad());
    request.then(
      songs => {
        if (!cancelled) setState({ key, songs });
      },
      error => {
        if (cancelled) return;
        console.warn(`[MusicHome] The shelf "${shelfId}" could not be loaded`, error);
        setState({ key, songs: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, settled, shelfId]);

  return settled ? { songs: state.songs, failed: state.songs === null } : { songs: null, failed: false };
}
