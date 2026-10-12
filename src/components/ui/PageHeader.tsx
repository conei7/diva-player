import type { ReactNode } from 'react';
import { cx } from './overlay';

export interface PageShellProps {
  className?: string;
  children: ReactNode;
}

/**
 * Page container: as wide as the window next to the guide (left-aligned, no max width), with
 * 24px top and 24px (≥1024) / 16px (640–1023) / 12px (<640) sides.
 * It is a plain <div>; the only <main> is the one in Layout.
 */
export function PageShell({ className, children }: PageShellProps) {
  return (
    <div className={cx('w-full px-3 pt-6 sm:px-4 lg:px-6', className)}>
      {children}
    </div>
  );
}

export interface PageHeaderProps {
  /** Rendered as the page's h1. */
  title: ReactNode;
  /** 14px secondary text next to the title (below it when narrow). */
  meta?: ReactNode;
  /** Right-aligned actions (8px apart). Folding them into ⋮ on mobile is up to the page. */
  actions?: ReactNode;
  titleId?: string;
  className?: string;
}

/**
 * Title row of a page. No eyebrow and no description paragraph by design.
 * The title keeps at least 12rem; when the actions don't fit beside it they wrap below.
 */
export function PageHeader({ title, meta, actions, titleId, className }: PageHeaderProps) {
  return (
    <div className={cx('mb-4 flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2', className)}>
      <div className="flex min-w-0 flex-[1_1_12rem] flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 id={titleId} className="m-0 min-w-0 break-words text-xl leading-7 font-bold text-yt-text sm:text-[28px] sm:leading-9">
          {title}
        </h1>
        {meta && <div className="text-sm leading-5 text-yt-text-secondary">{meta}</div>}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
