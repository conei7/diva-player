import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlaybackAttemptController } from './playbackAttempt';

describe('createPlaybackAttemptController', () => {
  afterEach(() => vi.useRealTimers());

  it('fires timeout only for the current player generation', () => {
    vi.useFakeTimers();
    const controller = createPlaybackAttemptController(1000);
    const firstTimeout = vi.fn();
    const secondTimeout = vi.fn();
    const first = controller.start('first', firstTimeout);
    controller.start('second', secondTimeout);

    vi.advanceTimersByTime(1000);

    expect(controller.isCurrent(first)).toBe(false);
    expect(firstTimeout).not.toHaveBeenCalled();
    expect(secondTimeout).toHaveBeenCalledOnce();
  });

  it('cancels a ready attempt and invalidates callbacks after cleanup', () => {
    vi.useFakeTimers();
    const controller = createPlaybackAttemptController(1000);
    const onTimeout = vi.fn();
    const token = controller.start('ready', onTimeout);
    controller.complete(token);
    controller.cancel();

    vi.advanceTimersByTime(1000);

    expect(controller.isCurrent(token)).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
