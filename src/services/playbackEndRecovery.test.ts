import { describe, expect, it } from 'vitest';
import {
  getPlaybackEndCheckDelayMs,
  hasReachedPlaybackEnd,
  MAX_PLAYBACK_END_CHECK_DELAY_MS,
} from './playbackEndRecovery';

describe('background playback end recovery', () => {
  it('treats playback within the end tolerance as complete', () => {
    expect(hasReachedPlaybackEnd(119.4, 120)).toBe(true);
    expect(hasReachedPlaybackEnd(118, 120)).toBe(false);
    expect(hasReachedPlaybackEnd(0, 0)).toBe(false);
  });

  it('uses remaining wall-clock time and periodically rechecks long tracks', () => {
    expect(getPlaybackEndCheckDelayMs(119, 120)).toBe(1500);
    expect(getPlaybackEndCheckDelayMs(0, 300)).toBe(MAX_PLAYBACK_END_CHECK_DELAY_MS);
    expect(getPlaybackEndCheckDelayMs(Number.NaN, 300)).toBe(MAX_PLAYBACK_END_CHECK_DELAY_MS);
  });
});
