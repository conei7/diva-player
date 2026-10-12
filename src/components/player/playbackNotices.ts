/**
 * Turns playback failures into one notice each (DESIGN_SPEC §6.2.1 「再生の失敗を知らせる」).
 *
 * Every failure path sets `playerStore.error` first and then lets the store recover:
 * - another video of the same song is selected (tryNextPV)            → 'switched'
 * - every video failed and the queue moved on (tryNextPV → next)       → 'skipped'
 * - a queued song has no playable video and the store skips it later   → 'skipped' (no 「戻る」)
 * - nothing could be played (end of the queue)                         → 'failed'
 * The tracker watches consecutive store states (zustand calls listeners synchronously after each
 * set), so the recovery that follows an error is attributed to that error. It never reads the
 * error text, which is internal.
 */
import type { PV, PVService, Song } from '../../types/vocadb';
import { isPlayablePV } from '../../utils/playablePV';

export type PlaybackNotice =
  /** The same song continues on another video. */
  | { kind: 'switched'; from: PVService; to: PVService }
  /** The failed song was skipped; `queueIndex` is where it sits in the queue (for 「戻る」). */
  | { kind: 'skipped'; songId: number; queueIndex: number; canGoBack: boolean }
  /** Nothing else to play. `canRetry` is false when the song has no playable video at all. */
  | { kind: 'failed'; songId: number; canRetry: boolean };

/** The part of playerStore the tracker reads. */
export interface PlaybackFailureSnapshot {
  currentSong: Pick<Song, 'id' | 'pvs'> | null;
  currentPV: Pick<PV, 'id' | 'service'> | null;
  queue: ReadonlyArray<Pick<Song, 'id' | 'pvs'>>;
  queueIndex: number;
  error: string | null;
}

/** How long the store gets to recover (it skips a song without a video after 500ms). */
export const PLAYBACK_FAILURE_SETTLE_MS = 1_500;

export interface PlaybackFailureTrackerOptions {
  onNotice: (notice: PlaybackNotice) => void;
  /** Called after a failure is reported, with the error that started it (to clear playerStore.error). */
  onSettled?: (error: string) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface PendingFailure {
  error: string;
  songId: number;
  pvId: number | null;
  service: PVService | null;
  queueIndex: number;
  /** The song has no playable video at all (nothing to retry, nothing to go back to). */
  noVideo: boolean;
}

function hasPlayableVideo(song: Pick<Song, 'pvs'>): boolean {
  return (song.pvs ?? []).some(isPlayablePV);
}

export function createPlaybackFailureTracker({
  onNotice,
  onSettled,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: PlaybackFailureTrackerOptions) {
  let pending: PendingFailure | null = null;
  let timer: unknown = null;

  const settle = (): PendingFailure | null => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const settled = pending;
    pending = null;
    if (settled) onSettled?.(settled.error);
    return settled;
  };

  const resolve = (state: PlaybackFailureSnapshot, prev: PlaybackFailureSnapshot) => {
    if (!pending) return;
    const songId = state.currentSong?.id ?? null;
    const songChanged = songId !== (prev.currentSong?.id ?? null);
    if (songChanged && songId !== null && songId !== pending.songId) {
      const failed = settle();
      if (failed) onNotice({ kind: 'skipped', songId: failed.songId, queueIndex: failed.queueIndex, canGoBack: !failed.noVideo });
      return;
    }
    const pvId = state.currentPV?.id ?? null;
    if (
      !songChanged
      && !pending.noVideo
      && songId === pending.songId
      && state.currentPV
      && pvId !== pending.pvId
      && pvId !== (prev.currentPV?.id ?? null)
    ) {
      const failed = settle();
      if (failed?.service) onNotice({ kind: 'switched', from: failed.service, to: state.currentPV.service });
    }
  };

  const detect = (state: PlaybackFailureSnapshot, prev: PlaybackFailureSnapshot) => {
    if (pending || !state.error || state.error === prev.error) return;
    // A queued song without any video fails before it becomes the current song: the queue index
    // already points at it while the previous song is still current.
    const indexed = state.queue[state.queueIndex];
    const failing = indexed && indexed.id !== state.currentSong?.id && !hasPlayableVideo(indexed)
      ? indexed
      : state.currentSong;
    if (!failing) return;
    const noVideo = !hasPlayableVideo(failing);
    pending = {
      error: state.error,
      songId: failing.id,
      pvId: noVideo ? null : state.currentPV?.id ?? null,
      service: noVideo ? null : state.currentPV?.service ?? null,
      queueIndex: state.queueIndex,
      noVideo,
    };
    timer = setTimer(() => {
      timer = null;
      const failed = settle();
      if (failed) onNotice({ kind: 'failed', songId: failed.songId, canRetry: !failed.noVideo });
    }, PLAYBACK_FAILURE_SETTLE_MS);
  };

  return {
    /** Feed every store change: `usePlayerStore.subscribe(tracker.update)`. */
    update(state: PlaybackFailureSnapshot, prev: PlaybackFailureSnapshot) {
      resolve(state, prev);
      detect(state, prev);
    },
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
    },
  };
}
