/**
 * PlaylistCover – プレイリストのカバーアート表示
 *
 * 手動カバー → 最大4曲のモザイク → アイコンフォールバック の優先順。
 */
import type { Playlist } from '../../types/vocadb';

export default function PlaylistCover({ playlist, className = '' }: { playlist: Playlist; className?: string }) {
  const thumbnails = Array.from(new Set(
    playlist.songs.map(song => song.thumbUrl).filter((url): url is string => Boolean(url)),
  )).slice(0, 4);

  if (playlist.coverArtUrl) {
    return <img src={playlist.coverArtUrl} alt="" className={`h-full w-full object-cover ${className}`} />;
  }

  if (!playlist.isPinned && thumbnails.length > 0) {
    const gridClass = thumbnails.length === 1 ? 'grid-cols-1' : 'grid-cols-2';
    return (
      <div className={`grid h-full w-full auto-rows-fr ${gridClass} overflow-hidden ${className}`}>
        {thumbnails.map((url, index) => (
          <img
            key={url}
            src={url}
            alt=""
            loading="lazy"
            className={`h-full min-h-0 w-full object-cover ${thumbnails.length === 3 && index === 0 ? 'row-span-2' : ''}`}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`flex h-full w-full items-center justify-center ${className}`}
      style={{ background: playlist.isPinned ? 'rgba(6,214,160,.14)' : 'var(--color-surface)' }}
    >
      {playlist.isPinned ? (
        <svg className="h-[42%] w-[42%]" style={{ color: 'var(--color-accent-cyan)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>
        </svg>
      ) : (
        <svg className="h-[42%] w-[42%] text-white/65" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
        </svg>
      )}
    </div>
  );
}
