import { useCallback, useState } from 'react';

/**
 * How much narrower the root is than the window: the vertical scrollbar where it takes space
 * (Windows), else about 0. The root's box is fractional (unlike clientWidth), so at 125% display
 * scaling only innerWidth's rounding is left over, and that is the same with and without the
 * scrollbar. Larger negatives come from pinch zoom (innerWidth follows the visual viewport).
 */
function rootScrollbarWidth(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
  const rootWidth = document.documentElement.getBoundingClientRect().width;
  if (rootWidth <= 0) return 0; // no layout (jsdom)
  const gap = window.innerWidth - rootWidth;
  return gap > -1 ? gap : 0;
}

/**
 * Calls `onWidth` with the element's width now and whenever it changes. Returns the cleanup.
 * Without ResizeObserver (old browsers, tests) only the first width is reported.
 *
 * The width is the one the element has without the window's scrollbar. A layout picked from it
 * changes the page's height, so near a threshold the scrollbar would come and go with the layout
 * and switch it back every frame; media queries ignore the scrollbar for the same reason.
 * 0 (not laid out) stays 0.
 */
export function observeElementWidth(node: Element, onWidth: (width: number) => void): () => void {
  const report = (width: number) => onWidth(width > 0 ? width + rootScrollbarWidth() : 0);
  report(node.getBoundingClientRect().width);
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(entries => {
    const entry = entries.at(-1);
    if (entry) report(entry.contentRect.width);
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
 * the first paint (no flash of the wrong variant). Detaching keeps the last width, so a
 * re-attached element does not flip the layout for a frame.
 */
export function useElementWidth<T extends Element>(): [(node: T | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((node: T | null) => (node ? observeElementWidth(node, setWidth) : undefined), []);
  return [ref, width];
}
