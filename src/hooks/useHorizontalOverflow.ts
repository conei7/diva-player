import { useCallback, useState } from 'react';

/** Whether a sideways-scrolling row has more content past its left (start) and right (end) edge. */
export interface HorizontalOverflow {
  start: boolean;
  end: boolean;
}

export const NO_HORIZONTAL_OVERFLOW: HorizontalOverflow = { start: false, end: false };

export function sameHorizontalOverflow(a: HorizontalOverflow, b: HorizontalOverflow): boolean {
  return a.start === b.start && a.end === b.end;
}

type ScrollBox = Pick<Element, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>;

/**
 * Reads the overflow of a row now. 1px of slack at each end: zoom and fractional widths leave the
 * scroll position a fraction short of the end, which would keep a fade on a row scrolled all the way.
 */
export function readHorizontalOverflow(scroller: ScrollBox): HorizontalOverflow {
  const maxScroll = scroller.scrollWidth - scroller.clientWidth;
  return { start: scroller.scrollLeft > 1, end: scroller.scrollLeft < maxScroll - 1 };
}

/**
 * Calls `onChange` with the row's overflow now and whenever it changes: on scroll, when the row or
 * one of its children is resized (labels after a language switch or font load, 表示しない ↔ 再表示),
 * and when children come or go (the song page's video switch appears once the song plays). The
 * children are observed one by one because a row without a `w-max` wrapper keeps its own size when
 * only its content grows. Returns the cleanup. Without ResizeObserver only scrolling updates it.
 */
export function observeHorizontalOverflow(
  scroller: Element,
  onChange: (overflow: HorizontalOverflow) => void,
): () => void {
  let current: HorizontalOverflow | null = null;
  const measure = () => {
    const next = readHorizontalOverflow(scroller);
    if (current && sameHorizontalOverflow(current, next)) return;
    current = next;
    onChange(next);
  };

  measure();
  scroller.addEventListener('scroll', measure, { passive: true });
  const cleanups = [() => scroller.removeEventListener('scroll', measure)];

  if (typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(measure);
    const observeRowAndChildren = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(scroller);
      for (const child of Array.from(scroller.children)) resizeObserver.observe(child);
    };
    observeRowAndChildren();
    cleanups.push(() => resizeObserver.disconnect());

    if (typeof MutationObserver !== 'undefined') {
      const mutationObserver = new MutationObserver(() => {
        observeRowAndChildren();
        measure();
      });
      mutationObserver.observe(scroller, { childList: true });
      cleanups.push(() => mutationObserver.disconnect());
    }
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Edge fades for a row that scrolls sideways with its scrollbar hidden: put the returned callback
 * ref on the scrolling element and show a fade on each side whose flag is true. Both are false
 * until the row is attached and while it fits (e.g. where it wraps instead of scrolling).
 *
 * The first reading happens while React attaches the ref, so a row that starts out overflowing
 * gets its fade before the first paint.
 */
export function useHorizontalOverflow<T extends Element>(): [
  (node: T | null) => (() => void) | undefined,
  HorizontalOverflow,
] {
  const [overflow, setOverflow] = useState(NO_HORIZONTAL_OVERFLOW);
  // Keeps the previous object when nothing changed: every attach (and StrictMode's extra one)
  // reports at once, which would otherwise re-render the row for a row that still fits.
  const ref = useCallback((node: T | null) => (node
    ? observeHorizontalOverflow(node, next => setOverflow(previous => (sameHorizontalOverflow(previous, next) ? previous : next)))
    : undefined), []);
  return [ref, overflow];
}
