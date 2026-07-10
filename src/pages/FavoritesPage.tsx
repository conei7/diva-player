import { useEffect, useMemo, useState } from 'react';
import { useHistoryStore } from '../stores/historyStore';
import { useRatingStore } from '../stores/ratingStore';
import VideoGrid from '../components/home/VideoGrid';
import type { Song } from '../types/vocadb';
import { getSongById } from '../api/vocadb';

type FavoriteSortMode = 'recent' | 'rating' | 'name' | 'artist';

/**
 * FavoritesPage - 高評価した曲 (星4・5) ページ
 */
export default function FavoritesPage() {
  const { ratings } = useRatingStore();
  const { entries } = useHistoryStore();
  const [filterText, setFilterText] = useState('');
  const [sortMode, setSortMode] = useState<FavoriteSortMode>('recent');
  const [loadedSongs, setLoadedSongs] = useState<Record<string, Song>>({});

  const highRatedIds = useMemo(() => Object.entries(ratings)
    .filter(([, rating]) => rating >= 4)
    .map(([id]) => Number(id))
    .filter(Number.isInteger), [ratings]);

  const songsById = useMemo(() => {
    const map = new Map<number, Song>(Object.values(loadedSongs).map(song => [song.id, song]));
    for (const entry of entries) map.set(entry.song.id, entry.song);
    return map;
  }, [entries, loadedSongs]);

  const missingIds = useMemo(
    () => highRatedIds.filter(id => !songsById.has(id)),
    [highRatedIds, songsById],
  );

  useEffect(() => {
    if (missingIds.length === 0) return;
    let cancelled = false;

    void Promise.all(missingIds.map(async id => {
      try {
        return await getSongById(id);
      } catch {
        return null;
      }
    })).then(songs => {
      if (cancelled) return;
      setLoadedSongs(previous => ({
        ...previous,
        ...Object.fromEntries(songs.filter((song): song is Song => song !== null).map(song => [String(song.id), song])),
      }));
    });

    return () => { cancelled = true; };
  }, [missingIds]);

  // 星4・5の曲を履歴または補完済み曲情報から取得（重複排除）
  const favoriteSongs: Song[] = useMemo(() => {
    const seen = new Set<number>();
    const result: Song[] = [];
    for (const id of highRatedIds) {
      const song = songsById.get(id);
      if (song && !seen.has(song.id)) {
        seen.add(song.id);
        result.push(song);
      }
    }
    return result;
  }, [highRatedIds, songsById]);

  const visibleSongs = useMemo(() => {
    const normalizedFilter = filterText.trim().toLowerCase();
    const filtered = normalizedFilter
      ? favoriteSongs.filter(song =>
          song.name.toLowerCase().includes(normalizedFilter) ||
          (song.artistString ?? '').toLowerCase().includes(normalizedFilter)
        )
      : favoriteSongs;

    if (sortMode === 'rating') {
      return [...filtered].sort((a, b) => (ratings[String(b.id)] ?? 0) - (ratings[String(a.id)] ?? 0));
    }
    if (sortMode === 'name') {
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    }
    if (sortMode === 'artist') {
      return [...filtered].sort((a, b) => (a.artistString ?? '').localeCompare(b.artistString ?? '', 'ja'));
    }
    return filtered;
  }, [favoriteSongs, filterText, ratings, sortMode]);

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
        <>
          <div className="mb-4 max-w-2xl">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="search"
                value={filterText}
                onChange={(event) => setFilterText(event.target.value)}
                placeholder="お気に入りを検索"
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                style={{
                  background: 'var(--color-surface)',
                  borderColor: 'var(--color-border)',
                  color: 'var(--color-text-primary)',
                }}
              />
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as FavoriteSortMode)}
                className="rounded-lg border px-3 py-2 text-sm outline-none sm:w-40"
                style={{
                  background: 'var(--color-surface)',
                  borderColor: 'var(--color-border)',
                  color: 'var(--color-text-primary)',
                }}
              >
                <option value="recent">履歴順</option>
                <option value="rating">評価順</option>
                <option value="name">曲名</option>
                <option value="artist">アーティスト</option>
              </select>
            </div>
            {filterText.trim() && (
              <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
                {visibleSongs.length} / {favoriteSongs.length} 件
              </p>
            )}
          </div>
          <VideoGrid songs={visibleSongs} loading={false} />
        </>
      )}
    </div>
  );
}
