import { lazy, Suspense, useState, useEffect, useEffectEvent, useCallback, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLocation, useNavigationType, useSearchParams } from 'react-router';
import CategoryChips, { type CategoryChip } from '../components/home/CategoryChips';
import VideoGrid from '../components/home/VideoGrid';
import SearchResults, { type UrlArtist } from '../components/search/SearchResults';
import { attachExternalViews, filterDiscoveryEligibleSongs, getAudioSimilarSongs, getRecommendedSongs, getTrendingSongs } from '../api/vocadb';
import { useHistoryStore } from '../stores/historyStore';
import { usePlayerStore } from '../stores/playerStore';
import { useRatingStore } from '../stores/ratingStore';
import { artistSearchKey, searchSongsBackend, textSearchKey, useSearchStore } from '../stores/searchStore';
import { usePlaylistStore } from '../stores/playlistStore';
import { useImplicitFeedbackStore } from '../stores/implicitFeedbackStore';
import { useGlobalFilterStore } from '../stores/globalFilterStore';
import { useUiStore } from '../stores/uiStore';
import type { Song } from '../types/vocadb';
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
  getDiscoveryRelaxationMessage,
  getDiscoveryRelaxationShortLabel,
  isDiscoveryFilterActive,
  requiresExternalViewCounts,
} from '../utils/globalFilters';
import { useFavoriteProducerStore } from '../stores/favoriteProducerStore';
import { performanceNow, recordPerformanceMetric, type PerformanceSegment } from '../utils/performanceMetrics';
import { selectRotatingWindow } from '../utils/pageWindow';
import { interleaveUniqueSongs, selectRecentProducerIds } from '../utils/recentProducers';
import { isDeterministicHomeRankingCategory } from '../utils/homeRanking';
import { formatTrendingReason } from '../utils/trendingReason';
import { formatWeeklyRankingReason } from '../utils/weeklyRankingReason';
import { excludeHiddenSongs, useHiddenSongStore } from '../stores/hiddenSongStore';
import { selectRotatingStartupSongs } from '../utils/startupRecommendations';
import { getProgressiveWindow } from '../utils/progressiveWindow';
import { homeRecommendationPools } from '../utils/homeRecommendationPools';
import { isSearchType, type SearchType } from '../utils/routes';
import { useTranslate, useTranslateSourceText, type TranslationKey } from '../i18n';
import { useLanguageStore } from '../stores/languageStore';
import {
  loadRecentPlayedAtBySongId,
  loadStartupRecommendationSnapshot,
  saveStartupRecommendationSnapshot,
  type StartupRecommendationSnapshot,
} from '../services/historyDatabase';
import {
  clearHomeFeedSnapshot,
  getHomeFeedSnapshot,
  saveHomeFeedSnapshot,
  updateHomeFeedSnapshotScroll,
} from '../utils/homeFeedSnapshot';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import { InfoTip } from '../components/ui/InfoTip';
import { InlineNotice } from '../components/ui/InlineNotice';
import { ErrorIcon, MusicNoteIcon, PersonStarIcon, SpinnerIcon } from '../components/ui/icons';

// The advanced search dialog is only needed after the user opens it.
const SearchFilters = lazy(() => import('../components/search/SearchFilters'));

type HomeCategoryId =
  | 'recommended'
  | 'ranking'
  | 'popular'
  | 'pace'
  | 'trending'
  | 'recent'
  | 'deep'
  | 'history_based'
  | 'favorite_producers';

type PrefetchableHomeCategoryId = Exclude<HomeCategoryId, 'recommended'>;

const CATEGORIES: CategoryChip[] = [
  { id: 'recommended', label: 'おすすめ' },
  { id: 'ranking', label: 'ランキング' },
  { id: 'popular', label: '人気' },
  { id: 'pace', label: '伸びている曲' },
  { id: 'trending', label: '急上昇' },
  { id: 'recent', label: '新着' },
  { id: 'deep', label: '隠れた名曲' },
  { id: 'history_based', label: '最近聴いたP' },
  { id: 'favorite_producers', label: 'お気に入りP' },
];

const CATEGORY_LABELS: Record<HomeCategoryId, TranslationKey> = {
  recommended: 'categoryRecommended',
  ranking: 'categoryRanking',
  popular: 'categoryPopular',
  pace: 'categoryPace',
  trending: 'categoryTrending',
  recent: 'categoryRecent',
  deep: 'categoryDeep',
  history_based: 'categoryHistoryBased',
  favorite_producers: 'categoryFavoriteProducers',
};

/** Feeds shown as rankings: their thumbnails carry the position. */
const RANKED_CATEGORIES = new Set<HomeCategoryId>(['ranking', 'popular', 'pace', 'trending']);

const PAGE_SIZE = 24;
// The first page fills about two screens of tiles; public/startup.js requests the same first page.
const FIRST_HOME_PAGE_SIZE = 24;
const APPEND_HOME_PAGE_SIZE = 36;
/**
 * Below this many songs after the filters, the feed relaxes them (once the source is exhausted) and
 * leaves loading more to the bounded auto-fill instead of infinite scroll. Independent of the page size.
 */
const DISCOVERY_MIN_COUNT = 12;
/** The next page starts loading this far before the end of the feed comes into view. */
const PREFETCH_MARGIN_PX = 1200;
const STARTUP_POOL_SIZE = PAGE_SIZE * 2;
const STARTUP_ROTATION_KEY = 'diva-startup-rotation-v1';
const MAX_FAVORITE_PRODUCER_REQUESTS = 4;
const MAX_AUTOFILL_PAGES = 2;
const HOME_CATEGORY_PREFETCH_DELAY_MS = 500;
/** history.state marker of the entry an advanced-only search (no `q`) was applied in. */
const ADVANCED_SEARCH_ENTRY_STATE = 'divaAdvancedSearch';

function asHomeCategoryId(id: string): HomeCategoryId {
  return CATEGORIES.some(category => category.id === id)
    ? (id as HomeCategoryId)
    : 'recommended';
}

function persistStartupRecommendations(songs: Song[]): void {
  const snapshot: StartupRecommendationSnapshot = {
    version: 3,
    savedAt: Date.now(),
    songs: songs.slice(0, STARTUP_POOL_SIZE),
  };
  void saveStartupRecommendationSnapshot(snapshot).catch(() => {
    // Private browsing retains the normal fresh recommendation path.
  });
}

function nextStartupRotation(): number {
  try {
    // The freshly generated cache is already shown in its base order before
    // the first reload, so an unset counter starts from the next rotation.
    const stored = Number.parseInt(sessionStorage.getItem(STARTUP_ROTATION_KEY) || '1', 10);
    const rotation = Number.isFinite(stored) && stored >= 0 ? stored : 1;
    sessionStorage.setItem(STARTUP_ROTATION_KEY, String(rotation + 1));
    return rotation;
  } catch {
    return Date.now();
  }
}

function isAdvancedSearchEntry(state: unknown): boolean {
  return Boolean(state && typeof state === 'object' && (state as Record<string, unknown>)[ADVANCED_SEARCH_ENTRY_STATE]);
}

/**
 * True while the browser's current history entry is still the one with this router key. A
 * navigation changes the entry (pushState / popstate) before the old page unmounts.
 */
function isCurrentHistoryEntry(locationKey: string): boolean {
  const state: unknown = window.history.state;
  const key = state && typeof state === 'object' ? (state as Record<string, unknown>).key : undefined;
  // The router calls the first entry of a tab 'default' (its history.state has no key).
  return (typeof key === 'string' && key ? key : 'default') === locationKey;
}

function parseUrlArtist(idParam: string | null, nameParam: string | null, roleParam: string | null): UrlArtist | null {
  if (!idParam || !/^\d+$/.test(idParam)) return null;
  const id = Number(idParam);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { id, name: nameParam ?? '', role: roleParam || undefined };
}

/**
 * `/` is the home feed, `/?q=…&type=…` the search results and `/?artistId=…` an artist's songs.
 * The URL is the source of truth: this page keeps the search store in sync with it, so Back,
 * reload and shared links always show the same screen.
 */
export default function HomePage() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [searchParams] = useSearchParams();
  const urlQuery = (searchParams.get('q') ?? '').trim();
  const typeParam = searchParams.get('type');
  const urlType: SearchType = isSearchType(typeParam) ? typeParam : 'all';
  const artistIdParam = searchParams.get('artistId');
  const artistNameParam = searchParams.get('artistName');
  const artistRoleParam = searchParams.get('artistRole');
  const urlArtist = useMemo(
    () => (urlQuery ? null : parseUrlArtist(artistIdParam, artistNameParam, artistRoleParam)),
    [artistIdParam, artistNameParam, artistRoleParam, urlQuery],
  );
  const urlKey = urlQuery
    ? textSearchKey(urlQuery, urlType)
    : urlArtist ? artistSearchKey(urlArtist.id, urlArtist.role) : null;
  const { hasSearched, searchOrigin, storeUrlKey } = useSearchStore(useShallow(state => ({
    hasSearched: state.hasSearched,
    searchOrigin: state.searchOrigin,
    storeUrlKey: state.urlSearchKey,
  })));
  const advancedSearchOpen = useUiStore(state => state.advancedSearchOpen);
  const advancedEntry = isAdvancedSearchEntry(location.state);

  const runUrlSearch = useCallback(() => {
    const store = useSearchStore.getState();
    if (urlQuery) void store.searchWithMode(urlQuery, urlType, location.key);
    else if (urlArtist) void store.searchArtistFromUrl(urlArtist.id, urlArtist.name, urlArtist.role, location.key);
    else void store.search();
  }, [location.key, urlArtist, urlQuery, urlType]);

  useEffect(() => {
    const store = useSearchStore.getState();
    if (urlKey) {
      // A new submit of the same URL (a new history entry) searches again; Back to it does not.
      const resubmitted = navigationType === 'PUSH' && store.urlSearchLocationKey !== location.key;
      if (store.urlSearchKey !== urlKey || !store.hasSearched || resubmitted) runUrlSearch();
      return;
    }
    if (!store.hasSearched) return;
    // Leaving a URL search (Back, the logo, the guide's ホーム) always returns to the feed.
    if (store.searchOrigin === 'url' || (store.searchOrigin === 'advanced' && !advancedEntry)) store.reset();
  }, [advancedEntry, location.key, navigationType, runUrlSearch, urlKey]);

  // The dialog belongs to the home page: close it when another page is opened (not on StrictMode's re-mount).
  useEffect(() => () => {
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '');
    if (window.location.pathname.replace(/\/+$/, '') !== base) useUiStore.getState().setAdvancedSearchOpen(false);
  }, []);

  const showResults = Boolean(urlKey)
    || (hasSearched && (searchOrigin === 'direct' || (searchOrigin === 'advanced' && advancedEntry)));

  return (
    <>
      {showResults ? (
        <SearchResults
          urlQuery={urlQuery}
          urlType={urlType}
          urlArtist={urlArtist}
          pending={Boolean(urlKey) && storeUrlKey !== urlKey}
          onRetry={runUrlSearch}
        />
      ) : (
        <HomeFeed />
      )}
      {advancedSearchOpen && (
        <Suspense fallback={null}>
          <SearchFilters advancedEntryState={ADVANCED_SEARCH_ENTRY_STATE} />
        </Suspense>
      )}
    </>
  );
}

function HomeFeed() {
  const t = useTranslate();
  const ts = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const location = useLocation();
  const navigationType = useNavigationType();
  const openSettings = useUiStore(state => state.openSettings);
  const [restoredHomeFeed] = useState(() => {
    if (navigationType !== 'POP') return undefined;
    return getHomeFeedSnapshot(location.key);
  });

  const [activeCategory, setActiveCategory] = useState<HomeCategoryId>('recommended');
  const [songs, setSongs] = useState<Song[]>(() => restoredHomeFeed?.songs ?? []);
  const [startupSongs, setStartupSongs] = useState<Song[]>(() => restoredHomeFeed?.startupSongs ?? []);
  const [loading, setLoading] = useState(() => restoredHomeFeed?.initialLoadPending ?? true);
  const [page, setPage] = useState(() => restoredHomeFeed?.page ?? 0);
  const [hasMore, setHasMore] = useState(() => restoredHomeFeed?.hasMore ?? true);
  const [recommendationReasons, setRecommendationReasons] = useState<Record<number, string>>(
    () => restoredHomeFeed?.recommendationReasons ?? {},
  );
  // A failed request: 'first' = the first page (nothing to show), 'more' = a later page.
  const [loadError, setLoadError] = useState<'first' | 'more' | null>(null);
  // Bumped by 再試行 to rebuild the feed from its first page.
  const [feedReload, setFeedReload] = useState(0);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchingRef = useRef(false);
  const autoFillPagesRef = useRef(0);
  // Keep paging while the current page is filtered out, but stop if an API
  // fallback starts returning the same page forever.
  const sourceSongIdsRef = useRef<Set<number>>(new Set(restoredHomeFeed?.songs.map(song => song.id) ?? []));
  const requestIdRef = useRef(0);
  const rankingSeedRef = useRef(createRankingSeed());
  const pendingHomePaintRef = useRef<{ startedAt: number; category: HomeCategoryId } | null>(
    restoredHomeFeed ? null : { startedAt: 0, category: 'recommended' },
  );
  const startupCacheStartedRef = useRef(Boolean(restoredHomeFeed));
  const firstHomeContentRecordedRef = useRef(Boolean(restoredHomeFeed));
  const firstHomePaintRecordedRef = useRef(Boolean(restoredHomeFeed));
  const persistedStartupSignatureRef = useRef('');
  const homeSourcePromisesRef = useRef<Map<string, Promise<Song[]>>>(new Map());
  const restoredRecommendedEntryRef = useRef(Boolean(restoredHomeFeed));
  const suppressStaleHomeFeedCacheRef = useRef(Boolean(restoredHomeFeed?.initialLoadPending));
  const restoredScrollYRef = useRef<number | null>(restoredHomeFeed?.scrollY ?? null);
  // The last scroll position recorded while this entry was the current one (see recordScrollPosition).
  const lastScrollYRef = useRef(restoredHomeFeed?.scrollY ?? window.scrollY);

  const { entries, hasHydrated, lastPlayedAtBySongId } = useHistoryStore();
  const currentSong = usePlayerStore(state => state.currentSong);
  const ratings = useRatingStore(state => state.ratings);
  const playlists = usePlaylistStore(state => state.playlists);
  const playlistsHydrated = usePlaylistStore(state => state.hasHydrated);
  const implicitFeedback = useImplicitFeedbackStore(state => state.feedback);
  const favoriteProducers = useFavoriteProducerStore(state => state.producers);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
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
  const isRecommendedHomeView = activeCategory === 'recommended';
  const recentProducerIds = useMemo(() => selectRecentProducerIds(entries), [entries]);
  const homeSourceContextKey = useMemo(() => JSON.stringify({
    filters: globalFilterSettings,
    favoriteProducerIds: favoriteProducers.map(producer => producer.id),
    recentProducerIds,
    recentSongIds: entries.slice(0, 50).map(entry => entry.song.id),
    rankingSeed: rankingSeedRef.current,
  }), [entries, favoriteProducers, globalFilterSettings, recentProducerIds]);
  // What the shown feed depends on: changing it rebuilds the feed. Playlists, ratings, the playing
  // song and the history only shape the next request (saving or rating a tile keeps the feed as it is).
  const homeFeedContextKey = useMemo(() => JSON.stringify({
    language,
    filters: globalFilterSettings,
    favoriteProducerIds: favoriteProducers.map(producer => producer.id),
  }), [favoriteProducers, globalFilterSettings, language]);

  useEffect(() => {
    if (startupCacheStartedRef.current || activeCategory !== 'recommended') return;

    startupCacheStartedRef.current = true;
    let cancelled = false;

    void (async () => {
      const snapshot = await loadStartupRecommendationSnapshot();
      if (!snapshot || cancelled) return;
      const cooldownMs = globalFilterSettings.cooldownHours * 60 * 60 * 1000;
      const lastPlayedAtBySongId = cooldownMs > 0
        ? await loadRecentPlayedAtBySongId(snapshot.songs.map(song => song.id), Date.now() - cooldownMs)
        : new Map<number, number>();
      if (cancelled) return;
      const cachedSongs = applyDiscoveryFilter(
        excludeHiddenSongs(filterVoiceSynthSongs(snapshot.songs), hiddenSongs),
        { settings: globalFilterSettings, ratings, lastPlayedAtBySongId },
      );
      // A late IndexedDB/history read must not prepend an old cache after a
      // fresh grid has already arrived and move the user's visible choices.
      if (cachedSongs.length === 0 || sourceSongIdsRef.current.size > 0) return;

      const rotation = nextStartupRotation();
      const selectedSongs = selectRotatingStartupSongs(cachedSongs, rotation, FIRST_HOME_PAGE_SIZE);
      setStartupSongs(selectedSongs);
      setLoading(false);
      if (!firstHomeContentRecordedRef.current) {
        firstHomeContentRecordedRef.current = true;
        recordPerformanceMetric({
          name: 'home.first-content',
          startedAt: 0,
          detail: {
            category: 'recommended',
            displayedCount: selectedSongs.length,
            poolCount: cachedSongs.length,
            rotation,
            source: 'personalized-cache',
          },
        });
      }
    })().catch(() => {
      // If either cache or cooldown history cannot be read safely, retain the
      // normal in-layout skeleton until a fresh personalized mix is ready.
    });

    return () => {
      cancelled = true;
    };
  }, [activeCategory, globalFilterSettings, hiddenSongs, ratings]);

  useEffect(() => {
    if (activeCategory === 'recommended') return;
    setStartupSongs([]);
  }, [activeCategory]);

  const fetchRecommendedHomeSongs = useCallback(async (pageNum: number) => {
    const { start, count } = getProgressiveWindow(pageNum, FIRST_HOME_PAGE_SIZE, APPEND_HOME_PAGE_SIZE);
    const excludeIds = new Set<number>();
    if (currentSong?.id) excludeIds.add(currentSong.id);
    sourceSongIdsRef.current.forEach(id => excludeIds.add(id));

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
      new Set(currentSong ? [currentSong.id] : []),
      implicitFeedback,
    );
    const knownSongs = rankedKnown.map(item => item.song).filter(song => !excludeIds.has(song.id));

    const seedIds = uniqueSongsById([
      ...eligibleEntries.slice(0, 5).map(entry => entry.song),
      ...(currentSong ? [currentSong] : []),
    ])
      .filter(song => song.id !== currentSong?.id)
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

    const discoverySeedIds = [...new Set([...preferenceSeedIds, ...seedIds])].slice(0, 2);
    const audioSeedIds = discoverySeedIds.slice(0, 1);

    const favoriteProducerWindow = selectRotatingWindow(
      favoriteProducers,
      pageNum,
      2,
    );
    // Use personal discovery on the first page as well. Each source advances
    // by the same window it actually requests, rather than skipping 24/36 hits
    // after fetching only eight.
    const optionalSources = Promise.all([
          Promise.all(discoverySeedIds.map(seedId =>
            getRecommendedSongs(seedId, count, 0.0, ratings, start)
              .catch(() => [] as Song[])
          )),
          Promise.all(audioSeedIds.map(seedId =>
            getAudioSimilarSongs(seedId, count, start)
              .catch(() => [] as Song[])
          )),
          Promise.all(favoriteProducerWindow.map(producer =>
            searchSongsBackend({
              artistIds: [producer.id],
              sort: 'FavoritedTimes',
              sortOrder: 'desc',
              start,
              maxResults: count,
              discoveryOnly: true,
              compactCards: true,
            })
              .then(result => result.items)
              .catch(() => [] as Song[]),
          )),
        ]);
    const popularPromise = searchSongsBackend({
      sort: 'FavoritedTimes',
      sortOrder: 'desc',
      maxResults: count,
      start,
      discoveryOnly: true,
      compactCards: true,
    });
    const [popularOutcome, optionalResults] = await Promise.all([
      popularPromise.then(result => ({ result, error: null as unknown }), error => ({ result: null, error })),
      optionalSources,
    ]);
    const popularSongs = popularOutcome.result?.items ?? [];
    const [seedResults, audioResults, favoriteResults] = optionalResults;
    const hybridCandidates = uniqueSongsById([
      ...favoriteResults.flat(),
      ...seedResults.flat(),
    ]);
    const audioCandidates = uniqueSongsById(audioResults.flat());
    const eligibleDiscoverySongs = await filterDiscoveryEligibleSongs(uniqueSongsById([
      ...hybridCandidates,
      ...audioCandidates,
    ]));
    const eligibleDiscoveryIds = new Set(eligibleDiscoverySongs.map(song => song.id));

    if (popularOutcome.error && eligibleDiscoverySongs.length === 0) throw popularOutcome.error;
    // Ratings are seeds and supporting evidence, not an entire page of saved
    // five-star songs. Keep room for unheard candidates throughout the feed.
    const knownIds = new Set([
      ...entries.map(entry => entry.song.id), ...playlistSongIds,
      ...Object.keys(ratings).map(Number), ...Object.keys(implicitFeedback).map(Number),
    ]);
    const detailed = rerankRecommendationCandidatesDetailed(homeRecommendationPools(
      knownSongs,
      hybridCandidates.filter(song => eligibleDiscoveryIds.has(song.id)),
      audioCandidates.filter(song => eligibleDiscoveryIds.has(song.id)),
      popularSongs, knownIds, count,
    ), {
      total: count,
      historyEntries: eligibleEntries,
      playlists: eligiblePlaylists,
      ratings,
      implicitFeedback,
      excludeIds,
      rankingSeed: rankingSeedRef.current,
      explorationStrength: 0.055,
      exposureEntries: useRecommendationExposureStore.getState().entries,
      favoriteProducerIds: new Set(favoriteProducers.map(producer => producer.id)),
      recentSongs: songs.slice(-12),
    });
    const mixed = detailed.ranked;
    const result = mixed.map(item => item.song);
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
    return {
      items: result,
      reasons: Object.fromEntries(mixed.map(item => [item.song.id, item.reason])),
      hasMore: popularSongs.length >= count
        || optionalResults.some(results => results.some(items => items.length >= count))
        || knownSongs.length > Math.max(1, Math.floor(count / 2)),
    };
  }, [currentSong, entries, favoriteProducers, playlists, ratings, implicitFeedback, songs]);

  const fetchPrefetchableHomeSongs = useCallback(async (
    category: PrefetchableHomeCategoryId,
    pageNum: number,
    priority: 'foreground' | 'background' = 'foreground',
  ): Promise<Song[]> => {
    const { start, count } = getProgressiveWindow(pageNum, FIRST_HOME_PAGE_SIZE, APPEND_HOME_PAGE_SIZE);
    switch (category) {
      case 'ranking':
        return getTrendingSongs(7, count, start, 'weekly', 0, globalFilterSettings, priority);
      case 'popular':
        return getTrendingSongs(30, count, start, 'alltime', 0, globalFilterSettings, priority);
      case 'pace':
        return getTrendingSongs(30, count, start, 'pace', 0, globalFilterSettings, priority);
      case 'trending':
        return getTrendingSongs(7, count, start, 'surge', 0, globalFilterSettings, priority);
      case 'recent':
        return getTrendingSongs(30, count, start, 'recent', 0, globalFilterSettings, priority);
      case 'deep':
        // The API's canonical seed-0 pool is kept hot with the other Home
        // feeds. Client-side exposure reranking below still varies its order
        // per page view, without making a new SQL/cache variant block the tab.
        return getTrendingSongs(30, count, start, 'deep', 0, globalFilterSettings, priority);
      case 'history_based': {
        const recentSongIds = new Set(entries.slice(0, 50).map(entry => entry.song.id));
        if (recentProducerIds.length > 0) {
          const producerWindow = selectRotatingWindow(recentProducerIds, pageNum, 4);
          const producerResults = await Promise.all(producerWindow.map(producerId =>
            searchSongsBackend({
              anyArtistIds: [producerId],
              sort: 'FavoritedTimes',
              sortOrder: 'desc',
              maxResults: Math.min(12, count),
              start,
              discoveryOnly: true,
              compactCards: true,
              priority,
            }).then(searchResult => searchResult.items).catch(() => [] as Song[]),
          ));
          const interleaved = interleaveUniqueSongs(producerResults, recentSongIds, PAGE_SIZE);
          if (interleaved.length > 0) return interleaved;
        }

        const fallback = await searchSongsBackend({
          sort: 'FavoritedTimes',
          sortOrder: 'desc',
          maxResults: count,
          start,
          discoveryOnly: true,
          compactCards: true,
          priority,
        });
        return fallback.items;
      }
      case 'favorite_producers': {
        if (favoriteProducers.length === 0) return [];
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
            start,
            maxResults: Math.min(12, count),
            discoveryOnly: true,
            compactCards: true,
            priority,
          }).then(result => result.items).catch(() => [] as Song[]),
        ));
        return uniqueSongsById(producerResults.flat()).slice(0, count);
      }
    }
  }, [entries, favoriteProducers, globalFilterSettings, recentProducerIds]);

  const loadPrefetchableHomeSongs = useCallback((
    category: PrefetchableHomeCategoryId,
    pageNum: number,
    priority: 'foreground' | 'background' = 'foreground',
  ): Promise<Song[]> => {
    if (pageNum > 0) return fetchPrefetchableHomeSongs(category, pageNum, priority);

    const key = `${homeSourceContextKey}:${category}:0`;
    const existing = homeSourcePromisesRef.current.get(key);
    if (existing) return existing;

    const request = fetchPrefetchableHomeSongs(category, 0, priority);
    homeSourcePromisesRef.current.set(key, request);
    void request.catch(() => {
      if (homeSourcePromisesRef.current.get(key) === request) {
        homeSourcePromisesRef.current.delete(key);
      }
    });
    return request;
  }, [fetchPrefetchableHomeSongs, homeSourceContextKey]);

  const fetchSongs = useCallback(async (
    category: HomeCategoryId,
    pageNum: number,
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
      let recommendedPage: Awaited<ReturnType<typeof fetchRecommendedHomeSongs>> | undefined;
      const sourceStartedAt = performanceNow();
      const { count } = getProgressiveWindow(pageNum, FIRST_HOME_PAGE_SIZE, APPEND_HOME_PAGE_SIZE);

      if (category === 'recommended') {
        recommendedPage = await fetchRecommendedHomeSongs(pageNum);
        result = recommendedPage.items;
      } else {
        result = await loadPrefetchableHomeSongs(category, pageNum, 'foreground');
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
      if (category !== 'recommended' && !isDeterministicHomeRankingCategory(category)) {
        result = rerankDisplayedSongs(result, rankingSeedRef.current);
      }
      if (requiresExternalViewCounts(globalFilterSettings)) {
        const externalViewsStartedAt = performanceNow();
        result = await attachExternalViews(result);
        segments.push({ name: 'externalViews', durationMs: performanceNow() - externalViewsStartedAt });
      }
      if (requestId !== requestIdRef.current) return;
      const filterStartedAt = performanceNow();
      result = filterVoiceSynthSongs(result);
      segments.push({ name: 'voiceFilter', durationMs: performanceNow() - filterStartedAt });

      const categoryReasons = recommendedPage?.reasons ?? (category === 'ranking' || category === 'trending'
        ? result.reduce<Record<number, string>>((reasons, song) => {
            const reason = category === 'ranking'
              ? formatWeeklyRankingReason(song, language)
              : formatTrendingReason(song, language);
            if (reason) reasons[song.id] = reason;
            return reasons;
          }, {})
        : {});

      if (pageNum === 0) {
        setSongs(result);
        if (result.length > 0 && !firstHomeContentRecordedRef.current) {
          firstHomeContentRecordedRef.current = true;
          recordPerformanceMetric({
            name: 'home.first-content',
            startedAt: category === 'recommended' ? 0 : startedAt,
            segments,
            detail: {
              category,
              displayedCount: result.length,
              source: category === 'recommended' ? 'personalized' : 'complete',
            },
          });
        }
        setRecommendationReasons(categoryReasons);
      } else {
        setSongs(prev => {
          const existingIds = new Set(prev.map(song => song.id));
          const newSongs = result.filter(song => !existingIds.has(song.id));
          return [...prev, ...newSongs];
        });
        if (recommendedPage || category === 'ranking' || category === 'trending') {
          setRecommendationReasons(previous => ({ ...previous, ...categoryReasons }));
        }
      }
      // A filtered page may contain no visible songs even though the source
      // still has more candidates. Continue until the source is exhausted or
      // a broken fallback repeats the same page.
      setHasMore((recommendedPage?.hasMore ?? fetchedCount >= count) && (pageNum === 0 || newSourceCount > 0));
      setLoadError(null);
      suppressStaleHomeFeedCacheRef.current = false;
      recordPerformanceMetric({
        name: 'home.load',
        startedAt,
        segments,
        detail: {
          category,
          page: pageNum,
          fetchedCount,
          displayedCount: result.length,
          favoriteProducerRequests: Math.min(favoriteProducers.length, category === 'recommended' ? 2 : MAX_FAVORITE_PRODUCER_REQUESTS),
        },
      });
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      console.error('Failed to fetch songs:', error);
      setHasMore(false);
      // Shown as 「読み込めませんでした」［再試行］, never as an empty feed.
      setLoadError(pageNum === 0 ? 'first' : 'more');
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
      if (requestId === requestIdRef.current) fetchingRef.current = false;
    }
  }, [favoriteProducers, fetchRecommendedHomeSongs, globalFilterSettings, language, loadPrefetchableHomeSongs]);

  // The first request reads the latest playlists, ratings and history without them becoming a reason
  // to rebuild the feed (fetchSongs changes whenever any of them does).
  const fetchFirstPage = useEffectEvent((category: HomeCategoryId, requestId: number) => {
    fetchSongs(category, 0, requestId);
  });

  useEffect(() => {
    if (restoredRecommendedEntryRef.current) {
      const canRestoreCachedFeed = isRecommendedHomeView
        && restoredHomeFeed?.sourceContextKey === homeFeedContextKey
        && !restoredHomeFeed.initialLoadPending;
      if (canRestoreCachedFeed) return;

      restoredRecommendedEntryRef.current = false;
      clearHomeFeedSnapshot(location.key);
      // Do not recache the old list while a changed-context request is in flight.
      suppressStaleHomeFeedCacheRef.current = true;
    }

    setLoading(true);
    setSongs([]);
    setPage(0);
    setHasMore(true);
    setLoadError(null);
    autoFillPagesRef.current = 0;
    sourceSongIdsRef.current.clear();

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if ((!hasHydrated || !playlistsHydrated) && (activeCategory === 'recommended' || activeCategory === 'history_based')) {
      return;
    }

    fetchFirstPage(activeCategory, requestId);
  }, [activeCategory, feedReload, hasHydrated, playlistsHydrated, homeFeedContextKey, isRecommendedHomeView, location.key, restoredHomeFeed]);

  useEffect(() => {
    if (!isRecommendedHomeView) {
      clearHomeFeedSnapshot(location.key);
      restoredRecommendedEntryRef.current = false;
      return;
    }
    if (suppressStaleHomeFeedCacheRef.current) return;
    if (songs.length === 0 && startupSongs.length === 0) {
      if (!loading) clearHomeFeedSnapshot(location.key);
      return;
    }

    // A failed later page is fetched again after Back (it is not counted as loaded).
    const pageIncomplete = loading || loadError === 'more';
    saveHomeFeedSnapshot(location.key, {
      songs,
      startupSongs,
      page: pageIncomplete && page > 0 ? page - 1 : page,
      hasMore: hasMore || loadError === 'more',
      recommendationReasons,
      scrollY: lastScrollYRef.current,
      initialLoadPending: loading && songs.length === 0 && startupSongs.length > 0,
      sourceContextKey: homeFeedContextKey,
    });
  }, [
    hasMore,
    homeFeedContextKey,
    isRecommendedHomeView,
    loadError,
    loading,
    location.key,
    page,
    recommendationReasons,
    songs,
    startupSongs,
  ]);

  // Back restores the feed at this position. It is recorded only while this history entry is the
  // current one: leaving scrolls the song page to the top and shortens the document, and neither
  // may overwrite where the user was.
  const recordScrollPosition = useCallback(() => {
    if (!isCurrentHistoryEntry(location.key)) return;
    lastScrollYRef.current = window.scrollY;
    updateHomeFeedSnapshotScroll(location.key, window.scrollY);
  }, [location.key]);

  useEffect(() => {
    window.addEventListener('scroll', recordScrollPosition, { passive: true });
    return () => window.removeEventListener('scroll', recordScrollPosition);
  }, [recordScrollPosition]);

  useEffect(() => {
    if (!restoredRecommendedEntryRef.current || restoredScrollYRef.current === null) return;
    const scrollY = restoredScrollYRef.current;
    // At the top there is nothing to restore (scrolling there would undo the browser's own restoration).
    if (scrollY <= 0) {
      restoredScrollYRef.current = null;
      return;
    }
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        // Cleared only once applied: StrictMode's effect re-run must not lose the position.
        restoredScrollYRef.current = null;
        window.scrollTo(0, scrollY);
        recordScrollPosition();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [location.key, recordScrollPosition]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore || fetchingRef.current) return;
    const nextPage = page + 1;
    setPage(nextPage);
    setLoading(true);
    fetchSongs(activeCategory, nextPage, requestIdRef.current);
  }, [
    loading,
    hasMore,
    page,
    activeCategory,
    fetchSongs,
  ]);

  // 再試行: a failed later page is requested again; a failed first page rebuilds the feed.
  const retryFeed = useCallback(() => {
    if (loadError === 'more' && page > 0) {
      if (fetchingRef.current) return;
      setLoadError(null);
      setHasMore(true);
      setLoading(true);
      fetchSongs(activeCategory, page, requestIdRef.current);
      return;
    }
    setFeedReload(value => value + 1);
  }, [activeCategory, fetchSongs, loadError, page]);

  const discoveryContext = useMemo(() => ({
    settings: globalFilterSettings,
    ratings,
    lastPlayedAtBySongId,
  }), [lastPlayedAtBySongId, globalFilterSettings, ratings]);
  const unhiddenFreshSongs = useMemo(() => excludeHiddenSongs(songs, hiddenSongs), [hiddenSongs, songs]);
  const unhiddenStartupSongs = useMemo(
    () => excludeHiddenSongs(startupSongs, hiddenSongs),
    [hiddenSongs, startupSongs],
  );
  const freshStrictDiscoverySongs = useMemo(
    () => applyDiscoveryFilter(unhiddenFreshSongs, discoveryContext),
    [discoveryContext, unhiddenFreshSongs],
  );
  const shouldRelaxFreshDiscovery = !loading
    && freshStrictDiscoverySongs.length < DISCOVERY_MIN_COUNT
    && !hasMore;
  const freshDiscoveryResult = useMemo(
    () => shouldRelaxFreshDiscovery
      ? applyDiscoveryFilterWithRelaxation(unhiddenFreshSongs, discoveryContext, DISCOVERY_MIN_COUNT)
      : { items: freshStrictDiscoverySongs, relaxedConditions: [] },
    [discoveryContext, freshStrictDiscoverySongs, shouldRelaxFreshDiscovery, unhiddenFreshSongs],
  );
  const startupDiscoverySongs = useMemo(
    () => applyDiscoveryFilter(unhiddenStartupSongs, discoveryContext),
    [discoveryContext, unhiddenStartupSongs],
  );
  const showingStartupCache = activeCategory === 'recommended'
    && startupDiscoverySongs.length > 0;
  const discoveryResult = showingStartupCache
    ? {
        // Keep the visible prefix in place: refreshing candidates may append
        // songs, but must not remove the tiles someone is about to choose.
        items: uniqueSongsById([...startupDiscoverySongs, ...freshDiscoveryResult.items]),
        relaxedConditions: freshDiscoveryResult.relaxedConditions,
      }
    : freshDiscoveryResult;
  const homeLoading = loading && !showingStartupCache;
  const startupRefreshTarget = showingStartupCache ? 40 : FIRST_HOME_PAGE_SIZE;
  const displaySongs = discoveryResult.items;

  useEffect(() => {
    if (activeCategory !== 'recommended' || displaySongs.length === 0) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const idleWindow = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
        cancelIdleCallback?: (id: number) => void;
      };
      const startPrefetch = () => {
        void loadPrefetchableHomeSongs('ranking', 0, 'background')
          .catch(() => [] as Song[])
          .then(() => {
            if (!cancelled) return loadPrefetchableHomeSongs('popular', 0, 'background');
            return [] as Song[];
          })
          .catch(() => [] as Song[]);
      };
      if (idleWindow.requestIdleCallback) {
        idleCallbackId = idleWindow.requestIdleCallback(startPrefetch, { timeout: 2_000 });
      } else {
        idleFallbackTimer = window.setTimeout(startPrefetch, 0);
      }
    }, HOME_CATEGORY_PREFETCH_DELAY_MS);
    let idleCallbackId: number | undefined;
    let idleFallbackTimer: number | undefined;

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (idleFallbackTimer !== undefined) window.clearTimeout(idleFallbackTimer);
      const idleWindow = window as Window & { cancelIdleCallback?: (id: number) => void };
      if (idleCallbackId !== undefined) idleWindow.cancelIdleCallback?.(idleCallbackId);
    };
  }, [activeCategory, displaySongs.length, loadPrefetchableHomeSongs]);

  useEffect(() => {
    if (activeCategory !== 'recommended'
      || !hasHydrated
      || loading
      || songs.length === 0
      || freshDiscoveryResult.items.length === 0
      || (hasMore && freshDiscoveryResult.items.length < startupRefreshTarget)) return;
    const signature = freshDiscoveryResult.items.slice(0, STARTUP_POOL_SIZE).map(song => song.id).join(',');
    if (signature === persistedStartupSignatureRef.current) return;
    persistedStartupSignatureRef.current = signature;
    persistStartupRecommendations(freshDiscoveryResult.items);
  }, [
    activeCategory,
    freshDiscoveryResult.items,
    hasHydrated,
    hasMore,
    loading,
    songs.length,
    startupRefreshTarget,
  ]);

  useEffect(() => {
    // An underfilled first screen is handled by the bounded auto-fill below.
    // Observing its already-visible sentinel as well caused an endless stream
    // of placeholder cards on large displays with strict filters.
    if (freshStrictDiscoverySongs.length < DISCOVERY_MIN_COUNT) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      observerEntries => {
        if (observerEntries[0].isIntersecting) loadMore();
      },
      { rootMargin: `0px 0px ${PREFETCH_MARGIN_PX}px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [freshStrictDiscoverySongs.length, loadMore]);

  useEffect(() => {
    if (loading || !hasMore || page !== 0 || songs.length < DISCOVERY_MIN_COUNT) return;
    const timer = window.setTimeout(loadMore, 180);
    return () => window.clearTimeout(timer);
  }, [hasMore, loadMore, loading, page, songs.length]);

  useEffect(() => {
    const pending = pendingHomePaintRef.current;
    if (homeLoading || !pending || typeof requestAnimationFrame === 'undefined') return;

    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (pendingHomePaintRef.current !== pending) return;
        pendingHomePaintRef.current = null;
        firstHomePaintRecordedRef.current = true;
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
  }, [displaySongs.length, homeLoading]);

  // 足切り後の表示件数が少ない場合は追加ページを先読みするが、
  // 2ページで打ち切って既存の段階緩和へ渡し、終わらないloading表示を作らない。
  useEffect(() => {
    if (
      loading
      || !hasMore
      || fetchingRef.current
      || freshStrictDiscoverySongs.length >= startupRefreshTarget
    ) return;

    if (autoFillPagesRef.current >= MAX_AUTOFILL_PAGES) {
      setHasMore(false);
      return;
    }
    autoFillPagesRef.current += 1;
    loadMore();
  }, [freshStrictDiscoverySongs.length, loading, hasMore, loadMore, startupRefreshTarget]);

  const selectCategory = useCallback((id: string) => {
    const nextCategory = asHomeCategoryId(id);
    if (nextCategory === activeCategory) return;
    restoredRecommendedEntryRef.current = false;
    clearHomeFeedSnapshot(location.key);
    firstHomePaintRecordedRef.current = false;
    pendingHomePaintRef.current = null;
    setStartupSongs([]);
    setActiveCategory(nextCategory);
  }, [activeCategory, location.key]);

  // 「最近聴いたP」 needs listening history; without it the chip would only repeat 人気.
  const visibleCategories = useMemo(
    () => CATEGORIES
      .filter(chip => chip.id !== 'history_based' || recentProducerIds.length > 0 || activeCategory === 'history_based')
      .map(chip => ({ ...chip, label: t(CATEGORY_LABELS[asHomeCategoryId(chip.id)]) })),
    [activeCategory, recentProducerIds.length, t],
  );

  const relaxedConditions = discoveryResult.relaxedConditions;
  const relaxationDetail = getDiscoveryRelaxationMessage(relaxedConditions, language);

  const emptyState = loadError ? (
    <EmptyState icon={<ErrorIcon />} title={ts('読み込めませんでした')} action={{ label: ts('再試行'), onClick: retryFeed }} />
  ) : activeCategory === 'favorite_producers' && favoriteProducers.length === 0 ? (
    <EmptyState
      icon={<PersonStarIcon />}
      title={ts('お気に入りPはまだいません')}
      action={{ label: ts('おすすめを見る'), onClick: () => selectCategory('recommended') }}
    />
  ) : isDiscoveryFilterActive(globalFilterSettings) ? (
    <EmptyState
      icon={<MusicNoteIcon />}
      title={t('noSongsMatchFilters')}
      action={{ label: ts('フィルターを変更'), onClick: () => openSettings('filter') }}
    />
  ) : undefined;

  return (
    // A click that opens a song also records where the feed was (for Back).
    <div className="w-full px-3 pb-6 sm:px-4 lg:px-6" onClickCapture={recordScrollPosition}>
      <div className="sticky top-[calc(var(--header-height,56px)_+_var(--selection-bar-height,0px))] z-[var(--z-sticky,20)] -mx-3 bg-yt-bg px-3 py-3 sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6">
        <CategoryChips
          chips={visibleCategories}
          activeChip={activeCategory}
          onPrefetch={(id) => {
            if (id === 'recommended' || !CATEGORIES.some(category => category.id === id)) return;
            void loadPrefetchableHomeSongs(asHomeCategoryId(id) as PrefetchableHomeCategoryId, 0, 'background');
          }}
          onSelect={selectCategory}
        />
      </div>

      {relaxationDetail && (
        <div className="mb-3 flex min-h-8 flex-wrap items-center gap-x-1 text-xs leading-4 text-yt-text-secondary">
          <span>{getDiscoveryRelaxationShortLabel(language)}</span>
          <InfoTip label={ts('詳細')}>{relaxationDetail}</InfoTip>
          <Button variant="text" size="sm" onClick={() => openSettings('filter')}>
            {ts('設定')}
          </Button>
        </div>
      )}

      <div className={relaxationDetail ? undefined : 'mt-3'} aria-busy={loading}>
        <VideoGrid
          songs={displaySongs}
          loading={homeLoading}
          visibilityIntent="discovery"
          emptyState={emptyState}
          showRanks={RANKED_CATEGORIES.has(activeCategory)}
          recommendationReasons={activeCategory === 'recommended' || activeCategory === 'ranking' || activeCategory === 'trending'
            ? recommendationReasons
            : undefined}
          alwaysShowReasons={activeCategory === 'ranking'}
          exposureSurface={activeCategory === 'recommended' ? 'home-recommended' : 'home-discovery'}
        />
      </div>

      <div ref={sentinelRef} className="mt-6 flex min-h-8 items-center justify-center text-yt-text-secondary">
        {loading && displaySongs.length > 0 && (
          <div role="status" className="flex items-center gap-2 py-4 text-sm">
            <SpinnerIcon />{ts('曲を読み込み中…')}
          </div>
        )}
        {loadError && !loading && displaySongs.length > 0 && (
          <InlineNotice tone="error" className="w-full max-w-md" action={{ label: ts('再試行'), onClick: retryFeed }}>
            {ts('読み込めませんでした')}
          </InlineNotice>
        )}
      </div>
    </div>
  );
}
