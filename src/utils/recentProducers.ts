import type { Song } from '../types/vocadb';

interface RecentSongEntry {
  song: Song;
}

const PRODUCER_CATEGORIES = new Set(['Producer', 'Band', 'Circle']);
const PRODUCER_TYPES = new Set(['Producer', 'Band', 'Circle']);
const PRODUCER_ROLES = new Set(['Composer', 'Arranger']);

function isProducerLike(artist: NonNullable<Song['artists']>[number]): boolean {
  if (PRODUCER_CATEGORIES.has(artist.categories)) return true;
  if (artist.artist?.artistType && PRODUCER_TYPES.has(artist.artist.artistType)) return true;
  const roles = `${artist.roles},${artist.effectiveRoles}`
    .split(/[,;]/)
    .map(role => role.trim())
    .filter(Boolean);
  return roles.some(role => PRODUCER_ROLES.has(role));
}

export function selectRecentProducerIds(
  entries: RecentSongEntry[],
  maxProducers = 8,
  historyWindow = 50,
): number[] {
  const scores = new Map<number, number>();
  const seenSongs = new Set<number>();

  entries.slice(0, historyWindow).forEach((entry, index) => {
    if (seenSongs.has(entry.song.id)) return;
    seenSongs.add(entry.song.id);
    const recencyScore = historyWindow - index;

    for (const artist of entry.song.artists ?? []) {
      const id = artist.artist?.id;
      if (id === undefined || !Number.isInteger(id) || id <= 0 || !isProducerLike(artist)) continue;
      scores.set(id, (scores.get(id) ?? 0) + recencyScore);
    }
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, maxProducers)
    .map(([id]) => id);
}

export function interleaveUniqueSongs(
  groups: Song[][],
  excludedIds: ReadonlySet<number>,
  limit: number,
): Song[] {
  const result: Song[] = [];
  const seen = new Set(excludedIds);
  const maxGroupLength = Math.max(0, ...groups.map(group => group.length));

  for (let index = 0; index < maxGroupLength && result.length < limit; index += 1) {
    for (const group of groups) {
      const song = group[index];
      if (!song || seen.has(song.id)) continue;
      seen.add(song.id);
      result.push(song);
      if (result.length >= limit) break;
    }
  }

  return result;
}
