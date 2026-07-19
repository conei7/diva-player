export const PLAYBACK_END_TOLERANCE_SECONDS = 0.75;
export const MAX_PLAYBACK_END_CHECK_DELAY_MS = 30_000;

export function hasReachedPlaybackEnd(currentTime: number, duration: number): boolean {
  return Number.isFinite(currentTime)
    && Number.isFinite(duration)
    && duration > 0
    && currentTime >= duration - PLAYBACK_END_TOLERANCE_SECONDS;
}

/** Background tabs throttle short intervals, so schedule from wall-clock time too. */
export function getPlaybackEndCheckDelayMs(currentTime: number, duration: number): number {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) {
    return MAX_PLAYBACK_END_CHECK_DELAY_MS;
  }
  const remainingMs = Math.max(0, duration - currentTime) * 1000 + 500;
  return Math.max(500, Math.min(MAX_PLAYBACK_END_CHECK_DELAY_MS, remainingMs));
}
