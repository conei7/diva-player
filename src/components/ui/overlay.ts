/**
 * Internal helpers shared by the ui primitives (Tooltip / Popover / Menu / Dialog / list parts).
 * Screens should import the components, not this file. Exceptions: `cx` (pure class-name joiner)
 * may be imported anywhere; `useAnchoredPosition` is re-exported from Popover.tsx as the public
 * entry point (DESIGN_SPEC §4.4).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Ref, RefCallback, RefObject } from 'react';

/** Joins the truthy class names. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/** A ref that always holds the latest value (for callbacks used by long-lived listeners). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/** Combines two refs (e.g. a child's own ref and ours) into one stable callback ref. */
export function useMergedRef<T>(first: Ref<T> | undefined, second: Ref<T> | undefined): RefCallback<T> {
  return useCallback((value: T | null) => {
    assignRef(first, value);
    assignRef(second, value);
  }, [first, second]);
}

/* ─── Focus ─────────────────────────────────────────────────────────────── */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

function isTabbable(element: HTMLElement): boolean {
  return element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest('[inert]');
}

/** Visible elements inside `root` that are in the Tab order. */
export function getFocusableElements(root: ParentNode | null | undefined): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isTabbable);
}

export function focusElement(element: Element | null | undefined): void {
  if (element instanceof HTMLElement && element.isConnected) element.focus({ preventScroll: true });
}

/** Esc pressed while an IME (Japanese input) is composing cancels the composition, not the overlay. */
export function isImeEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

interface FallbackLink {
  element: Element;
  next: Element | null;
  previous: Element | null;
}

/**
 * For a menu item that removes its own trigger with the row it sits in (「「X」から削除」,
 * 「表示しない」…): call before the action, run the result after it. If the trigger left the
 * document and focus fell back to <body>, focus moves to the same kind of control in the next row
 * (else the previous row, else the first control left in that list). Whole-page removals (a route
 * change: everything up to <main> or <body> went away) are left alone.
 */
export function captureRemovalFocusFallback(trigger: HTMLElement | null): () => void {
  if (!trigger || typeof document === 'undefined') return () => {};
  const chain: FallbackLink[] = [];
  for (let node: Element | null = trigger; node && node !== document.body && node.tagName !== 'MAIN'; node = node.parentElement) {
    chain.push({ element: node, next: node.nextElementSibling, previous: node.previousElementSibling });
  }
  const popup = trigger.getAttribute('aria-haspopup');
  const sameKind = popup ? `[aria-haspopup="${popup}"]` : null;

  return () => {
    if (trigger.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    // The outermost element that left the document is the removed item; its parent stayed.
    let removedIndex = 0;
    while (removedIndex + 1 < chain.length && !chain[removedIndex + 1].element.isConnected) removedIndex += 1;
    if (removedIndex + 1 >= chain.length) return;
    const removed = chain[removedIndex];
    const container = chain[removedIndex + 1].element;
    for (const sibling of [removed.next, removed.previous]) {
      if (!sibling?.isConnected || sibling.parentElement !== container) continue;
      const match = sameKind ? (sibling.matches(sameKind) ? sibling : sibling.querySelector(sameKind)) : null;
      const target = match instanceof HTMLElement && match.matches(FOCUSABLE_SELECTOR) && isTabbable(match)
        ? match
        : getFocusableElements(sibling)[0];
      if (target) {
        focusElement(target);
        return;
      }
    }
    focusElement(getFocusableElements(container)[0]);
  };
}

/* ─── Positioning (pure, unit-tested) ───────────────────────────────────── */

export interface RectLike { top: number; bottom: number; left: number; right: number; width: number; height: number }
export interface SizeLike { width: number; height: number }

/** Popups stay at least this far from the viewport edges. */
export const VIEWPORT_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  // When the popup is larger than the viewport, pin it to the start edge.
  return Math.max(min, Math.min(value, max));
}

export type AnchoredPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface AnchoredPosition {
  top: number;
  left: number;
  /** The side actually used after flipping (for the transform origin). */
  side: 'top' | 'bottom';
}

/**
 * Below (or above) the anchor, aligned to its start / end edge. Flips to the other side when
 * the preferred one has no room, then keeps the popup inside the viewport margin.
 */
export function computeAnchoredPosition(
  anchor: RectLike,
  size: SizeLike,
  viewport: SizeLike,
  placement: AnchoredPlacement = 'bottom-start',
  gap = 4,
  margin = VIEWPORT_MARGIN,
): AnchoredPosition {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= viewport.height - margin;
  const fitsAbove = above >= margin;
  const roomBelow = viewport.height - anchor.bottom;
  const roomAbove = anchor.top;
  const side: 'top' | 'bottom' = placement.startsWith('top')
    ? (fitsAbove || (!fitsBelow && roomAbove >= roomBelow) ? 'top' : 'bottom')
    : (fitsBelow || (!fitsAbove && roomBelow >= roomAbove) ? 'bottom' : 'top');
  const left = placement.endsWith('end') ? anchor.right - size.width : anchor.left;
  return {
    top: clamp(side === 'bottom' ? below : above, margin, viewport.height - margin - size.height),
    left: clamp(left, margin, viewport.width - margin - size.width),
    side,
  };
}

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/** Centered on the anchor's side; flips to the opposite side when it would leave the viewport. */
export function computeTooltipPosition(
  anchor: RectLike,
  size: SizeLike,
  viewport: SizeLike,
  placement: TooltipSide = 'bottom',
  gap = 8,
  margin = VIEWPORT_MARGIN,
): { top: number; left: number; side: TooltipSide } {
  const room: Record<TooltipSide, boolean> = {
    top: anchor.top - gap - size.height >= margin,
    bottom: anchor.bottom + gap + size.height <= viewport.height - margin,
    left: anchor.left - gap - size.width >= margin,
    right: anchor.right + gap + size.width <= viewport.width - margin,
  };
  const opposite: Record<TooltipSide, TooltipSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const side = !room[placement] && room[opposite[placement]] ? opposite[placement] : placement;
  let top: number;
  let left: number;
  if (side === 'top' || side === 'bottom') {
    top = side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - size.height;
    left = anchor.left + anchor.width / 2 - size.width / 2;
  } else {
    left = side === 'right' ? anchor.right + gap : anchor.left - gap - size.width;
    top = anchor.top + anchor.height / 2 - size.height / 2;
  }
  return {
    top: clamp(top, margin, viewport.height - margin - size.height),
    left: clamp(left, margin, viewport.width - margin - size.width),
    side,
  };
}

export function getViewportSize(): SizeLike {
  // clientWidth excludes the vertical scrollbar, so a right-aligned popup never sits under it.
  return { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
}

const HIDDEN_POSITION: AnchoredPosition = { top: -9999, left: -9999, side: 'bottom' };

/**
 * Fixed-position coordinates for `floating` next to `anchor` while `open`.
 * Measured before paint, then kept in place on scroll, resize and size changes.
 */
export function useAnchoredPosition(
  anchor: RefObject<HTMLElement | null>,
  floating: RefObject<HTMLElement | null>,
  open: boolean,
  placement: AnchoredPlacement = 'bottom-start',
  gap = 4,
): AnchoredPosition {
  const [position, setPosition] = useState<AnchoredPosition>(HIDDEN_POSITION);
  useLayoutEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const anchorElement = anchor.current;
      const floatingElement = floating.current;
      if (!anchorElement || !floatingElement) return;
      const next = computeAnchoredPosition(
        anchorElement.getBoundingClientRect(),
        // offset* sizes ignore the opening scale animation.
        { width: floatingElement.offsetWidth, height: floatingElement.offsetHeight },
        getViewportSize(),
        placement,
        gap,
      );
      setPosition(previous => (
        previous.top === next.top && previous.left === next.left && previous.side === next.side ? previous : next
      ));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (floating.current) observer?.observe(floating.current);
    if (anchor.current) observer?.observe(anchor.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, { capture: true });
      observer?.disconnect();
    };
  }, [anchor, floating, open, placement, gap]);
  return position;
}

export function transformOriginFor(placement: AnchoredPlacement, side: 'top' | 'bottom'): string {
  return `${side === 'bottom' ? 'top' : 'bottom'} ${placement.endsWith('end') ? 'right' : 'left'}`;
}

/* ─── Dismissal ─────────────────────────────────────────────────────────── */

/**
 * Menus and popovers sit above everything that opened them, so Esc closes the newest one first.
 * The listener runs in the capture phase and stops the event, so a dialog underneath or the
 * page's own Esc handlers (selection mode, shortcuts) don't also react.
 */
const transientLayers: Array<{ onEscape: () => void }> = [];

function onTransientKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || isImeEvent(event)) return;
  const layer = transientLayers.at(-1);
  if (!layer) return;
  event.preventDefault();
  event.stopPropagation();
  layer.onEscape();
}

export function useTransientLayer(active: boolean, onEscape: () => void): void {
  const latest = useLatest(onEscape);
  useEffect(() => {
    if (!active) return undefined;
    const layer = { onEscape: () => latest.current() };
    transientLayers.push(layer);
    if (transientLayers.length === 1) document.addEventListener('keydown', onTransientKeyDown, true);
    return () => {
      const index = transientLayers.indexOf(layer);
      if (index >= 0) transientLayers.splice(index, 1);
      if (transientLayers.length === 0) document.removeEventListener('keydown', onTransientKeyDown, true);
    };
  }, [active, latest]);
}

/** Calls `onOutside` for a pointerdown outside every given element (capture phase, so nothing can swallow it). */
export function useOutsidePointerDown(
  active: boolean,
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
  onOutside: () => void,
): void {
  const latestRefs = useLatest(refs);
  const latestHandler = useLatest(onOutside);
  useEffect(() => {
    if (!active) return undefined;
    const listener = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (latestRefs.current.some(ref => ref.current?.contains(target))) return;
      latestHandler.current();
    };
    document.addEventListener('pointerdown', listener, true);
    return () => document.removeEventListener('pointerdown', listener, true);
  }, [active, latestHandler, latestRefs]);
}

/** Stops the page behind a full-screen overlay (bottom sheet) from scrolling. */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
