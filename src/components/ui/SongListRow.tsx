import type { MouseEvent, ReactNode, Ref } from 'react';
import { Link } from 'react-router';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { watchPath } from '../../utils/routes';
import { formatArtistLine } from '../../utils/songMeta';
import { formatSongRelativeDate } from '../../utils/relativeDate';
import SongThumbnail from './SongThumbnail';
import ViewCounts from './ViewCounts';
import { hasViewCounts, joinMetaParts } from './songMetaParts';
import { CheckBoxIcon, CheckBoxOutlineIcon } from './icons';
import { SONG_ROW_LAYOUT } from './listLayout';
import { cx } from './overlay';
import type { SongRowSize } from './listLayout';

export type { SongRowSize } from './listLayout';

export interface SongListRowProps {
  song: Song;
  /** Thumbnail width 360 / 246 / 168 / 120 / 100px. Default 'md'. */
  size?: SongRowSize;
  /** Default watchPath(song.id, { autoplay: false }) (used for new-tab opens and SPA navigation). */
  href?: string;
  /** Plain left click / Enter: preventDefault and call this. Without it the link navigates (SPA). */
  onActivate?: () => void;
  /** Index number, drag handle… Rendered outside the link. Replaced by the checkbox in selection mode. */
  leading?: ReactNode;
  /** Default song.name. */
  title?: ReactNode;
  /**
   * Lines under the title (12px, secondary). Default:
   * md and larger → [formatArtistLine(song), <ViewCounts> · {relative date}], sm / xs → [formatArtistLine(song)].
   * Links and buttons inside meta / badges stay clickable (they sit above the row link).
   */
  meta?: ReactNode[];
  /** e.g. 「非表示中」「サビ 1:16〜」「★4」. */
  badges?: ReactNode;
  /** ⋮ (SongActionsMenu) or a pill. Rendered outside the link. */
  trailing?: ReactNode;
  /**
   * Shown over the thumbnail on row hover / keyboard focus, above the row link (e.g. a ▶
   * `IconButton variant="overlay"` that plays just this song). The rest of the thumbnail still
   * opens the row; the overlay's buttons only take clicks while shown, so taps on touch screens
   * keep opening the row. Not shown in selection mode.
   */
  thumbnailOverlay?: ReactNode;
  /** Vertical alignment of the trailing slot. Default: 'start' for xl / lg, 'center' for md / sm / xs. */
  trailingAlign?: 'start' | 'center';
  /** Now playing: tonal row background, "now playing" thumbnail and aria-current. */
  active?: boolean;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /** Default true. Lists like "related songs" pass false. */
  hoverBackground?: boolean;
  className?: string;
  'data-testid'?: string;
  /** Root element (e.g. for IntersectionObserver-based exposure logging). */
  ref?: Ref<HTMLDivElement>;
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Keeps plain text of meta/badges click-through (to the row link) while their links and buttons stay clickable. */
const CLICK_THROUGH =
  'pointer-events-none relative z-[1] [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_label]:pointer-events-auto [&_select]:pointer-events-auto [&_[role=button]]:pointer-events-auto';

export default function SongListRow({
  song,
  size = 'md',
  href,
  onActivate,
  leading,
  title,
  meta,
  badges,
  trailing,
  thumbnailOverlay,
  trailingAlign,
  active = false,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  hoverBackground = true,
  className,
  'data-testid': testId,
  ref,
}: SongListRowProps) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const layout = SONG_ROW_LAYOUT[size];
  const to = href ?? watchPath(song.id, { autoplay: false });
  const highlighted = active || (selectionMode && selected);

  let metaLines: ReactNode[];
  if (meta) {
    metaLines = meta;
  } else {
    const artistLine = formatArtistLine(song);
    if (layout.large || size === 'md') {
      const dateText = formatSongRelativeDate(song, Date.now(), language);
      metaLines = [artistLine, joinMetaParts([hasViewCounts(song) ? <ViewCounts key="views" song={song} /> : null, dateText])];
    } else {
      metaLines = [artistLine];
    }
  }
  const visibleMeta = metaLines.filter(line => line !== null && line !== undefined && line !== false && line !== '');

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (selectionMode) {
      event.preventDefault();
      onToggleSelect?.();
      return;
    }
    if (onActivate && isPlainLeftClick(event)) {
      event.preventDefault();
      onActivate();
    }
  };

  const handleAuxClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (selectionMode) event.preventDefault();
  };

  const leadingNode = selectionMode ? (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={t('「{title}」を選択', { title: song.name })}
      onClick={onToggleSelect}
      className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-yt-text transition-colors duration-150 hover:bg-yt-tonal"
    >
      {selected ? <CheckBoxIcon className="text-yt-link" /> : <CheckBoxOutlineIcon />}
    </button>
  ) : leading;

  const alignTrailing = trailingAlign ?? (layout.large ? 'start' : 'center');

  // Above the row link's ::after (z-[1]) while the thumbnail itself lets clicks through to the
  // link; the overlay's controls take clicks only while it is visible (row hover / focus).
  const overlayNode = thumbnailOverlay && !selectionMode ? (
    <div className="pointer-events-none flex h-full w-full items-center justify-center group-hover:*:pointer-events-auto group-focus-within:*:pointer-events-auto">
      {thumbnailOverlay}
    </div>
  ) : null;

  return (
    <div
      ref={ref}
      data-testid={testId}
      data-now-playing={active ? 'true' : undefined}
      data-selected={selectionMode && selected ? 'true' : undefined}
      className={cx(
        'group relative flex items-start rounded-card transition-colors duration-150',
        layout.gap,
        layout.padding,
        highlighted ? 'bg-yt-tonal' : hoverBackground && 'hover:bg-yt-tonal',
        selectionMode && 'select-none',
        className,
      )}
    >
      {leadingNode && (
        <div className="relative z-[1] flex shrink-0 items-center self-center">{leadingNode}</div>
      )}

      {/* Selection shows as the leading checkbox and the row background only (no second ✓ on the thumbnail). */}
      <SongThumbnail
        song={song}
        className={cx(layout.thumb, overlayNode && 'pointer-events-none z-[1]')}
        radius={layout.radius}
        nowPlaying={active}
        overlay={overlayNode}
      />

      <div className="min-w-0 flex-1">
        <h3 className={cx('m-0 line-clamp-2 break-words text-yt-text', layout.title)}>
          <Link
            to={to}
            onClick={handleClick}
            onAuxClick={handleAuxClick}
            aria-current={active ? 'true' : undefined}
            className="text-inherit no-underline after:absolute after:inset-0 after:rounded-card after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-yt-focus"
          >
            {title ?? song.name}
          </Link>
        </h3>
        {visibleMeta.length > 0 && (
          <div className={cx('mt-1 text-xs leading-[18px] text-yt-text-secondary', CLICK_THROUGH)}>
            {visibleMeta.map((line, index) => (
              <div key={index} className="truncate">{line}</div>
            ))}
          </div>
        )}
        {badges && (
          <div className={cx('mt-1 flex flex-wrap items-center gap-1 text-xs leading-[18px] text-yt-text-secondary', CLICK_THROUGH)}>
            {badges}
          </div>
        )}
      </div>

      {trailing && (
        <div className={cx('relative z-[1] flex shrink-0', alignTrailing === 'center' ? 'self-center' : 'self-start')}>
          {trailing}
        </div>
      )}
    </div>
  );
}
