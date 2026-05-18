import type { Song } from '../../types/vocadb';
import VideoCard from './VideoCard';

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
    <div className="animate-fade-in">
      <div className="rounded-xl overflow-hidden skeleton" style={{ aspectRatio: '16/9' }} />
      <div className="flex gap-3 pt-3">
        <div className="w-9 h-9 rounded-full skeleton flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-4/5 rounded skeleton" />
          <div className="h-3 w-3/5 rounded skeleton" />
          <div className="h-3 w-2/5 rounded skeleton" />
        </div>
      </div>
    </div>
  );
}

export default function VideoGrid({ songs, loading, showScore }: VideoGridProps) {
  if (loading && songs.length === 0) {
    return (
      <div
        className="grid gap-x-4 gap-y-6"
        style={{
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        }}
      >
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
    <div
      className="grid gap-x-4 gap-y-6"
      style={{
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      }}
    >
      {songs.map((song) => (
        <VideoCard key={song.id} song={song} showScore={showScore} />
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
