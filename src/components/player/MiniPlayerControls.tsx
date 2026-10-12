import type { KeyboardEvent, PointerEvent } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { showToast } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { displayQueueTitle } from '../../utils/displayNames';
import { getQueueDisplayWindow } from '../../utils/queueUtils';
import { songShareUrl } from '../../utils/routes';
import { formatArtistLine } from '../../utils/songMeta';
import IconButton from '../ui/IconButton';
import Menu, { MenuDivider, MenuItem } from '../ui/Menu';
import {
  CloseIcon,
  LinkIcon,
  MoreVertIcon,
  OpenPlayerIcon,
  PauseIcon,
  PlayIcon,
  PlaylistAddIcon,
  QueueMusicIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  SkipNextIcon,
  SkipPreviousIcon,
  TimerIcon,
} from '../ui/icons';
import { cx } from '../ui/overlay';
import SleepTimerMenuItems from './SleepTimerMenuItems';
import { copyTextToClipboard, formatRemainingClock, getQueuePosition } from './playerUi';
import { useSleepTimerRemaining } from './useSleepTimerRemaining';

export interface MiniPlayerSwipeHandlers {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
}

interface MiniPlayerControlsProps {
  /**
   * False while the player is on the song page or parked off screen. The controls stay in the DOM
   * (display:none) whenever a song is loaded, as they always have (tests wait for them).
   */
  visible: boolean;
  /** Under 640px: one 56px row (play / next / close) above the bottom navigation. */
  mobile: boolean;
  onOpenSongPage: () => void;
  swipeHandlers: MiniPlayerSwipeHandlers;
}

/** 44px tap targets on phones (DESIGN_SPEC §6.2.1 mobile row). */
const MOBILE_BUTTON = 'size-11!';
/** A disabled-looking button that still shows its tooltip (shuffle needs two songs). */
const SOFT_DISABLED = 'aria-disabled:cursor-default aria-disabled:text-yt-text-disabled aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent';

/** 「· ⏱ 残り 12:34」 after the meta line while a sleep timer runs (ticks every second on its own). */
function SleepTimerRemaining() {
  const t = useTranslateSourceText();
  const remainingMs = useSleepTimerRemaining();
  if (remainingMs <= 0) return null;
  return (
    <span className="ml-1 inline-flex shrink-0 items-center gap-0.5 tabular-nums">
      <span aria-hidden="true">·</span>
      <TimerIcon size={14} />
      {t('残り {time}', { time: formatRemainingClock(remainingMs) })}
    </span>
  );
}

/**
 * The mini player's text and controls (DESIGN_SPEC §6.2.1). GlobalPlayer renders them under the
 * video whenever a song is loaded and shows them only while the mini player is shown. The whole
 * block is the swipe surface on phones; the song label is where a swipe starts and a tap opens the
 * song page.
 */
export default function MiniPlayerControls({ visible, mobile, onOpenSongPage, swipeHandlers }: MiniPlayerControlsProps) {
  const t = useTranslateSourceText();
  const currentSong = usePlayerStore(state => state.currentSong);
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const pause = usePlayerStore(state => state.pause);
  const resume = usePlayerStore(state => state.resume);
  const next = usePlayerStore(state => state.next);
  const previous = usePlayerStore(state => state.previous);
  const closePlayer = usePlayerStore(state => state.closePlayer);
  const shuffleEnabled = usePlayerStore(state => state.shuffleEnabled);
  const toggleShuffle = usePlayerStore(state => state.toggleShuffle);
  const loopMode = usePlayerStore(state => state.loopMode);
  const toggleLoopMode = usePlayerStore(state => state.toggleLoopMode);
  const queue = usePlayerStore(state => state.queue);
  const queueIndex = usePlayerStore(state => state.queueIndex);
  const queueSources = usePlayerStore(state => state.queueSources);
  const queueTitle = usePlayerStore(state => state.queueTitle);
  const queueDrawerOpen = usePlayerStore(state => state.queueDrawerOpen);
  const toggleQueueDrawer = usePlayerStore(state => state.toggleQueueDrawer);

  if (!currentSong) return null;

  const playLabel = isPlaying ? t('一時停止') : t('再生');
  const togglePlayback = () => (isPlaying ? pause() : resume());
  const artist = formatArtistLine(currentSong);
  // 「wowaka · 作業用BGM 3/28」: the position stays visible when the names are cut short.
  const position = mobile ? null : getQueuePosition(queueSources, queueIndex);
  const meta = [artist, position ? displayQueueTitle(queueTitle, t) : ''].filter(Boolean).join(' · ');

  const openOnKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    onOpenSongPage();
  };

  const songLabel = (
    <div
      role="link"
      tabIndex={0}
      data-testid="mini-player-swipe-origin"
      className="min-w-0 flex-1 cursor-pointer select-none rounded-chip py-1 focus-visible:outline-offset-0"
      onClick={onOpenSongPage}
      onKeyDown={openOnKey}
    >
      <p className="truncate text-sm font-medium leading-5 text-yt-text">{currentSong.name}</p>
      <p className="flex min-w-0 items-center text-xs leading-[18px] text-yt-text-secondary">
        <span className="min-w-0 truncate">{meta}</span>
        {position && <span className="ml-1 shrink-0 tabular-nums">{position.position}/{position.total}</span>}
        {visible && <SleepTimerRemaining />}
      </p>
    </div>
  );

  if (mobile) {
    return (
      <div
        className={cx('mini-player-controls h-14 items-center gap-1 pl-3 pr-1', visible ? 'flex' : 'hidden')}
        data-testid="mini-player-gesture-surface"
        {...swipeHandlers}
      >
        {songLabel}
        <IconButton
          variant="filled"
          label={playLabel}
          icon={isPlaying ? <PauseIcon /> : <PlayIcon />}
          data-testid="global-mini-player-toggle"
          className={MOBILE_BUTTON}
          onClick={togglePlayback}
        />
        <IconButton label={t('次の曲')} icon={<SkipNextIcon />} className={MOBILE_BUTTON} onClick={next} />
        <IconButton
          label={t('ミニプレイヤーを閉じる')}
          icon={<CloseIcon />}
          data-testid="mini-player-close"
          className={MOBILE_BUTTON}
          onClick={closePlayer}
        />
      </div>
    );
  }

  const canShuffle = queue.length > 1 || shuffleEnabled;
  const loopLabel = loopMode === 'all' ? t('ループ: すべて') : loopMode === 'one' ? t('ループ: 1曲') : t('ループ: オフ');
  const queueDisplayCount = getQueueDisplayWindow(queue, queueIndex).items.length;

  const copyLink = () => {
    void copyTextToClipboard(songShareUrl(currentSong.id)).then(copied => {
      showToast(copied ? t('リンクをコピーしました') : t('リンクをコピーできませんでした'));
    });
  };
  const saveQueue = () => {
    useUiStore.getState().openSaveToPlaylist(queue, { source: 'queue', queueIndex });
  };

  return (
    <div
      className={cx('mini-player-controls flex-col', visible ? 'flex' : 'hidden')}
      data-testid="mini-player-gesture-surface"
      {...swipeHandlers}
    >
      <div className="flex h-[52px] items-center gap-1 pl-3 pr-1">
        {songLabel}
        <IconButton label={t('再生ページを開く')} icon={<OpenPlayerIcon />} tooltipPlacement="top" onClick={onOpenSongPage} />
        <IconButton
          label={t('ミニプレイヤーを閉じる')}
          icon={<CloseIcon />}
          tooltipPlacement="top"
          data-testid="mini-player-close"
          onClick={closePlayer}
        />
      </div>
      <div className="flex h-12 items-center justify-between gap-1 px-1 pb-1">
        <div className="flex items-center gap-1">
          <IconButton label={t('前の曲')} icon={<SkipPreviousIcon />} tooltipPlacement="top" onClick={previous} />
          <IconButton
            variant="filled"
            label={playLabel}
            icon={isPlaying ? <PauseIcon /> : <PlayIcon />}
            tooltipPlacement="top"
            data-testid="global-mini-player-toggle"
            onClick={togglePlayback}
          />
          <IconButton label={t('次の曲')} icon={<SkipNextIcon />} tooltipPlacement="top" onClick={next} />
        </div>
        <div className="flex items-center">
          <IconButton
            label={t('シャッフル')}
            icon={<ShuffleIcon />}
            pressed={shuffleEnabled}
            aria-disabled={!canShuffle || undefined}
            tooltip={canShuffle ? undefined : t('シャッフル（2曲以上で使えます）')}
            tooltipPlacement="top"
            className={SOFT_DISABLED}
            onClick={() => { if (canShuffle) toggleShuffle(); }}
          />
          <IconButton
            label={loopLabel}
            icon={loopMode === 'one' ? <RepeatOneIcon /> : <RepeatIcon />}
            pressed={loopMode !== 'none'}
            tooltipPlacement="top"
            onClick={toggleLoopMode}
          />
          <IconButton
            label={t('キュー')}
            icon={<QueueMusicIcon />}
            badge={queueDisplayCount}
            aria-haspopup="dialog"
            aria-expanded={queueDrawerOpen}
            tooltipPlacement="top"
            data-testid="mini-player-queue"
            className={cx(queueDrawerOpen && 'bg-yt-tonal')}
            onClick={toggleQueueDrawer}
          />
          {/* Only while shown: a hidden 「その他の操作」 must not be the first match for page-level ⋮ lookups. */}
          {visible && (
            <Menu
              align="end"
              width={264}
              trigger={<IconButton label={t('その他の操作')} icon={<MoreVertIcon />} tooltipPlacement="top" />}
            >
              <SleepTimerMenuItems />
              <MenuDivider />
              <MenuItem icon={<LinkIcon />} onSelect={copyLink}>{t('リンクをコピー')}</MenuItem>
              <MenuItem icon={<PlaylistAddIcon />} disabled={queue.length === 0} onSelect={saveQueue}>
                {t('キューをプレイリストに保存')}
              </MenuItem>
            </Menu>
          )}
        </div>
      </div>
    </div>
  );
}
