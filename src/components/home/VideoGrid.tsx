import { useCallback, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { Song } from '../../types/vocadb';
import SongCard from '../search/SongCard';
import { useSelectionStore } from '../../stores/selectionStore';
import { useRecommendationExposureStore, type ExposureSurface } from '../../stores/recommendationExposureStore';
import { useRecommendationDisplayStore } from '../../stores/recommendationDisplayStore';
import { useHiddenSongStore } from '../../stores/hiddenSongStore';
import { useTranslate } from '../../i18n';
import { filterSongsForVisibilityIntent, type SongVisibilityIntent } from '../../utils/songVisibility';
import { watchPath } from '../../utils/routes';
import EmptyState from '../ui/EmptyState';
import { SkeletonTile } from '../ui/Skeleton';
import { MusicNoteIcon } from '../ui/icons';

/**
 * VideoGrid - YouTube-style grid of song tiles.
 * repeat(auto-fill, minmax(320px, 1fr)): 3 columns at 1440px, 4 at 1920px; one full-bleed column on phones.
 */
interface VideoGridProps {
  songs: Song[];
  loading?: boolean;
  showScore?: boolean;
  recommendationReasons?: Record<number, string>;
  alwaysShowReasons?: boolean;
  exposureSurface?: ExposureSurface;
  /** Title of the default empty state. */
  emptyMessage?: string;
  /** Replaces the default empty state (an EmptyState with an action, for example). */
  emptyState?: ReactNode;
  visibilityIntent?: SongVisibilityIntent;
  /** Ranking feeds show 1, 2, 3… at the top-left of each thumbnail. */
  showRanks?: boolean;
}

const GRID_CLASS = 'grid grid-cols-1 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(320px,1fr))] sm:gap-x-4 sm:gap-y-10';

export default function VideoGrid({
  songs,
  loading,
  recommendationReasons,
  alwaysShowReasons = false,
  exposureSurface,
  emptyMessage,
  emptyState,
  visibilityIntent = 'discovery',
  showRanks = false,
}: VideoGridProps) {
  const t = useTranslate();
  const navigate = useNavigate();
  const setVisibleSongs = useSelectionStore(s => s.setVisibleSongs);
  const recordVisible = useRecommendationExposureStore(s => s.recordVisible);
  const recordClicked = useRecommendationExposureStore(s => s.recordClicked);
  const showRecommendationHints = useRecommendationDisplayStore(s => s.showHints);
  const hiddenSongs = useHiddenSongStore(s => s.hiddenSongs);
  const visibleSongs = useMemo(
    () => filterSongsForVisibilityIntent(songs, hiddenSongs, visibilityIntent),
    [hiddenSongs, songs, visibilityIntent],
  );

  // 表示中の曲リストをselectionStoreに登録（選択バーの「すべて選択」「条件で選択」用）
  useEffect(() => {
    setVisibleSongs(visibleSongs);
  }, [visibleSongs, setVisibleSongs]);

  const handlePlay = useCallback((song: Song) => {
    navigate(watchPath(song.id));
  }, [navigate]);

  if (loading && visibleSongs.length === 0) {
    return (
      <div className={GRID_CLASS} aria-busy="true">
        {Array.from({ length: 12 }).map((_, i) => (
          <SkeletonTile key={i} />
        ))}
      </div>
    );
  }

  if (!loading && visibleSongs.length === 0) {
    return emptyState ?? <EmptyState icon={<MusicNoteIcon />} title={emptyMessage ?? t('noSongsFound')} />;
  }

  return (
    <div className={GRID_CLASS}>
      {visibleSongs.map((song, index) => (
        <SongCard
          key={song.id}
          song={song}
          index={index}
          rank={showRanks ? index + 1 : undefined}
          showHidden={visibilityIntent === 'search'}
          onPlay={handlePlay}
          recommendationReason={showRecommendationHints || alwaysShowReasons ? recommendationReasons?.[song.id] : undefined}
          onVisible={exposureSurface ? () => recordVisible(song.id, exposureSurface, index + 1) : undefined}
          onExposureClick={exposureSurface ? () => recordClicked(song.id) : undefined}
        />
      ))}
    </div>
  );
}
