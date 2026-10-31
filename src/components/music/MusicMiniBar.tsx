import { useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerSwipeGesture } from '../../hooks/usePlayerSwipeGesture';
import { usePlayerInteractionStore } from '../../stores/playerInteractionStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';
import { isWatchPath, watchPath } from '../../utils/routes';
import type { SwipeDirection } from '../../utils/swipeGesture';
import { formatArtistLine } from '../../utils/songMeta';
import { clampFraction } from '../player/playerUi';
import { isSilentVolume } from '../player/playerMute';
import IconButton from '../ui/IconButton';
import { CloseIcon, PauseIcon, PlayIcon, SkipNextIcon, VolumeOffIcon } from '../ui/icons';
import { MOBILE_BUTTON_CLASS, ignoresAppVolume, toggleMuteWithToast } from './player/playerBarUi';
import SquareArt from './SquareArt';

/** The 2px progress along the bar's top edge (only shows progress; seeking is on the song page). */
function MiniBarProgress() {
  const progress = useProgressStore(state => state.progress);
  const duration = useProgressStore(state => state.duration);
  const fraction = duration > 0 ? clampFraction(progress / duration) : 0;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-px h-0.5 bg-yt-outline">
      <div className="h-full bg-brand" style={{ width: `${(fraction * 100).toFixed(3)}%` }} />
    </div>
  );
}

/**
 * The music layout's bar on phones (MusicDock shows it above the bottom nav while a song is loaded):
 * artwork, title and artist (a tap or Enter opens the song page), 再生 / 一時停止 and 次の曲. Swipes on
 * the bar work like on the standard mini player: left 次の曲, right 前の曲, up the song page (buttons
 * are left out of the gesture, and it follows the setting). While nothing can be heard it offers
 * ミュートを解除 here (nothing is drawn on the video), and ✕ closes the player like the standard one.
 * In a narrow bar (a phone held sideways, next to the video card) the artwork steps aside first.
 */
export default function MusicMiniBar() {
  const t = useTranslateSourceText();
  const navigate = useNavigate();
  const location = useLocation();
  const song = usePlayerStore(state => state.currentSong);
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const pause = usePlayerStore(state => state.pause);
  const resume = usePlayerStore(state => state.resume);
  const next = usePlayerStore(state => state.next);
  const previous = usePlayerStore(state => state.previous);
  const closePlayer = usePlayerStore(state => state.closePlayer);
  const silent = usePlayerStore(state => isSilentVolume(state.volume));
  const service = usePlayerStore(state => state.currentPV?.service);
  const swipeGestureEnabled = usePlayerInteractionStore(state => state.swipeGestureEnabled);
  const songId = song?.id ?? null;

  const openSongPage = useCallback(() => {
    if (songId === null) return;
    // Already on this song's page: bring its video back into view instead of adding a history entry.
    if (isWatchPath(location.pathname) && new URLSearchParams(location.search).get('v') === String(songId)) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      return;
    }
    // autoplay=0: opening the page never takes the playback over from another tab.
    navigate(watchPath(songId, { autoplay: false }));
  }, [location.pathname, location.search, navigate, songId]);

  const onSwipe = useCallback((direction: SwipeDirection) => {
    if (direction === 'left') next();
    else if (direction === 'right') previous();
    else if (direction === 'up') openSongPage();
  }, [next, openSongPage, previous]);

  const swipeHandlers = usePlayerSwipeGesture({ enabled: swipeGestureEnabled, onSwipe });

  if (!song) return null;

  const openOnKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    openSongPage();
  };

  return (
    <div
      className="music-mini-bar @container flex items-center gap-1 border-t border-yt-divider bg-yt-raised pl-2 pr-1"
      data-testid="music-mini-bar"
      {...swipeHandlers}
    >
      <MiniBarProgress />
      <div
        role="link"
        tabIndex={0}
        data-testid="music-mini-open"
        className="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-3 rounded-chip py-1 focus-visible:outline-offset-0"
        onClick={openSongPage}
        onKeyDown={openOnKey}
      >
        <SquareArt song={song} className="size-10 @max-[16rem]:hidden" loading="eager" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-5 text-yt-text">{song.name}</p>
          <p className="truncate text-xs leading-4 text-yt-text-secondary">{formatArtistLine(song)}</p>
        </div>
      </div>
      {silent && !ignoresAppVolume(service) && (
        <IconButton
          label={t('ミュートを解除')}
          icon={<VolumeOffIcon />}
          data-testid="music-mini-unmute"
          className={MOBILE_BUTTON_CLASS}
          onClick={() => toggleMuteWithToast(t)}
        />
      )}
      <IconButton
        variant="filled"
        label={isPlaying ? t('一時停止') : t('再生')}
        icon={isPlaying ? <PauseIcon /> : <PlayIcon />}
        data-testid="music-mini-play-toggle"
        className={MOBILE_BUTTON_CLASS}
        onClick={() => (isPlaying ? pause() : resume())}
      />
      <IconButton label={t('次の曲')} icon={<SkipNextIcon />} className={MOBILE_BUTTON_CLASS} onClick={next} />
      <IconButton
        label={t('プレイヤーを閉じる')}
        icon={<CloseIcon />}
        data-testid="music-mini-close"
        className={MOBILE_BUTTON_CLASS}
        onClick={closePlayer}
      />
    </div>
  );
}
