import { useEffect, useEffectEvent, useState } from 'react';
import type { Song } from '../../../types/vocadb';
import { peekShelfSongs, pendingShelfSongs, trackShelfSongs } from './musicHomeShelves';

interface ShelfState {
  key: string;
  songs: Song[];
}

/**
 * The songs of a network shelf for `key`, or null while they load (and after a failure, which is
 * only logged: the shelf stays hidden and never blocks the page). A result cached this session is
 * shown on the first render.
 */
export function useShelfSongs(shelfId: string, key: string, load: () => Promise<Song[]>): Song[] | null {
  const [state, setState] = useState<ShelfState | null>(() => {
    const songs = peekShelfSongs(shelfId, key);
    return songs ? { key, songs } : null;
  });
  const loaded = state?.key === key;
  const startLoad = useEffectEvent(() => load());

  useEffect(() => {
    if (loaded) return undefined;
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
        if (!cancelled) console.warn(`[MusicHome] The shelf "${shelfId}" could not be loaded`, error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, loaded, shelfId]);

  return loaded ? state.songs : null;
}
