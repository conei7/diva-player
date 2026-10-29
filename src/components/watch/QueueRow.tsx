import type { KeyboardEvent, Ref } from 'react';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { useRatingStore } from '../../stores/ratingStore';
import { usePlayerStore } from '../../stores/playerStore';
import { formatArtistLine } from '../../utils/songMeta';
import SongThumbnail from '../ui/SongThumbnail';
import SongActionsMenu from '../ui/SongActionsMenu';
import { MenuItem } from '../ui/Menu';
import { StarIcon, TrashIcon, VolumeBarsIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import StarRating from '../player/StarRating';
import RecommendationHint from '../recommendation/RecommendationHint';
import { hideSongWithUndo, removeQueueItemWithUndo } from './watchActions';

interface QueueRowProps {
  song: Song;
  /** Index in the whole queue. */
  index: number;
  current: boolean;
  /** Why autoplay picked the song (shown only when the hint setting is on). */
  hint?: string;
  onJump: (index: number) => void;
  rowRef?: Ref<HTMLLIElement>;
}

/**
 * One queue row (64px): number (or the playing mark) · 100×56 thumbnail · title / producer · ⋮.
 * The row button and the ⋮ are siblings (never nested). The <li> is what the queue-window e2e counts.
 */
export default function QueueRow({ song, index, current, hint, onJump, rowRef }: QueueRowProps) {
  const t = useTranslateSourceText();
  const rating = useRatingStore(state => state.ratings[String(song.id)] ?? 0);
  const setRating = useRatingStore(state => state.setRating);
  const artist = formatArtistLine(song);
  const restoring = usePlayerStore(state => state.queueRestoring);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onJump(index);
    }
  };

  return (
    <li
      ref={rowRef}
      data-now-playing={current ? 'true' : undefined}
      className={cx(
        'group relative flex items-center rounded-card pr-1 transition-colors duration-150',
        current ? 'bg-yt-tonal' : 'hover:bg-yt-tonal',
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={current ? 'true' : undefined}
        onClick={() => onJump(index)}
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-card py-1 pl-1 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yt-focus"
      >
        <span className="flex w-6 shrink-0 items-center justify-center text-xs tabular-nums text-yt-text-secondary">
          {current ? <VolumeBarsIcon size={16} className="text-brand" /> : index + 1}
        </span>
        <SongThumbnail song={song} radius="sm" className="w-[100px]" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 break-words text-sm font-medium leading-5 text-yt-text">{song.name}</span>
          <span className="block truncate text-xs leading-[18px] text-yt-text-secondary">
            {artist}
            {rating > 0 && ` · ★${rating}`}
          </span>
          {hint && <RecommendationHint reason={hint} className="mt-0.5" />}
        </span>
      </div>
      <SongActionsMenu
        song={song}
        include={['watchLater', 'save', 'hide']}
        extraItems={(
          // Same row as the other song ⋮ menus (playlist rows, rated songs): ☆ and the five stars, no label,
          // so the 40px stars of the bottom sheet fit at 320px (the group is named 「星評価」).
          <MenuItem keepOpen icon={<StarIcon />}>
            <StarRating rating={rating} onRate={value => setRating(song.id, value)} />
          </MenuItem>
        )}
        onHide={() => hideSongWithUndo(song, t, index)}
        footerItems={(
          <MenuItem disabled={restoring} icon={<TrashIcon />} onSelect={() => removeQueueItemWithUndo(index, t)}>
            {t('キューから削除')}
          </MenuItem>
        )}
      />
    </li>
  );
}
