import { useEffect, useState, useRef, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { usePlayerStore } from '../stores/playerStore';
import { useRatingStore } from '../stores/ratingStore';
import SongCard from '../components/search/SongCard';
import StarRating from '../components/player/StarRating';
import {
  getRecommendedSongs,
  getMetadataSimilarSongs,
  getAudioSimilarSongs,
} from '../api/vocadb';
import type { Song } from '../types/vocadb';
import { useSelectionStore } from '../stores/selectionStore';

/** サムネイルURLを解決 */
function getThumbUrl(song: Song): string | null {
  if (song.thumbUrl) return song.thumbUrl;
  const yt = song.pvs?.find(pv => pv.service === 'Youtube');
  if (yt) return `https://img.youtube.com/vi/${yt.pvId}/hqdefault.jpg`;
  return null;
}

type TabKey = 'recommend' | 'related' | 'deepdig';

interface TabState {
  items: Song[];
  loading: boolean;
  hasMore: boolean;
  page: number;
}

const PAGE_SIZE = 20;

// タブ表示順を左から: おすすめ → 関連曲 → deep dig
const TAB_ORDER: TabKey[] = ['recommend', 'related', 'deepdig'];

const TAB_LABELS: Record<TabKey, string> = {
  recommend: 'おすすめ',
  related:   '関連曲',
  deepdig:   'deep dig',
};

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-xl overflow-hidden" style={{ background: 'var(--color-bg-card)' }}>
          <div className="aspect-video skeleton" />
          <div className="p-3 space-y-2">
            <div className="h-4 w-3/4 rounded skeleton" />
            <div className="h-3 w-1/2 rounded skeleton" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function NowPlayingPage() {
  const { currentSong, setQueue } = usePlayerStore();
  const { getRating, setRating } = useRatingStore();

  const [activeTab, setActiveTab] = useState<TabKey>('recommend');
  const [tabs, setTabs] = useState<Record<TabKey, TabState>>({
    recommend: { items: [], loading: false, hasMore: true, page: 0 },
    related:   { items: [], loading: false, hasMore: true, page: 0 },
    deepdig:   { items: [], loading: false, hasMore: true, page: 0 },
  });

  const fetchedForRef   = useRef<number | null>(null);
  const sentinelRef     = useRef<HTMLDivElement | null>(null);
  const seenRecommendRef = useRef<Set<number>>(new Set());
  const seenRelatedRef   = useRef<Set<number>>(new Set());
  const seenDeepdigRef   = useRef<Set<number>>(new Set());

  const setVisibleSongs = useSelectionStore(s => s.setVisibleSongs);

  // おすすめ: メタデータ + 音声データ + プレイヤーデータ (/api/recommend)
  const fetchRecommend = useCallback(async (song: Song, page: number) => {
    const songs = await getRecommendedSongs(
      song.id, PAGE_SIZE, undefined, 0.0, undefined, page * PAGE_SIZE
    );
    const fresh = songs.filter(s => !seenRecommendRef.current.has(s.id));
    fresh.forEach(s => seenRecommendRef.current.add(s.id));
    setTabs(prev => ({
      ...prev,
      recommend: {
        items:   page === 0 ? fresh : [...prev.recommend.items, ...fresh],
        loading: false,
        hasMore: songs.length >= PAGE_SIZE,
        page:    page + 1,
      },
    }));
  }, []);

  // 関連曲: メタデータベクトルのみ (/api/recommend/metadata)
  const fetchRelated = useCallback(async (song: Song, page: number) => {
    const songs = await getMetadataSimilarSongs(song.id, PAGE_SIZE, page * PAGE_SIZE);
    const fresh = songs.filter(s => !seenRelatedRef.current.has(s.id));
    fresh.forEach(s => seenRelatedRef.current.add(s.id));
    setTabs(prev => ({
      ...prev,
      related: {
        items:   page === 0 ? fresh : [...prev.related.items, ...fresh],
        loading: false,
        hasMore: songs.length >= PAGE_SIZE,
        page:    page + 1,
      },
    }));
  }, []);

  // deep dig: 音響ベクトルのみ (/api/recommend/audio)
  const fetchDeepdig = useCallback(async (song: Song, page: number) => {
    const songs = await getAudioSimilarSongs(song.id, PAGE_SIZE, page * PAGE_SIZE);
    const fresh = songs.filter(s => !seenDeepdigRef.current.has(s.id));
    fresh.forEach(s => seenDeepdigRef.current.add(s.id));
    setTabs(prev => ({
      ...prev,
      deepdig: {
        items:   page === 0 ? fresh : [...prev.deepdig.items, ...fresh],
        loading: false,
        hasMore: songs.length >= PAGE_SIZE,
        page:    page + 1,
      },
    }));
  }, []);

  useEffect(() => {
    if (!currentSong) return;
    if (fetchedForRef.current === currentSong.id) return;
    fetchedForRef.current = currentSong.id;
    seenRecommendRef.current = new Set([currentSong.id]);
    seenRelatedRef.current   = new Set([currentSong.id]);
    seenDeepdigRef.current   = new Set([currentSong.id]);

    setTabs({
      recommend: { items: [], loading: true, hasMore: true, page: 0 },
      related:   { items: [], loading: true, hasMore: true, page: 0 },
      deepdig:   { items: [], loading: true, hasMore: true, page: 0 },
    });

    fetchRecommend(currentSong, 0).catch(() =>
      setTabs(prev => ({ ...prev, recommend: { ...prev.recommend, loading: false, hasMore: false } }))
    );
    fetchRelated(currentSong, 0).catch(() =>
      setTabs(prev => ({ ...prev, related: { ...prev.related, loading: false, hasMore: false } }))
    );
    fetchDeepdig(currentSong, 0).catch(() =>
      setTabs(prev => ({ ...prev, deepdig: { ...prev.deepdig, loading: false, hasMore: false } }))
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSong?.id]);

  const loadMore = useCallback(() => {
    if (!currentSong) return;
    const tab = tabs[activeTab];
    if (tab.loading || !tab.hasMore) return;
    setTabs(prev => ({ ...prev, [activeTab]: { ...prev[activeTab], loading: true } }));
    if (activeTab === 'recommend') fetchRecommend(currentSong, tab.page);
    if (activeTab === 'related')   fetchRelated(currentSong, tab.page);
    if (activeTab === 'deepdig')   fetchDeepdig(currentSong, tab.page);
  }, [currentSong, tabs, activeTab, fetchRecommend, fetchRelated, fetchDeepdig]);

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

  // 現在のタブの表示曲をselectionStoreに登録（FABの全選択・フィルター用）
  const activeTabItems = tabs[activeTab].items;
  useEffect(() => {
    setVisibleSongs(activeTabItems);
  }, [activeTabItems, setVisibleSongs]);

  if (!currentSong) return <Navigate to="/" replace />;

  const thumbUrl = getThumbUrl(currentSong);
  const rating   = getRating(currentSong.id);
  const tab      = tabs[activeTab];

  return (
    <div>
      {/* 現在の曲フィーチャー */}
      <div
        className="flex gap-5 mb-8 p-5 rounded-2xl"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        <div
          className="flex-shrink-0 rounded-xl overflow-hidden"
          style={{ width: 120, height: 90, background: 'var(--color-surface-elevated)' }}
        >
          {thumbUrl ? (
            <img src={thumbUrl} alt={currentSong.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"
                   style={{ color: 'var(--color-text-muted)', opacity: 0.4 }}>
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
              </svg>
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(29,185,84,0.2)', color: '#1DB954' }}
            >
              ? 再生中
            </span>
          </div>
          <h1 className="text-lg font-bold truncate leading-tight mb-1"
              style={{ color: 'var(--color-text-primary)' }}>
            {currentSong.name}
          </h1>
          <p className="text-sm truncate mb-2" style={{ color: 'var(--color-text-secondary)' }}>
            {currentSong.artistString}
          </p>
          <StarRating
            rating={rating}
            onRate={(r) => setRating(currentSong.id, r)}
            size="sm"
          />
        </div>
      </div>

      {/* タブ */}
      <div className="flex gap-1 mb-4 p-1 rounded-xl" style={{ background: 'var(--color-surface)' }}>
        {TAB_ORDER.map(key => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className="flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200"
            style={{
              background: activeTab === key ? 'var(--gradient-primary)' : 'transparent',
              color:      activeTab === key ? '#fff' : 'var(--color-text-secondary)',
              cursor: 'pointer',
            }}
          >
            {TAB_LABELS[key]}
            {!tabs[key].loading && tabs[key].items.length > 0 && (
              <span className="ml-1 text-[10px] opacity-70">{tabs[key].items.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* コンテンツ */}
      {tab.loading && tab.items.length === 0 && <SkeletonGrid />}

      {!tab.loading && tab.items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3"
             style={{ color: 'var(--color-text-muted)' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.3 }}>
            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
          </svg>
          <p className="text-sm">
            {activeTab === 'deepdig' 
              ? 'この曲は音響データが未解析のため、deep dig機能には対応していません。' 
              : '曲が見つかりませんでした'}
          </p>
        </div>
      )}

      {tab.items.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {tab.items.map((song, index) => (
            <div key={song.id} className="animate-fade-in"
                 style={{ animationDelay: `${(index % PAGE_SIZE) * 25}ms` }}>
              <SongCard
                song={song}
                index={index}
                onPlay={(s) => setQueue([s], 0)}
              />
            </div>
          ))}
        </div>
      )}

      {/* 無限スクロールセンチネル */}
      <div ref={sentinelRef} className="h-8 mt-4 flex items-center justify-center">
        {tab.loading && tab.items.length > 0 && (
          <div className="w-5 h-5 rounded-full border-2 animate-spin"
               style={{ borderColor: 'var(--color-primary)', borderTopColor: 'transparent' }} />
        )}
      </div>
    </div>
  );
}
