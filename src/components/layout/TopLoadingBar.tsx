import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../stores/uiStore';

/** Navigations that finish sooner never show the bar (no flash). */
const SHOW_DELAY_MS = 150;
/** Grow to 100% and fade out. */
const FINISH_MS = 320;
/** A press that never navigates (blocked, cancelled) stops the bar after this long. */
const STUCK_TIMEOUT_MS = 15_000;

type Phase = 'idle' | 'running' | 'finishing';

/**
 * 2px brand-colored bar at the very top while a page pressed in the guide / bottom nav is loading
 * (DESIGN_SPEC §6.1.5). Layout clears `pendingNavigation` once the new location has rendered.
 */
export default function TopLoadingBar() {
  const pendingNavigation = useUiStore(state => state.pendingNavigation);
  const finishNavigation = useUiStore(state => state.finishNavigation);
  const [phase, setPhase] = useState<Phase>('idle');
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (pendingNavigation) {
      if (startedAtRef.current === 0) startedAtRef.current = performance.now();
      setPhase('running');
      const stuckTimer = window.setTimeout(finishNavigation, STUCK_TIMEOUT_MS);
      return () => window.clearTimeout(stuckTimer);
    }
    const elapsed = startedAtRef.current ? performance.now() - startedAtRef.current : 0;
    startedAtRef.current = 0;
    setPhase(current => {
      if (current !== 'running') return current;
      return elapsed < SHOW_DELAY_MS ? 'idle' : 'finishing';
    });
    return undefined;
  }, [finishNavigation, pendingNavigation]);

  useEffect(() => {
    if (phase !== 'finishing') return undefined;
    const timer = window.setTimeout(() => setPhase('idle'), FINISH_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === 'idle') return null;
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-[var(--z-loading-bar)] h-0.5 overflow-hidden">
      <div className={`shell-loading-bar ${phase === 'running' ? 'shell-loading-bar-running' : 'shell-loading-bar-done'}`} />
    </div>
  );
}
