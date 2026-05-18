import { useHistoryStore } from '../stores/historyStore';
import VideoGrid from '../components/home/VideoGrid';
import type { Song } from '../types/vocadb';

/**
 * HistoryPage - 視聴履歴ページ
 */
export default function HistoryPage() {
  const { entries, clearHistory } = useHistoryStore();

  const songs: Song[] = entries.map(e => e.song);

  return (
    <div className="w-full px-4 sm:px-6 lg:px-8 py-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            視聴履歴
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {entries.length} 件
          </p>
        </div>
        {entries.length > 0 && (
          <button
            className="yt-action-btn"
            onClick={clearHistory}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
            </svg>
            <span className="hidden sm:inline">履歴を削除</span>
          </button>
        )}
      </div>

      <VideoGrid songs={songs} loading={false} />
    </div>
  );
}
