import { describe, expect, it } from 'vitest';
import { shuffleQueue } from './queueUtils';

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
