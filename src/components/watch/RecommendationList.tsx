import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { Song } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useRecommendationExposureStore, type ExposureSurface } from '../../stores/recommendationExposureStore';
import { useRecommendationDisplayStore } from '../../stores/recommendationDisplayStore';
import { excludeHiddenSongs, useHiddenSongStore } from '../../stores/hiddenSongStore';
import { useLanguageStore } from '../../stores/languageStore';
import { formatSongRelativeDate } from '../../utils/relativeDate';
import { formatArtistLine, songTypeLabel } from '../../utils/songMeta';
import ViewCounts from '../ui/ViewCounts';
import { hasViewCounts, joinMetaParts } from '../ui/songMetaParts';
import { watchPath } from '../../utils/routes';
import RecommendationHint from '../recommendation/RecommendationHint';
import SongListRow from '../ui/SongListRow';
import type { SongRowSize } from '../ui/SongListRow';
import SongActionsMenu from '../ui/SongActionsMenu';
import type { SongActionKey } from '../ui/SongActionsMenu';
import EmptyState from '../ui/EmptyState';
import { SkeletonListRow, SkeletonTile } from '../ui/Skeleton';
import { MusicNoteIcon } from '../ui/icons';
import RelatedSongCard from './RelatedSongCard';
import { useExposureObserver } from './useExposureObserver';

export interface RecommendationListEmpty {
  title: string;
  action?: { label: string; onClick: () => void };
}

interface RecommendationListProps {
  songs: Song[];
  loading: boolean;
  hasMore: boolean;
  recommendationReasons?: Record<number, string>;
  exposureSurface?: ExposureSurface;
  empty: RecommendationListEmpty;
  /** Phones: full-width cards instead of 168px rows. */
  cards?: boolean;
  rowSize?: SongRowSize;
}

/** Actions from ⋮ that count as an interaction with the recommendation. */
const ENGAGING_ACTIONS = new Set<SongActionKey>(['queue', 'watchLater', 'save']);

function RelatedItem({
  song,
  rank,
  active,
  reason,
  surface,
  cards,
  rowSize,
}: {
  song: Song;
  rank: number;
  active: boolean;
  reason?: string;
  surface?: ExposureSurface;
  cards: boolean;
  rowSize: SongRowSize;
}) {
  const navigate = useNavigate();
  const language = useLanguageStore(state => state.language);
  const recordVisible = useRecommendationExposureStore(state => state.recordVisible);
  const recordClicked = useRecommendationExposureStore(state => state.recordClicked);
  const isSelectionMode = useSelectionStore(state => state.isSelectionMode);
  const selected = useSelectionStore(state => state.selectedSongIds.has(song.id));
  const toggleSong = useSelectionStore(state => state.toggleSong);

  const onVisible = useCallback(() => {
    if (surface) recordVisible(song.id, surface, rank);
  }, [rank, recordVisible, song.id, surface]);
  const ref = useExposureObserver<HTMLDivElement>(surface ? onVisible : undefined, song.id);

  const activate = () => {
    if (surface) recordClicked(song.id);
    navigate(watchPath(song.id));
  };

  const viewBadges = hasViewCounts(song) ? <ViewCounts key="views" song={song} /> : null;
  const dateText = formatSongRelativeDate(song, Date.now(), language);
  const typeText = song.songType !== 'Original' && song.songType !== 'Unspecified'
    ? songTypeLabel(song.songType, language)
    : null;
  const badges = reason ? <RecommendationHint reason={reason} /> : undefined;
  const menu = isSelectionMode ? undefined : (
    <SongActionsMenu
      song={song}
      alwaysVisible={cards}
      onAction={key => {
        if (surface && ENGAGING_ACTIONS.has(key)) recordClicked(song.id);
      }}
    />
  );

  if (cards) {
    return (
      <RelatedSongCard
        cardRef={ref}
        song={song}
        href={watchPath(song.id, { autoplay: false })}
        onActivate={activate}
        meta={joinMetaParts([formatArtistLine(song), viewBadges, dateText])}
        badges={badges}
        trailing={menu}
        active={active}
        selectionMode={isSelectionMode}
        selected={selected}
        onToggleSelect={() => toggleSong(song)}
      />
    );
  }

  return (
    <SongListRow
      ref={ref}
      song={song}
      size={rowSize}
      data-testid="watch-recommendation-row"
      hoverBackground={false}
      onActivate={activate}
      meta={[
        formatArtistLine(song, { withVocalists: true }),
        joinMetaParts([viewBadges, dateText, typeText]),
      ]}
      badges={badges}
      trailing={menu}
      active={active}
      selectionMode={isSelectionMode}
      selected={selected}
      onToggleSelect={() => toggleSong(song)}
      className={rowSize === 'lg' || rowSize === 'fluid' ? '-mx-2' : '-mx-2 py-1!'}
    />
  );
}

/**
 * 関連一覧 of the watch page (right column / below the description on phones).
 * Clicking a song moves to its page in the SPA; modifier clicks open it in a new tab
 * (with autoplay=0). Hidden songs are left out.
 */
export default function RecommendationList({
  songs,
  loading,
  recommendationReasons,
  exposureSurface,
  empty,
  cards = false,
  rowSize = 'md',
}: RecommendationListProps) {
  const currentSongId = usePlayerStore(state => state.currentSong?.id);
  const showRecommendationHints = useRecommendationDisplayStore(state => state.showHints);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const visibleSongs = useMemo(() => excludeHiddenSongs(songs, hiddenSongs), [hiddenSongs, songs]);

  const skeletons = (count: number) => Array.from({ length: count }, (_, index) => (
    cards ? <SkeletonTile key={`skeleton-${index}`} /> : <SkeletonListRow key={`skeleton-${index}`} size={rowSize} />
  ));

  if (loading && visibleSongs.length === 0) {
    return <div className={cards ? 'space-y-6' : '-mx-2'}>{skeletons(cards ? 3 : 8)}</div>;
  }

  if (!loading && visibleSongs.length === 0) {
    return (
      <EmptyState
        compact
        icon={<MusicNoteIcon />}
        title={empty.title}
        action={empty.action ? { label: empty.action.label, onClick: empty.action.onClick } : undefined}
      />
    );
  }

  return (
    <div className={cards ? 'space-y-6' : undefined}>
      {visibleSongs.map((song, index) => (
        <RelatedItem
          key={song.id}
          song={song}
          rank={index + 1}
          active={currentSongId === song.id}
          reason={showRecommendationHints ? recommendationReasons?.[song.id] : undefined}
          surface={exposureSurface}
          cards={cards}
          rowSize={rowSize}
        />
      ))}
      {loading && <div className={cards ? 'space-y-6' : '-mx-2'}>{skeletons(cards ? 1 : 3)}</div>}
    </div>
  );
}
