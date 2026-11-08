import { useEffect, useMemo, useState } from 'react';
import { useCanGoNext } from '../../hooks/useCanGoNext';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';
import { floatingArtworkCandidates, floatingPlayerShape, type FloatingPlayerShape } from '../../services/floatingPlayerWindow';
import type { Song } from '../../types/vocadb';
import { formatArtistLine, formatClockDuration } from '../../utils/songMeta';
import { MusicNoteIcon, PauseIcon, PlayIcon, SkipNextIcon, SkipPreviousIcon } from '../ui/icons';
import { cx } from '../ui/overlay';

function useWindowShape(win: Window): FloatingPlayerShape {
  const [shape, setShape] = useState(() => floatingPlayerShape(win.innerWidth, win.innerHeight));
  useEffect(() => {
    const onResize = () => setShape(floatingPlayerShape(win.innerWidth, win.innerHeight));
    onResize();
    win.addEventListener('resize', onResize);
    return () => win.removeEventListener('resize', onResize);
  }, [win]);
  return shape;
}

/** The video thumbnail, next candidate on error; nothing in hidden mode (like the page's artwork). */
function Artwork({ song, className }: { song: Song; className: string }) {
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const candidates = useMemo(() => floatingArtworkCandidates(song), [song]);
  const [failed, setFailed] = useState(0);
  const src = hiddenMode ? undefined : candidates[failed];
  if (!src) {
    return (
      <div className={cx(className, 'flex items-center justify-center bg-neutral-800 text-white/50')}>
        <MusicNoteIcon size={40} />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={cx(className, 'object-cover')}
      onLoad={event => { if (event.currentTarget.naturalWidth <= 120) setFailed(index => index + 1); }}
      onError={() => setFailed(index => index + 1)}
    />
  );
}

/** Dragging previews the time and seeks once on release, so the video is not asked to seek per pixel. */
function FloatingProgress() {
  const t = useTranslateSourceText();
  const progress = useProgressStore(state => state.progress);
  const duration = useProgressStore(state => state.duration);
  const seekTo = usePlayerStore(state => state.seekTo);
  const [scrub, setScrub] = useState<number | null>(null);
  const max = Math.max(0, Math.floor(duration));
  const value = Math.min(max, Math.max(0, Math.floor(scrub ?? progress)));
  const commit = () => {
    if (scrub === null) return;
    seekTo(scrub);
    setScrub(null);
  };
  return (
    <div className="flex items-center gap-2 text-[11px] leading-4 tabular-nums text-white/70">
      <span className="w-10 shrink-0 text-right">{formatClockDuration(value)}</span>
      <input
        type="range"
        min={0}
        max={max || 1}
        step={1}
        value={value}
        disabled={max === 0}
        aria-label={t('再生位置')}
        aria-valuetext={`${formatClockDuration(value)} / ${formatClockDuration(max)}`}
        data-testid="floating-player-progress"
        className="h-1 min-w-0 flex-1 cursor-pointer accent-brand disabled:cursor-default"
        onChange={event => setScrub(Number(event.currentTarget.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="w-10 shrink-0">{formatClockDuration(max)}</span>
    </div>
  );
}

const ROUND_BUTTON = cx(
  'flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/85',
  'hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
  'aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent',
);

function FloatingControls() {
  const t = useTranslateSourceText();
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const pause = usePlayerStore(state => state.pause);
  const resume = usePlayerStore(state => state.resume);
  const next = usePlayerStore(state => state.next);
  const previous = usePlayerStore(state => state.previous);
  const canGoNext = useCanGoNext();
  const playLabel = isPlaying ? t('一時停止') : t('再生');
  return (
    <div className="flex items-center justify-center gap-3">
      <button type="button" className={ROUND_BUTTON} aria-label={t('前の曲')} title={t('前の曲')} onClick={previous}>
        <SkipPreviousIcon />
      </button>
      <button
        type="button"
        className={cx(
          'flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white text-black',
          'transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
        )}
        aria-label={playLabel}
        title={playLabel}
        data-testid="floating-player-toggle"
        onClick={() => (isPlaying ? pause() : resume())}
      >
        {isPlaying ? <PauseIcon size={28} /> : <PlayIcon size={28} />}
      </button>
      <button
        type="button"
        className={ROUND_BUTTON}
        aria-label={t('次の曲')}
        title={t('次の曲')}
        aria-disabled={!canGoNext || undefined}
        data-testid="floating-player-next"
        onClick={() => { if (canGoNext) next(); }}
      >
        <SkipNextIcon />
      </button>
    </div>
  );
}

function SongText({ song }: { song: Song }) {
  const artist = formatArtistLine(song);
  return (
    <div className="min-w-0">
      <p className="m-0 truncate text-base font-bold leading-6" title={song.name} data-testid="floating-player-title">{song.name}</p>
      {artist && <p className="m-0 truncate text-sm leading-5 text-white/70" title={artist}>{artist}</p>}
    </div>
  );
}

/**
 * What the 小窓プレイヤー window shows (FloatingPlayerHost renders it there): the artwork with the title,
 * artist, the seek bar and 前 / 再生 / 次, always dark like Spotify's miniplayer, with the theme's
 * accent colour. Space plays or pauses anywhere but on a control. Plain buttons with `title`: the
 * page's tooltips and menus would open in the page, not in this window.
 */
export default function FloatingPlayerView({ ownerWindow }: { ownerWindow: Window }) {
  const t = useTranslateSourceText();
  const song = usePlayerStore(state => state.currentSong);
  const shape = useWindowShape(ownerWindow);

  useEffect(() => {
    ownerWindow.document.title = song ? `${song.name} - DIVA Player` : 'DIVA Player';
  }, [ownerWindow, song]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== ' ' || event.repeat) return;
      const target = event.target as Element | null;
      if (target?.closest('button, input')) return;
      event.preventDefault();
      const player = usePlayerStore.getState();
      if (player.isPlaying) player.pause();
      else player.resume();
    };
    ownerWindow.document.addEventListener('keydown', onKeyDown);
    return () => ownerWindow.document.removeEventListener('keydown', onKeyDown);
  }, [ownerWindow]);

  if (!song) {
    return (
      <div className="flex h-dvh items-center justify-center bg-neutral-950 p-4 text-center text-sm text-white/70">
        {t('曲を選ぶと、ここで操作できます')}
      </div>
    );
  }

  if (shape === 'row') {
    return (
      <div data-testid="floating-player" data-shape="row" className="flex h-dvh w-full select-none items-center gap-3 overflow-hidden bg-neutral-950 p-3 text-white">
        <Artwork key={song.id} song={song} className="aspect-square h-full max-h-full shrink-0 rounded-[6px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <SongText song={song} />
          <FloatingProgress />
          <FloatingControls />
        </div>
      </div>
    );
  }

  return (
    <div data-testid="floating-player" data-shape="stacked" className="relative h-dvh w-full select-none overflow-hidden bg-neutral-950 text-white">
      <Artwork key={song.id} song={song} className="absolute inset-0 h-full w-full" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-linear-to-t from-black/90 via-black/65 to-transparent px-4 pb-3 pt-16">
        <SongText song={song} />
        <FloatingProgress />
        <FloatingControls />
      </div>
    </div>
  );
}
