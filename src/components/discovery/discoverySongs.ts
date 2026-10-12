import { useEffect, useMemo, useState } from 'react';
import { getSongsByIds } from '../../api/vocadb';
import type { Song } from '../../types/vocadb';
import { isPlayablePV } from '../../utils/playablePV';

export interface DiscoverySongSource {
  songId: number;
  name: string;
  artistString: string;
  thumbUrl?: string | null;
}

/**
 * A minimal Song for rows and thumbnails while the full song (videos, thumbnails) loads.
 * Never store it (playlists, queue): actions wait for the real Song.
 */
export function placeholderSong(source: DiscoverySongSource): Song {
  return {
    id: source.songId,
    name: source.name,
    defaultName: source.name,
    defaultNameLanguage: 'Unspecified',
    artistString: source.artistString,
    createDate: '',
    favoritedTimes: 0,
    lengthSeconds: 0,
    pvServices: '',
    ratingScore: 0,
    songType: 'Unspecified',
    status: 'Finished',
    version: 0,
    thumbUrl: source.thumbUrl ?? undefined,
  };
}

export function hasPlayableVideo(song: Song): boolean {
  return song.pvs?.some(pv => isPlayablePV(pv)) ?? false;
}

/**
 * Full songs for the given ids, fetched in one batch (getSongsByIds caches them).
 * Results accumulate, so ids that leave the list keep their song.
 */
export function useSongsById(ids: readonly number[]): ReadonlyMap<number, Song> {
  const key = useMemo(
    () => [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))].sort((left, right) => left - right).join(','),
    [ids],
  );
  const [songs, setSongs] = useState<ReadonlyMap<number, Song>>(() => new Map());

  useEffect(() => {
    if (!key) return undefined;
    let active = true;
    getSongsByIds(key.split(',').map(Number))
      .then(loaded => {
        if (!active || loaded.length === 0) return;
        setSongs(previous => {
          const next = new Map(previous);
          loaded.forEach(song => next.set(song.id, song));
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [key]);

  return songs;
}
