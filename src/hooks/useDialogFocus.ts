import { useEffect, useRef, type RefObject } from 'react';

/** Keep keyboard and scrolling inside an open dialog, then return focus. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
    ) ?? []).filter(element => element.getClientRects().length > 0);
    if (!ref.current?.contains(document.activeElement)) (focusable()[0] ?? ref.current)?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      // A nested dialog owns its own keyboard boundary.
      const activeDialog = document.activeElement?.closest('[role="dialog"]');
      if (activeDialog && activeDialog !== ref.current) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first) { event.preventDefault(); ref.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, ref]);
}
