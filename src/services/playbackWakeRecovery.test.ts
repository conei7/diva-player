import { describe, expect, it } from 'vitest';
import {
  createPlaybackWakeDetector,
  getSafeWakePosition,
  PLAYBACK_WAKE_GAP_MS,
} from './playbackWakeRecovery';

describe('playback wake recovery', () => {
  it('detects a long event-loop gap and ignores normal heartbeat drift', () => {
    let now = 1_000;
    const detector = createPlaybackWakeDetector({ now: () => now });
    now += 1_000;
    expect(detector.observe('heartbeat')).toBeNull();
    now += PLAYBACK_WAKE_GAP_MS + 1;
    expect(detector.observe('heartbeat')).toEqual({ source: 'heartbeat', gapMs: PLAYBACK_WAKE_GAP_MS + 1 });
  });

  it('accepts lifecycle wake events immediately and coalesces duplicates', () => {
    let now = 10_000;
    const detector = createPlaybackWakeDetector({ now: () => now });
    now += 100;
    expect(detector.observe('resume', true)).toEqual({ source: 'resume', gapMs: 100 });
    now += 10;
    expect(detector.observe('focus', true)).toBeNull();
    now += 300;
    expect(detector.observe('pageshow', true)).toEqual({ source: 'pageshow', gapMs: 300 });
  });

  it('never rewinds behind either the native or last confirmed position', () => {
    expect(getSafeWakePosition(40, 42, 120)).toBe(42);
    expect(getSafeWakePosition(50, 42, 120)).toBe(50);
    expect(getSafeWakePosition(Number.NaN, 150, 120)).toBe(120);
  });
});
