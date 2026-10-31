/**
 * Infinite lists (the home feed, search results) start loading their next page this far before
 * the end of the list comes into view, so scrolling rarely reaches the spinner.
 */
export const PREFETCH_MARGIN_PX = 1200;

/** IntersectionObserver options for the end-of-list sentinel. */
export const PREFETCH_OBSERVER_OPTIONS: IntersectionObserverInit = {
  rootMargin: `0px 0px ${PREFETCH_MARGIN_PX}px 0px`,
};
