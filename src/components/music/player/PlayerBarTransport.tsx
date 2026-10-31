import { useTranslateSourceText } from '../../../i18n';
import { FINE_HOVER_MEDIA_QUERY, useMediaQuery } from '../../../hooks/useMediaQuery';
import { usePlayerStore } from '../../../stores/playerStore';
import { useProgressStore } from '../../../stores/progressStore';
import { formatClockDuration } from '../../../utils/songMeta';
import ProgressLine from '../../player/ProgressLine';
import IconButton from '../../ui/IconButton';
import {
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  SkipNextIcon,
  SkipPreviousIcon,
} from '../../ui/icons';
import { cx } from '../../ui/overlay';
import type { QueueView } from '../../watch/queueView';
import { loopModeLabel, SOFT_DISABLED_CLASS } from './playerBarUi';

const TIME_CLASS = 'min-w-10 shrink-0 text-xs leading-4 tabular-nums text-yt-text-secondary';

/** 「1:23」 and 「4:05」 on both sides of the progress line (only this part re-renders with the progress). */
function PlayerTimes({ hasSong, seekable }: { hasSong: boolean; seekable: boolean }) {
  const progress = useProgressStore(state => state.progress);
  const duration = useProgressStore(state => state.duration);
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      {/* The seek slider reads the same times out (aria-valuetext). */}
      <span aria-hidden="true" className={cx(TIME_CLASS, 'text-right')}>{formatClockDuration(hasSong ? progress : 0)}</span>
      <div className="flex h-4 min-w-0 flex-1 flex-col justify-center">
        {hasSong ? <ProgressLine seekable={seekable} /> : <div aria-hidden="true" className="h-0.5 bg-yt-outline" />}
      </div>
      <span aria-hidden="true" className={TIME_CLASS}>{formatClockDuration(hasSong ? duration : 0)}</span>
    </div>
  );
}

interface PlayerBarTransportProps {
  /** From useQueueView(): also right during a cold restore, while `queue` is still empty. */
  view: QueueView;
}

/**
 * The middle of the player bar: シャッフル · 前の曲 · 再生 / 一時停止 · 次の曲 · ループ over the times and
 * the progress line. Same rules as the mini player and the queue header: shuffle needs two songs (it
 * stays focusable and says so in its tooltip), 前の曲 / 次の曲 follow the queue, also while it is
 * being restored. Tooltips open to the side so none rises over the video above the bar.
 */
export default function PlayerBarTransport({ view }: PlayerBarTransportProps) {
  const t = useTranslateSourceText();
  const hasSong = usePlayerStore(state => state.currentSong !== null);
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const pause = usePlayerStore(state => state.pause);
  const resume = usePlayerStore(state => state.resume);
  const next = usePlayerStore(state => state.next);
  const previous = usePlayerStore(state => state.previous);
  const shuffleEnabled = usePlayerStore(state => state.shuffleEnabled);
  const toggleShuffle = usePlayerStore(state => state.toggleShuffle);
  const loopMode = usePlayerStore(state => state.loopMode);
  const toggleLoopMode = usePlayerStore(state => state.toggleLoopMode);
  const queueLength = usePlayerStore(state => state.queue.length);
  const restoringLength = usePlayerStore(state => state.restoringQueueWindow?.songs.length ?? 0);
  const finePointer = useMediaQuery(FINE_HOVER_MEDIA_QUERY);

  const canShuffle = queueLength > 1 || shuffleEnabled;
  const canGoPrevious = queueLength > 0 || restoringLength > 0;
  const canGoNext = Boolean(view.nextSong) || (queueLength > 0 && loopMode !== 'none');
  const playLabel = isPlaying ? t('一時停止') : t('再生');

  return (
    <div className="flex w-full min-w-0 flex-col items-center gap-1">
      {/* 216px with the narrow gaps: still fits the middle column of a 640px window. */}
      <div className="flex items-center gap-1 lg:gap-2">
        <IconButton
          label={t('シャッフル')}
          icon={<ShuffleIcon />}
          pressed={shuffleEnabled}
          disabled={!hasSong}
          aria-disabled={(hasSong && !canShuffle) || undefined}
          tooltip={hasSong && !canShuffle ? t('シャッフル（2曲以上で使えます）') : undefined}
          tooltipPlacement="left"
          className={SOFT_DISABLED_CLASS}
          onClick={() => { if (canShuffle) toggleShuffle(); }}
        />
        <IconButton
          label={t('前の曲')}
          icon={<SkipPreviousIcon />}
          disabled={!hasSong || !canGoPrevious}
          tooltipPlacement="left"
          onClick={previous}
        />
        <IconButton
          variant="filled"
          label={playLabel}
          icon={isPlaying ? <PauseIcon /> : <PlayIcon />}
          disabled={!hasSong}
          tooltipPlacement="left"
          data-testid="music-play-toggle"
          onClick={() => (isPlaying ? pause() : resume())}
        />
        <IconButton
          label={t('次の曲')}
          icon={<SkipNextIcon />}
          disabled={!hasSong || !canGoNext}
          tooltipPlacement="right"
          onClick={next}
        />
        <IconButton
          label={loopModeLabel(loopMode, t)}
          icon={loopMode === 'one' ? <RepeatOneIcon /> : <RepeatIcon />}
          pressed={loopMode !== 'none'}
          disabled={!hasSong}
          tooltipPlacement="right"
          onClick={toggleLoopMode}
        />
      </div>
      <PlayerTimes hasSong={hasSong} seekable={finePointer} />
    </div>
  );
}
