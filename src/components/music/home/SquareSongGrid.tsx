import type { Song } from '../../../types/vocadb';
import { useTranslateSourceText } from '../../../i18n';
import { FINE_HOVER_MEDIA_QUERY, useMediaQuery } from '../../../hooks/useMediaQuery';
import { shortRecommendationReason } from '../../recommendation/reasonLabels';
import { SkeletonBlock } from '../../ui/Skeleton';
import ShelfSongCard from './ShelfSongCard';

/**
 * Columns of at least 168px across the page (two on a phone), 16px apart: each card's 8px hover panel
 * then meets its neighbour's.
 */
const SQUARE_GRID_CLASS =
  'm-0 grid list-none grid-cols-2 gap-x-4 gap-y-6 p-2 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))] -mx-2';

interface SquareSongGridProps {
  songs: Song[];
  /** Ranking feeds: 1, 2, 3… at the top-left of each artwork. */
  showRanks: boolean;
  /** Recommendation reasons by song id (already filtered by the feed's display setting). */
  reasons?: Record<number, string>;
  onVisible?: (song: Song, index: number) => void;
  onExposureClick?: (song: Song) => void;
}

/**
 * Home's feed in the music layout: the shelves' square cards in a grid (VideoGrid `square`), so the
 * page below the shelves keeps the same look instead of switching to video thumbnails. ▶ plays the song
 * here (Home stays open), the title opens the song page, as on the shelves.
 */
export default function SquareSongGrid({ songs, showRanks, reasons, onVisible, onExposureClick }: SquareSongGridProps) {
  const t = useTranslateSourceText();
  const finePointer = useMediaQuery(FINE_HOVER_MEDIA_QUERY);
  return (
    <ul className={SQUARE_GRID_CLASS} data-testid="music-feed-grid">
      {songs.map((song, index) => {
        const reason = reasons?.[song.id];
        return (
          <ShelfSongCard
            key={song.id}
            song={song}
            rank={showRanks ? index + 1 : undefined}
            finePointer={finePointer}
            feed={{
              onVisible: onVisible ? () => onVisible(song, index) : undefined,
              onExposureClick: onExposureClick ? () => onExposureClick(song) : undefined,
              reason: reason ? t(shortRecommendationReason(reason)) : null,
            }}
          />
        );
      })}
    </ul>
  );
}

/** The grid's placeholder while the first page loads (aria-busy is on the feed's wrapper). */
export function SquareSongGridSkeleton() {
  return (
    <div aria-hidden="true" className={SQUARE_GRID_CLASS}>
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} className="min-w-0">
          <SkeletonBlock className="aspect-[1/1] w-full rounded-[8px]" />
          <div className="mt-2 space-y-2 pt-1">
            <SkeletonBlock className="h-3.5 w-11/12 rounded-badge" />
            <SkeletonBlock className="h-3.5 w-3/5 rounded-badge" />
          </div>
        </div>
      ))}
    </div>
  );
}
