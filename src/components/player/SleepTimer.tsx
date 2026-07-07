import { useEffect, useMemo, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { storage } from '../../utils/storage';

const SLEEP_TIMER_KEY = 'sleepTimerUntil';
const TIMER_OPTIONS = [15, 30, 60, 90];

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default function SleepTimer() {
  const pause = usePlayerStore(s => s.pause);
  const [timerUntil, setTimerUntil] = useState<number | null>(() => storage.get<number>(SLEEP_TIMER_KEY));
  const [now, setNow] = useState(() => Date.now());
  const [isOpen, setIsOpen] = useState(false);

  const remainingMs = useMemo(() => {
    if (!timerUntil) return 0;
    return timerUntil - now;
  }, [now, timerUntil]);

  const isActive = !!timerUntil && remainingMs > 0;

  useEffect(() => {
    if (!timerUntil) return;

    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [timerUntil]);

  useEffect(() => {
    if (!timerUntil || remainingMs > 0) return;

    pause();
    storage.remove(SLEEP_TIMER_KEY);
    setTimerUntil(null);
    setIsOpen(false);
  }, [pause, remainingMs, timerUntil]);

  const setTimer = (minutes: number) => {
    const next = Date.now() + minutes * 60 * 1000;
    storage.set(SLEEP_TIMER_KEY, next);
    setNow(Date.now());
    setTimerUntil(next);
    setIsOpen(false);
  };

  const clearTimer = () => {
    storage.remove(SLEEP_TIMER_KEY);
    setTimerUntil(null);
    setIsOpen(false);
  };

  return (
    <div className="relative" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setIsOpen(false);
      }
    }}>
      <button
        className="btn-ghost p-1.5 rounded-lg"
        onClick={() => setIsOpen(open => !open)}
        title={isActive ? `スリープ: ${formatRemaining(remainingMs)}` : 'スリープタイマー'}
        style={{ color: isActive ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)' }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2zm1 5h-2v6l5 3 .98-1.74L13 11.87V7z"/>
        </svg>
      </button>

      {isActive && (
        <span
          className="absolute -top-1 -right-1 text-[9px] font-bold rounded-full px-1 leading-4 min-w-4 text-center"
          style={{ background: 'var(--color-accent-cyan)', color: '#071014' }}
        >
          {Math.ceil(remainingMs / 60000)}
        </span>
      )}

      {isOpen && (
        <div
          className="absolute right-0 bottom-full mb-2 w-40 p-2 rounded-lg border shadow-xl"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            color: 'var(--color-text-primary)',
          }}
          tabIndex={-1}
        >
          <div className="text-xs font-semibold px-2 pb-1" style={{ color: 'var(--color-text-secondary)' }}>
            スリープ
          </div>
          <div className="grid grid-cols-2 gap-1">
            {TIMER_OPTIONS.map(minutes => (
              <button
                key={minutes}
                className="btn-ghost rounded-md px-2 py-1.5 text-xs"
                onClick={() => setTimer(minutes)}
              >
                {minutes}分
              </button>
            ))}
          </div>
          {isActive && (
            <button
              className="btn-ghost mt-2 w-full rounded-md px-2 py-1.5 text-xs"
              onClick={clearTimer}
              style={{ color: 'var(--color-accent-pink)' }}
            >
              解除 ({formatRemaining(remainingMs)})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
