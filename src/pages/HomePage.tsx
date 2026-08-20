import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSearchParams } from 'react-router';
import CategoryChips, { type CategoryChip } from '../components/home/CategoryChips';
import VideoGrid from '../components/home/VideoGrid';
import { attachExternalViews, filterDiscoveryEligibleSongs, getAudioSimilarSongs, getRecommendedSongs, getSimilarSongs, getTrendingSongs } from '../api/vocadb';
import { useHistoryStore } from '../stores/historyStore';
import { usePlayerStore } from '../stores/playerStore';
import { useRatingStore } from '../stores/ratingStore';
import { searchSongsBackend, useSearchStore } from '../stores/searchStore';
import { usePlaylistStore } from '../stores/playlistStore';
import { useImplicitFeedbackStore } from '../stores/implicitFeedbackStore';
import { useGlobalFilterStore } from '../stores/globalFilterStore';
import { useUiStore } from '../stores/uiStore';
import type { Song } from '../types/vocadb';
import SearchFilters from '../components/search/SearchFilters';
import SearchSortControls from '../components/search/SearchSortControls';
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
import {
  applyDiscoveryFilter,
  applyDiscoveryFilterWithRelaxation,
  applyGlobalSongFilter,
  getDiscoveryRelaxationMessage,
  isDiscoveryFilterActive,
  isGlobalSongFilterActive,
  requiresExternalViewCounts,
} from '../utils/globalFilters';
import { useFavoriteProducerStore } from '../stores/favoriteProducerStore';
import { performanceNow, recordPerformanceMetric, type PerformanceSegment } from '../utils/performanceMetrics';
import { selectRotatingWindow } from '../utils/pageWindow';
import { interleaveUniqueSongs, selectRecentProducerIds } from '../utils/recentProducers';
import { resolveWithin } from '../utils/timeBudget';
import { isDeterministicHomeRankingCategory } from '../utils/homeRanking';
import { formatTrendingReason } from '../utils/trendingReason';
import { excludeHiddenSongs, useHiddenSongStore } from '../stores/hiddenSongStore';

type HomeCategoryId =
  | 'recommended'
  | 'popular'
  | 'pace'
  | 'trending'
  | 'recent'
  | 'deep'
  | 'history_based'
  | 'favorite_producers';

const CATEGORIES: CategoryChip[] = [
  { id: 'recommended', label: 'あなたへのおすすめ' },
  { id: 'popular', label: '人気の曲' },
  { id: 'pace', label: '再生ペース' },
  { id: 'trending', label: '急上昇' },
  { id: 'recent', label: '新着' },
  { id: 'deep', label: 'マイナー発掘' },
  { id: 'history_based', label: '最近聴いたPの曲' },
  { id: 'favorite_producers', label: 'お気に入りP' },
];

const PAGE_SIZE = 24;
const MAX_FAVORITE_PRODUCER_REQUESTS = 4;
const INITIAL_OPTIONAL_RECOMMENDATION_BUDGET_MS = 2_500;

function asHomeCategoryId(id: string): HomeCategoryId {
  return CATEGORIES.some(category => category.id === id)
    ? (id as HomeCategoryId)
    : 'recommended';
}

export default function HomePage() {
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('q') || '';
  const artistIdParam = searchParams.get('artistId');
  const artistRoleParam = searchParams.get('artistRole');
  const artistNameParam = searchParams.get('artistName') || '';

  const [activeCategory, setActiveCategory] = useState<HomeCategoryId>('recommended');
  const [songs, setSongs] = useState<Song[]>([]);
  const [startupSongs, setStartupSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const advancedSearchOpen = useUiStore(s => s.advancedSearchOpen);
  const setAdvancedSearchOpen = useUiStore(s => s.setAdvancedSearchOpen);
  const [recommendationReasons, setRecommendationReasons] = useState<Record<number, string>>({});

  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchingRef = useRef(false);
  const autoFillPagesRef = useRef(0);
  // Keep paging while the current page is filtered out, but stop if an API
  // fallback starts returning the same page forever.
  const sourceSongIdsRef = useRef<Set<number>>(new Set());
  const requestIdRef = useRef(0);
  const rankingSeedRef = useRef(createRankingSeed());
  const pendingHomePaintRef = useRef<{ startedAt: number; category: HomeCategoryId } | null>(null);
  const pendingSearchPaintRef = useRef<number | null>(null);
  const startupBootstrapStartedRef = useRef(false);
  const firstHomeContentRecordedRef = useRef(false);
  const firstHomePaintRecordedRef = useRef(false);

  const { entries, hasHydrated } = useHistoryStore();
  const { currentSong } = usePlayerStore();
  const { ratings } = useRatingStore();
  const { playlists } = usePlaylistStore();
  const implicitFeedback = useImplicitFeedbackStore(state => state.feedback);
  const favoriteProducers = useFavoriteProducerStore(state => state.producers);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const globalFilterSettings = useGlobalFilterStore(useShallow(state => ({
    enabled: state.enabled,
    minYoutubeViews: state.minYoutubeViews,
    minNicoViews: state.minNicoViews,
    excludedSongTypes: state.excludedSongTypes,
    vocalistFilters: state.vocalistFilters,
    vocalistMatchMode: state.vocalistMatchMode,
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
    searchByArtistId,
  } = useSearchStore();
  const isSearchMode = searchQuery.length > 0;
  const isArtistMode = !!artistIdParam;

  useEffect(() => {
    if (!artistIdParam) return;
    const artistId = Number(artistIdParam);
    if (!Number.isInteger(artistId) || artistId <= 0) return;

    setAdvancedSearchOpen(true);
    searchByArtistId(artistId, decodeURIComponent(artistNameParam), artistRoleParam || undefined);
  }, [artistIdParam, artistNameParam, artistRoleParam, searchByArtistId, setAdvancedSearchOpen]);

  useEffect(() => {
    if (startupBootstrapStartedRef.current
      || activeCategory !== 'recommended'
      || isSearchMode
      || isArtistMode) return;

    startupBootstrapStartedRef.current = true;
    pendingHomePaintRef.current = { startedAt: 0, category: 'recommended' };
    let cancelled = false;

    void searchSongsBackend({
      sort: 'FavoritedTimes',
      sortOrder: 'desc',
      maxResults: 12,
      start: 0,
      discoveryOnly: true,
    }).then(result => {
      if (cancelled) return;
      const initialSongs = filterVoiceSynthSongs(result.items);
      if (initialSongs.length === 0) {
        window.__DIVA_DISMISS_STARTUP_HOME__?.();
        return;
      }

      setStartupSongs(initialSongs);
      setLoading(false);
      if (!firstHomeContentRecordedRef.current) {
        firstHomeContentRecordedRef.current = true;
        recordPerformanceMetric({
          name: 'home.first-content',
          startedAt: 0,
          detail: {
            category: 'recommended',
            displayedCount: initialSongs.length,
            source: 'startup-popular',
          },
        });
      }
    }).catch(() => {
      // The hydrated recommendation request below remains the fallback.
      window.__DIVA_DISMISS_STARTUP_HOME__?.();
    });

    return () => {
      cancelled = true;
    };
  }, [activeCategory, isArtistMode, isSearchMode]);

  useEffect(() => {
    if (activeCategory === 'recommended' && !isSearchMode && !isArtistMode) return;
    setStartupSongs([]);
  }, [activeCategory, isArtistMode, isSearchMode]);

  const fetchRecommendedHomeSongs = useCallback(async (
    pageNum: number,
    onPopularReady?: (songs: Song[]) => void,
  ): Promise<Song[]> => {
    const excludeIds = new Set<number>();
    if (currentSong?.id) excludeIds.add(currentSong.id);

    const localPlaylistSongs = getPlaylistSongs(playlists);
    const eligibleKnownSongs = await filterDiscoveryEligibleSongs(uniqueSongsById([
      ...entries.map(entry => entry.song),
      ...localPlaylistSongs,
    ]));
    const eligibleKnownIds = new Set(eligibleKnownSongs.map(song => song.id));
    const eligibleEntries = entries.filter(entry => eligibleKnownIds.has(entry.song.id));
    const eligiblePlaylists = playlists.map(playlist => ({
      ...playlist,
      songs: playlist.songs.filter(song => eligibleKnownIds.has(song.id)),
    }));
    const playlistSongs = getPlaylistSongs(eligiblePlaylists);
    const playlistSongIds = new Set(playlistSongs.map(song => song.id));
    const rankedKnown = rankKnownSongs(
      eligibleEntries,
      playlistSongs,
      ratings,
      excludeIds,
      implicitFeedback,
    );
    const knownSongs = rankedKnown.map(item => item.song);

    const seedIds = uniqueSongsById([
      ...eligibleEntries.slice(0, 5).map(entry => entry.song),
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
        const inPlaylist = playlistSongIds.has(item.song.id);
        return rating >= 3 || manualCompletes >= 2 || inPlaylist;
      })
      .slice(0, 3)
      .map(item => item.song.id);

    const audioSeedIds = [...new Set([...seedIds, ...preferenceSeedIds])].slice(0, 2);

    const favoriteProducerWindow = selectRotatingWindow(
      favoriteProducers,
      pageNum,
      MAX_FAVORITE_PRODUCER_REQUESTS,
    );
    const optionalSources = Promise.all([
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
      Promise.all(favoriteProducerWindow.map(producer =>
        searchSongsBackend({
          artistIds: [producer.id],
          sort: 'FavoritedTimes',
          sortOrder: 'desc',
          start: pageNum * 12,
          maxResults: 12,
          discoveryOnly: true,
        })
          .then(result => result.items)
          .catch(() => [] as Song[]),
      )),
    ]);
    const popularPromise = searchSongsBackend({
      sort: 'FavoritedTimes',
      sortOrder: 'desc',
      maxResults: 12,
      start: pageNum * 12,
      discoveryOnly: true,
    });
    const optionalPromise = pageNum === 0
      ? resolveWithin(optionalSources, INITIAL_OPTIONAL_RECOMMENDATION_BUDGET_MS, [[], [], [], []] as Song[][][])
      : optionalSources.then(value => ({ value, timedOut: false }));

    // The personalized sources are valuable but can legitimately use their
    // whole 2.5-second budget. Paint the authoritative popular fallback as
    // soon as it arrives, then replace it with the personalized mix below.
    // This keeps first content independent from a cold recommendation path.
    if (pageNum === 0 && onPopularReady) {
      void popularPromise.then(result => {
        const fallback = filterVoiceSynthSongs(result.items);
        if (fallback.length > 0) onPopularReady(fallback);
      }).catch(() => {
        // The final Promise.all below owns the actual error handling path.
      });
    }

    const [popularResult, optionalResult] = await Promise.all([popularPromise, optionalPromise]);
    const [seedResults, preferenceResults, audioResults, favoriteResults] = optionalResult.value;
    const hybridCandidates = uniqueSongsById([
      ...favoriteResults.flat(),
      ...preferenceResults.flat(),
      ...seedResults.flat(),
    ]);
    const audioCandidates = uniqueSongsById(audioResults.flat());
    const eligibleDiscoverySongs = await filterDiscoveryEligibleSongs(uniqueSongsById([
      ...hybridCandidates,
      ...audioCandidates,
    ]));
    const eligibleDiscoveryIds = new Set(eligibleDiscoverySongs.map(song => song.id));

    const knownStart = pageNum * 10;
    const detailed = rerankRecommendationCandidatesDetailed({
      known: knownSongs.slice(knownStart, knownStart + 18),
      hybrid: hybridCandidates.filter(song => eligibleDiscoveryIds.has(song.id)),
      audio: audioCandidates.filter(song => eligibleDiscoveryIds.has(song.id)),
      popular: popularResult.items,
    }, {
      total: PAGE_SIZE,
      historyEntries: eligibleEntries,
      playlists: eligiblePlaylists,
      ratings,
      implicitFeedback,
      excludeIds,
      rankingSeed: rankingSeedRef.current,
      explorationStrength: 0.055,
      exposureEntries: useRecommendationExposureStore.getState().entries,
      favoriteProducerIds: new Set(favoriteProducers.map(producer => producer.id)),
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
    if (optionalResult.timedOut) {
      recordPerformanceMetric({
        name: 'home.optional-budget',
        startedAt: performanceNow() - INITIAL_OPTIONAL_RECOMMENDATION_BUDGET_MS,
        detail: { page: pageNum, timedOut: true },
      });
    }
    return result.length > 0 ? result : popularResult.items;
  }, [currentSong, entries, favoriteProducers, playlists, ratings, implicitFeedback]);

  const fetchSongs = useCallback(async (
    category: HomeCategoryId,
    pageNum: number,
    query: string,
    requestId: number,
  ) => {
    if (pageNum > 0 && fetchingRef.current) return;
    fetchingRef.current = true;
    const startedAt = performanceNow();
    const segments: PerformanceSegment[] = [];
    if (pageNum === 0 && !firstHomePaintRecordedRef.current) {
      pendingHomePaintRef.current ??= { startedAt, category };
    }

    try {
      let result: Song[] = [];
      const sourceStartedAt = performanceNow();

      if (artistIdParam) {
        const searchResult = await searchSongsBackend({
          artistIds: [Number(artistIdParam)],
          artistRole: artistRoleParam || undefined,
          sort: 'FavoritedTimes',
          sortOrder: 'desc',
          maxResults: PAGE_SIZE,
          start: pageNum * PAGE_SIZE,
        });
        result = searchResult.items;
      } else if (query) {
        const searchResult = await searchSongsBackend({
          query,
          sort: 'FavoritedTimes',
          sortOrder: 'desc',
          maxResults: PAGE_SIZE,
          start: pageNum * PAGE_SIZE,
        });
        result = searchResult.items;
      } else {
        switch (category) {
          case 'popular': {
            result = await getTrendingSongs(30, PAGE_SIZE, pageNum * PAGE_SIZE, 'alltime', 0, globalFilterSettings);
            break;
          }
          case 'pace': {
            result = await getTrendingSongs(30, PAGE_SIZE, pageNum * PAGE_SIZE, 'pace', 0, globalFilterSettings);
            break;
          }
          case 'recommended':
            result = await fetchRecommendedHomeSongs(pageNum, pageNum === 0 ? interimSongs => {
              if (requestId !== requestIdRef.current) return;
              setSongs(interimSongs);
              setRecommendationReasons({});
              setLoading(false);
              if (!firstHomeContentRecordedRef.current) {
                firstHomeContentRecordedRef.current = true;
                recordPerformanceMetric({
                  name: 'home.first-content',
                  startedAt,
                  segments: [{ name: 'source', durationMs: performanceNow() - sourceStartedAt }],
                  detail: { category, displayedCount: interimSongs.length, source: 'hydrated-popular' },
                });
              }
            } : undefined);
            break;
          case 'trending':
            result = await getTrendingSongs(7, PAGE_SIZE, pageNum * PAGE_SIZE, 'surge', 0, globalFilterSettings);
            break;
          case 'recent': {
            result = await getTrendingSongs(30, PAGE_SIZE, pageNum * PAGE_SIZE, 'recent', 0, globalFilterSettings);
            break;
          }
          case 'deep': {
            result = await getTrendingSongs(30, PAGE_SIZE, pageNum * PAGE_SIZE, 'deep', rankingSeedRef.current, globalFilterSettings);
            break;
          }
          case 'history_based': {
            const producers = selectRecentProducerIds(entries);
            const recentSongIds = new Set(entries.slice(0, 50).map(entry => entry.song.id));

            if (producers.length > 0) {
              const producerWindow = selectRotatingWindow(producers, pageNum, 4);
              const producerResults = await Promise.all(producerWindow.map(producerId =>
                searchSongsBackend({
                  anyArtistIds: [producerId],
                  sort: 'FavoritedTimes',
                  sortOrder: 'desc',
                  maxResults: 12,
                  start: pageNum * 12,
                  discoveryOnly: true,
                }).then(searchResult => searchResult.items).catch(() => [] as Song[]),
              ));
              result = interleaveUniqueSongs(producerResults, recentSongIds, PAGE_SIZE);
            }

            if (result.length === 0) {
              const fallback = await searchSongsBackend({
                sort: 'FavoritedTimes',
                sortOrder: 'desc',
                maxResults: PAGE_SIZE,
                start: pageNum * PAGE_SIZE,
                discoveryOnly: true,
              });
              result = fallback.items;
            }
            break;
          }
          case 'favorite_producers': {
            if (favoriteProducers.length > 0) {
              const favoriteProducerWindow = selectRotatingWindow(
                favoriteProducers,
                pageNum,
                MAX_FAVORITE_PRODUCER_REQUESTS,
              );
              const producerResults = await Promise.all(favoriteProducerWindow.map(producer =>
                searchSongsBackend({
                  artistIds: [producer.id],
                  sort: 'FavoritedTimes',
                  sortOrder: 'desc',
                  start: pageNum * 12,
                  maxResults: 12,
                  discoveryOnly: true,
                }).then(result => result.items).catch(() => [] as Song[]),
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
      segments.push({ name: 'source', durationMs: performanceNow() - sourceStartedAt });

      if (requestId !== requestIdRef.current) {
        recordPerformanceMetric({
          name: 'home.load',
          startedAt,
          segments,
          detail: { category, page: pageNum, stale: true },
        });
        return;
      }
      const fetchedCount = result.length;
      const sourceIds = result.map(song => song.id);
      const newSourceCount = sourceIds.filter(id => !sourceSongIdsRef.current.has(id)).length;
      sourceIds.forEach(id => sourceSongIdsRef.current.add(id));
      if (!query && !artistIdParam && category !== 'recommended' && !isDeterministicHomeRankingCategory(category)) {
        result = rerankDisplayedSongs(result, rankingSeedRef.current);
      }
      if (requiresExternalViewCounts(globalFilterSettings)) {
        const externalViewsStartedAt = performanceNow();
        result = await attachExternalViews(result);
        segments.push({ name: 'externalViews', durationMs: performanceNow() - externalViewsStartedAt });
      }
      const filterStartedAt = performanceNow();
      result = filterVoiceSynthSongs(result);
      segments.push({ name: 'voiceFilter', durationMs: performanceNow() - filterStartedAt });

      const trendingReasons = category === 'trending'
        ? result.reduce<Record<number, string>>((reasons, song) => {
            const reason = formatTrendingReason(song);
            if (reason) reasons[song.id] = reason;
            return reasons;
          }, {})
        : {};

      if (pageNum === 0) {
        setSongs(result);
        if (category === 'trending') setRecommendationReasons(trendingReasons);
        else if (category !== 'recommended') setRecommendationReasons({});
      } else {
        setSongs(prev => {
          const existingIds = new Set(prev.map(song => song.id));
          const newSongs = result.filter(song => !existingIds.has(song.id));
          return [...prev, ...newSongs];
        });
        if (category === 'trending') {
          setRecommendationReasons(previous => ({ ...previous, ...trendingReasons }));
        }
      }
      // A filtered page may contain no visible songs even though the source
      // still has more candidates. Continue until the source is exhausted or
      // a broken fallback repeats the same page.
      setHasMore(fetchedCount >= PAGE_SIZE && (pageNum === 0 || newSourceCount > 0));
      recordPerformanceMetric({
        name: 'home.load',
        startedAt,
        segments,
        detail: {
          category,
          page: pageNum,
          fetchedCount,
          displayedCount: result.length,
          favoriteProducerRequests: Math.min(favoriteProducers.length, MAX_FAVORITE_PRODUCER_REQUESTS),
        },
      });
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
  }, [artistIdParam, artistRoleParam, entries, favoriteProducers, fetchRecommendedHomeSongs, globalFilterSettings]);

  useEffect(() => {
    setLoading(true);
    setSongs([]);
    setPage(0);
    setHasMore(true);
    autoFillPagesRef.current = 0;
    sourceSongIdsRef.current.clear();

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (isArtistMode) {
      setLoading(false);
      return;
    }

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

  const discoveryLastPlayed = useMemo(
    () => new Map(entries.map(entry => [entry.song.id, entry.playedAt] as const)),
    [entries],
  );
  const discoveryContext = useMemo(() => ({
    settings: globalFilterSettings,
    ratings,
    lastPlayedAtBySongId: discoveryLastPlayed,
  }), [discoveryLastPlayed, globalFilterSettings, ratings]);
  const homeSongs = songs.length > 0 ? songs : startupSongs;
  const unhiddenSongs = useMemo(() => excludeHiddenSongs(homeSongs, hiddenSongs), [hiddenSongs, homeSongs]);
  const unhiddenSearchResults = useMemo(
    () => excludeHiddenSongs(searchResults, hiddenSongs),
    [hiddenSongs, searchResults],
  );
  const strictDiscoverySongs = useMemo(
    () => applyDiscoveryFilter(unhiddenSongs, discoveryContext),
    [discoveryContext, unhiddenSongs],
  );
  const shouldRelaxDiscovery = !hasSearched
    && !loading
    && strictDiscoverySongs.length < PAGE_SIZE
    && !hasMore;
  const discoveryResult = useMemo(
    () => shouldRelaxDiscovery
      ? applyDiscoveryFilterWithRelaxation(unhiddenSongs, discoveryContext, PAGE_SIZE)
      : { items: strictDiscoverySongs, relaxedConditions: [] },
    [discoveryContext, shouldRelaxDiscovery, strictDiscoverySongs, unhiddenSongs],
  );
  const displaySongs = useMemo(
    () => hasSearched
      ? applyGlobalSongFilter(unhiddenSearchResults, globalFilterSettings)
      : discoveryResult.items,
    [discoveryResult.items, globalFilterSettings, hasSearched, unhiddenSearchResults],
  );
  const relaxationMessage = hasSearched
    ? null
    : getDiscoveryRelaxationMessage(discoveryResult.relaxedConditions);

  useEffect(() => {
    if (searchLoading) {
      pendingSearchPaintRef.current ??= performanceNow();
      return;
    }
    if (!hasSearched || pendingSearchPaintRef.current === null || typeof requestAnimationFrame === 'undefined') return;

    const startedAt = pendingSearchPaintRef.current;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (pendingSearchPaintRef.current !== startedAt) return;
        pendingSearchPaintRef.current = null;
        recordPerformanceMetric({
          name: 'search.paint',
          startedAt,
          detail: { displayedCount: displaySongs.length },
        });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [displaySongs.length, hasSearched, searchLoading]);

  useEffect(() => {
    const pending = pendingHomePaintRef.current;
    if (loading || hasSearched || !pending || typeof requestAnimationFrame === 'undefined') return;

    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (pendingHomePaintRef.current !== pending) return;
        pendingHomePaintRef.current = null;
        firstHomePaintRecordedRef.current = true;
        window.__DIVA_DISMISS_STARTUP_HOME__?.();
        recordPerformanceMetric({
          name: 'home.paint',
          startedAt: pending.startedAt,
          detail: { category: pending.category, displayedCount: displaySongs.length },
        });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [displaySongs.length, hasSearched, loading]);

  // 足切り後の表示件数が少ない場合は、条件を満たす曲が24件揃うまで追加ページを先読みする。
  // 候補が少ないカテゴリや厳しい再生数条件でも、1ページ目だけで打ち切らない。
  useEffect(() => {
    if (
      hasSearched
      || loading
      || !hasMore
      || fetchingRef.current
      || strictDiscoverySongs.length >= PAGE_SIZE
    ) return;

    autoFillPagesRef.current += 1;
    loadMore();
  }, [strictDiscoverySongs.length, hasSearched, loading, hasMore, loadMore]);

  return (
    <div className="w-full px-4 sm:px-6 lg:px-8 py-4">
      {(advancedSearchOpen || isSearchMode || isArtistMode || hasSearched) && (
        <div className="mb-3 flex justify-end">
          <SearchSortControls />
        </div>
      )}
      {advancedSearchOpen && (
        <div className="mb-6">
          <SearchFilters />
        </div>
      )}

      {(isSearchMode || hasSearched) && !isArtistMode && (
        <div className="mb-6">
          <div>
            <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--color-text-primary)' }}>
              {searchQuery ? `「${searchQuery}」の検索結果` : '検索結果'}
            </h1>
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              {hasSearched
                ? searchLoading ? '検索中…' : `${totalCount.toLocaleString()} 件`
                : `${songs.length} 件`}
            </p>
          </div>
        </div>
      )}

      {isArtistMode && !isSearchMode && (
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--color-text-primary)' }}>
              {decodeURIComponent(artistNameParam)}{artistRoleParam ? ` (${artistRoleParam})` : ''} の楽曲
            </h1>
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              {searchLoading ? '検索中…' : `${totalCount.toLocaleString()} 件`}
            </p>
          </div>
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
            onSelect={(id) => {
              const nextCategory = asHomeCategoryId(id);
              if (nextCategory === activeCategory) return;
              firstHomePaintRecordedRef.current = false;
              pendingHomePaintRef.current = null;
              setStartupSongs([]);
              setActiveCategory(nextCategory);
            }}
          />
        </div>
      )}

      {!isSearchMode && !isArtistMode && !hasSearched && activeCategory === 'trending' && (
        <p className="mb-4 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          直近約7日間の再生増加が平常時より加速している曲。強い加速を優先し、相対的な伸びと楽曲情報の信頼性も加味します。
        </p>
      )}

      {hasSearched && searchError && (
        <p className="mb-4 text-sm" role="alert" style={{ color: 'var(--color-error)' }}>
          {searchError}
        </p>
      )}

      {relaxationMessage && (
        <p
          className="mb-4 rounded-lg border px-3 py-2 text-sm"
          role="status"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)', background: 'var(--color-surface)' }}
        >
          {relaxationMessage}
        </p>
      )}

      <VideoGrid
        songs={displaySongs}
        loading={hasSearched ? searchLoading : loading}
        emptyMessage={(hasSearched
          ? isGlobalSongFilterActive(globalFilterSettings)
          : isDiscoveryFilterActive(globalFilterSettings))
          ? '現在の表示フィルターに一致する曲がありません。設定の「表示・発見」で条件を調整してください。'
          : undefined}
        recommendationReasons={!isSearchMode && !isArtistMode && !hasSearched && (activeCategory === 'recommended' || activeCategory === 'trending')
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
