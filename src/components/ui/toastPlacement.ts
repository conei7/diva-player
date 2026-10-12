/**
 * Where the toast goes while a bottom sheet or modal dialog is open (pure, unit-tested).
 * Used by ToastBehavior (loaded after the first paint, outside the initial bundle).
 */

export interface ModalToastGeometry {
  viewportHeight: number;
  /** Layout box of the open bottom sheet / dialog panel / drawer (viewport px). */
  surfaceTop: number;
  surfaceBottom: number;
  /** Height of the panel's sticky footer; 0 when it has none. */
  footerHeight: number;
  toastHeight: number;
  /** env(safe-area-inset-top / -bottom) in px. */
  safeTop: number;
  safeBottom: number;
}

/**
 * The toast's distance from the viewport bottom while a sheet or modal dialog is open below
 * 1024px (the mini player and the bottom navigation are behind its scrim, so their clearance no
 * longer applies). In order: under the surface when there is room (centred dialogs), just above
 * it (bottom sheets), above its footer (full-screen dialogs), else at the bottom edge.
 */
export function computeModalToastBottom(geometry: ModalToastGeometry, gap = 8): number {
  const { viewportHeight, surfaceTop, surfaceBottom, footerHeight, toastHeight, safeTop, safeBottom } = geometry;
  const need = toastHeight + 2 * gap;
  if (viewportHeight - surfaceBottom >= need + safeBottom) return gap + safeBottom;
  if (surfaceTop >= need + safeTop) return viewportHeight - surfaceTop + gap;
  if (footerHeight > 0) return Math.max(gap + safeBottom, viewportHeight - surfaceBottom + footerHeight + gap);
  return gap + safeBottom;
}
