import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, PointerEvent, ReactElement, Ref } from 'react';
import { createPortal } from 'react-dom';
import { computeTooltipPosition, getViewportSize, useMergedRef } from './overlay';
import type { TooltipSide } from './overlay';

export type TooltipPlacement = TooltipSide;

export interface TooltipProps {
  /** The text. Use the same string as the trigger's aria-label (DESIGN_SPEC §2.1-4). */
  content: string;
  /** Default 'bottom'. Flips to the opposite side when there is no room. */
  placement?: TooltipPlacement;
  /** Hover delay in ms. Default 500. Keyboard focus shows it immediately. */
  delay?: number;
  /** One element that forwards ref and pointer / focus handlers to a DOM node (a <button>, IconButton…). */
  children: ReactElement;
}

interface TriggerProps {
  ref?: Ref<HTMLElement>;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-expanded'?: boolean | 'true' | 'false';
}

/** Moving from one tooltip to the next shows the next one without the hover delay (like YouTube). */
const WARM_WINDOW_MS = 400;
let lastHiddenAt = 0;
let hideCurrent: (() => void) | null = null;

function matchesFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Tooltip for icon-only controls: dark grey, 12px, shown after 500ms of hover or immediately on
 * keyboard focus, hidden on pointer leave / press / Esc / scroll. Never shown for touch.
 */
export default function Tooltip({ content, placement = 'bottom', delay = 500, children }: TooltipProps) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const openRef = useRef(false);
  // A press hides the tooltip until the pointer leaves (the press usually opens a menu or acts).
  const suppressedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: -9999, left: -9999 });

  const childProps = (isValidElement(children) ? children.props : {}) as TriggerProps;
  const mergedRef = useMergedRef<HTMLElement>(childProps.ref, triggerRef);

  const hide = useCallback(() => {
    window.clearTimeout(timerRef.current);
    if (hideCurrent === hide) hideCurrent = null;
    if (!openRef.current) return;
    openRef.current = false;
    lastHiddenAt = Date.now();
    setOpen(false);
  }, []);

  const show = useCallback(() => {
    window.clearTimeout(timerRef.current);
    const trigger = triggerRef.current;
    if (!trigger || !content || trigger.getAttribute('aria-expanded') === 'true') return;
    if (hideCurrent && hideCurrent !== hide) hideCurrent();
    hideCurrent = hide;
    openRef.current = true;
    setOpen(true);
  }, [content, hide]);

  useEffect(() => () => {
    window.clearTimeout(timerRef.current);
    if (hideCurrent === hide) hideCurrent = null;
  }, [hide]);

  // The trigger opened its menu / popover (e.g. Enter on a focused ⓘ): the tooltip would sit on it.
  const expanded = childProps['aria-expanded'] === true || childProps['aria-expanded'] === 'true';
  useEffect(() => {
    if (expanded) hide();
  }, [expanded, hide]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', hide, { capture: true });
      window.removeEventListener('blur', hide);
    };
  }, [hide, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;
    const next = computeTooltipPosition(
      trigger.getBoundingClientRect(),
      { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
      getViewportSize(),
      placement,
    );
    setPosition(previous => (previous.top === next.top && previous.left === next.left ? previous : { top: next.top, left: next.left }));
  }, [content, open, placement]);

  if (!isValidElement(children)) return children;
  if (!content) return children;

  const describedBy = open && content !== childProps['aria-label']
    ? [childProps['aria-describedby'], tooltipId].filter(Boolean).join(' ')
    : childProps['aria-describedby'];

  const trigger = cloneElement(children as ReactElement<TriggerProps>, {
    ref: mergedRef,
    'aria-describedby': describedBy,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      childProps.onPointerEnter?.(event);
      if (event.pointerType === 'touch' || suppressedRef.current) return;
      window.clearTimeout(timerRef.current);
      const warm = Date.now() - lastHiddenAt < WARM_WINDOW_MS;
      if (warm || delay <= 0) show();
      else timerRef.current = window.setTimeout(show, delay);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      childProps.onPointerLeave?.(event);
      suppressedRef.current = false;
      hide();
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      childProps.onPointerDown?.(event);
      suppressedRef.current = true;
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(event);
      if (!suppressedRef.current && matchesFocusVisible(event.currentTarget)) show();
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(event);
      suppressedRef.current = false;
      hide();
    },
  });

  return (
    <>
      {trigger}
      {open && createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          style={{ top: position.top, left: position.left }}
          className="pointer-events-none fixed z-[var(--z-tooltip,95)] w-max max-w-[240px] rounded-badge bg-[rgba(97,97,97,0.92)] px-2 py-1.5 text-xs font-normal leading-4 text-white [overflow-wrap:anywhere] transition-opacity duration-100 ease-out starting:opacity-0 motion-reduce:transition-none"
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
