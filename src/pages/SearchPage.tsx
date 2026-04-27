import { useEffect, useCallback, useState, useRef } from 'react';
import SearchBar from '../components/search/SearchBar';
import SearchFilters from '../components/search/SearchFilters';
import SongCard from '../components/search/SongCard';
import { useSearchStore } from '../stores/searchStore';
import { usePlayerStore } from '../stores/playerStore';
import { searchSongs } from '../api/vocadb';
import type { Song } from '../types/vocadb';

/**
 * SearchPage - メイン検索ページ
 * 
 * 初期状態では人気曲を表示。検索するとVocaDB APIの結果を表示。
 */
export default function SearchPage() {
  const { results, isLoading, error, hasSearched, loadMore, totalCount } = useSearchStore();
  const { addToQueue } = usePlayerStore();
  const [topSongs, setTopSongs] = useState<Song[]>([]);
  const [topLoading, setTopLoading] = useState(true);
  const fetchedRef = useRef(false);

  // 初回: 人気曲ロード（通常検索APIをFavoritedTimesソートで代用）
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    searchSongs({
      query: '',
      sort: 'FavoritedTimes',
      maxResults: 24,
      start: 0,
      getTotalCount: false,
      onlyWithPVs: true,
    })
      .then((result) => {
        setTopSongs(result.items);
        setTopLoading(false);
      })
      .catch(() => {
        setTopLoading(false);
      });
  }, []);

  const handleAddToQueue = useCallback((song: Song) => {
    addToQueue(song);
  }, [addToQueue]);

  // もっと読み込む
  const hasMore = hasSearched && results.length < totalCount;

  const displaySongs = hasSearched ? results : topSongs;
  const displayLoading = hasSearched ? isLoading : topLoading;

  return (
    <div className="space-y-6">
      {/* ヒーローセクション */}
      <div className="text-center py-8">
        <h1 className="text-3xl sm:text-4xl font-bold mb-3">
          <span className="glow-text" style={{ color: 'var(--color-accent-cyan)' }}>ボカロ</span>
          <span>ミュージックを探す</span>
        </h1>
        <p className="text-sm max-w-md mx-auto" style={{ color: 'var(--color-text-secondary)' }}>
          VocaDB のデータベースからボカロ曲を検索・再生
        </p>
      </div>

      {/* 検索バー */}
      <SearchBar />

      {/* フィルター */}
      {hasSearched && <SearchFilters />}

      {/* エラー表示 */}
      {error && (
        <div className="rounded-xl p-4 text-center animate-fade-in"
             style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
          <p className="text-sm" style={{ color: 'var(--color-error)' }}>{error}</p>
        </div>
      )}

      {/* セクションタイトル */}
      {!hasSearched && !topLoading && topSongs.length > 0 && (
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 rounded-full" style={{ background: 'var(--gradient-primary)' }} />
          <h2 className="text-lg font-semibold">🔥 人気のボカロ曲</h2>
        </div>
      )}

      {/* ローディングスケルトン */}
      {displayLoading && displaySongs.length === 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="rounded-xl overflow-hidden" style={{ background: 'var(--color-bg-card)' }}>
              <div className="aspect-video skeleton" />
              <div className="p-3 space-y-2">
                <div className="h-4 w-3/4 rounded skeleton" />
                <div className="h-3 w-1/2 rounded skeleton" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 結果グリッド */}
      {displaySongs.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {displaySongs.map((song, index) => (
            <div key={song.id} className="animate-fade-in" style={{ animationDelay: `${index * 30}ms` }}>
              <SongCard
                song={song}
                index={index}
                onAddToQueue={handleAddToQueue}
              />
            </div>
          ))}
        </div>
      )}

      {/* 結果なし */}
      {hasSearched && !isLoading && results.length === 0 && !error && (
        <div className="text-center py-16 animate-fade-in">
          <svg className="w-16 h-16 mx-auto mb-4" style={{ color: 'var(--color-text-muted)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
            <path d="M8 11h6" />
          </svg>
          <p style={{ color: 'var(--color-text-muted)' }}>
            検索結果が見つかりませんでした
          </p>
        </div>
      )}

      {/* もっと読み込む */}
      {hasMore && (
        <div className="text-center py-4">
          <button
            className="btn-primary"
            onClick={loadMore}
            disabled={isLoading}
          >
            {isLoading ? '読み込み中...' : 'もっと見る'}
          </button>
        </div>
      )}
    </div>
  );
}
