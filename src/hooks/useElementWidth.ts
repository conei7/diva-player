import { useCallback, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * How much narrower the root is than the window: the vertical scrollbar where it takes space
 * (Windows), else about 0. The root's box is fractional (unlike clientWidth), so at 125% display
 * scaling only innerWidth's rounding is left over, and that is the same with and without the
 * scrollbar. Larger negatives are for engines where innerWidth follows the visual viewport under
 * pinch zoom: the raw width is used there. Chromium keeps innerWidth at the layout viewport.
 */
function rootScrollbarWidth(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
  const rootWidth = document.documentElement.getBoundingClientRect().width;
  if (rootWidth <= 0) return 0; // no layout (jsdom)
  const gap = window.innerWidth - rootWidth;
  return gap > -1 ? gap : 0;
}

/**
 * Calls `onWidth` with the element's width now, and `onResize` (by default `onWidth`) whenever it
 * changes. Returns the cleanup. Without ResizeObserver (old browsers, tests) only the first width
 * is reported.
 *
 * The width is the one the element has without the window's scrollbar. A layout picked from it
 * changes the page's height, so near a threshold the scrollbar would come and go with the layout
 * and switch it back every frame; media queries ignore the scrollbar for the same reason.
 * 0 (not laid out) stays 0.
 */
export function observeElementWidth(
  node: Element,
  onWidth: (width: number) => void,
  onResize: (width: number) => void = onWidth,
): () => void {
  const compensate = (width: number) => (width > 0 ? width + rootScrollbarWidth() : 0);
  onWidth(compensate(node.getBoundingClientRect().width));
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(entries => {
    const entry = entries.at(-1);
    if (entry) onResize(compensate(entry.contentRect.width));
  });
  observer.observe(node);
  return () => observer.disconnect();
}

/**
 * The width (px) of the element that gets the returned callback ref, without the window's
 * scrollbar, for layouts that follow the space a page really has instead of the window (in the
 * music layout the library and the 再生中 panel take part of it). 0 until the element is attached.
 *
 * The first width is read while React attaches the ref, so the page re-renders with it before
 * the first paint (no flash of the wrong variant). Later widths are rendered before paint too
 * (flushSync): a plain update from a ResizeObserver callback has no event behind it, so React would
 * render it after the frame is painted, in the previous width's variant. The first report stays a
 * plain update: it runs inside React's commit, where flushSync warns. Detaching keeps the last
 * width, so a re-attached element does not flip the layout for a frame.
 *
 * Measure an element the variant cannot resize (an empty sentinel): a switch rendered inside the
 * callback that resizes the observed element leaves its notification for the next frame, and the
 * window gets the error event "ResizeObserver loop completed with undelivered notifications". A
 * switch that toggles the window's scrollbar can still cause it (benign: the next frame reports the
 * same compensated width), so an error reporter must ignore that event.
 */
export function useElementWidth<T extends Element>(): [(node: T | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((node: T | null) => (
    node ? observeElementWidth(node, setWidth, next => flushSync(() => setWidth(next))) : undefined
  ), []);
  return [ref, width];
}
