import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';
import { formatClockDuration } from '../../utils/songMeta';
import { cx } from '../ui/overlay';
import { clampFraction, getChorusRange, pointerFraction } from './playerUi';

/** How long the dragged position stays on screen while the player catches up with the seek. */
const SEEK_SETTLE_MS = 700;
const KEY_STEP_SECONDS = 5;

/**
 * The mini player's 2px progress line (DESIGN_SPEC §6.2.1): brand-colored progress, the estimated
 * chorus as a lighter band. With a mouse it grows to 4px on hover, shows the time under the
 * pointer and seeks on click / drag. On touch screens it only shows progress (the row below is the
 * swipe surface). Keyboard: ← → 5 seconds, Home / End.
 */
export default function ProgressLine({ seekable }: { seekable: boolean }) {
  const t = useTranslateSourceText();
  const progress = useProgressStore(state => state.progress);
  const duration = useProgressStore(state => state.duration);
  const chorusStart = usePlayerStore(state => state.currentSong?.chorusStartSeconds);
  const chorusEnd = usePlayerStore(state => state.currentSong?.chorusEndSeconds);
  const seekTo = usePlayerStore(state => state.seekTo);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragPointerRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => () => window.clearTimeout(settleTimerRef.current), []);

  const canSeek = duration > 0;
  const interactive = seekable && canSeek;
  const fraction = scrub ?? (canSeek ? clampFraction(progress / duration) : 0);
  const chorus = getChorusRange(chorusStart, chorusEnd, duration);
  const percent = (value: number) => `${(value * 100).toFixed(3)}%`;

  const trackFraction = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    return rect ? pointerFraction(clientX, rect) : 0;
  };

  const commitSeek = (value: number) => {
    seekTo(clampFraction(value) * duration);
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => setScrub(null), SEEK_SETTLE_MS);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive || event.button !== 0) return;
    event.preventDefault();
    dragPointerRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events cannot be captured.
    }
    window.clearTimeout(settleTimerRef.current);
    setScrub(trackFraction(event.clientX));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const value = trackFraction(event.clientX);
    if (dragPointerRef.current === event.pointerId) setScrub(value);
    else if (event.pointerType === 'mouse') setHover(value);
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (dragPointerRef.current !== event.pointerId) return;
    dragPointerRef.current = null;
    if (cancelled) {
      setScrub(null);
      return;
    }
    const value = trackFraction(event.clientX);
    setScrub(value);
    commitSeek(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canSeek || event.altKey || event.ctrlKey || event.metaKey) return;
    let target: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') target = Math.max(0, progress - KEY_STEP_SECONDS);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') target = Math.min(duration, progress + KEY_STEP_SECONDS);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = duration;
    if (target === null) return;
    event.preventDefault();
    seekTo(target);
  };

  const hoverSeconds = hover === null ? null : hover * duration;
  const hoverInChorus = hover !== null && chorus !== null && hover >= chorus.start && hover <= chorus.end;

  return (
    <div className="relative h-0.5 shrink-0">
      <div
        role="slider"
        tabIndex={canSeek ? 0 : -1}
        aria-label={t('シーク')}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, Math.round(duration))}
        aria-valuenow={Math.max(0, Math.round(fraction * duration))}
        aria-valuetext={`${formatClockDuration(fraction * duration)} / ${formatClockDuration(duration)}`}
        aria-disabled={!canSeek || undefined}
        className={cx(
          'group/progress absolute inset-x-0 -top-1 h-3 touch-none select-none focus-visible:outline-offset-[-2px]',
          interactive ? 'cursor-pointer' : 'pointer-events-none',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={event => finishDrag(event, false)}
        onPointerCancel={event => finishDrag(event, true)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        <div
          ref={trackRef}
          aria-hidden="true"
          className={cx(
            'pointer-events-none absolute inset-x-0 top-1 h-0.5 bg-white/20 transition-[height,top] duration-150 ease-out motion-reduce:transition-none',
            (interactive || scrub !== null) && 'group-hover/progress:top-[3px] group-hover/progress:h-1 group-focus-visible/progress:top-[3px] group-focus-visible/progress:h-1',
            scrub !== null && 'top-[3px] h-1',
          )}
        >
          <div className="absolute inset-y-0 left-0 bg-brand" style={{ width: percent(fraction) }} />
          {/* Over the fill so the chorus stays visible after it has played (lighter green there). */}
          {chorus && (
            <div className="absolute inset-y-0 bg-white/40" style={{ left: percent(chorus.start), width: percent(chorus.end - chorus.start) }} />
          )}
          {interactive && (
            <div
              className={cx(
                'absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand transition-transform duration-150 motion-reduce:transition-none',
                scrub !== null ? 'scale-100' : 'scale-0 group-hover/progress:scale-100 group-focus-visible/progress:scale-100',
              )}
              style={{ left: percent(fraction) }}
            />
          )}
        </div>
        {hoverSeconds !== null && scrub === null && (
          <div
            aria-hidden="true"
            className={cx(
              'pointer-events-none absolute bottom-full mb-1.5 whitespace-nowrap rounded-badge bg-[rgba(97,97,97,0.92)] px-2 py-1 text-xs leading-4 text-white tabular-nums',
              hover !== null && hover < 0.12 ? 'translate-x-0' : hover !== null && hover > 0.88 ? '-translate-x-full' : '-translate-x-1/2',
            )}
            style={{ left: percent(hover ?? 0) }}
          >
            {formatClockDuration(hoverSeconds)}
            {hoverInChorus && <> · {t('サビ（推定）')}</>}
          </div>
        )}
      </div>
    </div>
  );
}
