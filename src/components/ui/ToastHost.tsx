import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dismissToast, pauseToast, resumeToast, useToastStore } from '../../stores/toastStore';
import type { ToastItem } from '../../stores/toastStore';
import { cx, focusElement, prefersReducedMotion } from './overlay';

const LEAVE_MS = 150;

const loadToastBehavior = () => import('./ToastBehavior');
const ToastBehavior = lazy(loadToastBehavior);

/**
 * Renders the visible toast (DESIGN_SPEC §4.8). One per app, placed after <Routes> in App.
 * The live region is always in the DOM (after <main>) so screen readers announce new toasts.
 * ≥1024px: bottom-left of the content, beside the guide. Smaller: bottom-center above the mini player, the bottom navigation and
 * any bar fixed above them (`--bottom-bar-clearance`); while a bottom sheet or modal dialog is open,
 * next to it instead (ToastBehavior).
 *
 * Keyboard (ToastBehavior): F6 moves focus to the action button and back, ⌘/Ctrl+Z runs
 * 「元に戻す」. Esc on the toast goes back to where focus came from (a dialog underneath stays
 * open), and so does running the action. Dialogs include the action button in their Tab cycle.
 */
export default function ToastHost() {
  const current = useToastStore(state => state.toasts[0]);
  const [shown, setShown] = useState<ToastItem | undefined>(current);
  const [leaving, setLeaving] = useState(false);
  const [modalBottom, setModalBottom] = useState<number | null>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const insetProbeRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Let the outgoing toast slide away before the next one comes in.
  useEffect(() => {
    if ((current?.id ?? null) === (shown?.id ?? null)) return undefined;
    if (!shown || prefersReducedMotion()) {
      setShown(current);
      setLeaving(false);
      return undefined;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setShown(useToastStore.getState().toasts[0]);
      setLeaving(false);
    }, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [current, shown]);

  // Fetch the behavior chunk once the page is idle, so it is there before the first toast.
  useEffect(() => {
    const preload = () => void loadToastBehavior();
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(preload, { timeout: 5000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(preload, 2000);
    return () => window.clearTimeout(timer);
  }, []);

  const returnFocus = useCallback(() => {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    focusElement(target);
  }, []);

  const runAction = useCallback((toast: ToastItem) => {
    const action = toast.action;
    if (!action) return;
    const focusWasInToast = Boolean(toastRef.current?.contains(document.activeElement));
    dismissToast(toast.id);
    void Promise.resolve(action.onAction()).catch(error => { if (error?.name !== 'PlaylistPersistenceError') console.error('[Toast] Action failed', error); });
    // The button is about to go away: don't leave focus on <body>.
    if (focusWasInToast) returnFocus();
  }, [returnFocus]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      data-testid="toast-host"
      role="status"
      aria-live="polite"
      style={modalBottom === null ? undefined : { bottom: modalBottom }}
      className={cx(
        'pointer-events-none fixed z-[var(--z-toast,100)] flex',
        'inset-x-2 bottom-[calc(var(--floating-player-clearance,0px)_+_var(--bottom-nav-height,0px)_+_var(--bottom-bar-clearance,0px)_+_8px)] justify-center',
        'lg:inset-x-auto lg:bottom-[calc(var(--bottom-nav-height,0px)_+_24px)] lg:left-[calc(var(--guide-offset,0px)_+_24px)] lg:justify-start',
      )}
    >
      <div
        ref={insetProbeRef}
        aria-hidden="true"
        className="pointer-events-none invisible fixed left-0 top-0 h-0 w-0 pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)]"
      />
      {shown && (
        <div
          key={shown.id}
          ref={toastRef}
          onPointerEnter={() => pauseToast(shown.id)}
          onPointerLeave={() => resumeToast(shown.id)}
          onFocus={event => {
            pauseToast(shown.id);
            const from = event.relatedTarget;
            if (!returnFocusRef.current && from instanceof HTMLElement && !event.currentTarget.contains(from)) {
              returnFocusRef.current = from;
            }
          }}
          onBlur={event => {
            const to = event.relatedTarget;
            if (to instanceof Node && event.currentTarget.contains(to)) return;
            returnFocusRef.current = null;
            resumeToast(shown.id);
          }}
          onKeyDown={event => {
            // Esc on the toast goes back to where focus came from (a dialog underneath stays open).
            if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            returnFocus();
          }}
          className={cx(
            'flex min-h-12 w-max max-w-[min(480px,100%)] items-center gap-3 rounded-chip bg-yt-inverse px-4 py-3.5 text-sm font-normal leading-5 text-yt-on-inverse shadow-[0_4px_24px_rgba(0,0,0,0.35)]',
            'transition-[opacity,translate] duration-150 ease-out starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none',
            leaving ? 'pointer-events-none translate-y-2 opacity-0' : 'pointer-events-auto translate-y-0 opacity-100',
          )}
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{shown.message}</span>
          {shown.action && (
            <button
              ref={actionRef}
              type="button"
              data-toast-action=""
              onClick={() => runAction(shown)}
              className="-my-2 -mr-2 shrink-0 cursor-pointer rounded-full px-3 py-2 text-sm font-medium leading-5 text-yt-toast-action transition-colors duration-150 hover:bg-yt-toast-action/10"
            >
              {shown.action.label}
            </button>
          )}
        </div>
      )}
      {/* After the toast so its refs are attached when the behavior's layout effect measures. */}
      {shown && (
        <Suspense fallback={null}>
          <ToastBehavior
            key={shown.id}
            toast={shown}
            leaving={leaving}
            toastRef={toastRef}
            actionRef={actionRef}
            insetProbeRef={insetProbeRef}
            returnFocusRef={returnFocusRef}
            onModalBottomChange={setModalBottom}
            runAction={runAction}
            returnFocus={returnFocus}
          />
        </Suspense>
      )}
    </div>,
    document.body,
  );
}
