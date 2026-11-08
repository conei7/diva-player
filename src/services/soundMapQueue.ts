/**
 * 曲調マップ「近くの曲」のすべて再生を、通常のおすすめへ切り替えずに近い順のまま続ける (useAutoQueue).
 *
 * The sound-map API gives at most the 200 songs nearest to one song, most similar first (the
 * order of the 近くの曲 list). The origin's own 200 come first, so the queue goes on with the
 * 21st, 22nd, … listed song. Past them the walk widens outward: the origin's neighbours, nearest
 * first, each add their own nearest songs that have not been queued yet (breadth first, so the
 * songs closest to the origin keep coming first).
 */
import { fetchSoundMap, SoundMapRequestError } from '../api/soundMap';
import { getSongsByIds } from '../api/vocadb';
import type { Song } from '../types/vocadb';
import { isPlayablePV } from '../utils/playablePV';

/** The sound-map API's largest page. */
export const SOUND_MAP_NEIGHBOR_LIMIT = 200;
/** Map requests one refill may make (each covers up to 200 songs)… */
export const SOUND_MAP_REQUESTS_PER_REFILL = 3;
/** …and while it has found nothing new yet (far out, neighbour lists overlap a lot). */
export const SOUND_MAP_REQUESTS_WHEN_EMPTY = 8;
const MAX_CACHED_NEIGHBOR_LISTS = 256;
const SONG_BATCH_SIZE = 100;

interface SoundMapWalk {
  originSongId: number;
  /** Songs whose neighbours extend the list, in visiting order: the origin, then its neighbours, … */
  anchors: number[];
  anchorIds: Set<number>;
  /** Songs this walk put in the queue: one the user removed from the queue does not come back. */
  queued: Set<number>;
  /** Songs without a playable video. */
  unplayable: Set<number>;
}

const neighborLists = new Map<number, number[]>();
let walk: SoundMapWalk | null = null;

function walkFrom(originSongId: number): SoundMapWalk {
  if (walk?.originSongId !== originSongId) {
    walk = {
      originSongId,
      anchors: [originSongId],
      anchorIds: new Set([originSongId]),
      queued: new Set(),
      unplayable: new Set(),
    };
  }
  return walk;
}

async function loadNeighbors(songId: number, signal?: AbortSignal): Promise<number[]> {
  let ids: number[];
  try {
    const map = await fetchSoundMap(songId, { limit: SOUND_MAP_NEIGHBOR_LIMIT, signal });
    ids = map.items.filter(item => item.songId !== map.origin.songId).map(item => item.songId);
  } catch (error) {
    // A song outside the current map has no neighbours to add; anything else is a real failure.
    if (!(error instanceof SoundMapRequestError) || error.status !== 404) throw error;
    ids = [];
  }
  neighborLists.delete(songId);
  neighborLists.set(songId, ids);
  while (neighborLists.size > MAX_CACHED_NEIGHBOR_LISTS) {
    neighborLists.delete(neighborLists.keys().next().value!);
  }
  return ids;
}

export interface NextSoundMapSongsOptions {
  originSongId: number;
  /** Songs already in the queue and hidden songs. */
  excludeIds: ReadonlySet<number>;
  count: number;
  signal?: AbortSignal;
}

/**
 * The next `count` playable songs after the ones in the queue, in nearest order. Fewer (or none)
 * when this refill's map requests run out; the next refill goes on from there.
 */
export async function nextSoundMapQueueSongs({
  originSongId,
  excludeIds,
  count,
  signal,
}: NextSoundMapSongsOptions): Promise<Song[]> {
  if (count <= 0) return [];
  const state = walkFrom(originSongId);
  const picked: Song[] = [];
  /** Songs looked at in this refill: picked, or not returned by the batch API this time. */
  const seen = new Set<number>();
  let requests = 0;

  while (picked.length < count) {
    const wanted = Math.min(SONG_BATCH_SIZE, (count - picked.length) * 2);
    const ids: number[] = [];
    const chosen = new Set<number>();
    for (let index = 0; index < state.anchors.length && ids.length < wanted; index++) {
      const anchor = state.anchors[index];
      let neighbors = neighborLists.get(anchor);
      if (!neighbors) {
        const budget = picked.length + ids.length > 0 ? SOUND_MAP_REQUESTS_PER_REFILL : SOUND_MAP_REQUESTS_WHEN_EMPTY;
        if (requests >= budget) break;
        requests += 1;
        neighbors = await loadNeighbors(anchor, signal);
        signal?.throwIfAborted();
      }
      for (const id of neighbors) {
        if (state.anchorIds.has(id)) continue;
        state.anchorIds.add(id);
        state.anchors.push(id);
      }
      for (const id of neighbors) {
        if (ids.length >= wanted) break;
        if (
          id === originSongId
          || excludeIds.has(id)
          || state.queued.has(id)
          || state.unplayable.has(id)
          || seen.has(id)
          || chosen.has(id)
        ) continue;
        chosen.add(id);
        ids.push(id);
      }
    }
    if (ids.length === 0) break;

    const songs = await getSongsByIds(ids);
    signal?.throwIfAborted();
    const byId = new Map(songs.map(song => [song.id, song]));
    for (const id of ids) {
      if (picked.length >= count) break;
      const song = byId.get(id);
      if (song && !song.pvs?.some(pv => isPlayablePV(pv))) {
        state.unplayable.add(id);
        continue;
      }
      seen.add(id);
      if (song) picked.push(song);
    }
  }
  return picked;
}

/** Called once the songs are in the queue, so the walk never offers them again. */
export function rememberSoundMapQueueSongs(originSongId: number, songs: readonly Song[]): void {
  const state = walkFrom(originSongId);
  songs.forEach(song => state.queued.add(song.id));
}

/** Tests only. */
export function resetSoundMapQueueForTests(): void {
  neighborLists.clear();
  walk = null;
}
