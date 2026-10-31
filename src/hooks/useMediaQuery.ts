import { useCallback, useSyncExternalStore } from 'react';

/** Below the `sm` breakpoint (640px): bottom nav, bottom sheets, full-screen dialogs. */
export const MOBILE_MEDIA_QUERY = '(max-width: 639px)';
/** Touch-first devices: no hover-only affordances, no tooltips. */
export const COARSE_POINTER_MEDIA_QUERY = '(pointer: coarse)';
/** Mouse-like devices where hover-revealed controls are usable. */
export const FINE_HOVER_MEDIA_QUERY = '(hover: hover) and (pointer: fine)';
/** Wide enough for the expanded guide (`--breakpoint-guide`, 82rem). */
export const GUIDE_EXPANDED_MEDIA_QUERY = '(min-width: 1312px)';
/** Music layout: the 再生中 panel (with the video) beside the page. The CSS in area:music uses the same width. */
export const MUSIC_PANEL_MEDIA_QUERY = '(min-width: 1024px)';
/** Music layout: the library with names (a rail of icons and covers below it). */
export const MUSIC_LIBRARY_FULL_MEDIA_QUERY = '(min-width: 1280px)';

function canMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/** Subscribe to a CSS media query. Returns false where matchMedia is unavailable. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (!canMatchMedia()) return () => {};
    const mediaQueryList = window.matchMedia(query);
    mediaQueryList.addEventListener('change', onChange);
    return () => mediaQueryList.removeEventListener('change', onChange);
  }, [query]);

  const getSnapshot = useCallback(() => (canMatchMedia() ? window.matchMedia(query).matches : false), [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
