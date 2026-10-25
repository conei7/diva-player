import { useEffect, useRef, useState } from 'react';
import type { Song } from '../../types/vocadb';
import { getSongsByIds } from '../../api/vocadb';
import { AtlasSongLoader } from '../../utils/atlasSongLoader';
import { placeholderSong, type DiscoverySongSource } from './discoverySongs';

export function useAtlasSongs(ids: readonly number[], initial: readonly DiscoverySongSource[], scrollingUntil: { current: number }, priorityId?: number) {
  const [loader] = useState(() => new AtlasSongLoader(getSongsByIds, initial.map(placeholderSong)));
  const [songs, setSongs] = useState<ReadonlyMap<number, Song>>(() => new Map(loader.songs));
  const published = useRef(songs);
  const wanted = useRef(ids);
  wanted.current = ids;
  const priority = useRef(priorityId);
  priority.current = priorityId;
  const schedule = useRef(() => {});
  const key = ids.join(',');
  useEffect(() => {
    let frame = 0;
    const publish = () => {
      frame = 0;
      // One network batch may contain many new Japanese titles. Publish a few
      // per frame so their font shaping/layout cannot block a scroll gesture.
      const ready = wanted.current.filter(id => loader.songs.has(id) && !published.current.has(id));
      if (!ready.length) return;
      // Keep network/prefetch work running during a gesture, but let native
      // scrolling finish before adding newly shaped text. Existing labels stay.
      const moving = performance.now() < scrollingUntil.current;
      const publishIds = moving ? ready.filter(id => id === priority.current) : ready.slice(0, 4);
      if (!publishIds.length) { frame = requestAnimationFrame(publish); return; }
      const next = new Map(published.current);
      publishIds.forEach(id => next.set(id, loader.songs.get(id)!));
      const protectedIds = new Set(wanted.current);
      for (const id of next.keys()) {
        if (next.size <= 4096) break;
        if (!protectedIds.has(id)) next.delete(id);
      }
      published.current = next;
      setSongs(next);
      if (ready.length > publishIds.length) frame = requestAnimationFrame(publish);
    };
    schedule.current = () => { if (!frame) frame = requestAnimationFrame(publish); };
    const unsubscribe = loader.subscribe(() => schedule.current());
    return () => { unsubscribe(); cancelAnimationFrame(frame); loader.request([]); };
  }, [loader, scrollingUntil]);
  useEffect(() => {
    loader.request(key ? key.split(',').map(Number) : []);
    schedule.current();
  }, [loader, key]);
  return songs;
}
