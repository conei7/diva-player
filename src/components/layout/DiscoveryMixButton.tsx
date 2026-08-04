import { useEffect, useRef, useState } from 'react';
import { playDiscoveryMix } from '../../services/discoveryMix';

type GenerationStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'success'; count: number }
  | { state: 'empty' }
  | { state: 'error' };

export default function DiscoveryMixButton({
  expanded,
  onStarted,
}: {
  expanded: boolean;
  onStarted?: () => void;
}) {
  const [status, setStatus] = useState<GenerationStatus>({ state: 'idle' });
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const scheduleReset = () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setStatus({ state: 'idle' });
    }, 4000);
  };

  const generate = async () => {
    if (status.state === 'loading') return;
    setStatus({ state: 'loading' });
    try {
      const result = await playDiscoveryMix();
      if (result.songs.length === 0) {
        setStatus({ state: 'empty' });
        scheduleReset();
        return;
      }
      setStatus({ state: 'success', count: result.songs.length });
      onStarted?.();
      scheduleReset();
    } catch {
      setStatus({ state: 'error' });
      scheduleReset();
    }
  };

  const label = status.state === 'loading'
    ? '発掘中…'
    : status.state === 'success'
      ? `${status.count}曲を再生中`
      : '発掘ミックス';
  const detail = status.state === 'empty'
    ? '未聴の候補が見つかりませんでした。表示フィルターも確認してください'
    : status.state === 'error'
      ? '生成に失敗しました'
      : '音響が近い未聴曲を直接再生';

  return (
    <div className="mt-auto px-2 pt-3">
      <button
        type="button"
        disabled={status.state === 'loading'}
        onClick={() => void generate()}
        aria-label="発掘ミックスを生成して再生"
        aria-busy={status.state === 'loading'}
        title={expanded ? undefined : `${label} — ${detail}`}
        className="group w-full rounded-2xl border border-emerald-300/25 bg-gradient-to-br from-emerald-300/15 to-cyan-300/[0.06] text-emerald-50 shadow-[0_10px_30px_rgba(16,185,129,0.08)] transition hover:border-emerald-200/40 hover:from-emerald-300/25 hover:to-cyan-300/10 disabled:cursor-wait disabled:opacity-70"
      >
        <span className={`flex items-center ${expanded ? 'gap-3 px-3 py-3' : 'flex-col gap-1 px-1 py-3'}`}>
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className={status.state === 'loading' ? 'animate-spin' : 'transition-transform group-hover:scale-110'}
          >
            <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
            <path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" />
          </svg>
          <span className={expanded ? 'min-w-0 text-left' : 'text-center'}>
            <span className={`block font-semibold ${expanded ? 'text-sm' : 'text-[10px] leading-tight'}`}>{label}</span>
            {expanded && <span className="mt-0.5 block text-[11px] text-emerald-100/55" aria-live="polite">{detail}</span>}
          </span>
        </span>
      </button>
    </div>
  );
}
