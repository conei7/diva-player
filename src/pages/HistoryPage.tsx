import { useMemo, useState } from 'react';
import { useHistoryStore } from '../stores/historyStore';
import VideoGrid from '../components/home/VideoGrid';
import type { Song } from '../types/vocadb';

type HistorySortMode = 'recent' | 'name' | 'artist';

/**
 * HistoryPage - 視聴履歴ページ
 */
export default function HistoryPage() {
  const { entries, totalPlays, clearHistory } = useHistoryStore();
  const [filterText, setFilterText] = useState('');
  const [sortMode, setSortMode] = useState<HistorySortMode>('recent');

  const songs: Song[] = useMemo(() => {
    const normalizedFilter = filterText.trim().toLowerCase();
    const historySongs = entries.map(e => e.song);
    const filtered = normalizedFilter
      ? historySongs.filter(song =>
          song.name.toLowerCase().includes(normalizedFilter) ||
          (song.artistString ?? '').toLowerCase().includes(normalizedFilter)
        )
      : historySongs;

    if (sortMode === 'name') {
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    }
    if (sortMode === 'artist') {
      return [...filtered].sort((a, b) => (a.artistString ?? '').localeCompare(b.artistString ?? '', 'ja'));
    }
    return filtered;
  }, [entries, filterText, sortMode]);

  return (
    <div className="w-full px-4 sm:px-6 lg:px-8 py-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            視聴履歴
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {totalPlays} 件
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

      {entries.length > 0 && (
        <div className="mb-4 max-w-2xl">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="search"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder="履歴を検索"
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-primary)',
              }}
            />
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as HistorySortMode)}
              className="rounded-lg border px-3 py-2 text-sm outline-none sm:w-40"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-primary)',
              }}
            >
              <option value="recent">最近</option>
              <option value="name">曲名</option>
              <option value="artist">アーティスト</option>
            </select>
          </div>
          {filterText.trim() && (
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {songs.length} / {entries.length} 件を表示中
            </p>
          )}
        </div>
      )}

      <VideoGrid songs={songs} loading={false} />
    </div>
  );
}
