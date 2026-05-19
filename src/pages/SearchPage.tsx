import { useEffect, useCallback, useState, useRef } from 'react';
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
 * 曲クリック → そのキューを破棄して動的ミックスリストを生成 (YouTube方式)。
 */
export default function SearchPage() {
  const { results, isLoading, error, hasSearched, loadMore, totalCount, resolvedArtistId, query } = useSearchStore();
  const { setQueue } = usePlayerStore();
  const [topSongs, setTopSongs] = useState<Song[]>([]);
  const [topLoading, setTopLoading] = useState(true);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
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

  // 曲クリック → 現在のキューを破棄してこの曲を起点に新しいミックスリスト生成
  const handlePlay = useCallback((song: Song) => {
    setQueue([song], 0);
    // App.tsx の autoQueue ロジックが残件 ≤ 2 を検出して推薦40曲を自動追加する
  }, [setQueue]);

  // もっと読み込む
  const hasMore = hasSearched && results.length < totalCount;

  const displaySongs = hasSearched ? results : topSongs;
  const displayLoading = hasSearched ? isLoading : topLoading;

  return (
    <div>
      {/* 詳細検索ボタン */}
      <div className="flex justify-end mb-2">
        <button
          onClick={() => setIsAdvancedOpen(o => !o)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={{
              background: isAdvancedOpen ? 'rgba(139, 92, 246, 0.15)' : 'var(--color-surface)',
              color: isAdvancedOpen ? 'var(--color-accent-purple)' : 'var(--color-text-secondary)',
              border: isAdvancedOpen ? '1px solid rgba(139, 92, 246, 0.35)' : '1px solid var(--color-border)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
            </svg>
            詳細検索
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"
                 style={{ transform: isAdvancedOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
              <path d="M7 10l5 5 5-5z"/>
            </svg>
          </button>
      </div>

      {/* アーティスト検索モードバナー */}
      {hasSearched && resolvedArtistId && (
        <div className="rounded-xl px-4 py-2 flex items-center gap-2 text-sm animate-fade-in mb-4"
             style={{ background: 'rgba(6, 214, 160, 0.08)', border: '1px solid rgba(6, 214, 160, 0.2)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-accent-cyan)', flexShrink: 0 }}>
            <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
          </svg>
          <span style={{ color: 'var(--color-accent-cyan)' }}>アーティスト「{query}」の曲を表示中</span>
        </div>
      )}

      {/* フィルター（詳細検索パネル） */}
      {isAdvancedOpen && (
        <div className="animate-fade-in mb-4">
          <SearchFilters />
        </div>
      )}

      {/* エラー表示 */}
      {error && (
        <div className="rounded-xl p-4 text-center animate-fade-in mb-4"
             style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
          <p className="text-sm" style={{ color: 'var(--color-error)' }}>{error}</p>
        </div>
      )}

      {/* セクションタイトル */}
      {!hasSearched && !topLoading && topSongs.length > 0 && (
        <div className="flex items-center gap-3 mb-4">
          <div className="w-1 h-6 rounded-full" style={{ background: 'var(--gradient-primary)' }} />
          <h2 className="text-lg font-semibold">🔥 人気のボカロ曲</h2>
        </div>
      )}

      {/* ローディングスケルトン */}
      {displayLoading && displaySongs.length === 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
          {Array.from({ length: 10 }).map((_, i) => (
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
          {displaySongs.map((song, index) => (
            <div key={song.id} className="animate-fade-in" style={{ animationDelay: `${index * 30}ms` }}>
              <SongCard
                song={song}
                index={index}
                onPlay={handlePlay}
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
        <div className="text-center py-4 mt-4">
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