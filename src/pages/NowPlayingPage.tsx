import { useEffect, useState, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import { usePlayerStore } from '../stores/playerStore';
import { useRatingStore } from '../stores/ratingStore';
import SongCard from '../components/search/SongCard';
import StarRating from '../components/player/StarRating';
import { getRecommendedSongs } from '../api/vocadb';
import type { Song } from '../types/vocadb';

/** サムネイルURLを解決 */
function getThumbUrl(song: Song): string | null {
  if (song.thumbUrl) return song.thumbUrl;
  const yt = song.pvs?.find(pv => pv.service === 'Youtube');
  if (yt) return `https://img.youtube.com/vi/${yt.pvId}/hqdefault.jpg`;
  return null;
}

/** 配列をフィッシャー–イェーツシャッフル（破壊的） */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * NowPlayingPage
 * 
 * 再生中の曲情報 + おすすめ曲（キューとは独立した推薦リスト）を表示する。
 * 曲が再生されていない場合は検索ページにリダイレクト。
 */
export default function NowPlayingPage() {
  const { currentSong, setQueue, queue } = usePlayerStore();
  const { getRating, setRating } = useRatingStore();
  const [recs, setRecs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);
  const fetchedForRef = useRef<number | null>(null);

  // 現在の曲が変わったらおすすめを再フェッチ
  useEffect(() => {
    if (!currentSong) return;
    if (fetchedForRef.current === currentSong.id) return;
    fetchedForRef.current = currentSong.id;

    setLoading(true);
    setRecs([]);

    const queueIds = new Set(queue.map(s => s.id));

    getRecommendedSongs(currentSong.id, 60)
      .then(songs => {
        // キューにない曲のみ表示 + シャッフルで毎回順番を変える
        const filtered = songs.filter(s => s.id !== currentSong.id && !queueIds.has(s.id));
        setRecs(shuffle(filtered));
      })
      .catch(() => {
        setRecs([]);
      })
      .finally(() => {
        setLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSong?.id]);

  // 曲が再生されていない場合は検索ページへ
  if (!currentSong) {
    return <Navigate to="/" replace />;
  }

  const thumbUrl = getThumbUrl(currentSong);
  const rating = getRating(currentSong.id);

  return (
    <div>
      {/* 現在の曲 フィーチャー表示 */}
      <div
        className="flex gap-5 mb-8 p-5 rounded-2xl"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        {/* サムネイル */}
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

        {/* 曲情報 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {/* 再生中インジケーター */}
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(29,185,84,0.2)', color: '#1DB954' }}
            >
              ▶ 再生中
            </span>
          </div>
          <h1
            className="text-lg font-bold truncate leading-tight mb-1"
            style={{ color: 'var(--color-text-primary)' }}
          >
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

      {/* おすすめ曲セクション */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-1 h-6 rounded-full" style={{ background: 'var(--gradient-primary)' }} />
        <h2 className="text-base font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          おすすめ
        </h2>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          キューとは独立した関連曲
        </span>
      </div>

      {/* ローディングスケルトン */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-3">
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
      )}

      {/* おすすめグリッド */}
      {!loading && recs.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-3">
          {recs.map((song, index) => (
            <div key={song.id} className="animate-fade-in" style={{ animationDelay: `${index * 25}ms` }}>
              <SongCard
                song={song}
                index={index}
                onPlay={(s) => setQueue([s], 0)}
              />
            </div>
          ))}
        </div>
      )}

      {/* おすすめなし */}
      {!loading && recs.length === 0 && (
        <div
          className="flex flex-col items-center justify-center py-16 gap-3"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.3 }}>
            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
          </svg>
          <p className="text-sm">おすすめ曲を取得できませんでした</p>
        </div>
      )}
    </div>
  );
}
