import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useHistoryStore } from '../stores/historyStore';
import { useRatingStore } from '../stores/ratingStore';
import VideoGrid from '../components/home/VideoGrid';
import type { Song } from '../types/vocadb';
import { getSongById } from '../api/vocadb';
import {
  getRatingCounts,
  getSongIdsForRating,
  isRatingValue,
  RATING_VALUES,
  type RatingValue,
} from '../utils/ratedSongs';

type FavoriteSortMode = 'recent' | 'name' | 'artist';

/**
 * FavoritesPage - 星1〜5の評価別ライブラリ
 */
export default function FavoritesPage() {
  const { ratings } = useRatingStore();
  const { entries } = useHistoryStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filterText, setFilterText] = useState('');
  const [sortMode, setSortMode] = useState<FavoriteSortMode>('recent');
  const [loadedSongs, setLoadedSongs] = useState<Record<string, Song>>({});

  const ratingParam = Number(searchParams.get('rating'));
  const selectedRating: RatingValue = isRatingValue(ratingParam) ? ratingParam : 5;
  const ratingCounts = useMemo(() => getRatingCounts(ratings), [ratings]);
  const selectedRatedIds = useMemo(
    () => getSongIdsForRating(ratings, selectedRating),
    [ratings, selectedRating],
  );

  const songsById = useMemo(() => {
    const map = new Map<number, Song>(Object.values(loadedSongs).map(song => [song.id, song]));
    for (const entry of entries) map.set(entry.song.id, entry.song);
    return map;
  }, [entries, loadedSongs]);

  const missingIds = useMemo(
    () => selectedRatedIds.filter(id => !songsById.has(id)),
    [selectedRatedIds, songsById],
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

  // 選択した評価の曲を履歴または補完済み曲情報から取得（重複排除）
  const favoriteSongs: Song[] = useMemo(() => {
    const seen = new Set<number>();
    const result: Song[] = [];
    for (const id of selectedRatedIds) {
      const song = songsById.get(id);
      if (song && !seen.has(song.id)) {
        seen.add(song.id);
        result.push(song);
      }
    }
    return result;
  }, [selectedRatedIds, songsById]);

  const visibleSongs = useMemo(() => {
    const normalizedFilter = filterText.trim().toLowerCase();
    const filtered = normalizedFilter
      ? favoriteSongs.filter(song =>
          song.name.toLowerCase().includes(normalizedFilter) ||
          (song.artistString ?? '').toLowerCase().includes(normalizedFilter)
        )
      : favoriteSongs;

    if (sortMode === 'name') {
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    }
    if (sortMode === 'artist') {
      return [...filtered].sort((a, b) => (a.artistString ?? '').localeCompare(b.artistString ?? '', 'ja'));
    }
    return filtered;
  }, [favoriteSongs, filterText, sortMode]);

  const selectRating = (rating: RatingValue) => {
    setFilterText('');
    setSearchParams({ rating: String(rating) }, { replace: true });
  };

  return (
    <div className="w-full px-4 sm:px-6 lg:px-8 py-4">
      <div className="mb-6">
        <h1 className="text-xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
          評価した曲
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
          ★{selectedRating} · {ratingCounts[selectedRating]} 曲
        </p>
      </div>

      <div
        className="mb-6 grid max-w-2xl grid-cols-5 gap-1 rounded-xl border p-1"
        style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        role="tablist"
        aria-label="評価で絞り込む"
      >
        {RATING_VALUES.map(rating => {
          const active = rating === selectedRating;
          return (
            <button
              key={rating}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectRating(rating)}
              className="rounded-lg px-1 py-2 text-sm transition-colors"
              style={{
                background: active ? 'var(--color-accent-cyan)' : 'transparent',
                color: active ? '#07151a' : 'var(--color-text-secondary)',
                fontWeight: active ? 700 : 500,
              }}
            >
              <span className="block">★{rating}</span>
              <span className="block text-[10px] opacity-70">{ratingCounts[rating]}</span>
            </button>
          );
        })}
      </div>

      {favoriteSongs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#facc15', opacity: 0.2 }}>
            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
          </svg>
          <p className="text-base" style={{ color: 'var(--color-text-muted)' }}>
            ★{selectedRating} の曲はまだありません
          </p>
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            再生画面の星から評価できます
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
                placeholder="曲名・アーティスト"
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
