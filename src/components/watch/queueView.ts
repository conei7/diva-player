/**
 * What the playing-list panel and the queue drawer show for the current queue (pure, unit-tested).
 * Songs added by autoplay ('auto') are listed after a 「自動再生」 divider and are not counted in
 * the 「{current} / {total}」 position.
 */
import type { Song } from '../../types/vocadb';
import type { PlaybackSource } from '../../stores/playerStore';
import { getQueueDisplayWindow } from '../../utils/queueUtils';

export interface QueueEntry {
  song: Song;
  /** Index in the whole queue (what jumpToIndex / removeFromQueue take). */
  index: number;
  auto: boolean;
}

export interface QueueSegment {
  auto: boolean;
  entries: QueueEntry[];
}

export interface QueueView {
  /** The rendered window: up to ten played songs, the current one and everything after it. */
  entries: QueueEntry[];
  /** `entries` split where autoplay songs start or stop. */
  segments: QueueSegment[];
  nextSong: Song | null;
  /** Position among the songs that were not added by autoplay; null while an autoplay song plays. */
  position: { current: number; total: number } | null;
  currentIsAuto: boolean;
  /** Mixes (autoplay from one song, discovery mix, chorus highlights) start with the panel collapsed. */
  isMix: boolean;
  duplicateCount: number;
}

/** Built-in queue titles (stored as they are; see utils/displayNames.ts). */
const MIX_QUEUE_TITLES = new Set([
  'ミックスリスト',
  'ミックス',
  '発掘ミックス',
  '15秒サビハイライト',
  '15-second chorus highlights',
  'サビ発掘',
]);

export function buildQueueView(
  queue: readonly Song[],
  queueIndex: number,
  queueSources: readonly PlaybackSource[],
  queueTitle: string | undefined,
): QueueView {
  const sourceAt = (index: number): PlaybackSource => queueSources[index] ?? 'manual';
  const { items, startIndex } = getQueueDisplayWindow(queue, queueIndex);
  const entries: QueueEntry[] = items.map((song, offset) => {
    const index = startIndex + offset;
    return { song, index, auto: sourceAt(index) === 'auto' };
  });

  const segments: QueueSegment[] = [];
  for (const entry of entries) {
    const last = segments.at(-1);
    if (last && last.auto === entry.auto) last.entries.push(entry);
    else segments.push({ auto: entry.auto, entries: [entry] });
  }

  const hasCurrent = queueIndex >= 0 && queueIndex < queue.length;
  const currentIsAuto = hasCurrent && sourceAt(queueIndex) === 'auto';
  let total = 0;
  let current = 0;
  queue.forEach((_, index) => {
    if (sourceAt(index) === 'auto') return;
    total += 1;
    if (index <= queueIndex) current += 1;
  });
  const position = hasCurrent && !currentIsAuto && total > 1 ? { current, total } : null;

  const ownSources = queue.map((_, index) => sourceAt(index)).filter(source => source !== 'auto');
  const isMix = MIX_QUEUE_TITLES.has(queueTitle ?? '')
    || (ownSources.length > 0 && ownSources.every(source => source === 'discovery'));

  return {
    entries,
    segments,
    nextSong: hasCurrent ? queue[queueIndex + 1] ?? null : null,
    position,
    currentIsAuto,
    isMix,
    duplicateCount: queue.length - new Set(queue.map(song => song.id)).size,
  };
}
