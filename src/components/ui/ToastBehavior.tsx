import { useEffect, useLayoutEffect } from 'react';
import type { RefObject } from 'react';
import { useTranslateSourceText } from '../../i18n';
import type { ToastItem } from '../../stores/toastStore';
import { computeModalToastBottom } from './toastPlacement';

/** Below 1024px the toast is centred at the bottom; from 1024px it sits bottom-left (CSS only). */
const CENTERED_QUERY = '(max-width: 1023px)';
const DEFAULT_TOAST_HEIGHT = 48;

/**
 * The open bottom sheet (Menu), else the newest modal dialog's panel / drawer. Under its scrim the
 * mini player and bottom navigation are covered, so the toast stops making room for them and is
 * placed next to this surface instead of in the middle of it.
 */
function findModalSurface(): HTMLElement | null {
  const sheets = document.querySelectorAll<HTMLElement>('[data-menu-sheet]');
  if (sheets.length > 0) return sheets[sheets.length - 1];
  const modals = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
  const top = modals[modals.length - 1];
  if (!top) return null;
  return top.querySelector<HTMLElement>(':scope > [data-dialog-panel]') ?? top;
}

/** Vertical layout box in viewport px. Offsets ignore a panel's opening scale (its fixed backdrop only fades). */
function layoutBox(element: HTMLElement): { top: number; bottom: number } {
  const parent = element.offsetParent;
  if (parent instanceof HTMLElement && getComputedStyle(parent).position === 'fixed') {
    const top = parent.getBoundingClientRect().top + parent.clientTop + element.offsetTop;
    return { top, bottom: top + element.offsetHeight };
  }
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}

/** Where ⌘/Ctrl+Z belongs to the text being edited. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(target.type);
  }
  return target.closest('[role="textbox"], [role="searchbox"], [role="combobox"]') !== null;
}

export interface ToastBehaviorProps {
  toast: ToastItem;
  leaving: boolean;
  toastRef: RefObject<HTMLDivElement | null>;
  actionRef: RefObject<HTMLButtonElement | null>;
  /** Hidden element whose paddings are env(safe-area-inset-top / -bottom). */
  insetProbeRef: RefObject<HTMLDivElement | null>;
  /** Where focus was before it moved to the toast (F6). */
  returnFocusRef: RefObject<HTMLElement | null>;
  /** Distance from the viewport bottom while a sheet / modal is open; null = the CSS default. */
  onModalBottomChange: (bottom: number | null) => void;
  runAction: (toast: ToastItem) => void;
  returnFocus: () => void;
}

/**
 * What the visible toast does besides showing itself (split from ToastHost so the initial bundle
 * stays small; preloaded when the browser is idle):
 * - Placement next to an open sheet / modal dialog under 1024px (measured before paint, kept up to
 *   date as sheets open and close, resize, or the viewport changes).
 * - Keyboard: F6 moves focus to the action button and back; ⌘/Ctrl+Z runs 「元に戻す」 outside
 *   text fields. Inside open menus the keys stay with the menu (it stops them).
 */
export default function ToastBehavior({
  toast,
  leaving,
  toastRef,
  actionRef,
  insetProbeRef,
  returnFocusRef,
  onModalBottomChange,
  runAction,
  returnFocus,
}: ToastBehaviorProps) {
  const t = useTranslateSourceText();
  const undoLabel = t('元に戻す');
  const isUndo = toast.action?.label === undoLabel;

  useLayoutEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const centered = window.matchMedia(CENTERED_QUERY);
    let frame = 0;
    let observed: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const update = () => {
      frame = 0;
      const surface = centered.matches ? findModalSurface() : null;
      if (surface !== observed) {
        resizeObserver?.disconnect();
        observed = surface;
        if (surface) resizeObserver?.observe(surface);
        if (surface && toastRef.current) resizeObserver?.observe(toastRef.current);
      }
      if (!surface) {
        const toast = toastRef.current?.getBoundingClientRect();
        const videoElement = document.querySelector<HTMLElement>('[data-testid="global-player"]:not([aria-hidden="true"]) .global-player-video');
        const video = videoElement?.getBoundingClientRect();
        if (videoElement) resizeObserver?.observe(videoElement);
        if (toastRef.current) resizeObserver?.observe(toastRef.current);
        // On a song page the video can reach the default bottom toast position.
        // Measure the actual frame (including scrolling), not an assumed aspect ratio.
        if (toast) {
          const insets = insetProbeRef.current ? getComputedStyle(insetProbeRef.current) : null;
          const safeTop = Number.parseFloat(insets?.paddingTop ?? '') || 0;
          const safeBottom = Number.parseFloat(insets?.paddingBottom ?? '') || 0;
          let top = Math.max(safeTop, Math.min(toast.top, window.innerHeight - safeBottom - toast.height));
          if (video && video.width > 1 && video.height > 1
            && toast.left < video.right && toast.right > video.left
            && top < video.bottom && top + toast.height > video.top) {
            if (video.top - toast.height >= safeTop) {
              top = Math.max(safeTop, video.top - toast.height - 8);
            } else if (video.bottom + toast.height <= window.innerHeight - safeBottom) {
              top = Math.min(window.innerHeight - safeBottom - toast.height, video.bottom + 8);
            }
          }
          if (Math.abs(top - toast.top) > .5) {
            onModalBottomChange(Math.round(window.innerHeight - top - toast.height));
            return;
          }
        }
        // Keep a safe position until the video leaves: clearing it immediately
        // would alternate between the overlapping default and its safe position.
        if (!video || video.bottom <= 0 || video.top >= window.innerHeight) onModalBottomChange(null);
        return;
      }
      const box = layoutBox(surface);
      const footer = surface.querySelector<HTMLElement>(':scope > [data-dialog-footer]');
      const insets = insetProbeRef.current ? getComputedStyle(insetProbeRef.current) : null;
      onModalBottomChange(Math.round(computeModalToastBottom({
        viewportHeight: window.innerHeight,
        surfaceTop: box.top,
        surfaceBottom: box.bottom,
        footerHeight: footer?.offsetHeight ?? 0,
        toastHeight: toastRef.current?.offsetHeight || DEFAULT_TOAST_HEIGHT,
        safeTop: Number.parseFloat(insets?.paddingTop ?? '') || 0,
        safeBottom: Number.parseFloat(insets?.paddingBottom ?? '') || 0,
      })));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    update();
    // Dialogs and sheets are portals on <body>; drawers toggle aria-modal in place.
    const portals = new MutationObserver(schedule);
    portals.observe(document.body, { childList: true });
    const modality = new MutationObserver(schedule);
    modality.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    centered.addEventListener('change', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      portals.disconnect();
      modality.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      centered.removeEventListener('change', schedule);
      onModalBottomChange(null);
    };
  }, [insetProbeRef, onModalBottomChange, toastRef]);

  // Announced with the button when it gets focus.
  useEffect(() => {
    actionRef.current?.setAttribute('aria-keyshortcuts', isUndo ? 'F6 Control+Z Meta+Z' : 'F6');
  }, [actionRef, isUndo]);

  useEffect(() => {
    if (!toast.action || leaving) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const button = actionRef.current;
      if (!button) return;
      if (event.key === 'F6' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        if (document.activeElement === button) {
          returnFocus();
          return;
        }
        const active = document.activeElement;
        returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
        button.focus({ preventScroll: true });
        return;
      }
      const undoKey = (event.key === 'z' || event.key === 'Z') && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
      if (undoKey && isUndo && !isTextEntryTarget(event.target)) {
        event.preventDefault();
        runAction(toast);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actionRef, isUndo, leaving, returnFocus, returnFocusRef, runAction, toast]);

  return null;
}
