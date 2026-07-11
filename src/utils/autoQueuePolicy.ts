import type { Song } from '../types/vocadb';

export type AutoQueueStage = 'early' | 'middle' | 'late';

export interface KnownUnknownTarget {
  known: number;
  unknown: number;
}

export interface AutoQueuePlan {
  stage: AutoQueueStage;
  target: KnownUnknownTarget;
  requestedCount: number;
}

export const AUTO_QUEUE_LOW_WATERMARK = 3;
export const AUTO_QUEUE_TARGET_WATERMARK = 12;
export const AUTO_QUEUE_MAX_BATCH_SIZE = 12;

/**
 * Session progress must be based on played automatic songs, not queue length.
 * Queue length changes whenever a refill succeeds and would otherwise make the
 * same session move backwards.
 */
export function getAutoQueueStage(autoPlayedCount: number): AutoQueueStage {
  if (autoPlayedCount < 5) return 'early';
  if (autoPlayedCount < 12) return 'middle';
  return 'late';
}

export function getKnownUnknownTarget(stage: AutoQueueStage, requestedCount: number): KnownUnknownTarget {
  const safeCount = Math.max(0, Math.floor(requestedCount));
  const knownRatio = stage === 'early' ? 0.8 : stage === 'middle' ? 0.6 : 0.4;
  const known = Math.round(safeCount * knownRatio);
  return { known, unknown: safeCount - known };
}

export function createAutoQueuePlan(remainingCount: number, autoPlayedCount: number): AutoQueuePlan | null {
  if (remainingCount > AUTO_QUEUE_LOW_WATERMARK) return null;

  const requestedCount = Math.min(
    AUTO_QUEUE_MAX_BATCH_SIZE,
    Math.max(0, AUTO_QUEUE_TARGET_WATERMARK - Math.max(0, remainingCount)),
  );
  const stage = getAutoQueueStage(autoPlayedCount);
  return { stage, target: getKnownUnknownTarget(stage, requestedCount), requestedCount };
}

/**
 * Selects an exact known/unknown mix where both pools are sufficient. If a pool
 * is exhausted, candidates from the other pool fill the remainder in ranked
 * order, so a low candidate supply never empties autoplay unnecessarily.
 */
export function selectKnownUnknownMix(
  knownSongs: Song[],
  unknownSongs: Song[],
  target: KnownUnknownTarget,
  excludeIds: ReadonlySet<number>,
): Song[] {
  const unique = (songs: Song[]) => {
    const seen = new Set<number>(excludeIds);
    return songs.filter(song => {
      if (seen.has(song.id)) return false;
      seen.add(song.id);
      return true;
    });
  };

  const known = unique(knownSongs);
  const unknown = unique(unknownSongs);
  const selectedKnown = known.slice(0, target.known);
  const knownIds = new Set(selectedKnown.map(song => song.id));
  const selectedUnknown = unknown.filter(song => !knownIds.has(song.id)).slice(0, target.unknown);
  const selectedIds = new Set([...knownIds, ...selectedUnknown.map(song => song.id)]);
  const requestedCount = target.known + target.unknown;

  const overflow = [...known, ...unknown].filter(song => !selectedIds.has(song.id));

  const result: Song[] = [];
  const resultIds = new Set<number>();
  for (const song of [...selectedKnown, ...selectedUnknown, ...overflow]) {
    if (resultIds.has(song.id)) continue;
    resultIds.add(song.id);
    result.push(song);
    if (result.length === requestedCount) break;
  }
  return result;
}
