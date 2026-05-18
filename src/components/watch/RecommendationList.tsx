import { useNavigate } from 'react-router-dom';
import type { Song } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';

/**
 * RecommendationList - 推薦動画リスト
 *
 * WatchPage右側パネル。サムネイル + 曲名 + P名 の縦リスト。
 * クリックで /watch?v=songId へSPA遷移（ページリロードなし）
 */
interface RecommendationListProps {
  songs: Song[];
  loading: boolean;
  hasMore: boolean;
}

/** サムネイルURLを解決 */
function getThumbUrl(song: Song): string | null {
  if (song.thumbUrl) return song.thumbUrl;
  const yt = song.pvs?.find(pv => pv.service === 'Youtube');
  if (yt) return `https://img.youtube.com/vi/${yt.pvId}/hqdefault.jpg`;
  return null;
}

/** 再生時間フォーマット */
function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** P名を抽出 */
function getProducerName(song: Song): string {
  const producer = song.artists?.find(a => a.categories === 'Producer');
  if (producer) return producer.name || producer.artist?.name || '';
  const str = song.artistString;
  if (str.includes(' feat.')) return str.split(' feat.')[0];
  return str;
}

function SkeletonItem() {
  return (
    <div className="flex gap-2 p-1">
      <div className="w-40 flex-shrink-0 rounded-lg skeleton" style={{ aspectRatio: '16/9' }} />
      <div className="flex-1 space-y-1.5 py-0.5">
        <div className="h-3.5 w-full rounded skeleton" />
        <div className="h-3.5 w-3/4 rounded skeleton" />
        <div className="h-3 w-1/2 rounded skeleton" />
      </div>
    </div>
  );
}

export default function RecommendationList({ songs, loading }: RecommendationListProps) {
  const navigate = useNavigate();
  const { currentSong, isPlaying, hiddenMode } = usePlayerStore();

  if (loading && songs.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonItem key={i} />
        ))}
      </div>
    );
  }

  if (!loading && songs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-muted)', opacity: 0.3 }}>
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
        </svg>
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>曲が見つかりません</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {songs.map((song, index) => {
        const isActive = currentSong?.id === song.id;
        const thumbUrl = getThumbUrl(song);
        const duration = formatDuration(song.lengthSeconds);
        const producerName = getProducerName(song);

        return (
          <div
            key={song.id}
            className="rec-item animate-fade-in"
            style={{
              animationDelay: `${(index % 20) * 30}ms`,
              background: isActive ? 'var(--color-surface)' : 'transparent',
            }}
            onClick={() => navigate(`/watch?v=${song.id}`)}
          >
            {/* サムネイル */}
            <div
              className="relative w-40 flex-shrink-0 rounded-lg overflow-hidden"
              style={{ aspectRatio: '16/9', background: 'var(--color-surface)' }}
            >
              {!hiddenMode && thumbUrl ? (
                <img
                  src={thumbUrl}
                  alt={song.name}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center" style={{ background: 'var(--color-bg-secondary)' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-muted)', opacity: 0.3 }}>
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                  </svg>
                </div>
              )}
              {/* 再生中 */}
              {isActive && isPlaying && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                  <div className="flex items-end gap-0.5 h-4">
                    {[0, 1, 2, 3].map(i => (
                      <span key={i} className="equalizer-bar" style={{ height: '3px', animationDelay: `${i * 0.15}s` }} />
                    ))}
                  </div>
                </div>
              )}
              {/* 再生時間 */}
              {duration && (
                <span
                  className="absolute bottom-1 right-1 px-1 py-0.5 rounded text-[10px] font-medium"
                  style={{ background: 'rgba(0,0,0,0.8)', color: '#fff' }}
                >
                  {duration}
                </span>
              )}
            </div>

            {/* テキスト情報 */}
            <div className="flex-1 min-w-0 py-0.5">
              <h4
                className="line-clamp-2 text-sm font-medium leading-5"
                style={{ color: isActive ? 'var(--color-accent-cyan)' : 'var(--color-text-primary)' }}
                title={song.name}
              >
                {song.name}
              </h4>
              <p className="text-xs mt-1 truncate" style={{ color: 'var(--color-text-muted)' }}>
                {producerName}
              </p>
              {song.favoritedTimes > 0 && (
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  ♥ {song.favoritedTimes.toLocaleString()}
                </p>
              )}
            </div>
          </div>
        );
      })}

      {/* ローディング */}
      {loading && songs.length > 0 && (
        <div className="space-y-2 mt-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonItem key={`skel-${i}`} />
          ))}
        </div>
      )}
    </div>
  );
}
