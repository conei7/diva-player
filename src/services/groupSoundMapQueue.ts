import { fetchGroupSoundMap } from '../api/soundMap';
import { getSongsByIds } from '../api/vocadb';
import type { QueueContinuation } from '../stores/playerStore';
import type { Song } from '../types/vocadb';
import { isPlayablePV } from '../utils/playablePV';

type GroupContinuation = Extract<QueueContinuation, { kind: 'groupSoundMap' }>;
interface Page { ids: number[]; nextOffset: number; hasMore: boolean }
interface Walk { key: string; pages: Page[]; queued: Set<number>; unplayable: Set<number> }
// One active walk, at most the server's 100,000 IDs; never retain complete vectors or song objects.
let walk: Walk | null = null;
const keyOf = (group: GroupContinuation) => JSON.stringify([group.songIds, group.mapVersion, group.axisKey]);
function stateFor(group: GroupContinuation): Walk {
  const key = keyOf(group);
  if (walk?.key !== key) walk = { key, pages: [], queued: new Set(), unplayable: new Set() };
  return walk;
}

/** Continue around the original group's centre, using every coordinate rather than sampled dots. */
export async function nextGroupSoundMapQueueSongs({ continuation, excludeIds, count, signal }: {
  continuation: GroupContinuation; excludeIds: ReadonlySet<number>; count: number; signal: AbortSignal;
}): Promise<Song[]> {
  if (count <= 0) return [];
  const state = stateFor(continuation);
  const seeds = new Set(continuation.songIds);
  const picked: Song[] = [];
  const seen = new Set<number>();
  let requests = 0;
  while (picked.length < count) {
    signal.throwIfAborted();
    const wanted = Math.min(100, (count - picked.length) * 2);
    const ids: number[] = [];
    const chosen = new Set<number>();
    for (let pageIndex = 0; ids.length < wanted; pageIndex++) {
      let page = state.pages[pageIndex];
      if (!page) {
        const previous = state.pages.at(-1);
        if (previous && !previous.hasMore) break;
        if (requests >= (picked.length + ids.length > 0 ? 3 : 8)) break;
        requests++;
        const offset = previous?.nextOffset ?? 0;
        const result = await fetchGroupSoundMap(continuation.songIds, {
          signal, mapVersion: continuation.mapVersion, axisKey: continuation.axisKey,
          nearbyOffset: offset, nearbyLimit: 200, nearbyOnly: true,
        });
        signal.throwIfAborted();
        const nextOffset = result.nearbyNextOffset;
        if (!result.nearby || result.nearby.length > 200 || typeof result.nearbyHasMore !== 'boolean'
          || !Number.isSafeInteger(nextOffset) || nextOffset! < offset || nextOffset! > 100_000
          || (result.nearbyHasMore && nextOffset! <= offset)
          || result.mapVersion !== continuation.mapVersion
          || `${result.axisSelectionVersion}:${result.axes?.x}:${result.axes?.y}` !== continuation.axisKey) {
          throw new Error('Group map continuation contract changed');
        }
        page = { ids: result.nearby.map(point => point.songId), nextOffset: nextOffset!, hasMore: result.nearbyHasMore };
        state.pages.push(page);
      }
      for (const id of page.ids) {
        if (ids.length >= wanted) break;
        if (seeds.has(id) || excludeIds.has(id) || state.queued.has(id) || state.unplayable.has(id)
          || seen.has(id) || chosen.has(id)) continue;
        chosen.add(id);
        ids.push(id);
      }
    }
    if (ids.length === 0) break;
    const songs = await getSongsByIds(ids);
    signal.throwIfAborted();
    const byId = new Map(songs.map(song => [song.id, song]));
    for (const id of ids) {
      if (picked.length >= count) break;
      seen.add(id);
      const song = byId.get(id);
      if (song && !song.pvs?.some(isPlayablePV)) state.unplayable.add(id);
      else if (song) picked.push(song);
    }
  }
  return picked;
}

/** Only an accepted atomic queue append consumes the songs, so aborted work can be retried. */
export function rememberGroupSoundMapQueueSongs(group: GroupContinuation, songs: readonly Song[]): void {
  const state = stateFor(group);
  songs.forEach(song => state.queued.add(song.id));
}

export function resetGroupSoundMapQueueForTests(): void { walk = null; }
