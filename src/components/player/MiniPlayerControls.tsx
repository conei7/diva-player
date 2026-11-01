import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { useCanGoNext } from '../../hooks/useCanGoNext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerInteractionStore } from '../../stores/playerInteractionStore';
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
  VolumeOffIcon,
} from '../ui/icons';
import { cx, focusElement } from '../ui/overlay';
import { ignoresAppVolume } from '../music/player/playerBarUi';
import { closePlayerWithUndo } from '../watch/watchActions';
import SleepTimerMenuItems from './SleepTimerMenuItems';
import { isSilentVolume, unmutePlayer } from './playerMute';
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
  /**
   * Under 640px, and on short screens under 768px (beside the corner video): one 56px row
   * (play / next / close) above the bottom navigation.
   */
  mobile: boolean;
  onOpenSongPage: () => void;
  swipeHandlers: MiniPlayerSwipeHandlers;
}

/** 44px tap targets on phones (DESIGN_SPEC §6.2.1 mobile row). */
const MOBILE_BUTTON = 'size-11!';
/**
 * With ミュートを解除 the row has four buttons, which with their gaps need 188px (11.75rem): in a
 * narrower strip beside the corner video (560-575px wide windows) they step down to 40px, the phone
 * minimum (DESIGN_SPEC §1.9).
 */
const MOBILE_BUTTON_OF_FOUR = 'size-11! @max-[11.75rem]:size-10!';
/**
 * The song label leaves a strip narrower than 13rem to screen readers: beside three buttons it would
 * be under 56px. The phone row's four buttons take 200px with the label's margin, so with ミュートを解除
 * it steps aside below 16.25rem instead, keeping at least 60px when shown.
 */
const LABEL_ASIDE = '@max-[13rem]:sr-only';
const LABEL_ASIDE_OF_FOUR = '@max-[16.25rem]:sr-only';
/**
 * The corner strip without the guide (index.css area:player): ✕ is its last button, 8px from the video,
 * and has no room for a tooltip on any side that stays off the video.
 */
const NARROW_CORNER_STRIP_MEDIA_QUERY = '(min-width: 560px) and (max-width: 639px) and (max-height: 419.98px)';
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
 * song page. While nothing can be heard it offers ミュートを解除 here: nothing is drawn on the video.
 * On short screens the block is a strip beside the corner video; when that strip is narrow the song
 * label is left to screen readers so the buttons fit.
 */
export default function MiniPlayerControls({ visible, mobile, onOpenSongPage, swipeHandlers }: MiniPlayerControlsProps) {
  const t = useTranslateSourceText();
  const currentSong = usePlayerStore(state => state.currentSong);
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const pause = usePlayerStore(state => state.pause);
  const resume = usePlayerStore(state => state.resume);
  const next = usePlayerStore(state => state.next);
  const previous = usePlayerStore(state => state.previous);
  // Off at the end of the queue (next() would stop playback). Soft-disabled, so a keyboard user who
  // just pressed it onto the last song keeps focus there until autoplay appends songs.
  const canGoNext = useCanGoNext();
  const goNext = () => {
    if (canGoNext) next();
  };
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
  // With swipes on, a vertical drag is the 上スワイプ (song page): with the pan-y of index.css the
  // browser would take it for scrolling and cancel the pointer, as in the music mini bar.
  const swipeGestureEnabled = usePlayerInteractionStore(state => state.swipeGestureEnabled);
  const swipeLock = swipeGestureEnabled && 'touch-none!';
  // Muted with M, or a volume of 0 (the Bilibili player takes no volume from the app).
  const silent = usePlayerStore(state => isSilentVolume(state.volume));
  const service = usePlayerStore(state => state.currentPV?.service);
  const narrowCornerStrip = useMediaQuery(NARROW_CORNER_STRIP_MEDIA_QUERY);

  if (!currentSong) return null;

  const playLabel = isPlaying ? t('一時停止') : t('再生');
  const togglePlayback = () => (isPlaying ? pause() : resume());
  const closePlayer = () => closePlayerWithUndo(t);
  // No toast: the button going away is the answer. It goes away under the keyboard, which carries
  // on at 再生 / 一時停止 (moved now, before the re-render removes the button).
  const unmute = (event: MouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const hadFocus = button === document.activeElement;
    unmutePlayer();
    if (hadFocus) {
      focusElement(button.closest('[data-testid="mini-player-gesture-surface"]')
        ?.querySelector('[data-testid="global-mini-player-toggle"]'));
    }
  };
  const canUnmute = silent && !ignoresAppVolume(service);
  const unmuteButton = (className?: string) => canUnmute && (
    <IconButton
      label={t('ミュートを解除')}
      icon={<VolumeOffIcon />}
      data-testid="player-mute-badge"
      className={className}
      onClick={unmute}
    />
  );
  const artist = formatArtistLine(currentSong);
  // 「wowaka · 作業用BGM 3/28」: the position stays visible when the names are cut short.
  const position = mobile ? null : getQueuePosition(queueSources, queueIndex);
  const meta = [artist, position ? displayQueueTitle(queueTitle, t) : ''].filter(Boolean).join(' · ');

  const openOnKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    onOpenSongPage();
  };

  // The row's 12px start is 4px of padding and the label's 8px margin: when the strip beside the corner
  // video is too narrow for the label (index.css makes it a container), only screen readers keep it
  // and the buttons get that room.
  const songLabel = (
    <div
      role="link"
      tabIndex={0}
      data-testid="mini-player-swipe-origin"
      className={cx(
        'ml-2 min-w-0 flex-1 cursor-pointer select-none rounded-chip py-1 focus-visible:outline-offset-0',
        mobile && canUnmute ? LABEL_ASIDE_OF_FOUR : LABEL_ASIDE,
      )}
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
    const rowButton = canUnmute ? MOBILE_BUTTON_OF_FOUR : MOBILE_BUTTON;
    return (
      <div
        className={cx('mini-player-controls h-14 items-center gap-1 px-1', visible ? 'flex' : 'hidden', swipeLock)}
        data-testid="mini-player-gesture-surface"
        {...swipeHandlers}
      >
        {songLabel}
        {unmuteButton(rowButton)}
        <IconButton
          variant="filled"
          label={playLabel}
          icon={isPlaying ? <PauseIcon /> : <PlayIcon />}
          data-testid="global-mini-player-toggle"
          className={rowButton}
          onClick={togglePlayback}
        />
        <IconButton
          label={t('次の曲')}
          icon={<SkipNextIcon />}
          aria-disabled={!canGoNext || undefined}
          className={cx(rowButton, SOFT_DISABLED)}
          onClick={goNext}
        />
        <IconButton
          label={t('ミニプレイヤーを閉じる')}
          icon={<CloseIcon />}
          tooltip={narrowCornerStrip ? false : undefined}
          tooltipPlacement="left"
          data-testid="mini-player-close"
          className={rowButton}
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
      className={cx('mini-player-controls flex-col', visible ? 'flex' : 'hidden', swipeLock)}
      data-testid="mini-player-gesture-surface"
      {...swipeHandlers}
    >
      {/* The two rows are 52px + 3rem: index.css raises 1024px+ toasts above the corner strip by that much. */}
      <div className="flex h-[52px] items-center gap-1 px-1">
        {songLabel}
        {/*
          The top row's tooltips open below (the default, as for ミュートを解除): above it is the video.
          ✕'s opens to the left, like ⋮'s and the phone row's ✕: beside the corner video (index.css) a
          tooltip centred on the strip's last button would spill over the video.
        */}
        {unmuteButton()}
        <IconButton label={t('再生ページを開く')} icon={<OpenPlayerIcon />} tooltipPlacement="bottom" onClick={onOpenSongPage} />
        <IconButton
          label={t('ミニプレイヤーを閉じる')}
          icon={<CloseIcon />}
          tooltipPlacement="left"
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
          <IconButton
            label={t('次の曲')}
            icon={<SkipNextIcon />}
            aria-disabled={!canGoNext || undefined}
            className={SOFT_DISABLED}
            tooltipPlacement="top"
            onClick={goNext}
          />
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
              trigger={<IconButton label={t('その他の操作')} icon={<MoreVertIcon />} tooltipPlacement="left" />}
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
