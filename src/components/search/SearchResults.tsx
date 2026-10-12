import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import type { Song } from '../../types/vocadb';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { useSearchStore } from '../../stores/searchStore';
import { ADVANCED_SEARCH_UNAVAILABLE_ERROR } from '../../search/searchModel';
import { useGlobalFilterStore } from '../../stores/globalFilterStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useHiddenSongStore } from '../../stores/hiddenSongStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useUiStore } from '../../stores/uiStore';
import { applyGlobalSongFilter, isGlobalSongFilterActive } from '../../utils/globalFilters';
import { performanceNow, recordPerformanceMetric } from '../../utils/performanceMetrics';
import { formatSongRelativeDate } from '../../utils/relativeDate';
import { artistPath, searchPath, watchPath, type SearchType } from '../../utils/routes';
import { useLanguageStore } from '../../stores/languageStore';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import VideoGrid from '../home/VideoGrid';
import SongListRow, { type SongRowSize } from '../ui/SongListRow';
import ViewCounts from '../ui/ViewCounts';
import { hasViewCounts, joinMetaParts } from '../ui/songMetaParts';
import SongActionsMenu from '../ui/SongActionsMenu';
import { MenuItem } from '../ui/Menu';
import EmptyState from '../ui/EmptyState';
import { InlineNotice } from '../ui/InlineNotice';
import { SkeletonListRow } from '../ui/Skeleton';
import { CheckBoxOutlineIcon, PersonIcon, SearchIcon, SpinnerIcon } from '../ui/icons';
import AppliedFilterChips from './AppliedFilterChips';
import ProducerHeader from './ProducerHeader';
import SearchResultsToolbar from './SearchResultsToolbar';
import { MetaTag, SongArtistLine } from './SongCardBadges';
import { getSongProducerLinks, useSongTypeTagLabel } from './songCardMeta';
import { useAppliedFilterItems } from './appliedFilters';

export interface UrlArtist {
  id: number;
  name: string;
  role?: string;
}

interface SearchResultsProps {
  /** `q` of the URL ('' for artist pages and advanced-only searches). */
  urlQuery: string;
  urlType: SearchType;
  urlArtist: UrlArtist | null;
  /** The store still holds another search than the URL asks for (the URL search starts right after). */
  pending: boolean;
  /** Re-runs the search the URL describes (the 再試行 of the error notice). */
  onRetry: () => void;
}

/**
 * Search results and artist song lists: toolbar, applied conditions, producer header and the result
 * rows (tiles on phones). The URL is the source of truth; HomePage keeps the store in sync with it.
 */
export default function SearchResults({ urlQuery, urlType, urlArtist, pending, onRetry }: SearchResultsProps) {
  const t = useTranslate();
  const ts = useTranslateSourceText();
  const navigate = useNavigate();
  const openSettings = useUiStore(state => state.openSettings);
  const {
    results,
    isLoading,
    totalCount,
    error,
    loadMore,
    resolvedArtist,
    searchType,
    searchOrigin,
    query,
    artistRole,
  } = useSearchStore(useShallow(state => ({
    results: state.results,
    isLoading: state.isLoading,
    totalCount: state.totalCount,
    error: state.error,
    loadMore: state.loadMore,
    resolvedArtist: state.resolvedArtist,
    searchType: state.searchType,
    searchOrigin: state.searchOrigin,
    query: state.query,
    artistRole: state.artistRole,
  })));
  const globalFilterSettings = useGlobalFilterStore(useShallow(state => ({
    enabled: state.enabled,
    minYoutubeViews: state.minYoutubeViews,
    minNicoViews: state.minNicoViews,
    excludedSongTypes: state.excludedSongTypes,
    excludeSelfCovers: state.excludeSelfCovers,
    vocalistFilters: state.vocalistFilters,
    vocalistMatchMode: state.vocalistMatchMode,
    cooldownHours: state.cooldownHours,
    excludeRatedFromDiscovery: state.excludeRatedFromDiscovery,
  })));
  const appliedItems = useAppliedFilterItems();
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const isWide = useMediaQuery('(min-width: 1280px)');
  const isMedium = useMediaQuery('(min-width: 768px)');
  const rowSize: SongRowSize = isWide ? 'xl' : isMedium ? 'lg' : 'md';
  const loading = pending || isLoading;
  const songs = useMemo(
    () => (pending ? [] : applyGlobalSongFilter(results, globalFilterSettings)),
    [globalFilterSettings, pending, results],
  );
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pendingPaintRef = useRef<number | null>(null);

  // Legacy direct searches (the old top bar) have no `q` in the URL; their query comes from the store.
  const toolbarQuery = urlQuery || (searchOrigin === 'direct' && searchType !== 'vocalist' ? query : '');
  const toolbarType: SearchType = urlQuery ? urlType : searchType;
  const showProducerHeader = !pending && resolvedArtist !== null && (urlArtist !== null || searchType !== 'song');
  const headerArtist = resolvedArtist ?? (urlArtist ? { id: urlArtist.id, name: urlArtist.name } : null);

  useEffect(() => {
    if (isLoading) {
      pendingPaintRef.current ??= performanceNow();
      return;
    }
    if (pendingPaintRef.current === null || typeof requestAnimationFrame === 'undefined') return;
    const startedAt = pendingPaintRef.current;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (pendingPaintRef.current !== startedAt) return;
        pendingPaintRef.current = null;
        recordPerformanceMetric({ name: 'search.paint', startedAt, detail: { displayedCount: songs.length } });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [isLoading, songs.length]);

  const canLoadMore = !pending && !isLoading && results.length > 0 && results.length < totalCount;
  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || !canLoadMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) void loadMore();
    }, { threshold: 0.1 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [canLoadMore, loadMore]);

  const clearConditions = () => {
    const store = useSearchStore.getState();
    store.clearSearchConditions();
    void store.search();
  };

  const emptyState = appliedItems.length > 0 ? (
    <EmptyState icon={<SearchIcon />} title={ts('一致する曲がありません')} action={{ label: ts('フィルターをクリア'), onClick: clearConditions }} />
  ) : isGlobalSongFilterActive(globalFilterSettings) ? (
    <EmptyState icon={<SearchIcon />} title={t('noSongsMatchFilters')} action={{ label: ts('フィルターを変更'), onClick: () => openSettings('filter') }} />
  ) : (
    <EmptyState icon={<SearchIcon />} title={ts('一致する曲がありません')} />
  );

  const showError = Boolean(error) && !pending;

  return (
    <div className="w-full px-3 pb-6 sm:px-4 lg:px-6">
      {!showProducerHeader && (
        <h1 className="sr-only">
          {toolbarQuery ? t('searchResults', { query: toolbarQuery }) : t('searchResultsTitle')}
        </h1>
      )}
      <SearchResultsToolbar
        query={toolbarQuery}
        type={toolbarType}
        onTypeChange={type => {
          if (type === toolbarType || !toolbarQuery) return;
          navigate(searchPath(toolbarQuery, type));
        }}
        // The producer header already says how many songs there are.
        totalCount={loading || showError || showProducerHeader ? null : totalCount}
        appliedCount={appliedItems.length}
      />
      <AppliedFilterChips items={appliedItems} />
      {showProducerHeader && headerArtist && (
        <ProducerHeader
          artist={headerArtist}
          role={urlArtist?.role ?? artistRole}
          songCount={totalCount}
          loading={loading}
          songs={results}
        />
      )}
      {showError && (
        <InlineNotice
          tone="error"
          role="alert"
          className="mt-4"
          action={{ label: ts('再試行'), onClick: onRetry }}
        >
          {error === ADVANCED_SEARCH_UNAVAILABLE_ERROR ? ts('いまは詳細検索を使えません') : ts('検索できませんでした')}
        </InlineNotice>
      )}

      <div className={showProducerHeader ? 'mt-4' : 'mt-2'}>
        {showError && songs.length === 0 ? null : isMobile ? (
          <VideoGrid songs={songs} loading={loading} visibilityIntent="search" emptyState={emptyState} />
        ) : (
          <SearchResultList songs={songs} loading={loading} size={rowSize} emptyState={emptyState} />
        )}
      </div>

      <div ref={sentinelRef} className="mt-6 flex h-8 items-center justify-center text-yt-text-secondary">
        {isLoading && songs.length > 0 && <SpinnerIcon />}
      </div>
    </div>
  );
}

function SearchResultList({ songs, loading, size, emptyState }: {
  songs: Song[];
  loading: boolean;
  size: SongRowSize;
  emptyState: ReactNode;
}) {
  const setVisibleSongs = useSelectionStore(state => state.setVisibleSongs);

  useEffect(() => {
    setVisibleSongs(songs);
  }, [setVisibleSongs, songs]);

  // Rows carry their own 8px padding: thumbnails end up 16px apart (DESIGN_SPEC §6.5.2), like the other lists.
  if (loading && songs.length === 0) {
    return (
      <div aria-busy="true" className="-mx-2 flex flex-col">
        {Array.from({ length: 6 }).map((_, index) => <SkeletonListRow key={index} size={size} />)}
      </div>
    );
  }
  if (!loading && songs.length === 0) return <>{emptyState}</>;

  return (
    <div className="-mx-2 flex flex-col">
      {songs.map(song => <SearchResultRow key={song.id} song={song} size={size} />)}
    </div>
  );
}

function SearchResultRow({ song, size }: { song: Song; size: SongRowSize }) {
  const ts = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const navigate = useNavigate();
  const isNowPlaying = usePlayerStore(state => state.currentSong?.id === song.id && state.isPlaying);
  const isHidden = useHiddenSongStore(state => Boolean(state.hiddenSongs[String(song.id)]));
  const isSelectionMode = useSelectionStore(state => state.isSelectionMode);
  const longPressSelectionEnabled = useSelectionStore(state => state.longPressSelectionEnabled);
  const isSelected = useSelectionStore(state => state.selectedSongIds.has(song.id));
  const toggleSelection = useSelectionStore(state => state.toggleSong);
  const enterSelectionMode = useSelectionStore(state => state.enterSelectionMode);
  const tagLabel = useSongTypeTagLabel(song);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);
  const producer = getSongProducerLinks(song)[0];
  const producerHref = producer
    ? producer.id ? artistPath({ id: producer.id, name: producer.name }) : searchPath(producer.name, 'producer')
    : null;

  useEffect(() => () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  const selectThisSong = useCallback(() => {
    enterSelectionMode();
    if (!useSelectionStore.getState().selectedSongIds.has(song.id)) toggleSelection(song);
  }, [enterSelectionMode, song, toggleSelection]);

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Long-press selection (mouse / pen only), like the home tiles.
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!longPressSelectionEnabled || event.pointerType === 'touch' || isSelectionMode || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    longPressTriggered.current = false;
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      longPressTriggered.current = true;
      selectThisSong();
    }, 500);
  };

  const firstLine = joinMetaParts([
    hasViewCounts(song) ? <ViewCounts key="views" song={song} /> : null,
    formatSongRelativeDate(song, Date.now(), language),
  ]);

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      onClickCapture={event => {
        if (!longPressTriggered.current) return;
        longPressTriggered.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <SongListRow
        song={song}
        size={size}
        className="song-card"
        active={isNowPlaying}
        onActivate={() => navigate(watchPath(song.id))}
        selectionMode={isSelectionMode}
        selected={isSelected}
        onToggleSelect={() => toggleSelection(song)}
        meta={[
          firstLine || null,
          <SongArtistLine key="artists" song={song} linked={!isSelectionMode} vocalistSeparator=" feat. " />,
        ]}
        badges={tagLabel || isHidden ? (
          <>
            {tagLabel && <MetaTag>{tagLabel}</MetaTag>}
            {isHidden && <MetaTag>{ts('非表示中')}</MetaTag>}
          </>
        ) : undefined}
        trailing={isSelectionMode ? undefined : (
          <SongActionsMenu
            song={song}
            extraItems={(
              <>
                {producer && producerHref && (
                  <MenuItem icon={<PersonIcon />} href={producerHref}>
                    {ts('{name}の曲', { name: producer.name })}
                  </MenuItem>
                )}
                <MenuItem icon={<CheckBoxOutlineIcon />} onSelect={selectThisSong}>
                  {ts('選択')}
                </MenuItem>
              </>
            )}
          />
        )}
      />
    </div>
  );
}
