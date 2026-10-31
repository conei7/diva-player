import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Song } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import { getSquareSongThumbnailCandidates } from '../../utils/songThumbnail';
import { MusicNoteIcon } from '../ui/icons';
import { cx } from '../ui/overlay';

export interface SquareArtProps {
  /** The song whose video thumbnail is cropped to a square. */
  song?: Pick<Song, 'thumbUrl' | 'pvs'> | null;
  /** Ready-made image URLs (e.g. a playlist cover), tried in order. Used when `song` is not given. */
  candidates?: readonly string[];
  /** Size comes from className (e.g. `size-12` or `w-full`). Always square. */
  className?: string;
  radius?: 'sm' | 'md' | 'full';
  /** Shown when there is no image (default: a note). */
  fallbackIcon?: ReactNode;
  loading?: 'lazy' | 'eager';
  children?: ReactNode;
}

const RADIUS_CLASS = { sm: 'rounded-[4px]', md: 'rounded-[8px]', full: 'rounded-full' } as const;

/**
 * Square artwork for the music layout (songs carry no album cover in lists, so the video thumbnail is
 * cropped). Falls back to the next image on error and shows no image in hidden mode, like SongThumbnail.
 */
export default function SquareArt({
  song,
  candidates: givenCandidates,
  className,
  radius = 'sm',
  fallbackIcon,
  loading = 'lazy',
  children,
}: SquareArtProps) {
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const candidates = useMemo(
    () => (song ? getSquareSongThumbnailCandidates(song) : [...(givenCandidates ?? [])]),
    [givenCandidates, song],
  );
  const signature = candidates.join('\u0000');
  const [failure, setFailure] = useState({ signature, index: 0 });
  const imageIndex = failure.signature === signature ? failure.index : 0;
  const imageUrl = hiddenMode ? undefined : candidates[imageIndex];

  return (
    <div className={cx('relative isolate aspect-square shrink-0 overflow-hidden bg-yt-tonal-solid', RADIUS_CLASS[radius], className)}>
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
        <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-yt-text-disabled">
          {fallbackIcon ?? <MusicNoteIcon size={20} className="h-auto w-[40%] max-w-12 min-w-4" />}
        </div>
      )}
      {children}
    </div>
  );
}
