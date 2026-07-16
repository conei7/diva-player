import { useState, useEffect, useCallback, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSearchParams } from 'react-router-dom';
import CategoryChips, { type CategoryChip } from '../components/home/CategoryChips';
import VideoGrid from '../components/home/VideoGrid';
import { searchSongs, getTopSongs, getRecommendedSongs, getSimilarSongs, getAudioSimilarSongs, getTrendingSongs, attachExternalViews, getSongsByProducer } from '../api/vocadb';
import { useHistoryStore } from '../stores/historyStore';
import { usePlayerStore } from '../stores/playerStore';
import { useRatingStore } from '../stores/ratingStore';
import { useSearchStore } from '../stores/searchStore';
import { useSelectionStore } from '../stores/selectionStore';
import { usePlaylistStore } from '../stores/playlistStore';
import { useImplicitFeedbackStore } from '../stores/implicitFeedbackStore';
import { useGlobalFilterStore } from '../stores/globalFilterStore';
import type { Song } from '../types/vocadb';
import SearchFilters from '../components/search/SearchFilters';
import {
  getPlaylistSongs,
  rankKnownSongs,
  uniqueSongsById,
} from '../utils/recommendationScoring';
import { rerankRecommendationCandidatesDetailed } from '../utils/recommendationReranking';
import { filterVoiceSynthSongs } from '../utils/voiceSynthSongs';
import { useRecommendationDebugStore } from '../stores/recommendationDebugStore';
import { createRankingSeed } from '../utils/rankingRandomization';
import { rerankDisplayedSongs, useRecommendationExposureStore } from '../stores/recommendationExposureStore';
import { applyDiscoveryFilter, applyGlobalSongFilter, requiresExternalViewCounts } from '../utils/globalFilters';
import { useFavoriteProducerStore } from '../stores/favoriteProducerStore';

type HomeCategoryId =
  | 'recommended'
  | 'popular'
  | 'trending'
  | 'recent'
  | 'deep'
  | 'history_based'
  | 'favorite_producers';

const CATEGORIES: CategoryChip[] = [
  { id: 'recommended', label: 'あなたへのおすすめ' },
  { id: 'popular', label: '人気の曲' },
  { id: 'trending', label: '急上昇' },
  { id: 'recent', label: '新着' },
  { id: 'deep', label: 'マイナー発掘' },
  { id: 'history_based', label: '最近聴いたPの曲' },
  { id: 'favorite_producers', label: 'お気に入りP' },
];

const PAGE_SIZE = 24;

function asHomeCategoryId(id: string): HomeCategoryId {
  return CATEGORIES.some(category => category.id === id)
    ? (id as HomeCategoryId)
    : 'recommended';
}

export default function HomePage() {
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('q') || '';
  const artistIdParam = searchParams.get('artistId');
  const artistNameParam = searchParams.get('artistName') || '';

  const [activeCategory, setActiveCategory] = useState<HomeCategoryId>('recommended');
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [recommendationReasons, setRecommendationReasons] = useState<Record<number, string>>({});

  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchingRef = useRef(false);
  const autoFillPagesRef = useRef(0);
  const requestIdRef = useRef(0);
  const rankingSeedRef = useRef(createRankingSeed());

  const { entries, hasHydrated } = useHistoryStore();
  const { currentSong } = usePlayerStore();
  const { ratings } = useRatingStore();
  const { playlists } = usePlaylistStore();
  const implicitFeedback = useImplicitFeedbackStore(state => state.feedback);
  const favoriteProducers = useFavoriteProducerStore(state => state.producers);
  const globalFilterSettings = useGlobalFilterStore(useShallow(state => ({
    enabled: state.enabled,
    minYoutubeViews: state.minYoutubeViews,
    minNicoViews: state.minNicoViews,
    excludedSongTypes: state.excludedSongTypes,
    cooldownHours: state.cooldownHours,
    excludeRatedFromDiscovery: state.excludeRatedFromDiscovery,
  })));
  const {
    results: searchResults,
    isLoading: searchLoading,
    hasSearched,
    totalCount,
    error: searchError,
    loadMore: searchLoadMore,
  } = useSearchStore();
  const setVisibleSongs = useSelectionStore(state => state.setVisibleSongs);

  const isSearchMode = searchQuery.length > 0;
  const isArtistMode = !!artistIdParam;

  const fetchRecommendedHomeSongs = useCallback(async (pageNum: number): Promise<Song[]> => {
    const excludeIds = new Set<number>();
    if (currentSong?.id) excludeIds.add(currentSong.id);

    const playlistSongs = getPlaylistSongs(playlists);
    const rankedKnown = rankKnownSongs(entries, playlistSongs, ratings, excludeIds, implicitFeedback);
    const knownSongs = rankedKnown.map(item => item.song);

    const seedIds = uniqueSongsById([
      ...entries.slice(0, 5).map(entry => entry.song),
      ...(currentSong ? [currentSong] : []),
    ])
      .filter(song => !excludeIds.has(song.id))
      .slice(0, 2)
      .map(song => song.id);

    const preferenceSeedIds = rankedKnown
      .filter(item => {
        const rating = ratings[String(item.song.id)] ?? 0;
        const feedback = implicitFeedback[String(item.song.id)];
        const manualCompletes = feedback?.manualCompleteCount ?? 0;
        const inPlaylist = playlistSongs.some(song => song.id === item.song.id);
        return rating >= 3 || manualCompletes >= 2 || inPlaylist;
      })
      .slice(0, 3)
      .map(item => item.song.id);

    const audioSeedIds = [...new Set([...seedIds, ...preferenceSeedIds])].slice(0, 2);

    const [popularResult, seedResults, preferenceResults, audioResults] = await Promise.all([
      searchSongs({
        sort: 'FavoritedTimes',
        maxResults: 12,
        start: pageNum * 12,
        getTotalCount: false,
        onlyWithPVs: true,
      }),
      Promise.all(seedIds.map(seedId =>
        getRecommendedSongs(seedId, 8, 0.0, ratings, pageNum * 8)
          .catch(() => [] as Song[])
      )),
      Promise.all(preferenceSeedIds.map(seedId =>
        getSimilarSongs(seedId, 8, pageNum * 8)
          .catch(() => [] as Song[])
      )),
      Promise.all(audioSeedIds.map(seedId =>
        getAudioSimilarSongs(seedId, 8, pageNum * 8)
          .catch(() => [] as Song[])
      )),
    ]);

    const knownStart = pageNum * 10;
    const detailed = rerankRecommendationCandidatesDetailed({
      known: knownSongs.slice(knownStart, knownStart + 18),
      hybrid: uniqueSongsById([...preferenceResults.flat(), ...seedResults.flat()]),
      audio: uniqueSongsById(audioResults.flat()),
      popular: popularResult.items,
    }, {
      total: PAGE_SIZE,
      historyEntries: entries,
      playlists,
      ratings,
      implicitFeedback,
      excludeIds,
      rankingSeed: rankingSeedRef.current,
      explorationStrength: 0.055,
      exposureEntries: useRecommendationExposureStore.getState().entries,
    });
    const mixed = detailed.ranked;
    const result = mixed.map(item => item.song);
    if (pageNum === 0) setRecommendationReasons(Object.fromEntries(mixed.map(item => [item.song.id, item.reason])));
    useRecommendationDebugStore.getState().recordSnapshot({
      id: `${Date.now()}-home-${pageNum}`,
      surface: 'home',
      generatedAt: Date.now(),
      rankingSeed: rankingSeedRef.current,
      seedSongIds: [...seedIds, ...preferenceSeedIds],
      familiarityBias: 0,
      candidateCount: detailed.trace.length,
      selectedCount: detailed.ranked.length,
      trace: detailed.trace,
    });
    return result.length > 0 ? result : getTopSongs(720, PAGE_SIZE);
  }, [currentSong, entries, playlists, ratings, implicitFeedback]);

  const fetchSongs = useCallback(async (
    category: HomeCategoryId,
    pageNum: number,
    query: string,
    requestId: number,
  ) => {
    if (pageNum > 0 && fetchingRef.current) return;
    fetchingRef.current = true;

    try {
      let result: Song[] = [];

      if (artistIdParam) {
        const searchResult = await searchSongs({
          artistIds: [Number(artistIdParam)],
          sort: 'FavoritedTimes',
          maxResults: PAGE_SIZE,
          start: pageNum * PAGE_SIZE,
          getTotalCount: false,
          onlyWithPVs: true,
        });
        result = searchResult.items;
      } else if (query) {
        const searchResult = await searchSongs({
          query,
          sort: 'FavoritedTimes',
          maxResults: PAGE_SIZE,
          start: pageNum * PAGE_SIZE,
          getTotalCount: false,
          onlyWithPVs: true,
        });
        result = searchResult.items;
      } else {
        switch (category) {
          case 'popular': {
            result = await getTrendingSongs(30, PAGE_SIZE, pageNum * PAGE_SIZE, 'growth', rankingSeedRef.current);
            break;
          }
          case 'recommended':
            result = await fetchRecommendedHomeSongs(pageNum);
            break;
          case 'trending':
            result = await getTrendingSongs(7, PAGE_SIZE, pageNum * PAGE_SIZE, 'surge', rankingSeedRef.current);
            break;
          case 'recent': {
            result = await getTrendingSongs(30, PAGE_SIZE, pageNum * PAGE_SIZE, 'recent', rankingSeedRef.current);
            break;
          }
          case 'deep': {
            const searchResult = await searchSongs({
              sort: 'AdditionDate',
              maxResults: PAGE_SIZE,
              start: pageNum * PAGE_SIZE + Math.floor(Math.random() * 100),
              getTotalCount: false,
              onlyWithPVs: true,
            });
            result = searchResult.items;
            break;
          }
          case 'history_based': {
            const recentSong = entries[0]?.song;
            const producers = recentSong?.artists
              ?.filter(artist => artist.categories?.includes('Producer'))
              .map(artist => artist.artist?.id)
              .filter((id): id is number => id !== undefined) ?? [];

            if (producers.length > 0) {
              const searchResult = await searchSongs({
                artistIds: producers,
                sort: 'FavoritedTimes',
                maxResults: PAGE_SIZE,
                start: pageNum * PAGE_SIZE,
                getTotalCount: false,
                onlyWithPVs: true,
              });
              result = searchResult.items;
            }

            if (result.length === 0) {
              result = await getTopSongs(720, PAGE_SIZE);
            }
            break;
          }
          case 'favorite_producers': {
            if (favoriteProducers.length > 0) {
              const producerResults = await Promise.all(favoriteProducers.map(producer =>
                getSongsByProducer([producer.id], 0, 12, pageNum * 12).then(result => result.items).catch(() => [] as Song[]),
              ));
              const seen = new Set<number>();
              result = producerResults.flat().filter(song => {
                if (seen.has(song.id)) return false;
                seen.add(song.id);
                return true;
              }).slice(0, PAGE_SIZE);
            }
            break;
          }
        }
      }

      if (requestId !== requestIdRef.current) return;
      const fetchedCount = result.length;
      if (!query && !artistIdParam && category !== 'recommended') {
        result = rerankDisplayedSongs(result, rankingSeedRef.current);
      }
      if (requiresExternalViewCounts(globalFilterSettings)) {
        result = await attachExternalViews(result);
      }
      result = filterVoiceSynthSongs(result);

      if (pageNum === 0) {
        setSongs(result);
        if (category !== 'recommended') setRecommendationReasons({});
      } else {
        setSongs(prev => {
          const existingIds = new Set(prev.map(song => song.id));
          const newSongs = result.filter(song => !existingIds.has(song.id));
          return [...prev, ...newSongs];
        });
      }
      setHasMore(fetchedCount >= PAGE_SIZE);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      console.error('Failed to fetch songs:', error);
      setHasMore(false);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
      fetchingRef.current = false;
    }
  }, [artistIdParam, entries, favoriteProducers, fetchRecommendedHomeSongs, globalFilterSettings]);

  useEffect(() => {
    setLoading(true);
    setSongs([]);
    setPage(0);
    setHasMore(true);
    autoFillPagesRef.current = 0;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!isSearchMode && !isArtistMode && !hasHydrated && (activeCategory === 'recommended' || activeCategory === 'history_based')) {
      return;
    }

    fetchSongs(activeCategory, 0, searchQuery, requestId);
  }, [activeCategory, searchQuery, artistIdParam, isSearchMode, isArtistMode, hasHydrated, fetchSongs]);

  const loadMore = useCallback(() => {
    if (hasSearched) {
      if (!searchLoading && searchResults.length < totalCount) {
        searchLoadMore();
      }
      return;
    }

    if (loading || !hasMore || fetchingRef.current) return;
    const nextPage = page + 1;
    setPage(nextPage);
    setLoading(true);
    fetchSongs(activeCategory, nextPage, searchQuery, requestIdRef.current);
  }, [
    loading,
    hasMore,
    page,
    activeCategory,
    searchQuery,
    fetchSongs,
    hasSearched,
    searchLoading,
    searchResults.length,
    totalCount,
    searchLoadMore,
  ]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) loadMore();
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const discoveryLastPlayed = new Map(entries.map(entry => [entry.song.id, entry.playedAt] as const));
  const displaySongs = hasSearched
    ? applyGlobalSongFilter(searchResults, globalFilterSettings)
    : applyDiscoveryFilter(songs, {
        settings: globalFilterSettings,
        ratings,
        lastPlayedAtBySongId: discoveryLastPlayed,
      });

  // 足切り後の表示件数が少ない場合は、条件を満たす曲が24件揃うまで追加ページを先読みする。
  // 候補が少ないカテゴリや厳しい再生数条件でも、1ページ目だけで打ち切らない。
  useEffect(() => {
    if (
      hasSearched
      || loading
      || !hasMore
      || fetchingRef.current
      || displaySongs.length >= PAGE_SIZE
      || autoFillPagesRef.current >= 8
    ) return;

    autoFillPagesRef.current += 1;
    loadMore();
  }, [displaySongs.length, hasSearched, loading, hasMore, loadMore]);

  useEffect(() => {
    setVisibleSongs(displaySongs);
  }, [displaySongs, setVisibleSongs]);

  return (
    <div className="w-full px-4 sm:px-6 lg:px-8 py-4">
      {isAdvancedOpen && (
        <div className="mb-6">
          <SearchFilters />
        </div>
      )}

      {(isSearchMode || hasSearched) && !isArtistMode && (
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--color-text-primary)' }}>
              {searchQuery ? `「${searchQuery}」の検索結果` : '検索結果'}
            </h1>
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              {hasSearched ? `${totalCount.toLocaleString()} 件` : `${songs.length} 件`}
            </p>
          </div>
          <button
            className="text-sm px-4 py-2 rounded-lg border transition-colors flex items-center gap-2"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
          >
            詳細検索 {isAdvancedOpen ? '▲' : '▼'}
          </button>
        </div>
      )}

      {isArtistMode && !isSearchMode && !hasSearched && (
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--color-text-primary)' }}>
              {decodeURIComponent(artistNameParam)} の楽曲
            </h1>
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              {songs.length} 件
            </p>
          </div>
        </div>
      )}

      {!isSearchMode && !isArtistMode && !hasSearched && (
        <div className="mb-4 flex items-center justify-end">
          <button
            className="text-sm px-4 py-2 rounded-lg border transition-colors flex items-center gap-2"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
          >
            詳細検索 {isAdvancedOpen ? '▲' : '▼'}
          </button>
        </div>
      )}

      {!isSearchMode && !isArtistMode && !hasSearched && (
        <div
          className="sticky z-20 pb-2 pt-3 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 mb-4"
          style={{ top: 'var(--header-height)', background: 'var(--color-bg-primary)' }}
        >
          <CategoryChips
            chips={CATEGORIES}
            activeChip={activeCategory}
            onSelect={(id) => setActiveCategory(asHomeCategoryId(id))}
          />
        </div>
      )}

      {hasSearched && searchError && (
        <p className="mb-4 text-sm" role="alert" style={{ color: 'var(--color-error)' }}>
          {searchError}
        </p>
      )}

      <VideoGrid
        songs={displaySongs}
        loading={hasSearched ? searchLoading : loading}
        recommendationReasons={!isSearchMode && !isArtistMode && !hasSearched && activeCategory === 'recommended'
          ? recommendationReasons
          : undefined}
        exposureSurface={!isSearchMode && !isArtistMode && !hasSearched
          ? activeCategory === 'recommended' ? 'home-recommended' : 'home-discovery'
          : undefined}
      />

      <div ref={sentinelRef} className="h-8 mt-6 flex items-center justify-center">
        {(hasSearched ? searchLoading : loading) && displaySongs.length > 0 && (
          <div
            className="w-6 h-6 rounded-full border-2 animate-spin"
            style={{ borderColor: 'var(--color-accent-cyan)', borderTopColor: 'transparent' }}
          />
        )}
      </div>
    </div>
  );
}
