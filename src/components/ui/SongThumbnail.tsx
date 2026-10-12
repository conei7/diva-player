import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Song } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import { getWideSongThumbnailCandidates } from '../../utils/songThumbnail';
import { formatClockDuration } from '../../utils/songMeta';
import { useTranslateSourceText } from '../../i18n';
import { CheckIcon, MusicNoteIcon, VolumeBarsIcon } from './icons';
import { cx } from './overlay';

export interface SongThumbnailProps {
  song: Song;
  /** Size comes from the width in className (e.g. `w-[168px]` or `w-full`). The ratio is always 16:9. */
  className?: string;
  /** 0 / 8 / 12px. Default 'md'. */
  radius?: 'none' | 'sm' | 'md';
  /** Bottom-right duration badge (when lengthSeconds is known). Default true. */
  showDuration?: boolean;
  /** Rank badge at the top-left. */
  rank?: number;
  /** Dims the image and shows the "now playing" badge at the bottom-left. */
  nowPlaying?: boolean;
  /** 2px blue frame and a check mark at the top-left. */
  selected?: boolean;
  /** Revealed while the thumbnail (or an ancestor `.group`) is hovered or focused, e.g. "Play all". */
  overlay?: ReactNode;
  loading?: 'lazy' | 'eager';
  /** Always-visible content layered over the image (e.g. a "can't play" label). */
  children?: ReactNode;
}

const RADIUS_CLASS = {
  none: 'rounded-none',
  sm: 'rounded-chip',
  md: 'rounded-card',
} as const;

export default function SongThumbnail({
  song,
  className,
  radius = 'md',
  showDuration = true,
  rank,
  nowPlaying = false,
  selected = false,
  overlay,
  loading = 'lazy',
  children,
}: SongThumbnailProps) {
  const t = useTranslateSourceText();
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const candidates = useMemo(() => getWideSongThumbnailCandidates(song), [song]);
  const signature = candidates.join('\u0000');
  const [failure, setFailure] = useState({ signature, index: 0 });
  const imageIndex = failure.signature === signature ? failure.index : 0;
  const imageUrl = hiddenMode ? undefined : candidates[imageIndex];
  const duration = showDuration && song.lengthSeconds > 0 ? formatClockDuration(song.lengthSeconds) : null;
  const hasRank = typeof rank === 'number' && Number.isFinite(rank);

  return (
    <div
      className={cx(
        'group/thumb relative isolate aspect-video shrink-0 overflow-hidden bg-yt-tonal-solid',
        RADIUS_CLASS[radius],
        className,
      )}
    >
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
          <MusicNoteIcon size={24} className="h-auto w-[24%] max-w-12 min-w-5" />
        </div>
      )}

      {nowPlaying && <div aria-hidden="true" className="absolute inset-0 bg-black/50" />}

      {children}

      {overlay && (
        <div className="absolute inset-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 group-hover/thumb:opacity-100 group-focus-within/thumb:opacity-100">
          {overlay}
        </div>
      )}

      {(selected || hasRank) && (
        <div className="pointer-events-none absolute left-1 top-1 flex items-center gap-1">
          {selected && (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-yt-link text-yt-on-inverse">
              <CheckIcon size={18} />
            </span>
          )}
          {hasRank && (
            <span className="rounded-badge bg-black/60 px-1.5 text-sm font-bold leading-6 text-white tabular-nums">
              {rank}
            </span>
          )}
        </div>
      )}

      {nowPlaying && (
        // The text label only appears when the thumbnail is at least 160px wide;
        // smaller thumbnails (queue / playlist panel rows) show the icon alone.
        <div className="@container pointer-events-none absolute inset-0">
          <span className="absolute bottom-1 left-1 flex max-w-[calc(100%-4rem)] items-center gap-1 rounded-badge bg-thumb-badge px-1 py-px text-xs font-medium leading-4 text-white">
            <VolumeBarsIcon size={16} className="shrink-0 text-brand" />
            <span className="hidden truncate @min-[10rem]:inline">{t('再生中')}</span>
          </span>
        </div>
      )}

      {duration && (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded-badge bg-thumb-badge px-1 py-px text-xs font-medium leading-4 text-white tabular-nums">
          {duration}
        </span>
      )}

      {selected && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] border-2 border-yt-link" />
      )}
    </div>
  );
}
