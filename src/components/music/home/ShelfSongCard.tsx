import { useMemo } from 'react';
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
import { playShelfSong } from './musicHomeSources';

interface ShelfSongCardProps {
  song: Song;
  /** Ranking shelves: the position, shown at the top-left of the artwork. */
  rank?: number;
  /** Mouse devices: ▶ and ⋮ appear on hover / focus (touch screens always show them). */
  finePointer: boolean;
}

/**
 * Square song card of a Home shelf. The artwork (and its ▶) plays the song here, Home stays open;
 * the title opens the song page (`…&autoplay=0`, so a new tab never takes over playback).
 * In selection mode the artwork selects the song instead.
 */
export default function ShelfSongCard({ song, rank, finePointer }: ShelfSongCardProps) {
  const t = useTranslateSourceText();
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
    if (playable) playShelfSong(song);
  };

  const selectThisSong = () => {
    useSelectionStore.getState().enterSelectionMode();
    if (!useSelectionStore.getState().selectedSongIds.has(song.id)) useSelectionStore.getState().toggleSong(song);
  };

  return (
    <li
      data-testid="music-shelf-card"
      data-now-playing={isCurrent ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className={cx('group relative shrink-0 snap-start', SHELF_CARD_WIDTH_CLASS)}
    >
      {/* The artwork plays the song: a transparent button over it (with the ▶ at the bottom-right). */}
      <div className="relative">
        <SquareArt song={song} radius="md" className="w-full">
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
        <div className="min-w-0 flex-1">
          <h3 className={cx('m-0 text-sm font-medium leading-5', isCurrent ? 'text-brand' : 'text-yt-text')}>
            {isSelectionMode ? (
              <span className="line-clamp-2 break-words">{song.name}</span>
            ) : (
              <Link
                to={href}
                className="line-clamp-2 break-words rounded-sm text-inherit no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus"
              >
                {song.name}
              </Link>
            )}
          </h3>
          <p className="m-0 mt-0.5 truncate text-sm leading-5 text-yt-text-secondary">{formatArtistLine(song)}</p>
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
