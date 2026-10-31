import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useCanGoNext } from '../../hooks/useCanGoNext';
import { useRootLayoutVariable } from '../../hooks/useRootLayoutVariable';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { formatArtistLine } from '../../utils/songMeta';
import IconButton from '../ui/IconButton';
import { PauseIcon, PlayIcon, SkipNextIcon } from '../ui/icons';
import { cx, focusElement, getFocusableElements, prefersReducedMotion } from '../ui/overlay';
import { SOFT_DISABLED_CLASS } from '../music/player/playerBarUi';

/** 44px tap targets, as in the phone mini player row. */
const TAP_TARGET = 'size-11!';
/** The 56px row plus the home-indicator inset. */
const ROW_HEIGHT = 'calc(56px + env(safe-area-inset-bottom, 0px))';

/** The keyboard carries on at the first control right under the video once the row goes away. */
function focusUnderVideo(videoColumn: HTMLElement | null) {
  focusElement(getFocusableElements(videoColumn)[0]);
}

/**
 * The song page under 1024px has no mini player or player bar. Once its video has scrolled off,
 * WatchPage shows this row (song · play/pause · next) fixed at the bottom, so the related list can
 * be browsed without scrolling back up to pause. It never shows while the video is on screen.
 */
export default function WatchScrolledControls({ videoColumnRef }: { videoColumnRef: RefObject<HTMLElement | null> }) {
  const t = useTranslateSourceText();
  const currentSong = usePlayerStore(state => state.currentSong);
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const pause = usePlayerStore(state => state.pause);
  const resume = usePlayerStore(state => state.resume);
  const next = usePlayerStore(state => state.next);
  // The mini player's rule: off at the end of the queue unless it loops.
  const canGoNext = useCanGoNext();
  // Toasts go above the row instead of covering it.
  useRootLayoutVariable('--bottom-bar-clearance', currentSong ? ROW_HEIGHT : null);
  const rowRef = useRef<HTMLDivElement>(null);
  const hasSong = currentSong !== null;
  // The row can also go away under a focused button (次の曲 opens the next song at the top, or
  // PageUp brings the video back): focus moves on instead of falling to <body>. A layout cleanup
  // still sees the row in the document.
  useLayoutEffect(() => {
    const row = rowRef.current;
    const videoColumn = videoColumnRef.current;
    return () => {
      if (row?.contains(document.activeElement)) focusUnderVideo(videoColumn);
    };
  }, [hasSong, videoColumnRef]);

  if (!currentSong) return null;

  const backToVideo = () => {
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    // The row goes away once the video is back.
    focusUnderVideo(videoColumnRef.current);
  };

  return (
    <div
      ref={rowRef}
      data-testid="watch-scrolled-controls"
      className="fixed inset-x-0 bottom-0 z-[var(--z-sticky,20)] border-t border-yt-divider bg-yt-raised pb-[env(safe-area-inset-bottom)] translate-y-0 transition-transform duration-200 ease-out starting:translate-y-full motion-reduce:transition-none"
    >
      <div className="flex h-14 items-center gap-1 pl-3 pr-1">
        <button
          type="button"
          onClick={backToVideo}
          className="min-h-11 min-w-0 flex-1 cursor-pointer rounded-chip py-1 text-left [-webkit-tap-highlight-color:transparent] focus-visible:outline-offset-0"
        >
          <span className="block truncate text-sm font-medium leading-5 text-yt-text">{currentSong.name}</span>
          <span className="block truncate text-xs leading-[18px] text-yt-text-secondary">{formatArtistLine(currentSong)}</span>
          {/* The visible name stays the start of the button's name; this says what a tap does. */}
          <span className="sr-only">{`, ${t('動画に戻る')}`}</span>
        </button>
        <IconButton
          variant="filled"
          label={isPlaying ? t('一時停止') : t('再生')}
          icon={isPlaying ? <PauseIcon /> : <PlayIcon />}
          tooltipPlacement="top"
          className={TAP_TARGET}
          onClick={() => (isPlaying ? pause() : resume())}
        />
        <IconButton
          label={t('次の曲')}
          icon={<SkipNextIcon />}
          tooltipPlacement="top"
          // Soft-disabled at the end of the queue: a focused button keeps focus until autoplay appends songs.
          aria-disabled={!canGoNext || undefined}
          className={cx(TAP_TARGET, SOFT_DISABLED_CLASS)}
          onClick={() => {
            if (canGoNext) next();
          }}
        />
      </div>
    </div>
  );
}
