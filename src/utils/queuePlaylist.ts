import type { Song } from '../types/vocadb';

export type QueueSaveScope = 'all' | 'currentAndRemaining' | 'remaining';

export function getQueueSongsForScope(queue: Song[], queueIndex: number, scope: QueueSaveScope): Song[] {
  if (scope === 'all' || queueIndex < 0) return [...queue];
  if (scope === 'remaining') return queue.slice(queueIndex + 1);
  return queue.slice(queueIndex);
}
