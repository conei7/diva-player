import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import type { useNavLinkProps } from '../../layout/navHooks';
import Tooltip from '../../ui/Tooltip';
import { cx } from '../../ui/overlay';
import { LIBRARY_ROW_CLASS, libraryRowStateClass } from './libraryModel';

/** What useNavLinkProps gives a destination link (preloading, loading bar, home reset). */
export type NavLinkHandlers = ReturnType<ReturnType<typeof useNavLinkProps>>;

/**
 * In the 72px rail the names are not shown: they appear in a tooltip on the right (over the page,
 * never over the video on the other side). In the full column the row shows its own text.
 */
export function RailTooltip({ rail, label, children }: { rail: boolean; label: string; children: ReactElement }) {
  return rail ? <Tooltip content={label} placement="right">{children}</Tooltip> : children;
}

/** A square icon tile in place of artwork (後で聴く, 評価した曲, folders …), the size of a cover. */
export function LibraryIconTile({ rail, children }: { rail: boolean; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex shrink-0 items-center justify-center rounded-[4px] bg-yt-tonal-solid text-yt-text',
        rail ? 'size-12' : 'size-10',
      )}
    >
      {children}
    </span>
  );
}

interface LibraryLinkProps {
  to: string;
  label: string;
  /** The grey second line of the full column (「プレイリスト · 12曲」). */
  meta?: ReactNode;
  /** A SquareArt or a LibraryIconTile (size-12 in the rail, size-10 in the full column). */
  art: ReactNode;
  active: boolean;
  rail: boolean;
  /** The rail's tooltip with the name (off where it could reach the video, see RAIL_NAME_TOOLTIP_MEDIA_QUERY). */
  tooltip?: boolean;
  handlers: NavLinkHandlers;
}

/** One entry of the library list: a 56px row (cover + name + kind line), or a cover alone in the rail. */
export function LibraryLink({ to, label, meta, art, active, rail, tooltip = true, handlers }: LibraryLinkProps) {
  return (
    <RailTooltip rail={rail && tooltip} label={label}>
      <Link
        to={to}
        aria-current={active ? 'page' : undefined}
        aria-label={rail ? label : undefined}
        className={cx(LIBRARY_ROW_CLASS, libraryRowStateClass(active), 'h-14', rail ? 'justify-center' : 'gap-3 px-2')}
        {...handlers}
      >
        {art}
        {!rail && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium leading-5">{label}</span>
            {meta && <span className="block truncate text-xs leading-[18px] text-yt-text-secondary">{meta}</span>}
          </span>
        )}
      </Link>
    </RailTooltip>
  );
}
