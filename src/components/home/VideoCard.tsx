import { Link, useNavigate } from 'react-router-dom';
import type { Song } from '../../types/vocadb';
import { usePlayerStore, getPlayablePV } from '../../stores/playerStore';

interface VideoCardProps {
  song: Song;
  showScore?: boolean;
}

function getThumbUrl(song: Song): string | null {
  if (song.thumbUrl) return song.thumbUrl;
  const yt = song.pvs?.find(pv => pv.service === 'Youtube');
  if (yt) return `https://img.youtube.com/vi/${yt.pvId}/hqdefault.jpg`;
  return null;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getProducerInfo(song: Song): { name: string; id?: number } {
  const producer = song.artists?.find(a => a.categories?.includes('Producer'));
  if (producer) return { name: producer.name || producer.artist?.name || '', id: producer.artist?.id };

  const str = song.artistString;
  if (str.includes(' feat.')) return { name: str.split(' feat.')[0] };
  return { name: str };
}

export default function VideoCard({ song, showScore }: VideoCardProps) {
  const navigate = useNavigate();
  const { currentSong, isPlaying, hiddenMode } = usePlayerStore();
  const isCurrentSong = currentSong?.id === song.id;
  const thumbUrl = getThumbUrl(song);
  const duration = formatDuration(song.lengthSeconds);
  const producer = getProducerInfo(song);
  const hasPlayablePV = !!getPlayablePV(song);

  const handleClick = () => {
    if (!hasPlayablePV) return;
    navigate(`/watch?v=${song.id}`);
  };

  const handleSongLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    handleClick();
  };

  const handleProducerClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (producer.id) {
      navigate(`/?artistId=${producer.id}&artistName=${encodeURIComponent(producer.name)}`);
    } else if (producer.name) {
      navigate(`/?q=${encodeURIComponent(producer.name)}`);
    }
  };

  return (
    <div
      className="group cursor-pointer animate-fade-in"
      onClick={handleClick}
      style={{ opacity: hasPlayablePV ? 1 : 0.5 }}
    >
      <Link
        to={`/watch?v=${song.id}`}
        className="block relative w-full rounded-xl overflow-hidden"
        style={{ aspectRatio: '16/9', background: 'var(--color-surface)' }}
        onClick={handleSongLinkClick}
        aria-label={`${song.name}を再生`}
      >
        {!hiddenMode && thumbUrl ? (
          <img
            src={thumbUrl}
            alt={song.name}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center" style={{ background: 'var(--color-bg-secondary)' }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-muted)', opacity: 0.3 }}>
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
          </div>
        )}

        {isCurrentSong && isPlaying && (
          <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
            <div className="flex items-end gap-0.5 h-5">
              {[0, 1, 2, 3].map(i => (
                <span key={i} className="equalizer-bar" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}

        <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1">
          {duration && (
            <span
              className="px-1 py-0.5 rounded text-xs font-medium"
              style={{ background: 'rgba(0,0,0,0.8)', color: '#fff', fontSize: '11px', lineHeight: '12px' }}
            >
              {duration}
            </span>
          )}
        </div>

        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-200" />
      </Link>

      <div className="pt-2.5 px-0.5">
        <Link
          to={`/watch?v=${song.id}`}
          className="block line-clamp-2 text-sm font-medium leading-5 mb-1"
          style={{ color: 'var(--color-text-primary)' }}
          title={song.name}
          onClick={handleSongLinkClick}
        >
          {song.name}
        </Link>

        <div className="flex items-center flex-wrap gap-2 mt-0.5">
          <p
            className="text-xs truncate transition-colors cursor-pointer hover:underline"
            style={{ color: 'var(--color-text-secondary)' }}
            onClick={handleProducerClick}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
            title={`${producer.name} の曲を表示`}
          >
            {producer.name}
          </p>

          <div className="flex items-center gap-1.5 flex-wrap flex-1">
            <div className="flex-1" />

            {song.songType !== 'Original' && song.songType !== 'Unspecified' && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-medium leading-none"
                style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'var(--color-accent-purple)' }}
              >
                {song.songType}
              </span>
            )}
          </div>
        </div>

        {showScore && song.ratingScore > 0 && (
          <span className="text-xs mt-0.5 inline-block" style={{ color: 'var(--color-accent-cyan)' }}>
            score {song.ratingScore}
          </span>
        )}
      </div>
    </div>
  );
}
