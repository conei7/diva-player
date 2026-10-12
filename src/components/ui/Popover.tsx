import { useId, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  cx,
  focusElement,
  getFocusableElements,
  transformOriginFor,
  useAnchoredPosition,
  useLatest,
  useOutsidePointerDown,
  useTransientLayer,
} from './overlay';
import type { AnchoredPlacement } from './overlay';

// eslint-disable-next-line react-refresh/only-export-components -- shared with Menu (DESIGN_SPEC §4.4)
export { useAnchoredPosition };
export type PopoverPlacement = AnchoredPlacement;

export interface PopoverProps {
  /** The element the popover hangs from. Focus returns here when it closes. */
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** Default 'bottom-start'. Flips above when there is no room below. */
  placement?: PopoverPlacement;
  /** Width in px (never wider than the viewport minus 16px). Default: fits the content. */
  width?: number;
  /** Accessible name of the popover. */
  label?: string;
  /** id of the panel (for the anchor's aria-controls). Default: generated. */
  id?: string;
  children: ReactNode;
}

/**
 * Small floating panel (#282828, 12px corners) for InfoTip text, the connection details, etc.
 * Closes on outside press and Esc; Esc / Tab out return focus to the anchor.
 * While open the anchor points at it (aria-controls, unless the caller set one). Interactive
 * content gets focus; plain text gets focus on the panel itself, which then has the text as its
 * description, so screen readers read the explanation on opening.
 */
export default function Popover({ anchor, open, onClose, placement = 'bottom-start', width, label, id, children }: PopoverProps) {
  const generatedId = useId();
  const panelId = id ?? generatedId;
  const contentId = `${panelId}-content`;
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useLatest(onClose);
  const position = useAnchoredPosition(anchor, panelRef, open, placement, 8);

  const closeAndReturnFocus = () => {
    focusElement(anchor.current);
    onCloseRef.current();
  };

  useTransientLayer(open, closeAndReturnFocus);
  useOutsidePointerDown(open, [panelRef, anchor], () => onCloseRef.current());

  // Interactive content gets focus; plain text: the panel itself (described by the text).
  useLayoutEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    const anchorElement = anchor.current;
    const ownsControls = Boolean(anchorElement && !anchorElement.hasAttribute('aria-controls'));
    if (ownsControls) anchorElement?.setAttribute('aria-controls', panelId);
    const first = getFocusableElements(panel)[0];
    if (first) {
      focusElement(first);
    } else if (panel) {
      panel.setAttribute('aria-describedby', contentId);
      focusElement(panel);
    }
    return () => {
      if (ownsControls && anchorElement?.getAttribute('aria-controls') === panelId) anchorElement.removeAttribute('aria-controls');
      const active = document.activeElement;
      if (panel && (panel.contains(active) || active === document.body || active === null)) focusElement(anchorElement);
    };
  }, [anchor, contentId, open, panelId]);

  if (!open || typeof document === 'undefined') return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') {
      // Keys pressed in the popover belong to it: the page shortcuts on window (Space / ← →) and key
      // handlers of the anchor's React ancestors must not also act on them. Esc never gets here.
      event.stopPropagation();
      return;
    }
    const focusable = getFocusableElements(panelRef.current);
    const leavingStart = event.shiftKey && (focusable.length === 0 || document.activeElement === focusable[0]);
    const leavingEnd = !event.shiftKey && (focusable.length === 0 || document.activeElement === focusable.at(-1));
    if (!leavingStart && !leavingEnd) return;
    event.preventDefault();
    closeAndReturnFocus();
  };

  return createPortal(
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // Presses and clicks inside the portal must not reach clickable ancestors in the React tree.
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      style={{
        top: position.top,
        left: position.left,
        width: width ? `min(${width}px, calc(100vw - 16px))` : undefined,
        transformOrigin: transformOriginFor(placement, position.side),
      }}
      className={cx(
        'fixed z-[var(--z-menu,90)] max-h-[calc(100dvh-16px)] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-card bg-yt-menu px-4 py-3 text-left text-sm font-normal leading-5 text-yt-text shadow-[0_4px_32px_rgba(0,0,0,0.5)] outline-none',
        !width && 'w-max',
        'scale-100 opacity-100 transition-[opacity,scale] duration-150 ease-out starting:scale-95 starting:opacity-0 motion-reduce:transition-none',
      )}
    >
      <div id={contentId}>{children}</div>
    </div>,
    document.body,
  );
}
