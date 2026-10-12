import { useEffect, useState } from 'react';
import { getSleepTimerRemainingMs, useSleepTimerStore } from '../../stores/sleepTimerStore';

/** Milliseconds left on the sleep timer (0 when none), ticking once a second while a timer runs. */
export function useSleepTimerRemaining(): number {
  const until = useSleepTimerStore(state => state.until);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return getSleepTimerRemainingMs(until, now);
}
