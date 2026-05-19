import { useNavigate } from 'react-router-dom';
import type { Song } from '../../types/vocadb';
import SongCard from '../search/SongCard';

/**
 * VideoGrid - YouTube風のレスポンシブ動画グリッド
 *
 * CSS Grid で 1列（スマホ）〜 4列（大画面PC）まで可変。
 */
interface VideoGridProps {
  songs: Song[];
  loading?: boolean;
  showScore?: boolean;
}

function SkeletonCard() {
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'var(--color-bg-card)' }}>
      <div className="aspect-video skeleton" />
      <div className="p-3 space-y-2">
        <div className="h-4 w-3/4 rounded skeleton" />
        <div className="h-3 w-1/2 rounded skeleton" />
      </div>
    </div>
  );
}

export default function VideoGrid({ songs, loading, showScore: _showScore }: VideoGridProps) {
  const navigate = useNavigate();

  const handlePlay = (song: Song) => {
    navigate(`/watch?v=${song.id}`);
  };
  if (loading && songs.length === 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
        {Array.from({ length: 12 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (!loading && songs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-muted)', opacity: 0.2 }}>
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
        </svg>
        <p className="text-base" style={{ color: 'var(--color-text-muted)' }}>
          楽曲が見つかりません
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
      {songs.map((song, index) => (
        <SongCard key={song.id} song={song} index={index} onPlay={handlePlay} />
      ))}
      {/* 追加ローディング */}
      {loading && songs.length > 0 &&
        Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={`skel-${i}`} />
        ))
      }
    </div>
  );
}
