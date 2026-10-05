import type { Song } from '../types/vocadb';

export interface DedupedQueue {
  queue: Song[];
  queueIndex: number;
  currentSong: Song | null;
  removed: number;
}

export const MIX_QUEUE_DISPLAY_TARGET = 40;
export const MIX_QUEUE_DISPLAY_HISTORY_LIMIT = 10;

export interface QueueDisplayWindow<T> {
  items: T[];
  startIndex: number;
}

/** Keeps the current item visible while limiting rendered playback history. */
export function getQueueDisplayWindow<T>(
  queue: readonly T[],
  queueIndex: number,
  historyLimit = MIX_QUEUE_DISPLAY_HISTORY_LIMIT,
): QueueDisplayWindow<T> {
  const hasCurrentIndex = Number.isInteger(queueIndex) && queueIndex >= 0 && queueIndex < queue.length;
  const startIndex = hasCurrentIndex
    ? Math.max(0, queueIndex - Math.max(0, historyLimit))
    : 0;
  return { items: queue.slice(startIndex), startIndex };
}

/** Returns a new Fisher-Yates shuffled array without mutating the source. */
export function shuffleQueue<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function dedupeQueueBySongId(queue: Song[], queueIndex: number, currentSong: Song | null): DedupedQueue {
  if (queue.length <= 1) {
    return { queue, queueIndex, currentSong, removed: 0 };
  }

  const indexesBySongId = new Map<number, number[]>();
  queue.forEach((song, index) => {
    const indexes = indexesBySongId.get(song.id) ?? [];
    indexes.push(index);
    indexesBySongId.set(song.id, indexes);
  });

  const keepIndexes = new Set<number>();
  indexesBySongId.forEach(indexes => {
    keepIndexes.add(indexes.includes(queueIndex) ? queueIndex : indexes[0]);
  });

  const nextQueue = queue.filter((_, index) => keepIndexes.has(index));
  const removed = queue.length - nextQueue.length;
  if (removed === 0) {
    return { queue, queueIndex, currentSong, removed: 0 };
  }

  const currentIndex = nextQueue.findIndex(song => song.id === currentSong?.id);
  const nextIndex = currentIndex >= 0 ? currentIndex : Math.min(queueIndex, nextQueue.length - 1);
  const nextCurrentSong = nextQueue[nextIndex] ?? null;

  return {
    queue: nextQueue,
    queueIndex: nextIndex,
    currentSong: nextCurrentSong,
    removed,
  };
}
