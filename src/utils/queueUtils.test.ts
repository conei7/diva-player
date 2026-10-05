import { describe, expect, it } from 'vitest';
import {
  getQueueDisplayWindow,
  MIX_QUEUE_DISPLAY_HISTORY_LIMIT,
  MIX_QUEUE_DISPLAY_TARGET,
  shuffleQueue,
} from './queueUtils';

describe('getQueueDisplayWindow', () => {
  it('keeps the current song and up to ten previous songs in the display window', () => {
    const queue = Array.from({ length: 55 }, (_, index) => index);
    const window = getQueueDisplayWindow(queue, 30);

    expect(window.startIndex).toBe(30 - MIX_QUEUE_DISPLAY_HISTORY_LIMIT);
    expect(window.items[0]).toBe(20);
    expect(window.items[10]).toBe(30);
    expect(window.items).toEqual(queue.slice(20));
  });

  it('keeps the entire queue visible before enough playback history exists', () => {
    const queue = Array.from({ length: 13 }, (_, index) => index);

    expect(getQueueDisplayWindow(queue, 0)).toEqual({ items: queue, startIndex: 0 });
    expect(getQueueDisplayWindow(queue, 5).items).toEqual(queue);
  });

  it('uses the same forty-item target as background mix prefill', () => {
    expect(MIX_QUEUE_DISPLAY_TARGET).toBe(40);
  });
});

describe('shuffleQueue', () => {
  it('does not mutate the source and produces a permutation', () => {
    const source = [1, 2, 3, 4];
    const shuffled = shuffleQueue(source, () => 0);

    expect(source).toEqual([1, 2, 3, 4]);
    expect(shuffled).toEqual([2, 3, 4, 1]);
    expect([...shuffled].sort()).toEqual(source);
  });

  it('keeps an empty or single-item queue unchanged', () => {
    expect(shuffleQueue([])).toEqual([]);
    expect(shuffleQueue(['only'])).toEqual(['only']);
  });
});
