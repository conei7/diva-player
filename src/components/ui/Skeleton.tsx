import { SONG_ROW_LAYOUT } from './listLayout';
import { cx } from './overlay';
import type { SongRowSize } from './listLayout';

/*
 * Skeletons only exist where a screen renders them. Nothing here is mounted
 * globally: the home performance test requires zero `main .skeleton` while the
 * grid is visible, so append-loading uses a spinner instead.
 */

export interface SkeletonBlockProps {
  /** Size and shape (e.g. "h-4 w-1/2 rounded-badge"). */
  className?: string;
}

/** A `.skeleton` block (#272727 ⇄ #3f3f3f). */
export function SkeletonBlock({ className }: SkeletonBlockProps) {
  return <div aria-hidden="true" className={cx('skeleton', className)} />;
}

export interface SkeletonListRowProps {
  /** Same geometry as SongListRow of this size. Default 'md'. */
  size?: SongRowSize;
}

/** Placeholder with the same height as a SongListRow of the given size. */
export function SkeletonListRow({ size = 'md' }: SkeletonListRowProps) {
  const layout = SONG_ROW_LAYOUT[size];
  const lineHeight = layout.large ? 'h-[18px]' : 'h-3.5';

  return (
    <div aria-hidden="true" className={cx('flex items-start', layout.gap, layout.padding)}>
      <div className={cx('skeleton aspect-video shrink-0', layout.thumb, layout.radius === 'md' ? 'rounded-card' : 'rounded-chip')} />
      <div className={cx('min-w-0 flex-1', layout.large ? 'space-y-2.5 pt-1' : 'space-y-2 pt-0.5')}>
        <div className={cx('skeleton w-11/12 rounded-badge', lineHeight)} />
        <div className={cx('skeleton w-3/5 rounded-badge', lineHeight)} />
        <div className="skeleton h-3 w-2/5 rounded-badge" />
      </div>
    </div>
  );
}

/** 16:9 thumbnail + two lines (grid tile placeholder). */
export function SkeletonTile() {
  return (
    <div aria-hidden="true" className="min-w-0">
      <div className="skeleton aspect-video w-full rounded-card" />
      <div className="mt-3 space-y-2">
        <div className="skeleton h-4 w-11/12 rounded-badge" />
        <div className="skeleton h-3.5 w-3/5 rounded-badge" />
      </div>
    </div>
  );
}
