export interface ProgressiveWindow {
  start: number;
  count: number;
}

/** Offsets contiguous pages that show a small first batch and larger appends. */
export function getProgressiveWindow(
  page: number,
  firstCount = 12,
  appendCount = 28,
  laterCount = appendCount,
): ProgressiveWindow {
  const normalizedPage = Math.max(0, Math.floor(page));
  const normalizedFirst = Math.max(1, Math.floor(firstCount));
  const normalizedAppend = Math.max(1, Math.floor(appendCount));
  const normalizedLater = Math.max(1, Math.floor(laterCount));
  if (normalizedPage === 0) return { start: 0, count: normalizedFirst };
  if (normalizedPage === 1) return { start: normalizedFirst, count: normalizedAppend };
  return {
    start: normalizedFirst + normalizedAppend + (normalizedPage - 2) * normalizedLater,
    count: normalizedLater,
  };
}
