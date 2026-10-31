import { usePlayerStore } from '../stores/playerStore';

type NextState = Pick<
  ReturnType<typeof usePlayerStore.getState>,
  'queue' | 'queueIndex' | 'loopMode' | 'restoringQueueWindow'
>;

/**
 * Whether 次の曲 moves on: there is a next song, or the queue repeats. At the end of the queue
 * next() stops playback, so every bar disables 次の曲 (and ignores the left swipe) there until
 * autoplay appends songs; a shelf song starts as a one-song queue. During a cold restore the next
 * song comes from the loaded window, as in the queue view (useQueueView). A zustand selector, so
 * swipe handlers can also read it once with `selectCanGoNext(usePlayerStore.getState())`.
 */
export function selectCanGoNext({ queue, queueIndex, loopMode, restoringQueueWindow: restoring }: NextState): boolean {
  const songs = restoring?.songs ?? queue;
  const index = queueIndex - (restoring?.offset ?? 0);
  const hasNextSong = index >= 0 && index + 1 < songs.length;
  // A restoring window means the current song is loaded, so a repeating queue can always go on
  // (next() wraps or replays it while the rest of the saved queue loads).
  return hasNextSong || ((queue.length > 0 || restoring !== null) && loopMode !== 'none');
}

/** The player bars' rule for 次の曲 (see selectCanGoNext). */
export function useCanGoNext(): boolean {
  return usePlayerStore(selectCanGoNext);
}
