import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { getQueueSongsForScope } from './queuePlaylist';

const queue = [1, 2, 3].map(id => ({ id, name: `曲${id}` } as Song));

describe('getQueueSongsForScope', () => {
  it('selects the complete queue', () => {
    expect(getQueueSongsForScope(queue, 1, 'all').map(song => song.id)).toEqual([1, 2, 3]);
  });

  it('selects current and remaining songs', () => {
    expect(getQueueSongsForScope(queue, 1, 'currentAndRemaining').map(song => song.id)).toEqual([2, 3]);
  });

  it('selects only songs after the current song', () => {
    expect(getQueueSongsForScope(queue, 1, 'remaining').map(song => song.id)).toEqual([3]);
  });

  it('falls back to the complete queue when nothing is playing', () => {
    expect(getQueueSongsForScope(queue, -1, 'remaining').map(song => song.id)).toEqual([1, 2, 3]);
  });
});
