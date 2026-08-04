import { useEffect, useRef } from 'react';
import {
  createPlaybackWakeDetector,
  type PlaybackWakeSignal,
  type PlaybackWakeSource,
} from '../services/playbackWakeRecovery';

const HEARTBEAT_INTERVAL_MS = 1_000;

export function usePlaybackWakeRecovery(
  onWake: (signal: PlaybackWakeSignal) => void,
  enabled = true,
): void {
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;

  useEffect(() => {
    if (!enabled) return;
    const detector = createPlaybackWakeDetector();
    const observe = (source: PlaybackWakeSource, force = false) => {
      const signal = detector.observe(source, force);
      if (signal) onWakeRef.current(signal);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') observe('visibility', true);
    };
    const onPageShow = () => observe('pageshow', true);
    const onFocus = () => observe('focus', true);
    const onOnline = () => observe('online', true);
    const onResume = () => observe('resume', true);
    const heartbeat = window.setInterval(() => observe('heartbeat'), HEARTBEAT_INTERVAL_MS);

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('resume', onResume);
    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('resume', onResume);
    };
  }, [enabled]);
}
