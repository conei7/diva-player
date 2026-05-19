import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import CategoryChips, { type CategoryChip } from '../components/home/CategoryChips';
import VideoGrid from '../components/home/VideoGrid';
import { searchSongs, getTopSongs, getRecommendedSongs } from '../api/vocadb';
import { useHistoryStore } from '../stores/historyStore';
import { usePlayerStore } from '../stores/playerStore';
import { useRatingStore } from '../stores/ratingStore';
import type { Song } from '../types/vocadb';

/**
 * HomePage - YouTube風ホーム画面
 *
 * カテゴリーチップでフィルター切替 + レスポンシブ動画グリッド
 * 無限スクロールで追加読み込み
 */

const CATEGORIES: CategoryChip[] = [
  { id: 'all', label: 'すべて' },
  { id: 'recommended', label: 'AI あなたへのおすすめ' },
  { id: 'trending', label: '人気急上昇' },
  { id: 'recent', label: '最近の投稿' },
  { id: 'deep', label: 'マイナー発掘 (Deep Dig)' },
  { id: 'history_based', label: '最近聴いたPの曲' },
];

const PAGE_SIZE = 24;

export default function HomePage() {
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('q') || '';
  const artistIdParam = searchParams.get('artistId');
  const artistNameParam = searchParams.get('artistName') || '';

  const [activeCategory, setActiveCategory] = useState('all');
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchingRef = useRef(false);
  const { entries } = useHistoryStore();
  const { currentSong } = usePlayerStore();
  const { ratings } = useRatingStore();

  // 検索 or アーティストフィルターモード
  const isSearchMode = searchQuery.length > 0;
  const isArtistMode = !!artistIdParam;

  const fetchSongs = useCallback(async (category: string, pageNum: number, query: string) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    try {
      let result: Song[] = [];

      if (artistIdParam) {
        // アーティストフィルターモード
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
        // 検索モード
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
          case 'all': {
            const searchResult = await searchSongs({
              sort: 'FavoritedTimes',
              maxResults: PAGE_SIZE,
              start: pageNum * PAGE_SIZE,
              getTotalCount: false,
              onlyWithPVs: true,
            });
            result = searchResult.items;
            break;
          }
          case 'recommended': {
            const seedId = currentSong?.id || entries[0]?.song?.id;
            if (seedId) {
              result = await getRecommendedSongs(seedId, PAGE_SIZE, undefined, 0.0, ratings, pageNum * PAGE_SIZE);
            } else {
              // フォールバック: 人気曲
              result = await getTopSongs(720, PAGE_SIZE);
            }
            break;
          }
          case 'trending': {
            result = await getTopSongs(168, PAGE_SIZE); // 1週間
            break;
          }
          case 'recent': {
            const searchResult = await searchSongs({
              sort: 'PublishDate',
              maxResults: PAGE_SIZE,
              start: pageNum * PAGE_SIZE,
              getTotalCount: false,
              onlyWithPVs: true,
            });
            result = searchResult.items;
            break;
          }
          case 'deep': {
            // マイナー: スコアが低いがPVありの曲を発掘
            const searchResult = await searchSongs({
              sort: 'AdditionDate',
              maxResults: PAGE_SIZE,
              start: pageNum * PAGE_SIZE + Math.floor(Math.random() * 100), // ランダムオフセット
              getTotalCount: false,
              onlyWithPVs: true,
            });
            result = searchResult.items;
            break;
          }
          case 'history_based': {
            // 最近聴いたPの曲
            const recentSong = entries[0]?.song;
            if (recentSong) {
              const producers = recentSong.artists?.filter(a => a.categories?.includes('Producer')).map(a => a.artist?.id).filter(Boolean) as number[];
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
            }
            if (result.length === 0) {
              result = await getTopSongs(720, PAGE_SIZE);
            }
            break;
          }
        }
      }

      if (pageNum === 0) {
        setSongs(result);
      } else {
        setSongs(prev => {
          const existingIds = new Set(prev.map(s => s.id));
          const newSongs = result.filter(s => !existingIds.has(s.id));
          return [...prev, ...newSongs];
        });
      }
      setHasMore(result.length >= PAGE_SIZE);
    } catch (error) {
      console.error('Failed to fetch songs:', error);
      setHasMore(false);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [currentSong?.id, entries, ratings, artistIdParam]);

  // カテゴリーまたは検索クエリ変更時に再取得
  useEffect(() => {
    setLoading(true);
    setSongs([]);
    setPage(0);
    setHasMore(true);
    fetchSongs(activeCategory, 0, searchQuery);
  }, [activeCategory, searchQuery, fetchSongs, artistIdParam]);

  // 無限スクロール
  const loadMore = useCallback(() => {
    if (loading || !hasMore || fetchingRef.current) return;
    const nextPage = page + 1;
    setPage(nextPage);
    setLoading(true);
    fetchSongs(activeCategory, nextPage, searchQuery);
  }, [loading, hasMore, page, activeCategory, searchQuery, fetchSongs]);

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

  return (
    <div className="w-full px-4 sm:px-6 lg:px-8 py-4">
      {/* 検索モードヘッダー */}
      {isSearchMode && (
        <div className="mb-6">
          <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--color-text-primary)' }}>
            「{searchQuery}」の検索結果
          </h1>
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {songs.length} 件の楽曲
          </p>
        </div>
      )}

      {/* アーティストモードヘッダー */}
      {isArtistMode && !isSearchMode && (
        <div className="mb-6">
          <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--color-text-primary)' }}>
            {decodeURIComponent(artistNameParam)} の楽曲
          </h1>
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {songs.length} 件
          </p>
        </div>
      )}

      {/* カテゴリーチップ（検索モードでは非表示） */}
      {!isSearchMode && !isArtistMode && (
        <div 
          className="sticky z-20 pb-2 pt-3 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8" 
          style={{ top: 'var(--header-height)', background: 'var(--color-bg-primary)' }}
        >
          <CategoryChips
            chips={CATEGORIES}
            activeChip={activeCategory}
            onSelect={setActiveCategory}
          />
        </div>
      )}

      {/* 動画グリッド */}
      <VideoGrid
        songs={songs}
        loading={loading}
      />

      {/* 無限スクロールセンチネル */}
      <div ref={sentinelRef} className="h-8 mt-6 flex items-center justify-center">
        {loading && songs.length > 0 && (
          <div
            className="w-6 h-6 rounded-full border-2 animate-spin"
            style={{ borderColor: 'var(--color-accent-cyan)', borderTopColor: 'transparent' }}
          />
        )}
      </div>
    </div>
  );
}
