/**
 * Markers and keyboard moves of the view-count chart's points (pure, unit-tested). Every daily point
 * stays a hover / tap / focus target; only how many dots are drawn and which one is the Tab stop change.
 */

/** Above this many points a series draws its line with only the first, last and highlighted dot. */
export const DENSE_SERIES_POINTS = 40;

/** Whether point `index` of a series with `count` points draws its dot. */
export function showsPointDot(index: number, count: number, highlighted: boolean): boolean {
  return count <= DENSE_SERIES_POINTS || highlighted || index === 0 || index === count - 1;
}

/**
 * Where ← → Home End move the focus inside one series (each series is a single Tab stop),
 * or null for any other key.
 */
export function pointIndexForKey(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowLeft': return Math.max(0, index - 1);
    case 'ArrowRight': return Math.min(count - 1, index + 1);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}
