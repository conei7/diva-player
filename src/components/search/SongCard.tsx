import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { Link } from 'react-router';
import type { Song } from '../../types/vocadb';
import { getPlayablePV, usePlayerStore } from '../../stores/playerStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useHiddenSongStore } from '../../stores/hiddenSongStore';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { formatSongRelativeDate } from '../../utils/relativeDate';
import { shortRecommendationReason } from '../recommendation/reasonLabels';
import { artistPath, searchPath, watchPath } from '../../utils/routes';
import SongThumbnail from '../ui/SongThumbnail';
import SongActionsMenu from '../ui/SongActionsMenu';
import { MenuItem } from '../ui/Menu';
import { CheckBoxOutlineIcon, PersonIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import ViewCounts from '../ui/ViewCounts';
import { hasViewCounts } from '../ui/songMetaParts';
import { MetaTag, SongArtistLine } from './SongCardBadges';
import { getSongProducerLinks, useSongTypeTagLabel } from './songCardMeta';

interface SongCardProps {
  song: Song;
  /** Position in the grid (kept for callers; the rank badge uses `rank`). */
  index: number;
  onPlay?: (song: Song) => void;
  onSelect?: (song: Song) => void;
  recommendationReason?: string;
  onVisible?: () => void;
  onExposureClick?: () => void;
  /** Explicit searches also show songs that are hidden from discovery. */
  showHidden?: boolean;
  /** Ranking-type feeds show the position at the top-left of the thumbnail. */
  rank?: number;
}

function isPlainLeftClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * The title link's ::after covers the tile (the card is `relative`) and carries the focus ring.
 * It ignores the pointer, so the thumbnail, the artist links and the ⋮ keep their own clicks.
 * Phones: the thumbnail is full-bleed (-12px on both sides); the ring follows it and is drawn inside.
 */
const TITLE_LINK_CLASS = cx(
  "text-inherit no-underline focus-visible:outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-card after:content-['']",
  'focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-yt-focus',
  'max-sm:after:-inset-x-3 max-sm:after:rounded-none max-sm:focus-visible:after:-outline-offset-2',
);

/**
 * Home / search tile (YouTube grid item): 16:9 thumbnail, 2-line title, artist line, view counts.
 * Same-tab clicks play the song; modified and middle clicks open `…&autoplay=0` in a new tab.
 */
export default function SongCard({
  song,
  onPlay,
  onSelect,
  recommendationReason,
  onVisible,
  onExposureClick,
  showHidden = false,
  rank,
}: SongCardProps) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const isNowPlaying = usePlayerStore(state => state.currentSong?.id === song.id && state.isPlaying);
  const setQueue = usePlayerStore(state => state.setQueue);
  const isHidden = useHiddenSongStore(state => Boolean(state.hiddenSongs[String(song.id)]));
  const isSelectionMode = useSelectionStore(state => state.isSelectionMode);
  const longPressSelectionEnabled = useSelectionStore(state => state.longPressSelectionEnabled);
  const isSelected = useSelectionStore(state => state.selectedSongIds.has(song.id));
  const toggleSelection = useSelectionStore(state => state.toggleSong);
  const enterSelectionMode = useSelectionStore(state => state.enterSelectionMode);
  const hasPlayablePV = useMemo(() => getPlayablePV(song) !== null, [song]);
  const tagLabel = useSongTypeTagLabel(song);
  const cardRef = useRef<HTMLDivElement>(null);
  const visibilityReportedRef = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);
  const href = watchPath(song.id, { autoplay: false });
  const producer = getSongProducerLinks(song)[0];

  useEffect(() => {
    visibilityReportedRef.current = false;
  }, [song.id]);

  useEffect(() => {
    if (!onVisible || !cardRef.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (!visibilityReportedRef.current && entries[0]?.isIntersecting && (entries[0].intersectionRatio ?? 0) >= 0.35) {
        visibilityReportedRef.current = true;
        onVisible();
      }
    }, { threshold: [0.35] });
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [onVisible]);

  useEffect(() => () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  const play = useCallback(() => {
    onExposureClick?.();
    if (onPlay) onPlay(song);
    else setQueue([song], 0);
    onSelect?.(song);
  }, [onExposureClick, onPlay, onSelect, setQueue, song]);

  const selectThisSong = useCallback(() => {
    enterSelectionMode();
    if (!useSelectionStore.getState().selectedSongIds.has(song.id)) toggleSelection(song);
  }, [enterSelectionMode, song, toggleSelection]);

  // Clicks on the text area (outside the links and the ⋮) behave like the title link.
  const handleCardClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (isSelectionMode) {
      event.preventDefault();
      toggleSelection(song);
      return;
    }
    if (isPlainLeftClick(event)) play();
  };

  const handleLinkClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.stopPropagation();
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      event.preventDefault();
      return;
    }
    if (isSelectionMode) {
      event.preventDefault();
      toggleSelection(song);
      return;
    }
    // Modified clicks keep the link's default: the song opens in a new tab without autoplay.
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    play();
  };

  const handleLinkAuxClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (isSelectionMode) event.preventDefault();
    event.stopPropagation();
  };

  // In selection mode the title is a checkbox: Space toggles it (Enter is the link's click, which toggles too).
  const handleSelectionKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== ' ' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    toggleSelection(song);
  };

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Long-press selection is mouse/pen-only: on touch screens a held finger usually means scrolling.
  const handlePointerDown = (event: PointerEvent<HTMLAnchorElement>) => {
    if (!longPressSelectionEnabled || event.pointerType === 'touch' || isSelectionMode) return;
    longPressTriggered.current = false;
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      longPressTriggered.current = true;
      selectThisSong();
    }, 500);
  };

  if (isHidden && !showHidden) return null;

  const linkHandlers = {
    onClick: handleLinkClick,
    onAuxClick: handleLinkAuxClick,
    onPointerDown: handlePointerDown,
    onPointerUp: clearLongPress,
    onPointerCancel: clearLongPress,
    onPointerLeave: clearLongPress,
  };
  const relativeDate = formatSongRelativeDate(song, Date.now(), language);
  const reasonLabel = recommendationReason ? t(shortRecommendationReason(recommendationReason)) : null;
  const producerHref = producer
    ? producer.id ? artistPath({ id: producer.id, name: producer.name }) : searchPath(producer.name, 'producer')
    : null;

  return (
    <div
      ref={cardRef}
      data-selected={isSelectionMode && isSelected ? 'true' : undefined}
      className={cx('song-card group relative min-w-0', isSelectionMode && 'cursor-pointer select-none')}
      onClick={handleCardClick}
    >
      <Link
        to={href}
        tabIndex={-1}
        aria-hidden="true"
        draggable={false}
        className="relative block max-sm:-mx-3"
        {...linkHandlers}
      >
        <SongThumbnail
          song={song}
          className="w-full max-sm:rounded-none"
          rank={isSelectionMode ? undefined : rank}
          nowPlaying={isNowPlaying}
          selected={isSelectionMode && isSelected}
        >
          {!hasPlayablePV && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60">
              <span className="rounded-badge bg-thumb-badge px-2 py-1 text-xs leading-4 font-medium text-white">
                {t('再生できません')}
              </span>
            </div>
          )}
          {isSelectionMode && !isSelected && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-1 top-1 h-6 w-6 rounded-full border-2 border-white bg-black/30"
            />
          )}
        </SongThumbnail>
      </Link>

      <div className="mt-3 flex items-start">
        <div className="min-w-0 flex-1 pr-1">
          <h3 className="m-0 line-clamp-2 break-words text-base leading-[22px] font-medium text-yt-text">
            {/*
              The focus ring is drawn by ::after around the whole tile: the 2-line clamp's overflow
              would clip a ring on the link itself. In selection mode the title is the tile's checkbox.
            */}
            <Link
              to={href}
              role={isSelectionMode ? 'checkbox' : undefined}
              aria-checked={isSelectionMode ? isSelected : undefined}
              onKeyDown={isSelectionMode ? handleSelectionKeyDown : undefined}
              className={TITLE_LINK_CLASS}
              {...linkHandlers}
            >
              {song.name}
            </Link>
          </h3>
          <p className="m-0 mt-1 truncate text-sm leading-5 text-yt-text-secondary">
            <SongArtistLine song={song} linked={!isSelectionMode} />
          </p>
          {(hasViewCounts(song) || relativeDate || tagLabel || (showHidden && isHidden)) && (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm leading-5 text-yt-text-secondary">
              <ViewCounts song={song} />
              {relativeDate && <span>{relativeDate}</span>}
              {tagLabel && <MetaTag>{tagLabel}</MetaTag>}
              {showHidden && isHidden && <MetaTag>{t('非表示中')}</MetaTag>}
            </div>
          )}
          {reasonLabel && (
            <p className="m-0 mt-1 truncate text-sm leading-5 text-yt-text-secondary">{reasonLabel}</p>
          )}
        </div>
        {!isSelectionMode && (
          <div className="-mr-2 -mt-2">
            <SongActionsMenu
              song={song}
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
    </div>
  );
}
