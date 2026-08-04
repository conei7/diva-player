export const PLAYBACK_WAKE_GAP_MS = 5_000;
export const PLAYBACK_WAKE_DEBOUNCE_MS = 250;

export type PlaybackWakeSource = 'heartbeat' | 'visibility' | 'pageshow' | 'focus' | 'online' | 'resume';

export interface PlaybackWakeSignal {
  source: PlaybackWakeSource;
  gapMs: number;
}

interface PlaybackWakeDetectorOptions {
  now?: () => number;
  wakeGapMs?: number;
  debounceMs?: number;
}

/**
 * Detects a browser event-loop suspension without treating wall-clock time as
 * listened playback time. Player adapters use the signal to query their own
 * authoritative position and either resume there or advance when truly ended.
 */
export function createPlaybackWakeDetector(options: PlaybackWakeDetectorOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const wakeGapMs = options.wakeGapMs ?? PLAYBACK_WAKE_GAP_MS;
  const debounceMs = options.debounceMs ?? PLAYBACK_WAKE_DEBOUNCE_MS;
  let lastObservedAt = now();
  let lastEmittedAt = Number.NEGATIVE_INFINITY;

  return {
    observe(source: PlaybackWakeSource, force = false): PlaybackWakeSignal | null {
      const observedAt = now();
      const gapMs = Math.max(0, observedAt - lastObservedAt);
      lastObservedAt = observedAt;
      if (!force && gapMs < wakeGapMs) return null;
      if (observedAt - lastEmittedAt < debounceMs) return null;
      lastEmittedAt = observedAt;
      return { source, gapMs };
    },
  };
}

export function getSafeWakePosition(
  playerPosition: number,
  lastKnownPosition: number,
  duration: number,
): number {
  const nativePosition = Number.isFinite(playerPosition) ? Math.max(0, playerPosition) : 0;
  const rememberedPosition = Number.isFinite(lastKnownPosition) ? Math.max(0, lastKnownPosition) : 0;
  const position = Math.max(nativePosition, rememberedPosition);
  return Number.isFinite(duration) && duration > 0 ? Math.min(duration, position) : position;
}
