import { describe, expect, it } from 'vitest';
import {
  createPlaybackWakeDetector,
  getSafeWakePosition,
  PLAYBACK_WAKE_GAP_MS,
  shouldRecoverYouTubePause,
} from './playbackWakeRecovery';

describe('playback wake recovery', () => {
  const recoveringPause = { requestedPlaying: true, startupPending: false, hidden: false,
    lastWakeAt: 10_000, now: 10_010, nativePauseInteraction: false };

  it('recovers a delayed visible provider pause following resume', () => {
    expect(shouldRecoverYouTubePause(recoveringPause)).toBe(true);
    expect(shouldRecoverYouTubePause({ ...recoveringPause, now: 11_000 })).toBe(false);
    expect(shouldRecoverYouTubePause({ ...recoveringPause, now: 9_999 })).toBe(false);
  });

  it('preserves explicit application and native iframe pause during wake recovery', () => {
    expect(shouldRecoverYouTubePause({ ...recoveringPause, requestedPlaying: false })).toBe(false);
    expect(shouldRecoverYouTubePause({ ...recoveringPause, nativePauseInteraction: true })).toBe(false);
    expect(shouldRecoverYouTubePause({ ...recoveringPause, lastWakeAt: null })).toBe(false);
  });

  it('retains the existing startup and hidden-tab retry without restarting a paused queue', () => {
    expect(shouldRecoverYouTubePause({ ...recoveringPause, lastWakeAt: null, hidden: true })).toBe(true);
    expect(shouldRecoverYouTubePause({ ...recoveringPause, lastWakeAt: null, startupPending: true })).toBe(true);
    expect(shouldRecoverYouTubePause({ ...recoveringPause, hidden: true, requestedPlaying: false })).toBe(false);
  });

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
