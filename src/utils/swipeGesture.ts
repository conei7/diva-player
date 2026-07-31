export type SwipeDirection = 'left' | 'right' | 'up';

export interface SwipeGesturePoint {
  x: number;
  y: number;
  time: number;
}

export interface SwipeGestureOptions {
  horizontalThreshold?: number;
  upwardThreshold?: number;
  maxDurationMs?: number;
  horizontalDominance?: number;
}

const DEFAULTS: Required<SwipeGestureOptions> = {
  horizontalThreshold: 64,
  upwardThreshold: 72,
  maxDurationMs: 600,
  horizontalDominance: 1.25,
};

export function getSwipeDirection(
  start: SwipeGesturePoint,
  end: SwipeGesturePoint,
  options: SwipeGestureOptions = {},
): SwipeDirection | null {
  const config = { ...DEFAULTS, ...options };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const duration = end.time - start.time;
  if (duration < 0 || duration > config.maxDurationMs) return null;

  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX >= config.horizontalThreshold && absX >= absY * config.horizontalDominance) {
    return dx < 0 ? 'left' : 'right';
  }
  if (dy <= -config.upwardThreshold && absY >= absX * config.horizontalDominance) return 'up';
  return null;
}
