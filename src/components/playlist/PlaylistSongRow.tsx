/**
 * PlaylistSongRow – one song of a playlist (SongListRow + ⋮).
 * Rows carry the song's saved position so actions on a duplicate reach that copy.
 */
import { memo } from 'react';
import type { ReactNode } from 'react';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { useRatingStore } from '../../stores/ratingStore';
import { formatSongRelativeDate } from '../../utils/relativeDate';
import { formatArtistLine } from '../../utils/songMeta';
import ViewCounts from '../ui/ViewCounts';
import { hasViewCounts, joinMetaParts } from '../ui/songMetaParts';
import StarRating from '../player/StarRating';
import { MenuItem } from '../ui/Menu';
import SongActionsMenu, { type SongActionKey } from '../ui/SongActionsMenu';
import SongListRow from '../ui/SongListRow';
import { ImageIcon, MoveToBottomIcon, MoveToTopIcon, StarIcon, TrashIcon, VolumeBarsIcon } from '../ui/icons';

/** Above this many songs the list is window-virtualized (and drag reordering is off). */
export const VIRTUAL_THRESHOLD = 200;

const WATCH_LATER_ACTIONS: SongActionKey[] = ['queue', 'save', 'share', 'hide'];

/** Stable callbacks shared by every row; each takes the row's saved position. */
export interface PlaylistRowActions {
  play: (position: number) => void;
  toggleSelect: (index: number) => void;
  remove: (index: number) => void;
  moveToTop: (index: number) => void;
  moveToBottom: (index: number) => void;
  setThumbnail: (index: number) => void;
}

interface PlaylistSongRowProps {
  song: Song;
  /** Position in the saved order. */
  index: number;
  /** Position in the list as shown (search / sort applied). */
  position: number;
  lastIndex: number;
  playlistName: string;
  /** Songs can be reordered and removed (not smart / synced). */
  editable: boolean;
  /**
   * The list shows the manual order (手動, not searched): 一番上に移動 / 一番下に移動 are offered
   * only then, like the drag handles (in a sorted view the move would not show).
   */
  reorderable: boolean;
  /** 後で聴く: its ⋮ doesn't offer 「後で聴くに保存」 next to 「「後で聴く」から削除」. */
  watchLater: boolean;
  /** Phones: smaller row, no index number. */
  compact: boolean;
  active: boolean;
  selectionMode: boolean;
  selected: boolean;
  /** Drag handle (only when manual order can be changed). */
  dragHandle?: ReactNode;
  actions: PlaylistRowActions;
}

function PlaylistSongRow({
  song,
  index,
  position,
  lastIndex,
  playlistName,
  editable,
  reorderable,
  watchLater,
  compact,
  active,
  selectionMode,
  selected,
  dragHandle,
  actions,
}: PlaylistSongRowProps) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const rating = useRatingStore(state => state.ratings[String(song.id)] ?? 0);
  const setRating = useRatingStore(state => state.setRating);

  const metaLine = joinMetaParts([
    formatArtistLine(song),
    hasViewCounts(song) ? <ViewCounts key="views" song={song} /> : null,
    formatSongRelativeDate(song, Date.now(), language),
    rating > 0 ? `★${rating}` : null,
  ]);

  const showNumber = !compact;
  const leading = dragHandle || showNumber ? (
    <div className="flex items-center">
      {dragHandle}
      {showNumber && (
        <span className="flex w-6 shrink-0 justify-center text-sm leading-5 text-yt-text-secondary tabular-nums">
          {active ? <VolumeBarsIcon size={16} className="text-brand" /> : position + 1}
        </span>
      )}
    </div>
  ) : undefined;

  return (
    <SongListRow
      song={song}
      size={compact ? 'sm' : 'md'}
      active={active}
      onActivate={() => actions.play(position)}
      leading={leading}
      meta={[metaLine]}
      selectionMode={selectionMode}
      selected={selected}
      onToggleSelect={() => actions.toggleSelect(index)}
      data-testid="playlist-song-row"
      trailing={(
        <SongActionsMenu
          song={song}
          include={watchLater ? WATCH_LATER_ACTIONS : undefined}
          extraItems={(
            <>
              <MenuItem keepOpen icon={<StarIcon />}>
                <StarRating rating={rating} onRate={value => setRating(song.id, value)} size="md" />
              </MenuItem>
              {editable && reorderable && (
                <>
                  <MenuItem icon={<MoveToTopIcon />} disabled={index === 0} onSelect={() => actions.moveToTop(index)}>
                    {t('一番上に移動')}
                  </MenuItem>
                  <MenuItem icon={<MoveToBottomIcon />} disabled={index === lastIndex} onSelect={() => actions.moveToBottom(index)}>
                    {t('一番下に移動')}
                  </MenuItem>
                </>
              )}
              {editable && (
                <MenuItem icon={<ImageIcon />} onSelect={() => actions.setThumbnail(index)}>
                  {t('サムネイルに設定')}
                </MenuItem>
              )}
            </>
          )}
          footerItems={editable ? (
            <MenuItem icon={<TrashIcon />} onSelect={() => actions.remove(index)}>
              {t('「{name}」から削除', { name: playlistName })}
            </MenuItem>
          ) : undefined}
        />
      )}
    />
  );
}

export default memo(PlaylistSongRow);
