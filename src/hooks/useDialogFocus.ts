import { useEffect, useRef, type RefObject } from 'react';

export interface DialogFocusOptions {
  /**
   * Put the visible toast's action button (「元に戻す」…, outside the dialog) into the Tab cycle
   * after the dialog's last control, so a toast raised from inside the dialog stays reachable.
   */
  includeToast?: boolean;
}

/** The visible toast's action button (ToastHost), or null. */
function visibleToastAction(): HTMLElement | null {
  const element = document.querySelector<HTMLElement>('[data-testid="toast-host"] [data-toast-action]');
  return element && element.getClientRects().length > 0 ? element : null;
}

/** Only the newest open modal handles keys pressed while focus is outside every dialog. */
function isNewestModal(element: HTMLElement | null): boolean {
  const modals = document.querySelectorAll('[aria-modal="true"]');
  return modals.length === 0 || modals[modals.length - 1] === element;
}

/** Keep keyboard and scrolling inside an open dialog, then return focus. */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  { includeToast = false }: DialogFocusOptions = {},
) {
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
      const root = ref.current;
      const active = document.activeElement;
      // A nested dialog owns its own keyboard boundary.
      const activeDialog = active?.closest('[role="dialog"]');
      if (activeDialog && activeDialog !== root) return;
      // Focus outside every dialog (the toast, <body>): the newest modal alone takes the key.
      if (!activeDialog && !root?.contains(active) && !isNewestModal(root)) return;
      if (event.key === 'Escape') {
        // Esc while an IME is composing only cancels the conversion; Esc already handled
        // (preventDefault) by a control or by the toast keeps the dialog open.
        if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first) { event.preventDefault(); ref.current?.focus(); return; }
      const toast = includeToast ? visibleToastAction() : null;
      const inside = Boolean(root?.contains(active));
      if (toast && active === toast) {
        // From the toast back into the dialog.
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        (toast && active === first ? toast : last)?.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        (toast && active === last ? toast : first).focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [includeToast, open, ref]);
}
