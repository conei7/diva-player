import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router';
import type { Song } from '../../../types/vocadb';
import { useTranslateSourceText } from '../../../i18n';
import { getPlayablePV, usePlayerStore } from '../../../stores/playerStore';
import { useSelectionStore } from '../../../stores/selectionStore';
import { artistPath, searchPath, watchPath } from '../../../utils/routes';
import { formatArtistLine } from '../../../utils/songMeta';
import { getSongProducerLinks } from '../../search/songCardMeta';
import { MenuItem } from '../../ui/Menu';
import SongActionsMenu from '../../ui/SongActionsMenu';
import { CheckBoxOutlineIcon, CheckIcon, PauseIcon, PersonIcon, PlayIcon, VolumeBarsIcon } from '../../ui/icons';
import { cx } from '../../ui/overlay';
import SquareArt from '../SquareArt';
import { SHELF_CARD_WIDTH_CLASS } from './musicHomeShelves';
import { ART_SHADOW_CLASS, CARD_HOVER_CLASS } from './SongShelf';
import { playShelfSong } from './musicHomeSources';

interface ShelfSongCardProps {
  song: Song;
  /** Ranking shelves: the position, shown at the top-left of the artwork. */
  rank?: number;
  /** Mouse devices: ▶ and ⋮ appear on hover / focus (touch screens always show them). */
  finePointer: boolean;
  /**
   * A card of Home's feed grid (VideoGrid `square`) instead of a shelf: the grid column's width, the
   * `song-card` class of the feed's cards, and the feed's exposure records and reason line.
   */
  feed?: {
    /** Once 35% of the card has been on screen. */
    onVisible?: () => void;
    /** ▶ or the title. */
    onExposureClick?: () => void;
    /** Why it was recommended, a short grey line under the artist. */
    reason?: string | null;
  };
}

/**
 * Square song card of a Home shelf. The artwork (and its ▶) plays the song here, Home stays open;
 * the title (and the artist line under it) opens the song page (`…&autoplay=0`, so a new tab never
 * takes over playback).
 * In selection mode the artwork selects the song instead.
 */
export default function ShelfSongCard({ song, rank, finePointer, feed }: ShelfSongCardProps) {
  const t = useTranslateSourceText();
  const cardRef = useRef<HTMLLIElement>(null);
  const onExposureClick = feed?.onExposureClick;
  // The latest callback (a new function on every render of the grid) without re-observing.
  const onVisibleRef = useRef(feed?.onVisible);
  useEffect(() => {
    onVisibleRef.current = feed?.onVisible;
  });
  const observeVisibility = Boolean(feed?.onVisible);
  // The same rule as the feed's video cards (SongCard): reported once per song, at 35% on screen.
  useEffect(() => {
    const card = cardRef.current;
    if (!observeVisibility || !card || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting && (entries[0].intersectionRatio ?? 0) >= 0.35) {
        observer.disconnect();
        onVisibleRef.current?.();
      }
    }, { threshold: [0.35] });
    observer.observe(card);
    return () => observer.disconnect();
  }, [observeVisibility, song.id]);
  const isCurrent = usePlayerStore(state => state.currentSong?.id === song.id);
  const isPlaying = usePlayerStore(state => state.currentSong?.id === song.id && state.isPlaying);
  const isSelectionMode = useSelectionStore(state => state.isSelectionMode);
  const isSelected = useSelectionStore(state => state.selectedSongIds.has(song.id));
  const playable = useMemo(() => getPlayablePV(song) !== null, [song]);
  const href = watchPath(song.id, { autoplay: false });
  const producer = getSongProducerLinks(song)[0];
  const producerHref = producer
    ? producer.id ? artistPath({ id: producer.id, name: producer.name }) : searchPath(producer.name, 'producer')
    : null;
  const selected = isSelectionMode && isSelected;
  const showPlayButton = playable && !isSelectionMode;
  // Always shown for the loaded song (it says whether a press pauses or resumes) and on touch screens.
  const playButtonPinned = isCurrent || !finePointer;

  const artLabel = isSelectionMode
    ? t('「{title}」を選択', { title: song.name })
    : isPlaying
      ? t('「{title}」を一時停止', { title: song.name })
      : t('「{title}」を再生', { title: song.name });

  const activate = () => {
    if (isSelectionMode) {
      useSelectionStore.getState().toggleSong(song);
      return;
    }
    if (!playable) return;
    onExposureClick?.();
    playShelfSong(song);
  };

  const selectThisSong = () => {
    useSelectionStore.getState().enterSelectionMode();
    if (!useSelectionStore.getState().selectedSongIds.has(song.id)) useSelectionStore.getState().toggleSong(song);
  };

  return (
    <li
      ref={cardRef}
      data-testid={feed ? 'music-feed-card' : 'music-shelf-card'}
      data-now-playing={isCurrent ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className={cx(
        'group relative',
        CARD_HOVER_CLASS,
        feed ? 'song-card min-w-0' : cx('shrink-0 snap-start', SHELF_CARD_WIDTH_CLASS),
      )}
    >
      {/* The artwork plays the song: a transparent button over it (with the ▶ at the bottom-right). */}
      <div className="relative">
        <SquareArt song={song} radius="md" className={cx('w-full', ART_SHADOW_CLASS)}>
          {rank !== undefined && !isSelectionMode && (
            <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-badge bg-black/60 px-1.5 text-sm font-bold leading-6 text-white tabular-nums">
              {rank}
            </span>
          )}
          {!playable && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60">
              <span className="rounded-badge bg-thumb-badge px-2 py-1 text-xs font-medium leading-4 text-white">
                {t('再生できません')}
              </span>
            </span>
          )}
          {isPlaying && (
            <span className="pointer-events-none absolute bottom-2 left-2 flex items-center rounded-badge bg-thumb-badge p-1 text-brand">
              <VolumeBarsIcon size={16} />
            </span>
          )}
          {isSelectionMode && (
            selected ? (
              <>
                <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] border-2 border-yt-link" />
                <span aria-hidden="true" className="pointer-events-none absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-yt-link text-white">
                  <CheckIcon size={18} />
                </span>
              </>
            ) : (
              <span aria-hidden="true" className="pointer-events-none absolute left-1.5 top-1.5 size-6 rounded-full border-2 border-white bg-black/30" />
            )
          )}
        </SquareArt>
        <button
          type="button"
          aria-label={artLabel}
          aria-pressed={isSelectionMode ? isSelected : undefined}
          disabled={!isSelectionMode && !playable}
          onClick={activate}
          className="absolute inset-0 flex cursor-pointer items-end justify-end rounded-[8px] p-2 [-webkit-tap-highlight-color:transparent] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus disabled:cursor-default"
        >
          {showPlayButton && (
            <span
              aria-hidden="true"
              className={cx(
                'flex size-10 items-center justify-center rounded-full bg-brand text-yt-bg shadow-[0_8px_16px_rgb(0_0_0/0.35)] transition-[opacity,translate] duration-150 sm:size-12',
                playButtonPinned
                  ? 'opacity-100'
                  : 'translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100',
              )}
            >
              {isPlaying ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
            </span>
          )}
        </button>
      </div>

      <div className="mt-2 flex items-start gap-0.5">
        {/* relative: the title link's ::after covers the title and artist lines (a touch-sized target). */}
        <div className="relative min-w-0 flex-1">
          <h3 className={cx('m-0 text-sm font-medium leading-5', isCurrent ? 'text-brand' : 'text-yt-text')}>
            {isSelectionMode ? (
              <span className="line-clamp-2 break-words">{song.name}</span>
            ) : (
              <Link
                to={href}
                onClick={onExposureClick}
                className="line-clamp-2 break-words rounded-sm text-inherit no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus after:absolute after:inset-x-0 after:-top-1 after:bottom-0 after:content-['']"
              >
                {song.name}
              </Link>
            )}
          </h3>
          <p className="m-0 mt-0.5 truncate text-sm leading-5 text-yt-text-secondary">{formatArtistLine(song)}</p>
          {feed?.reason && (
            <p className="m-0 mt-0.5 truncate text-xs leading-[18px] text-yt-text-secondary">{feed.reason}</p>
          )}
        </div>
        {!isSelectionMode && (
          <div className="-mr-2 -mt-1.5">
            <SongActionsMenu
              song={song}
              // 32px for the mouse; touch screens get a 40px target (sm is only 40px under 640px).
              size={finePointer ? 'sm' : 'md'}
              alwaysVisible={!finePointer}
              extraItems={(
                <>
                  {producer && producerHref && (
                    <MenuItem icon={<PersonIcon />} href={producerHref}>
                      {t('{name}の曲', { name: producer.name })}
                    </MenuItem>
                  )}
                  <MenuItem icon={<CheckBoxOutlineIcon />} onSelect={selectThisSong}>
                    {t('選択')}
                  </MenuItem>
                </>
              )}
            />
          </div>
        )}
      </div>
    </li>
  );
}
