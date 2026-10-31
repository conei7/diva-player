import { Link, useLocation } from 'react-router';
import { useTranslateSourceText } from '../../i18n';
import { MUSIC_PANEL_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useMusicLayoutStore } from '../../stores/musicLayoutStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import type { Song } from '../../types/vocadb';
import { isWatchPath, watchPath } from '../../utils/routes';
import { formatArtistLine } from '../../utils/songMeta';
import { formatRemainingClock } from '../player/playerUi';
import { useSleepTimerRemaining } from '../player/useSleepTimerRemaining';
import IconButton from '../ui/IconButton';
import { PlaylistAddIcon, QueueMusicIcon, TimerIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import type { QueueView } from '../watch/queueView';
import { useQueueView } from '../watch/useQueueView';
import NowPlayingViewIcon from './player/NowPlayingViewIcon';
import PlayerBarMenu from './player/PlayerBarMenu';
import PlayerBarTransport from './player/PlayerBarTransport';
import PlayerBarVolume from './player/PlayerBarVolume';
import SquareArt from './SquareArt';

/** 「· ⏱ 残り 12:34」 after the artist while a sleep timer runs (ticks every second on its own). */
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

/** Left: artwork, title and artist (both open the song page) and プレイリストに保存. */
function PlayerBarSong({ song }: { song: Song | null }) {
  const t = useTranslateSourceText();
  const openSaveToPlaylist = useUiStore(state => state.openSaveToPlaylist);

  if (!song) {
    return (
      <div className="flex min-w-0 items-center gap-3">
        <SquareArt className="size-14" />
        <p className="line-clamp-2 min-w-0 text-sm leading-5 text-yt-text-secondary">
          {t('曲を選ぶと、ここで操作できます')}
        </p>
      </div>
    );
  }

  // autoplay=0: opening the page never takes the playback over from another tab (it resumes here as before).
  const songPath = watchPath(song.id, { autoplay: false });
  return (
    <div className="flex min-w-0 items-center gap-3">
      {/* The title is the same link for the keyboard and screen readers. */}
      <Link to={songPath} tabIndex={-1} aria-hidden="true" className="shrink-0 rounded-[4px]">
        <SquareArt song={song} className="size-14" loading="eager" />
      </Link>
      <div className="min-w-0">
        <Link
          to={songPath}
          className="block truncate rounded-chip text-sm font-medium leading-5 text-yt-text hover:underline"
        >
          {song.name}
        </Link>
        <p className="flex min-w-0 items-center overflow-hidden text-xs leading-[18px] text-yt-text-secondary">
          <span className="min-w-0 truncate">{formatArtistLine(song)}</span>
          <SleepTimerRemaining />
        </p>
      </div>
      <IconButton
        label={t('プレイリストに保存')}
        icon={<PlaylistAddIcon />}
        tooltipPlacement="top"
        onClick={() => openSaveToPlaylist(song)}
      />
    </div>
  );
}

/** Right: 再生中 (where the panel exists), キュー, mute and volume, ⋮. Below 1024px only the essentials. */
function PlayerBarExtras({ view, wide }: { view: QueueView; wide: boolean }) {
  const t = useTranslateSourceText();
  const hasSong = usePlayerStore(state => state.currentSong !== null);
  const queueDrawerOpen = usePlayerStore(state => state.queueDrawerOpen);
  const toggleQueueDrawer = usePlayerStore(state => state.toggleQueueDrawer);
  const nowPlayingOpen = useMusicLayoutStore(state => state.nowPlayingOpen);
  const toggleNowPlaying = useMusicLayoutStore(state => state.toggleNowPlaying);
  const isWatch = isWatchPath(useLocation().pathname);
  // While the 再生中 panel is beside the page, its 次に再生 is the queue: go there instead of covering
  // the panel (and its video) with the queue drawer.
  const queueInPanel = wide && nowPlayingOpen && hasSong && !isWatch && !queueDrawerOpen;
  const openQueue = () => {
    const section = queueInPanel
      ? document.querySelector<HTMLElement>('[data-testid="music-now-playing-queue"]')
      : null;
    if (!section) {
      toggleQueueDrawer();
      return;
    }
    section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    section.querySelector<HTMLElement>('h2, h3')?.setAttribute('tabindex', '-1');
    section.querySelector<HTMLElement>('h2, h3')?.focus({ preventScroll: true });
  };

  // Tooltips open to the left: above the bar's right end sits the video (panel or mini player).
  return (
    <div className="flex min-w-0 items-center justify-end gap-0.5">
      {wide && (
        <IconButton
          label={t('再生中')}
          icon={<NowPlayingViewIcon />}
          // The song page shows the video in the page instead of the panel.
          pressed={nowPlayingOpen && !isWatch}
          disabled={!hasSong || isWatch}
          tooltipPlacement="left"
          data-testid="music-now-playing-toggle"
          onClick={toggleNowPlaying}
        />
      )}
      <IconButton
        label={t('キュー')}
        icon={<QueueMusicIcon />}
        badge={hasSong ? view.entries.length : undefined}
        disabled={!hasSong}
        aria-haspopup={queueInPanel ? undefined : 'dialog'}
        aria-expanded={queueInPanel ? undefined : queueDrawerOpen}
        tooltipPlacement="left"
        data-testid="music-player-queue"
        className={cx(queueDrawerOpen && 'bg-yt-tonal')}
        onClick={openQueue}
      />
      <PlayerBarVolume showSlider={wide} />
      <PlayerBarMenu />
    </div>
  );
}

/**
 * The music layout's player bar along the bottom of the window (640px and up; phones get
 * MusicMiniBar). Three areas: the song on the left, the transport and progress in the middle (at most
 * 720px, always centred), and the extras on the right. Everything stays in place but disabled while no
 * song is loaded. It holds the same controls and rules as the standard layout's mini player, which the
 * music layout does not show.
 */
export default function MusicPlayerBar() {
  const t = useTranslateSourceText();
  const song = usePlayerStore(state => state.currentSong);
  // Built once for both sides: 次の曲 and the queue count also work during a cold restore.
  const { view } = useQueueView();
  // The same width as the 再生中 panel; the side columns are wide enough for what they hold.
  const wide = useMediaQuery(MUSIC_PANEL_MEDIA_QUERY);

  return (
    <section
      className={cx(
        'music-player-bar grid items-center',
        wide
          ? 'grid-cols-[minmax(272px,1fr)_minmax(0,720px)_minmax(272px,1fr)] gap-4 px-4'
          : 'grid-cols-[minmax(180px,1fr)_minmax(216px,1fr)_minmax(180px,1fr)] gap-2 px-2',
      )}
      aria-label={t('再生バー')}
      data-testid="music-player-bar"
    >
      <PlayerBarSong song={song} />
      <PlayerBarTransport view={view} />
      <PlayerBarExtras view={view} wide={wide} />
    </section>
  );
}
