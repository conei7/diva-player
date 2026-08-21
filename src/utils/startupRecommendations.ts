import type { Song } from '../types/vocadb';

const STABLE_TOP_COUNT = 4;

function positiveModulo(value: number, divisor: number): number {
  if (divisor <= 0) return 0;
  return ((value % divisor) + divisor) % divisor;
}

/**
 * Keeps the highest-confidence songs anchored while rotating the remaining
 * personalized pool on each full page load. This changes both content (when
 * the pool exceeds the page size) and order without mixing in generic songs.
 */
export function selectRotatingStartupSongs(
  songs: Song[],
  rotation: number,
  limit: number,
): Song[] {
  const target = Math.max(0, Math.floor(limit));
  if (target === 0) return [];

  const seen = new Set<number>();
  const uniqueSongs = songs.filter(song => {
    if (!Number.isInteger(song.id) || seen.has(song.id)) return false;
    seen.add(song.id);
    return true;
  });
  if (uniqueSongs.length <= 1) return uniqueSongs.slice(0, target);
  if (uniqueSongs.length <= STABLE_TOP_COUNT) {
    const offset = positiveModulo(Math.floor(rotation), uniqueSongs.length);
    return [...uniqueSongs.slice(offset), ...uniqueSongs.slice(0, offset)].slice(0, target);
  }

  const coreCount = Math.min(STABLE_TOP_COUNT, target, uniqueSongs.length);
  const core = uniqueSongs.slice(0, coreCount);
  const tail = uniqueSongs.slice(coreCount);
  const remaining = Math.min(target - core.length, tail.length);
  if (remaining <= 0) return core;

  const rotationStep = tail.length <= remaining ? 1 : remaining;
  const offset = positiveModulo(Math.floor(rotation) * rotationStep, tail.length);
  const selected = Array.from(
    { length: remaining },
    (_, index) => tail[(offset + index) % tail.length],
  );
  return [...core, ...selected];
}
