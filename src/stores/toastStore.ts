/**
 * The one notification surface (DESIGN_SPEC §4.8): a single toast at a time, queued.
 * Callable from anywhere, including outside React: `showToast(t('キューに追加しました'))`.
 * Messages and action labels are passed in already translated.
 */
import { create } from 'zustand';

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** Display time in ms. Default 4000, or 8000 with an action. */
  duration?: number;
}

export interface ToastItem {
  id: string;
  message: string;
  action?: ToastAction;
  duration: number;
}

export const TOAST_DURATION_MS = 4_000;
export const TOAST_ACTION_DURATION_MS = 8_000;
/** Once another toast is waiting, the visible one stays at most this much longer. */
export const TOAST_HANDOFF_MS = 1_000;
/** After the pointer leaves a paused toast it stays at least this long. */
export const TOAST_RESUME_MIN_MS = 1_000;

interface ToastState {
  /** toasts[0] is the visible one; the rest wait in order. */
  toasts: ToastItem[];
}

export const useToastStore = create<ToastState>(() => ({ toasts: [] }));

let sequence = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
/** When the visible toast hides (while its timer runs). */
let deadline = 0;
/** Remaining time of the visible toast while paused (hover / focus); null when running. */
let pausedRemaining: number | null = null;

function clearTimer() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function schedule(ms: number) {
  clearTimer();
  deadline = Date.now() + ms;
  timer = setTimeout(() => {
    timer = null;
    const visible = useToastStore.getState().toasts[0];
    if (visible) dismissToast(visible.id);
  }, ms);
}

/** Starts the timer of whatever is visible now. */
function startVisible() {
  clearTimer();
  pausedRemaining = null;
  const [visible, ...waiting] = useToastStore.getState().toasts;
  if (!visible) return;
  schedule(waiting.length > 0 ? Math.min(visible.duration, TOAST_HANDOFF_MS) : visible.duration);
}

/** Someone is waiting: let the visible toast go soon. */
function hurryVisible() {
  if (pausedRemaining !== null) {
    pausedRemaining = Math.min(pausedRemaining, TOAST_HANDOFF_MS);
    return;
  }
  if (deadline - Date.now() > TOAST_HANDOFF_MS) schedule(TOAST_HANDOFF_MS);
}

/** Shows a one-line notice (no trailing period, at most one action). Returns its id. */
export function showToast(message: string, options: ToastOptions = {}): string {
  const id = `toast-${++sequence}`;
  const duration = options.duration !== undefined && Number.isFinite(options.duration) && options.duration > 0
    ? options.duration
    : (options.action ? TOAST_ACTION_DURATION_MS : TOAST_DURATION_MS);
  const toast: ToastItem = { id, message, action: options.action, duration };
  const { toasts } = useToastStore.getState();
  const last = toasts.at(-1);

  if (toasts.length === 0) {
    useToastStore.setState({ toasts: [toast] });
    startVisible();
  } else if (last && last.message === message) {
    // The same notice again (pressing the same button twice): replace it instead of queueing a copy.
    useToastStore.setState({ toasts: [...toasts.slice(0, -1), toast] });
    if (toasts.length === 1) startVisible();
  } else {
    useToastStore.setState({ toasts: [...toasts, toast] });
    hurryVisible();
  }
  return id;
}

export function dismissToast(id: string): void {
  const { toasts } = useToastStore.getState();
  const index = toasts.findIndex(toast => toast.id === id);
  if (index < 0) return;
  useToastStore.setState({ toasts: toasts.filter(toast => toast.id !== id) });
  if (index === 0) startVisible();
}

/** Stops the visible toast's timer (pointer over it, or its action button focused). */
export function pauseToast(id: string): void {
  if (useToastStore.getState().toasts[0]?.id !== id || pausedRemaining !== null) return;
  pausedRemaining = Math.max(0, deadline - Date.now());
  clearTimer();
}

export function resumeToast(id: string): void {
  if (useToastStore.getState().toasts[0]?.id !== id || pausedRemaining === null) return;
  const remaining = pausedRemaining;
  pausedRemaining = null;
  schedule(Math.max(remaining, TOAST_RESUME_MIN_MS));
}

/** Removes every toast (tests, or when a whole screen's notices become stale). */
export function clearToasts(): void {
  clearTimer();
  pausedRemaining = null;
  deadline = 0;
  useToastStore.setState({ toasts: [] });
}
