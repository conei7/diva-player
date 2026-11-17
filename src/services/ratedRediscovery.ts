import { attachExternalViews, getDiscoveryEligibleSongIds, getSongsByIds } from '../api/vocadb';
import type { Song } from '../types/vocadb';
import type { GlobalFilterSettings } from '../stores/globalFilterStore';
import { matchesDiscoveryFilter, requiresExternalViewCounts } from '../utils/globalFilters';
import { isVoiceSynthSong } from '../utils/voiceSynthSongs';
import { isPlayablePV } from '../utils/playablePV';

export const REDISCOVERY_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const REDISCOVERY_REASON = 'しばらく聴いていない評価済みの曲との再会';
const WEIGHTS: Record<number, number> = { 2: 1, 3: 2, 4: 8, 5: 12 };
const MAX_CANDIDATES = 12;

export interface RatedRediscoveryOptions {
  ratings: Record<string, number>;
  lastPlayedAtBySongId: ReadonlyMap<number, number | null>;
  excludeIds: ReadonlySet<number>;
  settings: GlobalFilterSettings;
  requestedCount: number;
  now?: number;
  random?: () => number;
  signal?: AbortSignal;
}

/** Weighted sampling without replacement over ALL rated IDs, including songs
 * absent from the bounded history/playlist metadata pool. Every valid ID has
 * positive probability; the metadata/network work stays bounded to 12 cards. */
export function sampleRatedRediscoveryIds(options: RatedRediscoveryOptions): number[] {
  const { ratings, lastPlayedAtBySongId, excludeIds, now = Date.now(), random = Math.random } = options;
  return Object.entries(ratings).flatMap(([key, rating]) => {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id <= 0 || !WEIGHTS[rating] || excludeIds.has(id)) return [];
    const lastPlayed = lastPlayedAtBySongId.get(id);
    if (lastPlayed != null && (!Number.isFinite(lastPlayed) || now - lastPlayed < REDISCOVERY_AGE_MS)) return [];
    const u = Math.max(Number.MIN_VALUE, Math.min(1, random()));
    return [{ id, priority: -Math.log(u) / WEIGHTS[rating] }];
  }).sort((a, b) => a.priority - b.priority || a.id - b.id)
    .slice(0, MAX_CANDIDATES).map(item => item.id);
}

/** At most one surprise per refill; a 12-song refill has a 65% chance.
 * Smaller refills scale down, and explicit filters are never relaxed here. */
export async function getRatedRediscoverySong(options: RatedRediscoveryOptions): Promise<Song | null> {
  const { settings, requestedCount, signal, random = Math.random } = options;
  if (signal?.aborted || settings.excludeRatedFromDiscovery || requestedCount <= 0
    || random() >= Math.min(0.8, requestedCount / 12 * 0.65)) return null;
  const ids = sampleRatedRediscoveryIds(options);
  if (ids.length === 0) return null;
  try {
    const eligible = await getDiscoveryEligibleSongIds(ids, signal);
    if (signal?.aborted) return null;
    const cards = await getSongsByIds(ids.filter(id => eligible.has(id)));
    if (signal?.aborted) return null;
    const songs = requiresExternalViewCounts(settings) ? await attachExternalViews(cards) : cards;
    if (signal?.aborted) return null;
    const byId = new Map(songs.map(song => [song.id, song]));
    for (const id of ids) {
      const song = byId.get(id);
      if (song && eligible.has(id) && isVoiceSynthSong(song)
        && song.pvs?.some(isPlayablePV) && matchesDiscoveryFilter(song, options)) return song;
    }
  } catch {
    // An optional surprise must never prevent the ordinary queue from filling.
  }
  return null;
}

export function insertRatedRediscovery(
  ranked: Song[], song: Song | null, total: number, random = Math.random,
): Song[] {
  if (!song || total <= 0) return ranked;
  const next = ranked.filter(item => item.id !== song.id).slice(0, total - 1);
  const position = Math.min(next.length, Math.floor(random() * (next.length + 1)));
  next.splice(position, 0, song);
  return next;
}
