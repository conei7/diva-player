import { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams, Navigate, useNavigate } from 'react-router-dom';
import VideoPlayer from '../components/watch/VideoPlayer';
import VideoInfo from '../components/watch/VideoInfo';
import ActionBar from '../components/watch/ActionBar';
import Description from '../components/watch/Description';
import FilterChips, { type RecTabKey } from '../components/watch/FilterChips';
import RecommendationList from '../components/watch/RecommendationList';
import { usePlayerStore } from '../stores/playerStore';
import { useHistoryStore } from '../stores/historyStore';
import { useRatingStore } from '../stores/ratingStore';
import {
  getSongById,
  getRecommendedSongs,
  getSongsByProducerFromBackend,
  getSimilarSongs,
  getRelatedSongs,
} from '../api/vocadb';
import type { Song } from '../types/vocadb';

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
  loading: boolean;
  hasMore: boolean;
  page: number;
}

const PAGE_SIZE = 40;

export default function WatchPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const songIdStr = searchParams.get('v');
  const songId = songIdStr ? Number(songIdStr) : null;

  const { currentSong, setQueue, replaceQueueList } = usePlayerStore();
  const { addToHistory } = useHistoryStore();
  const { ratings } = useRatingStore();

  const [song, setSong] = useState<Song | null>(null);
  const [loadingSong, setLoadingSong] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<RecTabKey>('producer');
  const [tabs, setTabs] = useState<Record<RecTabKey, TabState>>({
    producer: { items: [], loading: false, hasMore: true, page: 0 },
    related: { items: [], loading: false, hasMore: true, page: 0 },
    recommended: { items: [], loading: false, hasMore: true, page: 0 },
    deep: { items: [], loading: false, hasMore: true, page: 0 },
  });

  const fetchedForRef = useRef<number | null>(null);
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

    setLoadingSong(true);
    setError(null);
    setSong(null);

    // タブリセット
    setTabs({
      producer: { items: [], loading: true, hasMore: true, page: 0 },
      related: { items: [], loading: true, hasMore: true, page: 0 },
      recommended: { items: [], loading: true, hasMore: true, page: 0 },
      deep: { items: [], loading: true, hasMore: true, page: 0 },
    });
    seenSets.current = {
      producer: new Set([songId]),
      related: new Set([songId]),
      recommended: new Set([songId]),
      deep: new Set([songId]),
    };

    getSongById(songId)
      .then((loadedSong) => {
        setSong(loadedSong);
        setLoadingSong(false);

        // 再生開始（現在の曲と違う場合のみ）
        if (currentSong?.id !== loadedSong.id) {
          setQueue([loadedSong], 0);
        }

        addToHistory(loadedSong);

        // 推薦データの取得
        fetchProducer(loadedSong, 0);
        fetchRelated(loadedSong, 0);
        fetchRecommended(loadedSong, 0);
        fetchDeep(loadedSong, 0);
      })
      .catch((err) => {
        setError(err.message || '楽曲の読み込みに失敗しました');
        setLoadingSong(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId]);

  // --- フェッチ関数 ---

  const fetchProducer = useCallback(async (s: Song, page: number) => {
    try {
      const producerIds = (s.artists ?? [])
        .filter(a => a.categories === 'Producer')
        .map(a => a.artist?.id)
        .filter((id): id is number => id !== undefined);

      const items = await getSongsByProducerFromBackend(s.id, producerIds, PAGE_SIZE, page * PAGE_SIZE);
      const fresh = items.filter(item => !seenSets.current.producer.has(item.id));
      fresh.forEach(item => seenSets.current.producer.add(item.id));

      setTabs(prev => ({
        ...prev,
        producer: {
          items: page === 0 ? fresh : [...prev.producer.items, ...fresh],
          loading: false,
          hasMore: items.length >= PAGE_SIZE,
          page: page + 1,
        },
      }));
    } catch {
      setTabs(prev => ({ ...prev, producer: { ...prev.producer, loading: false, hasMore: false } }));
    }
  }, []);

  const fetchRelated = useCallback(async (s: Song, page: number) => {
    try {
      const items = await getRelatedSongs(s.id);
      const fresh = items.filter(item => !seenSets.current.related.has(item.id));
      fresh.forEach(item => seenSets.current.related.add(item.id));

      setTabs(prev => ({
        ...prev,
        related: {
          items: page === 0 ? fresh : [...prev.related.items, ...fresh],
          loading: false,
          hasMore: false, // VocaDB /related はページネーションなし
          page: page + 1,
        },
      }));
    } catch {
      setTabs(prev => ({ ...prev, related: { ...prev.related, loading: false, hasMore: false } }));
    }
  }, []);

  const fetchRecommended = useCallback(async (s: Song, page: number) => {
    try {
      const items = await getRecommendedSongs(s.id, PAGE_SIZE, undefined, 0.0, ratings, page * PAGE_SIZE);
      const fresh = items.filter(item => !seenSets.current.recommended.has(item.id));
      fresh.forEach(item => seenSets.current.recommended.add(item.id));

      setTabs(prev => ({
        ...prev,
        recommended: {
          items: page === 0 ? fresh : [...prev.recommended.items, ...fresh],
          loading: false,
          hasMore: items.length >= PAGE_SIZE,
          page: page + 1,
        },
      }));
    } catch {
      setTabs(prev => ({ ...prev, recommended: { ...prev.recommended, loading: false, hasMore: false } }));
    }
  }, [ratings]);

  const fetchDeep = useCallback(async (s: Song, page: number) => {
    try {
      const items = await getSimilarSongs(s.id, PAGE_SIZE, page * PAGE_SIZE);
      const fresh = items.filter(item => !seenSets.current.deep.has(item.id));
      fresh.forEach(item => seenSets.current.deep.add(item.id));

      setTabs(prev => ({
        ...prev,
        deep: {
          items: page === 0 ? fresh : [...prev.deep.items, ...fresh],
          loading: false,
          hasMore: items.length >= PAGE_SIZE,
          page: page + 1,
        },
      }));
    } catch {
      setTabs(prev => ({ ...prev, deep: { ...prev.deep, loading: false, hasMore: false } }));
    }
  }, []);

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

  // タブのデータが変わるか、songが変わったらキューを更新 (YouTubeのMixリスト風)
  useEffect(() => {
    if (song && currentTab.items.length > 0) {
      replaceQueueList([song, ...currentTab.items]);
    }
  }, [song, currentTab.items, replaceQueueList]);

  // 動画が自動再生で次に進んだ場合などにURLを同期する
  useEffect(() => {
    if (currentSong && songId && currentSong.id !== songId) {
      navigate(`/watch?v=${currentSong.id}`);
    }
  }, [currentSong?.id, songId, navigate]);

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
            {/* フィルターチップス */}
            <div className="sticky z-30 pb-2 pt-2 -mx-2 px-2 bg-[#0f0f0f]" style={{ top: 'var(--header-height)' }}>
              <FilterChips
                activeTab={activeTab}
                onTabChange={setActiveTab}
                counts={counts}
              />
            </div>

            {/* 推薦リスト */}
            <RecommendationList
              songs={currentTab.items}
              loading={currentTab.loading}
              hasMore={currentTab.hasMore}
            />

            {/* 無限スクロールセンチネル */}
            <div ref={sentinelRef} className="h-8 mt-4" />
          </div>
        </div>
      )}
    </div>
  );
}
