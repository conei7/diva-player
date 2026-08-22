import { useEffect, useState, useRef, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSearchParams, Navigate, useNavigate } from 'react-router';
import VideoPlayer from '../components/watch/VideoPlayer';
import VideoInfo from '../components/watch/VideoInfo';
import ActionBar from '../components/watch/ActionBar';
import Description from '../components/watch/Description';
import FilterChips, { type RecTabKey } from '../components/watch/FilterChips';
import RecommendationList from '../components/watch/RecommendationList';
import { usePlayerStore } from '../stores/playerStore';
import { useRatingStore } from '../stores/ratingStore';
import { useHistoryStore } from '../stores/historyStore';
import { usePlaylistStore } from '../stores/playlistStore';
import { useImplicitFeedbackStore } from '../stores/implicitFeedbackStore';
import {
  getSongById,
  getRecommendedSongs,
  getSongsByProducerFromBackend,
  getSongsByProducer,
  getAudioSimilarSongs,
  getMetadataSimilarSongs,
  attachExternalViews,
} from '../api/vocadb';
import type { Song } from '../types/vocadb';
import { useSelectionStore } from '../stores/selectionStore';
import QueueSidebar from '../components/player/QueueSidebar';
import { rerankRecommendationCandidatesDetailed } from '../utils/recommendationReranking';
import { useRecommendationDebugStore } from '../stores/recommendationDebugStore';
import { createRankingSeed } from '../utils/rankingRandomization';
import { rerankDisplayedSongs, useRecommendationExposureStore } from '../stores/recommendationExposureStore';
import { useGlobalFilterStore } from '../stores/globalFilterStore';
import { useFavoriteProducerStore } from '../stores/favoriteProducerStore';
import { useUiStore } from '../stores/uiStore';
import {
  filterDiscoverySourcePage,
  getDiscoveryRelaxationMessage,
  isDiscoveryFilterActive,
  requiresExternalViewCounts,
  type DiscoveryRelaxedCondition,
} from '../utils/globalFilters';
import { excludeHiddenSongs, useHiddenSongStore } from '../stores/hiddenSongStore';
import { getPlaybackOwnership } from '../services/playbackOwnership';
import { fetchProgressivePages } from '../utils/progressivePageFetch';

function WatchQueue() {
  const queue = usePlayerStore(s => s.queue);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const queueTitle = usePlayerStore(s => s.queueTitle);
  const openSaveToPlaylist = useUiStore(s => s.openSaveToPlaylist);
  const [expanded, setExpanded] = useState(false);

  if (queue.length <= 1) return null;
  const nextSong = queue[queueIndex + 1];

  return (
    <div className="mb-4 rounded-xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
      <div className="flex items-center transition-colors hover:bg-white/5">
        <button
          className="flex min-w-0 flex-1 items-center justify-between px-4 py-3"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          <div className="min-w-0 text-left">
            <h3 className="truncate text-sm font-semibold max-w-[180px] sm:max-w-[280px]" style={{ color: 'var(--color-text-primary)' }}>
              次: {nextSong?.name || '終了'}
            </h3>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>{queueTitle} - {queueIndex + 1}/{queue.length}曲</p>
          </div>
          <svg
            width="24" height="24" viewBox="0 0 24 24" fill="currentColor"
            className={`ml-2 shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          >
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </button>
        <button
          type="button"
          className="btn-ghost mr-2 shrink-0 rounded-lg p-2"
          onClick={() => openSaveToPlaylist(queue, { source: 'queue', queueIndex })}
          title="キューをプレイリストに保存"
          aria-label="キューをプレイリストに保存"
          style={{ color: 'var(--color-accent-cyan)' }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
            <path d="M4 4h16v16H4z" opacity=".35" />
          </svg>
        </button>
      </div>
      
      {expanded && (
        <div className="border-t" style={{ borderColor: 'var(--color-border)', height: 'min(400px, 50dvh)' }}>
          <QueueSidebar hideHeader={true} />
        </div>
      )}
    </div>
  );
}

/**
 * WatchPage - YouTube風の再生画面 (/watch?v=楽曲ID)
 *
 * 2ペイン構成:
 * - 左: VideoPlayer + VideoInfo + ActionBar + Description
 * - 右: FilterChips + RecommendationList
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
}

const PAGE_SIZE = 40;
const INITIAL_REFILL_PAGES = 3;

function mergeUniqueSongs(groups: Song[][]): Song[] {
  const seen = new Set<number>();
  return groups.flat().filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export default function WatchPage() {
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

  const { currentSong, setQueue, setRootSeed, resume } = usePlayerStore();
  const currentSongId = currentSong?.id;
  const { ratings } = useRatingStore();
  const { entries } = useHistoryStore();
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
  const filterDiscoverySongs = useCallback((items: Song[], minimumCount = PAGE_SIZE, allowRelaxation = true) => {
    const candidates = excludeHiddenSongs(items, hiddenSongs);
    const context = {
      settings: globalFilterSettings,
      ratings,
      lastPlayedAtBySongId: new Map(entries.map(entry => [entry.song.id, entry.playedAt] as const)),
    };
    return filterDiscoverySourcePage(candidates, context, minimumCount, allowRelaxation);
  }, [entries, globalFilterSettings, hiddenSongs, ratings]);

  const [song, setSong] = useState<Song | null>(null);
  const [loadingSong, setLoadingSong] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const setVisibleSongs = useSelectionStore(s => s.setVisibleSongs);

  const [activeTab, setActiveTab] = useState<RecTabKey>('recommended');
  const [tabs, setTabs] = useState<Record<RecTabKey, TabState>>({
    producer: { items: [], relaxedConditions: [], loading: false, hasMore: true, page: 0 },
    related: { items: [], relaxedConditions: [], loading: false, hasMore: true, page: 0 },
    recommended: { items: [], relaxedConditions: [], loading: false, hasMore: true, page: 0 },
    deep: { items: [], relaxedConditions: [], loading: false, hasMore: true, page: 0 },
  });

  const fetchedForRef = useRef<number | null>(null);
  const randomOffsetRef = useRef(Math.floor(Math.random() * 20));
  const rankingSeedRef = useRef(createRankingSeed());
  // URLからのロード中はナビゲーションエフェクトをブロックするフラグ
  const loadingFromUrlRef = useRef(false);
  const seenSets = useRef<Record<RecTabKey, Set<number>>>({
    producer: new Set(),
    related: new Set(),
    recommended: new Set(),
    deep: new Set(),
  });

  const sentinelRef = useRef<HTMLDivElement>(null);

  // 曲をロード & 再生開始
  useEffect(() => {
    if (!songId) return;
    if (fetchedForRef.current === songId) return;
    fetchedForRef.current = songId;
    randomOffsetRef.current = Math.floor(Math.random() * 20);
    rankingSeedRef.current = createRankingSeed();
    loadingFromUrlRef.current = true;

    setLoadingSong(true);
    setError(null);
    setSong(null);

    // タブリセット
    setTabs({
      producer: { items: [], relaxedConditions: [], loading: true, hasMore: true, page: 0 },
      related: { items: [], relaxedConditions: [], loading: true, hasMore: true, page: 0 },
      recommended: { items: [], relaxedConditions: [], loading: true, hasMore: true, page: 0 },
      deep: { items: [], relaxedConditions: [], loading: true, hasMore: true, page: 0 },
    });
    seenSets.current = {
      producer: new Set([songId]),
      related: new Set([songId]),
      recommended: new Set([songId]),
      deep: new Set([songId]),
    };

    getSongById(songId)
      .then((loadedSong) => {
        loadingFromUrlRef.current = false;
        setSong(loadedSong);
        setLoadingSong(false);

        // 再生開始（現在の曲と違う場合のみ）
        if (currentSong?.id !== loadedSong.id) {
          setRootSeed(loadedSong); // ユーザーが能動的に選んだ曲をRoot Seedに
          setQueue([loadedSong], 0, shouldAutoplay);
        } else if (shouldAutoplay) {
          resume();
        }

        // 推薦データの取得
        fetchProducer(loadedSong, 0);
        fetchRelated(loadedSong, 0);
        fetchRecommended(loadedSong, 0);
        fetchDeep(loadedSong, 0);
      })
      .catch((err) => {
        loadingFromUrlRef.current = false;
        setError(err.message || '楽曲の読み込みに失敗しました');
        setLoadingSong(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId]);

  // --- フェッチ関数 ---

  useEffect(() => {
    if (!song || !songId || loadingFromUrlRef.current) return;
    setTabs({
      producer: { items: [], relaxedConditions: [], loading: true, hasMore: true, page: 0 },
      related: { items: [], relaxedConditions: [], loading: true, hasMore: true, page: 0 },
      recommended: { items: [], relaxedConditions: [], loading: true, hasMore: true, page: 0 },
      deep: { items: [], relaxedConditions: [], loading: true, hasMore: true, page: 0 },
    });
    seenSets.current = {
      producer: new Set([song.id]),
      related: new Set([song.id]),
      recommended: new Set([song.id]),
      deep: new Set([song.id]),
    };
    fetchProducer(song, 0);
    fetchRelated(song, 0);
    fetchRecommended(song, 0);
    fetchDeep(song, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilterSettings]);

  const fetchProducer = useCallback(async (s: Song, page: number) => {
    try {
      const producerIds = (s.artists ?? [])
        .filter(a => a.categories?.includes('Producer'))
        .map(a => a.artist?.id)
        .filter((id): id is number => id !== undefined);

      // Producer pagination is already popularity-ordered by the backend.
      // Applying the mix tab's random offset here skipped the first page and
      // made the same-P tab appear to miss songs when its pool was small.
      const producerSongs = await getSongsByProducerFromBackend(s.id, producerIds, PAGE_SIZE, page * PAGE_SIZE);
      const filtered = filterDiscoverySongs(
        requiresExternalViewCounts(globalFilterSettings) ? await attachExternalViews(producerSongs) : producerSongs,
        PAGE_SIZE,
        producerSongs.length < PAGE_SIZE,
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
          hasMore: producerSongs.length >= PAGE_SIZE,
          page: page + 1,
        },
      }));
    } catch {
      setTabs(prev => ({ ...prev, producer: { ...prev.producer, loading: false, hasMore: false } }));
    }
  }, [filterDiscoverySongs, globalFilterSettings]);

  const fetchRelated = useCallback(async (s: Song, page: number) => {
    try {
      const { pages: relatedPages, nextPage } = await fetchProgressivePages({
        startPage: page,
        maxPages: page === 0 ? INITIAL_REFILL_PAGES : 1,
        fetchPage: async sourcePage => {
          const source = await getMetadataSimilarSongs(
            s.id,
            PAGE_SIZE * 2,
            sourcePage * PAGE_SIZE * 2,
          );
          return requiresExternalViewCounts(globalFilterSettings)
            ? await attachExternalViews(source)
            : source;
        },
        needsMore: pages => {
          const sourceExhausted = pages[pages.length - 1].length < PAGE_SIZE * 2;
          if (sourceExhausted) return false;
          return filterDiscoverySongs(
            mergeUniqueSongs(pages),
            PAGE_SIZE,
            false,
          ).items.length < PAGE_SIZE;
        },
      });
      const relatedSongs = mergeUniqueSongs(relatedPages);
      const sourceExhausted = relatedPages[relatedPages.length - 1].length < PAGE_SIZE * 2;
      const filtered = filterDiscoverySongs(
        relatedSongs,
        PAGE_SIZE,
        sourceExhausted,
      );
      const items = rerankDisplayedSongs(
        filtered.items.slice(0, PAGE_SIZE),
        rankingSeedRef.current,
      );
      const fresh = items.filter(item => !seenSets.current.related.has(item.id));
      fresh.forEach(item => seenSets.current.related.add(item.id));

      setTabs(prev => ({
        ...prev,
        related: {
          items: page === 0 ? fresh : [...prev.related.items, ...fresh],
          relaxedConditions: page === 0
            ? filtered.relaxedConditions
            : [...new Set([...prev.related.relaxedConditions, ...filtered.relaxedConditions])],
          loading: false,
          hasMore: !sourceExhausted,
          page: nextPage,
        },
      }));
    } catch {
      setTabs(prev => ({ ...prev, related: { ...prev.related, loading: false, hasMore: false } }));
    }
  }, [filterDiscoverySongs, globalFilterSettings]);

  const fetchRecommended = useCallback(async (s: Song, page: number) => {
    try {
      type SourcePage = [Song[], Song[], Song[]];
      const rankSources = (sourcePages: SourcePage[]) => {
        const hybrid = mergeUniqueSongs(sourcePages.map(result => result[0]));
        const audio = mergeUniqueSongs(sourcePages.map(result => result[1]));
        const favorite = mergeUniqueSongs(sourcePages.map(result => result[2]));
        const lastPage = sourcePages[sourcePages.length - 1];
        const sourceExhausted = lastPage[0].length < PAGE_SIZE * 2
          && lastPage[1].length < PAGE_SIZE
          && lastPage[2].length < PAGE_SIZE;
        const hybridFiltered = filterDiscoverySongs([...favorite, ...hybrid], PAGE_SIZE, sourceExhausted);
        const audioFiltered = filterDiscoverySongs(audio, 4, sourceExhausted);
        const detailed = rerankRecommendationCandidatesDetailed({
          hybrid: hybridFiltered.items,
          audio: audioFiltered.items,
        }, {
          total: PAGE_SIZE,
          historyEntries: entries,
          playlists,
          ratings,
          implicitFeedback,
          excludeIds: new Set([s.id]),
          rankingSeed: rankingSeedRef.current,
          explorationStrength: 0.06,
          exposureEntries: useRecommendationExposureStore.getState().entries,
          favoriteProducerIds: new Set(favoriteProducers.map(producer => producer.id)),
        });
        return {
          detailed,
          sourceExhausted,
          relaxedConditions: [...new Set([
            ...hybridFiltered.relaxedConditions,
            ...audioFiltered.relaxedConditions,
          ])],
        };
      };

      const { pages: pageResults, nextPage } = await fetchProgressivePages<SourcePage>({
        startPage: page,
        maxPages: page === 0 ? INITIAL_REFILL_PAGES : 1,
        fetchPage: async sourcePage => {
          const offset = randomOffsetRef.current + sourcePage * PAGE_SIZE * 2;
          const raw = await Promise.all([
            getRecommendedSongs(s.id, PAGE_SIZE * 2, 0.0, ratings, offset),
            getAudioSimilarSongs(s.id, PAGE_SIZE, offset),
            Promise.all(favoriteProducers.map(producer =>
              getSongsByProducer([producer.id], 0, PAGE_SIZE, sourcePage * PAGE_SIZE)
                .then(result => result.items)
                .catch(() => [] as Song[]),
            )).then(results => results.flat()),
          ]);
          if (!requiresExternalViewCounts(globalFilterSettings)) return raw as SourcePage;
          return await Promise.all(raw.map(items => attachExternalViews(items))) as SourcePage;
        },
        needsMore: sourcePages => {
          const ranked = rankSources(sourcePages);
          return !ranked.sourceExhausted && ranked.detailed.ranked.length < PAGE_SIZE;
        },
      });
      const { detailed, sourceExhausted, relaxedConditions } = rankSources(pageResults);
      const mixed = detailed.ranked;
      const items = mixed.map(item => item.song);
      const fresh = items.filter(item => !seenSets.current.recommended.has(item.id));
      fresh.forEach(item => seenSets.current.recommended.add(item.id));
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
          hasMore: !sourceExhausted,
          page: nextPage,
        },
      }));
    } catch {
      setTabs(prev => ({ ...prev, recommended: { ...prev.recommended, loading: false, hasMore: false } }));
    }
  }, [entries, favoriteProducers, globalFilterSettings, implicitFeedback, playlists, ratings, filterDiscoverySongs]);

  const fetchDeep = useCallback(async (s: Song, page: number) => {
    try {
      const deepSongs = await getAudioSimilarSongs(s.id, PAGE_SIZE, page * PAGE_SIZE);
      const filtered = filterDiscoverySongs(
        requiresExternalViewCounts(globalFilterSettings) ? await attachExternalViews(deepSongs) : deepSongs,
        PAGE_SIZE,
        deepSongs.length < PAGE_SIZE,
      );
      const items = rerankDisplayedSongs(
        filtered.items,
        rankingSeedRef.current,
      );
      const fresh = items.filter(item => !seenSets.current.deep.has(item.id));
      fresh.forEach(item => seenSets.current.deep.add(item.id));

      setTabs(prev => ({
        ...prev,
        deep: {
          items: page === 0 ? fresh : [...prev.deep.items, ...fresh],
          relaxedConditions: page === 0
            ? filtered.relaxedConditions
            : [...new Set([...prev.deep.relaxedConditions, ...filtered.relaxedConditions])],
          loading: false,
          hasMore: deepSongs.length >= PAGE_SIZE,
          page: page + 1,
        },
      }));
    } catch {
      setTabs(prev => ({ ...prev, deep: { ...prev.deep, loading: false, hasMore: false } }));
    }
  }, [filterDiscoverySongs, globalFilterSettings]);

  // 追加読み込み
  const loadMore = useCallback(() => {
    if (!song) return;
    const tab = tabs[activeTab];
    if (tab.loading || !tab.hasMore) return;

    setTabs(prev => ({ ...prev, [activeTab]: { ...prev[activeTab], loading: true } }));

    switch (activeTab) {
      case 'producer': fetchProducer(song, tab.page); break;
      case 'related': fetchRelated(song, tab.page); break;
      case 'recommended': fetchRecommended(song, tab.page); break;
      case 'deep': fetchDeep(song, tab.page); break;
    }
  }, [song, tabs, activeTab, fetchProducer, fetchRelated, fetchRecommended, fetchDeep]);

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
  const relaxationMessage = getDiscoveryRelaxationMessage(currentTab.relaxedConditions);



  // 現在のタブの表示曲をselectionStoreに登録（FABの全選択・フィルター用）
  useEffect(() => {
    setVisibleSongs(displayTabItems);
  }, [displayTabItems, setVisibleSongs]);

  // 動画が自動再生で次に進んだ場合などにURLを同期する
  // loadingFromUrlRef が true の間 (URL変更後のフェッチ中) はナビゲートしない
  useEffect(() => {
    if (loadingFromUrlRef.current) return;
    if (currentSongId && songId && currentSongId !== songId) {
      navigate(`/watch?v=${currentSongId}`);
    }
  }, [currentSongId, songId, navigate]);

  // songId がない場合はホームへ
  if (!songId) return <Navigate to="/" replace />;

  const counts: Record<RecTabKey, number> = {
    producer: tabs.producer.items.length,
    related: tabs.related.items.length,
    recommended: tabs.recommended.items.length,
    deep: tabs.deep.items.length,
  };

  return (
    <div className="w-full px-4 lg:px-6 py-4">
      {/* ローディング */}
      {loadingSong && (
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1 min-w-0">
            <div className="video-player-wrapper skeleton" style={{ borderRadius: '12px' }} />
            <div className="mt-3 space-y-2">
              <div className="h-6 w-3/4 rounded skeleton" />
              <div className="h-4 w-1/2 rounded skeleton" />
            </div>
          </div>
          <div className="lg:w-96 xl:w-[420px] flex-shrink-0 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex gap-2">
                <div className="w-40 rounded-lg skeleton" style={{ aspectRatio: '16/9' }} />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-full rounded skeleton" />
                  <div className="h-3 w-3/4 rounded skeleton" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* エラー */}
      {error && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-error)', opacity: 0.5 }}>
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
          </svg>
          <p className="text-base" style={{ color: 'var(--color-text-muted)' }}>{error}</p>
        </div>
      )}

      {/* メインコンテンツ */}
      {song && !loadingSong && (
        <div className="flex flex-col lg:flex-row gap-6">

          {/* ─── 左: メインプレイヤーエリア ─── */}
          <div className="flex-1 min-w-0">
            {/* YouTube Player */}
            <VideoPlayer />

            {/* タイトル + メタデータ */}
            <VideoInfo song={song} />

            {/* アクションバー (5段階星評価) */}
            <ActionBar song={song} />

            {/* 概要欄 */}
            <Description song={song} />
          </div>

          {/* ─── 右: 推薦リスト ─── */}
          <div className="lg:w-96 xl:w-[420px] flex-shrink-0">
            
            {/* キュー (ミックスリスト) */}
            <WatchQueue />

            {/* フィルターチップス */}
            <div className="sticky z-30 pb-2 pt-2 -mx-2 px-2 bg-[#0f0f0f]" style={{ top: 'var(--header-height)' }}>
              <FilterChips
                activeTab={activeTab}
                onTabChange={setActiveTab}
                counts={counts}
              />
            </div>

            {/* 推薦リスト */}
            {relaxationMessage && (
              <p
                className="mb-2 rounded-lg border px-3 py-2 text-xs"
                role="status"
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)', background: 'var(--color-surface)' }}
              >
                {relaxationMessage}
              </p>
            )}
            <RecommendationList
              songs={displayTabItems}
              loading={currentTab.loading}
              hasMore={currentTab.hasMore}
              recommendationReasons={activeTab === 'recommended' ? currentTab.reasons : undefined}
              exposureSurface={activeTab === 'producer' ? 'watch-producer' : activeTab === 'related' ? 'watch-related' : activeTab === 'recommended' ? 'watch-recommended' : 'watch-deep'}
              emptyMessage={isDiscoveryFilterActive(globalFilterSettings)
                ? '現在の表示・発見フィルターに一致する候補がありません。設定から条件を調整してください。'
                : undefined}
            />

            {/* 無限スクロールセンチネル */}
            <div ref={sentinelRef} className="h-8 mt-4" />
          </div>
        </div>
      )}
    </div>
  );
}
