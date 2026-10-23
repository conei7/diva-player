import { useEffect, useState, useRef, useCallback, useLayoutEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSearchParams, Navigate, useNavigate, Link } from 'react-router';
import VideoPlayer from '../components/watch/VideoPlayer';
import NoVideoFrame from '../components/watch/NoVideoFrame';
import VideoInfo from '../components/watch/VideoInfo';
import Description from '../components/watch/Description';
import FilterChips, { type RecTabKey } from '../components/watch/FilterChips';
import RecommendationList, { type RecommendationListEmpty } from '../components/watch/RecommendationList';
import PlaylistPanel from '../components/watch/PlaylistPanel';
import { VIDEO_FRAME_CLASS } from '../components/watch/videoFrame';
import { getPlayablePV, usePlayerStore } from '../stores/playerStore';
import { useRatingStore } from '../stores/ratingStore';
import { useHistoryStore } from '../stores/historyStore';
import { usePlaylistStore } from '../stores/playlistStore';
import { useImplicitFeedbackStore } from '../stores/implicitFeedbackStore';
import {
  getSongById,
  getRecommendedSongs,
  getSongsByProducerFromBackend,
  getAudioSimilarSongs,
  getMetadataSimilarSongs,
  attachExternalViews,
} from '../api/vocadb';
import type { Song } from '../types/vocadb';
import { useSelectionStore } from '../stores/selectionStore';
import { rerankRecommendationCandidatesDetailed } from '../utils/recommendationReranking';
import { useRecommendationDebugStore } from '../stores/recommendationDebugStore';
import { createRankingSeed } from '../utils/rankingRandomization';
import { rerankDisplayedSongs, useRecommendationExposureStore } from '../stores/recommendationExposureStore';
import { useGlobalFilterStore } from '../stores/globalFilterStore';
import { useFavoriteProducerStore } from '../stores/favoriteProducerStore';
import { useUiStore } from '../stores/uiStore';
import { useLanguageStore } from '../stores/languageStore';
import {
  filterDiscoverySourcePage,
  getDiscoveryRelaxationMessage,
  getDiscoveryRelaxationShortLabel,
  isDiscoveryFilterActive,
  requiresExternalViewCounts,
  type DiscoveryRelaxedCondition,
} from '../utils/globalFilters';
import { excludeHiddenSongs, useHiddenSongStore } from '../stores/hiddenSongStore';
import { getPlaybackOwnership } from '../services/playbackOwnership';
import { isCurrentWatchSongRequest, watchUrlPlaybackTarget } from '../utils/watchNavigation';
import { useTranslate, useTranslateSourceText } from '../i18n';
import { getProgressiveWindow } from '../utils/progressiveWindow';
import { getProducerNames } from '../utils/songMeta';
import { watchPath } from '../utils/routes';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import Button, { buttonClassName } from '../components/ui/Button';
import { InfoTip } from '../components/ui/InfoTip';
import { SkeletonBlock, SkeletonListRow } from '../components/ui/Skeleton';
import { ErrorIcon } from '../components/ui/icons';
import { cx } from '../components/ui/overlay';

/**
 * WatchPage - YouTube風の再生ページ (/watch?v=楽曲ID)
 *
 * 1024px 以上は2カラム（左: 動画・タイトル・操作・概要 / 右: 再生中リスト・チップ・関連一覧）。
 * それ未満は1カラムで、再生中リストは動画のすぐ下に出す（動画より上には高さの変わる物を置かない）。
 *
 * URLの ?v= パラメータ変更で、ページリロードなしに
 * メインの IFrame とメタデータだけがスムーズに切り替わる。
 */

interface TabState {
  items: Song[];
  reasons?: Record<number, string>;
  relaxedConditions: DiscoveryRelaxedCondition[];
  loading: boolean;
  hasMore: boolean;
  page: number;
  loadError?: boolean;
}

const PAGE_SIZE = 40;
const FIRST_WATCH_PAGE_SIZE = 12;
const APPEND_WATCH_PAGE_SIZE = 28;
const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)';

function emptyTabs(): Record<RecTabKey, TabState> {
  return {
    producer: { items: [], relaxedConditions: [], loading: false, hasMore: true, page: 0 },
    related: { items: [], relaxedConditions: [], loading: false, hasMore: true, page: 0 },
    recommended: { items: [], relaxedConditions: [], loading: false, hasMore: true, page: 0 },
    deep: { items: [], relaxedConditions: [], loading: false, hasMore: true, page: 0 },
  };
}

export type WatchPageDocumentTitleState =
  | { songId: number; status: 'loading' | 'error' }
  | { songId: number; status: 'loaded'; song: Song };

interface WatchPageProps {
  onDocumentTitleStateChange?: (state: WatchPageDocumentTitleState) => void;
}

export default function WatchPage({ onDocumentTitleStateChange }: WatchPageProps = {}) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const language = useLanguageStore(state => state.language);
  const isDesktop = useMediaQuery(DESKTOP_MEDIA_QUERY);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const songIdStr = searchParams.get('v');
  const songId = songIdStr ? Number(songIdStr) : null;
  // Song links use autoplay=0 so a newly opened tab does not steal an active
  // player from another tab. If no live remote owner exists, the same URL is a
  // normal direct play request and should start automatically. Stale crashed
  // owners are expired by playbackOwnership.
  const shouldAutoplay = searchParams.get('autoplay') !== '0'
    || getPlaybackOwnership().getState() !== 'remote';

  const { currentSong, setQueue, setRootSeed, resume, pause } = usePlayerStore();
  const currentSongId = currentSong?.id;
  const { ratings } = useRatingStore();
  const { entries, hasHydrated } = useHistoryStore();
  const { playlists } = usePlaylistStore();
  const implicitFeedback = useImplicitFeedbackStore(state => state.feedback);
  const favoriteProducers = useFavoriteProducerStore(state => state.producers);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const openSettings = useUiStore(state => state.openSettings);
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
  const filterDiscoverySongs = useCallback((items: Song[], minimumCount = PAGE_SIZE, allowRelaxation = true) => {
    const candidates = excludeHiddenSongs(items, hiddenSongs);
    const context = {
      settings: globalFilterSettings,
      ratings,
      lastPlayedAtBySongId: useHistoryStore.getState().lastPlayedAtBySongId,
    };
    return filterDiscoverySourcePage(candidates, context, minimumCount, allowRelaxation);
  }, [globalFilterSettings, hiddenSongs, ratings]);

  const [song, setSong] = useState<Song | null>(null);
  const [loadingSong, setLoadingSong] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const setVisibleSongs = useSelectionStore(s => s.setVisibleSongs);

  const [activeTab, setActiveTab] = useState<RecTabKey>('recommended');
  const [tabs, setTabs] = useState<Record<RecTabKey, TabState>>(emptyTabs);

  const fetchedForRef = useRef<number | null>(null);
  const songRequestGenerationRef = useRef(0);
  const songRequestAbortRef = useRef<AbortController | null>(null);
  const randomOffsetRef = useRef(Math.floor(Math.random() * 20));
  const rankingSeedRef = useRef(createRankingSeed());
  // URLからのロード中はナビゲーションエフェクトをブロックするフラグ
  const loadingFromUrlRef = useRef(false);
  // A song without a playable video is shown without touching the queue. Until the playing
  // song changes, the URL must not be synced back to it.
  const unplayableRef = useRef<{ songId: number; playingSongId: number | null } | null>(null);
  const seenSets = useRef<Record<RecTabKey, Set<number>>>({
    producer: new Set(),
    related: new Set(),
    recommended: new Set(),
    deep: new Set(),
  });

  const sentinelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!songId) return;
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [songId]);

  // 曲をロード & 再生開始
  useEffect(() => {
    if (!songId) return;
    if (fetchedForRef.current === songId) return;
    onDocumentTitleStateChange?.({ songId, status: 'loading' });
    songRequestAbortRef.current?.abort();
    const requestAbortController = new AbortController();
    songRequestAbortRef.current = requestAbortController;
    const requestGeneration = ++songRequestGenerationRef.current;
    fetchedForRef.current = songId;
    randomOffsetRef.current = Math.floor(Math.random() * 20);
    rankingSeedRef.current = createRankingSeed();
    loadingFromUrlRef.current = true;
    unplayableRef.current = null;

    setLoadingSong(true);
    setLoadFailed(false);
    setSong(null);

    // タブリセット
    setTabs(emptyTabs());
    seenSets.current = {
      producer: new Set([songId]),
      related: new Set([songId]),
      recommended: new Set([songId]),
      deep: new Set([songId]),
    };

    getSongById(songId)
      .then((loadedSong) => {
        // A slower response for the previous URL must never replace the song
        // selected by a newer navigation.
        if (!isCurrentWatchSongRequest(requestGeneration, songRequestGenerationRef.current, songId, fetchedForRef.current)) return;
        const player = usePlayerStore.getState();
        if (getPlayablePV(loadedSong)) {
          // 再生開始（現在の曲と違う場合のみ）
          if (player.currentSong?.id !== loadedSong.id) {
            setRootSeed(loadedSong); // ユーザーが能動的に選んだ曲をRoot Seedに
            setQueue([loadedSong], 0, shouldAutoplay);
          } else if (shouldAutoplay) {
            resume();
          }
        } else {
          // No playable video: keep the queue and the playing song, just stop the sound.
          unplayableRef.current = { songId: loadedSong.id, playingSongId: player.currentSong?.id ?? null };
          if (player.isPlaying) pause();
        }
        loadingFromUrlRef.current = false;
        setSong(loadedSong);
        setLoadingSong(false);
        onDocumentTitleStateChange?.({ songId, status: 'loaded', song: loadedSong });

        // The active tab loads first. Other recommendation modes load when selected.
      })
      .catch(() => {
        if (!isCurrentWatchSongRequest(requestGeneration, songRequestGenerationRef.current, songId, fetchedForRef.current)) return;
        loadingFromUrlRef.current = false;
        setLoadFailed(true);
        setLoadingSong(false);
        onDocumentTitleStateChange?.({ songId, status: 'error' });
      });
    return () => {
      requestAbortController.abort();
      if (songRequestAbortRef.current === requestAbortController) songRequestAbortRef.current = null;
      // StrictMode (dev) runs effects twice. Forget the request here so the second run
      // starts a fresh one instead of leaving the recommendation tabs without a signal.
      if (fetchedForRef.current === songId) fetchedForRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId, retryToken]);

  // --- フェッチ関数 ---

  useEffect(() => {
    if (!song || !songId || loadingFromUrlRef.current) return;
    setTabs(emptyTabs());
    seenSets.current = {
      producer: new Set([song.id]),
      related: new Set([song.id]),
      recommended: new Set([song.id]),
      deep: new Set([song.id]),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilterSettings]);

  const fetchProducer = useCallback(async (s: Song, page: number) => {
    const signal = songRequestAbortRef.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const { start, count } = getProgressiveWindow(page, FIRST_WATCH_PAGE_SIZE, APPEND_WATCH_PAGE_SIZE, PAGE_SIZE);
      const producerIds = (s.artists ?? [])
        .filter(a => a.categories?.includes('Producer'))
        .map(a => a.artist?.id)
        .filter((id): id is number => id !== undefined);

      // Producer pagination is already popularity-ordered by the backend.
      // Applying the mix tab's random offset here skipped the first page and
      // made the same-P tab appear to miss songs when its pool was small.
      const producerSongs = await getSongsByProducerFromBackend(s.id, producerIds, count, start, signal);
      const filtered = filterDiscoverySongs(
        requiresExternalViewCounts(globalFilterSettings) ? await attachExternalViews(producerSongs) : producerSongs,
        count,
        producerSongs.length < count,
      );
      const items = rerankDisplayedSongs(
        filtered.items,
        rankingSeedRef.current,
      );
      const fresh = items.filter(item => !seenSets.current.producer.has(item.id));
      fresh.forEach(item => seenSets.current.producer.add(item.id));

      setTabs(prev => ({
        ...prev,
        producer: {
          items: page === 0 ? fresh : [...prev.producer.items, ...fresh],
          relaxedConditions: page === 0
            ? filtered.relaxedConditions
            : [...new Set([...prev.producer.relaxedConditions, ...filtered.relaxedConditions])],
          loading: false,
          hasMore: producerSongs.length >= count && fresh.length > 0,
          page: page + 1,
        },
      }));
    } catch {
      if (signal.aborted || fetchedForRef.current !== s.id) return;
      setTabs(prev => ({ ...prev, producer: { ...prev.producer, loading: false, hasMore: false, loadError: true } }));
    }
  }, [filterDiscoverySongs, globalFilterSettings]);

  const fetchRelated = useCallback(async (s: Song, page: number) => {
    const signal = songRequestAbortRef.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const { start, count } = getProgressiveWindow(page, FIRST_WATCH_PAGE_SIZE, APPEND_WATCH_PAGE_SIZE, PAGE_SIZE);
      const sourceSongs = await getMetadataSimilarSongs(s.id, count, start, signal);
      const relatedSongs = requiresExternalViewCounts(globalFilterSettings)
        ? await attachExternalViews(sourceSongs)
        : sourceSongs;
      const sourceExhausted = sourceSongs.length < count;
      const filtered = filterDiscoverySongs(
        relatedSongs,
        count,
        sourceExhausted,
      );
      const items = rerankDisplayedSongs(
        filtered.items.slice(0, count),
        rankingSeedRef.current,
      );
      const fresh = items.filter(item => !seenSets.current.related.has(item.id));
      fresh.forEach(item => seenSets.current.related.add(item.id));
      if (signal.aborted || fetchedForRef.current !== s.id) return;

      setTabs(prev => ({
        ...prev,
        related: {
          items: page === 0 ? fresh : [...prev.related.items, ...fresh],
          relaxedConditions: page === 0
            ? filtered.relaxedConditions
            : [...new Set([...prev.related.relaxedConditions, ...filtered.relaxedConditions])],
          loading: false,
          loadError: false,
          hasMore: !sourceExhausted && fresh.length > 0,
          page: page + 1,
        },
      }));
    } catch {
      if (signal.aborted || fetchedForRef.current !== s.id) return;
      setTabs(prev => ({ ...prev, related: { ...prev.related, loading: false, hasMore: false, loadError: true } }));
    }
  }, [filterDiscoverySongs, globalFilterSettings]);

  const fetchRecommended = useCallback(async (s: Song, page: number) => {
    const signal = songRequestAbortRef.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const { start, count } = getProgressiveWindow(page, FIRST_WATCH_PAGE_SIZE, APPEND_WATCH_PAGE_SIZE, PAGE_SIZE);
      type SourcePage = [Song[], Song[], Song[]];
      const favoriteWindow = favoriteProducers.slice(0, 2);
      const raw = await Promise.all([
        getRecommendedSongs(s.id, count, 0.0, ratings, randomOffsetRef.current + start, signal),
        getAudioSimilarSongs(s.id, count, randomOffsetRef.current + start, signal),
        Promise.all(favoriteWindow.map(producer =>
          getSongsByProducerFromBackend(s.id, [producer.id], count, start, signal)
            .catch(() => [] as Song[]),
        )).then(results => results.flat()),
      ]) as SourcePage;
      const sourcePage = requiresExternalViewCounts(globalFilterSettings)
        ? await Promise.all(raw.map(items => attachExternalViews(items))) as SourcePage
        : raw;
      const [hybrid, audio, favorite] = sourcePage;
      const sourceExhausted = hybrid.length < count
        && audio.length < count
        && favorite.length < count;
      const hybridFiltered = filterDiscoverySongs([...favorite, ...hybrid], count, sourceExhausted);
      const audioFiltered = filterDiscoverySongs(audio, Math.min(4, count), sourceExhausted);
      const detailed = rerankRecommendationCandidatesDetailed({
        hybrid: hybridFiltered.items,
        audio: audioFiltered.items,
      }, {
        total: count,
        historyEntries: entries,
        playlists,
        ratings,
        implicitFeedback,
        excludeIds: new Set([s.id, ...seenSets.current.recommended]),
        rankingSeed: rankingSeedRef.current,
        explorationStrength: 0.06,
        exposureEntries: useRecommendationExposureStore.getState().entries,
        favoriteProducerIds: new Set(favoriteProducers.map(producer => producer.id)),
      });
      const relaxedConditions = [...new Set([
        ...hybridFiltered.relaxedConditions,
        ...audioFiltered.relaxedConditions,
      ])];
      const mixed = detailed.ranked;
      const items = mixed.map(item => item.song);
      const fresh = items.filter(item => !seenSets.current.recommended.has(item.id));
      fresh.forEach(item => seenSets.current.recommended.add(item.id));
      if (signal.aborted || fetchedForRef.current !== s.id) return;
      const freshIds = new Set(fresh.map(item => item.id));
      const reasons = Object.fromEntries(mixed
        .filter(item => freshIds.has(item.song.id))
        .map(item => [item.song.id, item.reason]));

      useRecommendationDebugStore.getState().recordSnapshot({
        id: `${Date.now()}-watch-${s.id}-${page}`,
        surface: 'watch',
        generatedAt: Date.now(),
        rankingSeed: rankingSeedRef.current,
        seedSongIds: [s.id],
        strategy: 'recommended',
        familiarityBias: 0,
        candidateCount: detailed.trace.length,
        selectedCount: fresh.length,
        trace: detailed.trace,
      });

      setTabs(prev => ({
        ...prev,
        recommended: {
          items: page === 0 ? fresh : [...prev.recommended.items, ...fresh],
          reasons: page === 0 ? reasons : { ...prev.recommended.reasons, ...reasons },
          relaxedConditions: page === 0
            ? relaxedConditions
            : [...new Set([...prev.recommended.relaxedConditions, ...relaxedConditions])],
          loading: false,
          hasMore: !sourceExhausted && fresh.length > 0,
          page: page + 1,
        },
      }));
    } catch {
      if (signal.aborted || fetchedForRef.current !== s.id) return;
      setTabs(prev => ({ ...prev, recommended: { ...prev.recommended, loading: false, hasMore: false, loadError: true } }));
    }
  }, [entries, favoriteProducers, globalFilterSettings, implicitFeedback, playlists, ratings, filterDiscoverySongs]);

  const fetchDeep = useCallback(async (s: Song, page: number) => {
    const signal = songRequestAbortRef.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const { start, count } = getProgressiveWindow(page, FIRST_WATCH_PAGE_SIZE, APPEND_WATCH_PAGE_SIZE, PAGE_SIZE);
      const deepSongs = await getAudioSimilarSongs(s.id, count, start, signal);
      const filtered = filterDiscoverySongs(
        requiresExternalViewCounts(globalFilterSettings) ? await attachExternalViews(deepSongs) : deepSongs,
        count,
        deepSongs.length < count,
      );
      const items = rerankDisplayedSongs(
        filtered.items,
        rankingSeedRef.current,
      );
      const fresh = items.filter(item => !seenSets.current.deep.has(item.id));
      fresh.forEach(item => seenSets.current.deep.add(item.id));
      if (signal.aborted || fetchedForRef.current !== s.id) return;

      setTabs(prev => ({
        ...prev,
        deep: {
          items: page === 0 ? fresh : [...prev.deep.items, ...fresh],
          relaxedConditions: page === 0
            ? filtered.relaxedConditions
            : [...new Set([...prev.deep.relaxedConditions, ...filtered.relaxedConditions])],
          loading: false,
          hasMore: deepSongs.length >= count && fresh.length > 0,
          page: page + 1,
        },
      }));
    } catch {
      if (signal.aborted || fetchedForRef.current !== s.id) return;
      setTabs(prev => ({ ...prev, deep: { ...prev.deep, loading: false, hasMore: false, loadError: true } }));
    }
  }, [filterDiscoverySongs, globalFilterSettings]);

  useEffect(() => {
    if (!song || loadingFromUrlRef.current) return;
    if (globalFilterSettings.cooldownHours > 0 && !hasHydrated) return;
    const tab = tabs[activeTab];
    if (tab.loading || tab.items.length > 0 || !tab.hasMore) return;

    setTabs(previous => ({
      ...previous,
      [activeTab]: { ...previous[activeTab], loading: true },
    }));
    switch (activeTab) {
      case 'producer': void fetchProducer(song, tab.page); break;
      case 'related': void fetchRelated(song, tab.page); break;
      case 'recommended': void fetchRecommended(song, tab.page); break;
      case 'deep': void fetchDeep(song, tab.page); break;
    }
  }, [activeTab, fetchDeep, fetchProducer, fetchRecommended, fetchRelated, globalFilterSettings.cooldownHours, hasHydrated, song, tabs]);

  // 追加読み込み
  const loadMore = useCallback(() => {
    if (!song) return;
    if (globalFilterSettings.cooldownHours > 0 && !hasHydrated) return;
    const tab = tabs[activeTab];
    if (tab.loading || !tab.hasMore) return;

    setTabs(prev => ({ ...prev, [activeTab]: { ...prev[activeTab], loading: true } }));

    switch (activeTab) {
      case 'producer': fetchProducer(song, tab.page); break;
      case 'related': fetchRelated(song, tab.page); break;
      case 'recommended': fetchRecommended(song, tab.page); break;
      case 'deep': fetchDeep(song, tab.page); break;
    }
  }, [song, tabs, activeTab, fetchProducer, fetchRelated, fetchRecommended, fetchDeep, globalFilterSettings.cooldownHours, hasHydrated]);

  // Retry a recommendation tab that failed to load (its first page or a later one).
  const retryTab = useCallback(() => {
    setTabs(prev => ({ ...prev, [activeTab]: { ...prev[activeTab], loadError: false, hasMore: true } }));
  }, [activeTab]);

  // 無限スクロール
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const currentTab = tabs[activeTab];
  const displayTabItems = currentTab.items;
  const relaxationMessage = getDiscoveryRelaxationMessage(currentTab.relaxedConditions, language);

  // 現在のタブの表示曲をselectionStoreに登録（FABの全選択・フィルター用）
  useEffect(() => {
    setVisibleSongs(displayTabItems);
  }, [displayTabItems, setVisibleSongs]);

  // 動画が自動再生で次に進んだ場合などにURLを同期する
  // loadingFromUrlRef が true の間 (URL変更後のフェッチ中) はナビゲートしない
  useEffect(() => {
    const unplayable = unplayableRef.current;
    if (
      unplayable
      && unplayable.songId === songId
      && song?.id === songId
      && (currentSongId ?? null) === unplayable.playingSongId
    ) return;
    const target = watchUrlPlaybackTarget({
      requestedSongId: songId,
      displayedSongId: song?.id ?? null,
      playingSongId: currentSongId ?? null,
      loadingFromUrl: loadingFromUrlRef.current,
    });
    if (target) navigate(watchPath(target));
  }, [currentSongId, song?.id, songId, navigate]);

  // songId がない場合はホームへ
  if (!songId) return <Navigate to="/" replace />;

  const playable = song ? Boolean(getPlayablePV(song)) : true;
  const producerName = song ? getProducerNames(song)[0] : undefined;

  const empty: RecommendationListEmpty = currentTab.loadError
    ? { title: t('読み込めませんでした'), action: { label: t('再試行'), onClick: retryTab } }
    : isDiscoveryFilterActive(globalFilterSettings)
      ? { title: t('フィルターに合う曲がありません'), action: { label: t('フィルターを変更'), onClick: () => openSettings('filter') } }
      : activeTab === 'related'
        ? { title: t('関連曲が見つかりません'), action: { label: t('おすすめを見る'), onClick: () => setActiveTab('recommended') } }
        : { title: tk('noSongsFound') };

  if (loadFailed) {
    return (
      <div className="flex flex-col items-center px-4 py-16 text-center">
        <span aria-hidden="true" className="mb-4 flex text-yt-text-disabled [&>svg]:size-16"><ErrorIcon /></span>
        <p className="m-0 text-base font-medium leading-6 text-yt-text">{t('曲を読み込めませんでした')}</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" onClick={() => setRetryToken(value => value + 1)}>{t('再試行')}</Button>
          {/* Same words as the app-wide error screen (RouteErrorBoundary): a verb, not 「ホームへ」. */}
          <Link to="/" className={buttonClassName({ variant: 'tonal' })}>{t('ホームに戻る')}</Link>
        </div>
      </div>
    );
  }

  const videoArea = loadingSong || !song
    ? <div aria-hidden="true" className={cx(VIDEO_FRAME_CLASS, 'bg-yt-tonal-solid')} />
    : playable ? <VideoPlayer /> : <NoVideoFrame song={song} />;

  const relatedSection = (
    <>
      <FilterChips
        activeTab={activeTab}
        onTabChange={setActiveTab}
        producerName={producerName}
        sticky={isDesktop}
        className="py-3 max-sm:px-3"
      />
      {relaxationMessage && (
        <div className="mb-2 flex items-center gap-1 text-xs leading-[18px] text-yt-text-secondary max-sm:px-3">
          <span>{getDiscoveryRelaxationShortLabel(language)}</span>
          <InfoTip label={t('詳細')}>{relaxationMessage}</InfoTip>
        </div>
      )}
      <div className="max-sm:px-3">
        {song ? (
          <RecommendationList
            songs={displayTabItems}
            loading={currentTab.loading || (!currentTab.loadError && currentTab.items.length === 0 && currentTab.hasMore)}
            hasMore={currentTab.hasMore}
            recommendationReasons={activeTab === 'recommended' ? currentTab.reasons : undefined}
            exposureSurface={activeTab === 'producer' ? 'watch-producer' : activeTab === 'related' ? 'watch-related' : activeTab === 'recommended' ? 'watch-recommended' : 'watch-deep'}
            empty={empty}
            cards={isMobile}
          />
        ) : (
          <div className="-mx-2">
            {Array.from({ length: 6 }, (_, index) => <SkeletonListRow key={index} size="md" />)}
          </div>
        )}
      </div>
      {/* 無限スクロールセンチネル */}
      <div ref={sentinelRef} className="mt-4 h-8" />
    </>
  );

  return (
    <div className="w-full pb-6 sm:px-4 sm:pt-4 lg:px-6 lg:pt-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(402px,2fr)] max-sm:gap-0">
        {/* ─── 左: 動画・タイトル・操作・概要 ─── */}
        <div className="min-w-0 flex-1">
          {videoArea}
          {!isDesktop && <PlaylistPanel variant={isMobile ? 'sheet' : 'inline'} startCollapsed className="mt-3 max-sm:mt-0" />}
          {song && !loadingSong ? (
            <>
              <VideoInfo song={song} />
              <Description song={song} />
            </>
          ) : (
            <div className="mt-3 space-y-3 max-sm:px-3" aria-hidden="true">
              <SkeletonBlock className="h-7 w-3/4 rounded-badge" />
              <div className="flex items-center gap-3">
                <SkeletonBlock className="size-10 shrink-0 rounded-full" />
                <SkeletonBlock className="h-5 w-40 rounded-badge" />
              </div>
            </div>
          )}
        </div>

        {/* ─── 右: 再生中リスト・チップ・関連一覧 ─── */}
        <div className="min-w-0 w-full max-sm:mt-3">
          {isDesktop && <PlaylistPanel className="mb-3" />}
          {relatedSection}
        </div>
      </div>
    </div>
  );
}
