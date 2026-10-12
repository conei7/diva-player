import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOAST_ACTION_DURATION_MS,
  TOAST_DURATION_MS,
  TOAST_HANDOFF_MS,
  TOAST_RESUME_MIN_MS,
  clearToasts,
  dismissToast,
  pauseToast,
  resumeToast,
  showToast,
  useToastStore,
} from './toastStore';

const visible = () => useToastStore.getState().toasts[0];
const messages = () => useToastStore.getState().toasts.map(toast => toast.message);

describe('toastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
  });

  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it('shows a toast for 4 seconds and returns its id', () => {
    const id = showToast('キューに追加しました');
    expect(visible()).toMatchObject({ id, message: 'キューに追加しました', duration: TOAST_DURATION_MS });
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(visible()?.id).toBe(id);
    vi.advanceTimersByTime(1);
    expect(visible()).toBeUndefined();
  });

  it('keeps toasts with an action for 8 seconds and honours a custom duration', () => {
    const onAction = vi.fn();
    showToast('プレイリストを削除しました', { action: { label: '元に戻す', onAction } });
    expect(visible()?.duration).toBe(TOAST_ACTION_DURATION_MS);
    vi.advanceTimersByTime(TOAST_ACTION_DURATION_MS - 1);
    expect(visible()).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(visible()).toBeUndefined();

    showToast('短い', { duration: 1500 });
    vi.advanceTimersByTime(1500);
    expect(visible()).toBeUndefined();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('shows one toast at a time and hands the visible one off quickly when another waits', () => {
    const first = showToast('A');
    const second = showToast('B');
    expect(messages()).toEqual(['A', 'B']);
    vi.advanceTimersByTime(TOAST_HANDOFF_MS - 1);
    expect(visible()?.id).toBe(first);
    vi.advanceTimersByTime(1);
    expect(visible()?.id).toBe(second);
    // The last one in the queue gets its full time.
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(visible()?.id).toBe(second);
    vi.advanceTimersByTime(1);
    expect(visible()).toBeUndefined();
  });

  it('never extends a toast that was about to hide anyway', () => {
    showToast('A');
    vi.advanceTimersByTime(TOAST_DURATION_MS - 300);
    showToast('B');
    vi.advanceTimersByTime(300);
    expect(visible()?.message).toBe('B');
  });

  it('shortens every toast of a burst except the last', () => {
    showToast('A');
    showToast('B');
    showToast('C');
    vi.advanceTimersByTime(TOAST_HANDOFF_MS);
    expect(visible()?.message).toBe('B');
    vi.advanceTimersByTime(TOAST_HANDOFF_MS);
    expect(visible()?.message).toBe('C');
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(visible()?.message).toBe('C');
  });

  it('replaces a repeated message instead of queueing a copy', () => {
    const first = showToast('キューに追加しました');
    vi.advanceTimersByTime(3000);
    const second = showToast('キューに追加しました');
    expect(second).not.toBe(first);
    expect(messages()).toEqual(['キューに追加しました']);
    // The timer restarted for the replacement.
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(visible()?.id).toBe(second);
    vi.advanceTimersByTime(1);
    expect(visible()).toBeUndefined();
  });

  it('dismisses the visible toast or a waiting one', () => {
    const first = showToast('A');
    const second = showToast('B');
    const third = showToast('C');
    dismissToast(second);
    expect(messages()).toEqual(['A', 'C']);
    dismissToast(first);
    expect(visible()?.id).toBe(third);
    dismissToast('missing');
    expect(visible()?.id).toBe(third);
  });

  it('pauses while hovered and gives a moment after the pointer leaves', () => {
    const id = showToast('A');
    vi.advanceTimersByTime(TOAST_DURATION_MS - 200);
    pauseToast(id);
    vi.advanceTimersByTime(60_000);
    expect(visible()?.id).toBe(id);
    resumeToast(id);
    vi.advanceTimersByTime(TOAST_RESUME_MIN_MS - 1);
    expect(visible()?.id).toBe(id);
    vi.advanceTimersByTime(1);
    expect(visible()).toBeUndefined();
  });

  it('hands off a paused toast once the pointer leaves', () => {
    const id = showToast('A');
    pauseToast(id);
    showToast('B');
    vi.advanceTimersByTime(60_000);
    expect(visible()?.id).toBe(id);
    resumeToast(id);
    vi.advanceTimersByTime(TOAST_HANDOFF_MS);
    expect(visible()?.message).toBe('B');
  });

  it('ignores pause and resume for toasts that are not visible', () => {
    showToast('A');
    const waiting = showToast('B');
    pauseToast(waiting);
    vi.advanceTimersByTime(TOAST_HANDOFF_MS);
    expect(visible()?.id).toBe(waiting);
  });
});
