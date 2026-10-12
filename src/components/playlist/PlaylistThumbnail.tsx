import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Playlist } from '../../types/vocadb';
import { useLanguageStore } from '../../stores/languageStore';
import { usePlayerStore } from '../../stores/playerStore';
import { WATCH_LATER_ID } from '../../stores/playlistStore';
import { formatCount } from '../../utils/songMeta';
import { ClockIcon, PlaylistIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { getPlaylistCoverCandidates } from './playlistDisplay';

export interface PlaylistThumbnailProps {
  playlist: Pick<Playlist, 'id' | 'coverArtUrl' | 'songs'>;
  /** Width (e.g. `w-40`); the image is always 16:9. */
  className?: string;
  /** The two lines stacked above the image that mark a playlist. Default true. */
  stacked?: boolean;
  /** Bottom-right 「≡ 28曲」 badge. Default true. */
  showCount?: boolean;
  /** 8px / 12px corners. Default 'md'. */
  radius?: 'sm' | 'md';
  loading?: 'lazy' | 'eager';
  /** Layered over the image (e.g. the hover 「すべて再生」 button). */
  children?: ReactNode;
}

/**
 * 16:9 cover of a playlist: the chosen cover, else the first song's thumbnail, else an icon
 * (後で聴く: clock, others: playlist). Falls through to the next image when one fails.
 */
export default function PlaylistThumbnail({
  playlist,
  className,
  stacked = true,
  showCount = true,
  radius = 'md',
  loading = 'lazy',
  children,
}: PlaylistThumbnailProps) {
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const language = useLanguageStore(state => state.language);
  const { coverArtUrl, songs } = playlist;
  const candidates = useMemo(() => getPlaylistCoverCandidates({ coverArtUrl, songs }), [coverArtUrl, songs]);
  const signature = candidates.join('\u0000');
  const [failure, setFailure] = useState({ signature, index: 0 });
  const imageIndex = failure.signature === signature ? failure.index : 0;
  const imageUrl = hiddenMode ? undefined : candidates[imageIndex];
  const FallbackIcon = playlist.id === WATCH_LATER_ID ? ClockIcon : PlaylistIcon;

  return (
    <div className={cx('shrink-0', stacked && 'pt-2', className)}>
      <div className="relative">
        {stacked && (
          <>
            <div aria-hidden="true" className="absolute inset-x-[8%] -top-2 h-1 rounded-t-badge bg-white/10" />
            <div aria-hidden="true" className="absolute inset-x-[4%] -top-1 h-1 rounded-t-badge bg-white/20" />
          </>
        )}
        <div className={cx('relative aspect-video overflow-hidden bg-yt-tonal-solid', radius === 'sm' ? 'rounded-chip' : 'rounded-card')}>
          {imageUrl ? (
            <img
              key={imageUrl}
              src={imageUrl}
              alt=""
              loading={loading}
              decoding="async"
              draggable={false}
              className="absolute inset-0 h-full w-full object-cover"
              onError={() => setFailure(previous => ({
                signature,
                index: (previous.signature === signature ? previous.index : 0) + 1,
              }))}
            />
          ) : (
            <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-yt-text-secondary">
              <FallbackIcon size={32} className="h-auto w-[22%] min-w-6 max-w-12" />
            </div>
          )}
          {showCount && (
            <span className="pointer-events-none absolute bottom-1 right-1 flex items-center gap-0.5 rounded-badge bg-thumb-badge py-px pl-0.5 pr-1 text-xs font-medium leading-4 text-white tabular-nums">
              <PlaylistIcon size={16} />
              {formatCount(songs.length, 'song', language)}
            </span>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
