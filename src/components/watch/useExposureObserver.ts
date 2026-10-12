import { useEffect, useRef } from 'react';

/**
 * Calls `onVisible` once when at least 35% of the element has been on screen
 * (recommendation exposure logging). Reset when `resetKey` (the song) changes.
 */
export function useExposureObserver<T extends Element>(onVisible: (() => void) | undefined, resetKey: unknown) {
  const ref = useRef<T | null>(null);
  const reportedRef = useRef(false);

  useEffect(() => {
    reportedRef.current = false;
  }, [resetKey]);

  useEffect(() => {
    const element = ref.current;
    if (!onVisible || !element || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0];
      if (!reportedRef.current && entry?.isIntersecting && (entry.intersectionRatio ?? 0) >= 0.35) {
        reportedRef.current = true;
        onVisible();
      }
    }, { threshold: [0.35] });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible]);

  return ref;
}
