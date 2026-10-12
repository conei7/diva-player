/**
 * Small helpers shared by the mini player, the progress line, the keyboard shortcuts and the
 * sleep timer (DESIGN_SPEC §6.2). Plain functions only (no React, no stores) so they are easy to
 * test and the component files keep exporting components alone.
 */
import type { PlaybackSource } from '../../stores/playerStore';

/* ─── Queue position (「作業用BGM 3/28」) ──────────────────────────────────── */

export interface QueuePosition {
  /** 1-based position of the current song among the songs the user queued. */
  position: number;
  total: number;
}

/**
 * Position of the current song in the queue the user started, for 「{キュー名} {現在}/{総数}」.
 * Songs appended by autoplay (`'auto'`) are not counted. Returns null while an autoplayed song is
 * playing, or when fewer than two songs were queued (a single song plus autoplay).
 */
export function getQueuePosition(queueSources: readonly PlaybackSource[], queueIndex: number): QueuePosition | null {
  if (!Number.isInteger(queueIndex) || queueIndex < 0 || queueIndex >= queueSources.length) return null;
  if (queueSources[queueIndex] === 'auto') return null;
  let total = 0;
  let position = 0;
  queueSources.forEach((source, index) => {
    if (source === 'auto') return;
    total += 1;
    if (index <= queueIndex) position += 1;
  });
  return total >= 2 ? { position, total } : null;
}

/* ─── Keyboard shortcuts ─────────────────────────────────────────────────── */

/** Minimal element surface used by isInteractiveTarget (a DOM Element satisfies it). */
interface ClosestCapable {
  closest(selector: string): unknown;
  isContentEditable?: boolean;
}

/**
 * Controls that own their keys: Space and ← → typed there must not drive the player.
 * Inside a dialog or a menu every key belongs to that layer.
 */
const OWN_KEYS_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="slider"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="spinbutton"]',
  '[role="dialog"]',
  '[role="menu"]',
].join(', ');

/** Where typing is expected (even `?` must stay text there). */
const TEXT_ENTRY_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="spinbutton"]',
  '[role="dialog"]',
  '[role="menu"]',
].join(', ');

function asClosestCapable(target: unknown): ClosestCapable | null {
  if (!target || typeof target !== 'object') return null;
  const candidate = target as ClosestCapable;
  return typeof candidate.closest === 'function' ? candidate : null;
}

/**
 * True when a key pressed on `target` belongs to that control (DESIGN_SPEC §6.2.2): text fields,
 * buttons, links, summary, ARIA widgets, anything inside a dialog or a menu.
 */
export function isInteractiveTarget(target: unknown): boolean {
  const element = asClosestCapable(target);
  if (!element) return false;
  if (element.isContentEditable) return true;
  return Boolean(element.closest(OWN_KEYS_SELECTOR));
}

/** True when `target` is a place where the user types (the `?` shortcut stays out of those). */
export function isTextEntryTarget(target: unknown): boolean {
  const element = asClosestCapable(target);
  if (!element) return false;
  if (element.isContentEditable) return true;
  return Boolean(element.closest(TEXT_ENTRY_SELECTOR));
}

/** Alt / Ctrl / ⌘ combinations belong to the browser (Alt+← is "Back"). */
export function hasCommandModifier(event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey'>): boolean {
  return event.altKey || event.ctrlKey || event.metaKey;
}

/* ─── Progress line ──────────────────────────────────────────────────────── */

export function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Fraction of the track under the pointer (0 at the left edge, 1 at the right edge). */
export function pointerFraction(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0)) return 0;
  return clampFraction((clientX - rect.left) / rect.width);
}

/**
 * The estimated chorus as fractions of the track, or null when it is unknown. A missing end
 * falls back to 15 seconds after the start (the length of a chorus highlight).
 */
export function getChorusRange(
  chorusStartSeconds: number | null | undefined,
  chorusEndSeconds: number | null | undefined,
  duration: number,
): { start: number; end: number } | null {
  if (typeof chorusStartSeconds !== 'number' || !Number.isFinite(chorusStartSeconds) || !(duration > 0)) return null;
  const startSeconds = Math.max(0, chorusStartSeconds);
  const endSeconds = typeof chorusEndSeconds === 'number' && Number.isFinite(chorusEndSeconds) && chorusEndSeconds > startSeconds
    ? chorusEndSeconds
    : startSeconds + 15;
  const start = clampFraction(startSeconds / duration);
  const end = clampFraction(endSeconds / duration);
  return end > start ? { start, end } : null;
}

/* ─── Sleep timer ────────────────────────────────────────────────────────── */

/** Remaining time as 12:34 (or 1:02:03), rounded up to the second. */
export function formatRemainingClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * The option the running timer was started with. sleepTimerStore keeps only the deadline, so the
 * watcher records the choice whenever a new deadline appears (from any menu). After a reload the
 * choice is unknown and no option is checked; the remaining time is still shown.
 */
let lastSleepTimerChoice: { until: number; minutes: number } | null = null;

export function recordSleepTimerChoice(until: number | null, now = Date.now()): void {
  if (until === null) {
    lastSleepTimerChoice = null;
    return;
  }
  lastSleepTimerChoice = { until, minutes: Math.round((until - now) / 60_000) };
}

export function getSleepTimerChoice(until: number | null): number | null {
  if (until === null || !lastSleepTimerChoice || lastSleepTimerChoice.until !== until) return null;
  return lastSleepTimerChoice.minutes;
}

/* ─── Clipboard ──────────────────────────────────────────────────────────── */

/** Copies text; falls back to a hidden textarea when the async clipboard is unavailable. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or not focused: try the selection-based copy below.
  }
  if (typeof document === 'undefined') return false;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}
