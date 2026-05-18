import { useMemo } from 'react';
import { useHistoryStore } from '../stores/historyStore';
import { useRatingStore } from '../stores/ratingStore';
import VideoGrid from '../components/home/VideoGrid';
import type { Song } from '../types/vocadb';

/**
 * FavoritesPage - 高評価した曲 (星4・5) ページ
 */
export default function FavoritesPage() {
  const { ratings } = useRatingStore();
  const { entries } = useHistoryStore();

  // 星4・5の曲を履歴から取得（重複排除）
  const favoriteSongs: Song[] = useMemo(() => {
    const highRatedIds = new Set(
      Object.entries(ratings)
        .filter(([, rating]) => rating >= 4)
        .map(([id]) => Number(id))
    );

    const seen = new Set<number>();
    const result: Song[] = [];
    for (const entry of entries) {
      if (highRatedIds.has(entry.song.id) && !seen.has(entry.song.id)) {
        seen.add(entry.song.id);
        result.push(entry.song);
      }
    }
    return result;
  }, [ratings, entries]);

  return (
    <div className="w-full px-4 sm:px-6 lg:px-8 py-4">
      <div className="mb-6">
        <h1 className="text-xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
          高く評価した曲
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
          ★4 以上の評価をつけた {favoriteSongs.length} 曲
        </p>
      </div>

      {favoriteSongs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#facc15', opacity: 0.2 }}>
            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
          </svg>
          <p className="text-base" style={{ color: 'var(--color-text-muted)' }}>
            まだ高評価をつけた曲がありません
          </p>
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            楽曲を再生して★4以上の評価をつけましょう
          </p>
        </div>
      ) : (
        <VideoGrid songs={favoriteSongs} loading={false} />
      )}
    </div>
  );
}
