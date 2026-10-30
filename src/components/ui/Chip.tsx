import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { FINE_HOVER_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import IconButton from './IconButton';
import Tooltip from './Tooltip';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from './icons';
import { cx } from './overlay';

/* ─── Chip ──────────────────────────────────────────────────────────────── */

export type ChipProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Passing a boolean makes the chip a toggle (aria-pressed + data-active). */
  selected?: boolean;
  icon?: ReactNode;
  /** Shown after the label in a smaller, secondary color. */
  count?: number | string;
  ref?: Ref<HTMLButtonElement>;
};

const CHIP_BASE =
  'inline-flex h-10 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-chip px-3 text-sm font-medium leading-5 transition-colors duration-150 sm:h-8 disabled:cursor-default disabled:bg-yt-tonal disabled:text-yt-text-disabled';

/** Icons inside chips are drawn at 18px regardless of the size prop they were given. */
const CHIP_ICON = '-ml-0.5 flex shrink-0 [&>svg]:h-[18px] [&>svg]:w-[18px]';

export function Chip({ selected, icon, count, className, children, type = 'button', ref, ...rest }: ChipProps) {
  const toggleProps = selected === undefined
    ? {}
    : { 'aria-pressed': selected, 'data-active': selected ? 'true' : 'false' };
  const hasCount = count !== undefined && count !== null && count !== '';

  return (
    <button
      ref={ref}
      type={type}
      {...toggleProps}
      {...rest}
      className={cx(
        CHIP_BASE,
        selected
          ? 'bg-yt-inverse text-yt-on-inverse'
          : 'bg-yt-tonal text-yt-text hover:bg-yt-tonal-hover',
        className,
      )}
    >
      {icon && <span aria-hidden="true" className={CHIP_ICON}>{icon}</span>}
      <span>{children}</span>
      {hasCount && (
        <span className={cx('text-xs font-normal tabular-nums', selected ? 'text-yt-on-inverse/60' : 'text-yt-text-secondary')}>
          {count}
        </span>
      )}
    </button>
  );
}

/* ─── RemovableChip ─────────────────────────────────────────────────────── */

export interface RemovableChipProps {
  label: string;
  onRemove: () => void;
  /** Defaults to 「{label}を外す」. Used for the × button's aria-label and tooltip. */
  removeLabel?: string;
  icon?: ReactNode;
  onSelect?: () => void;
  selected?: boolean;
}

export function RemovableChip({ label, onRemove, removeLabel, icon, onSelect, selected }: RemovableChipProps) {
  const t = useTranslateSourceText();
  const removeText = removeLabel ?? t('{label}を外す', { label });

  return (
    <span className={cx('inline-flex h-10 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-chip border pl-3 pr-1 text-sm font-medium leading-5 text-yt-text sm:h-8', selected ? 'border-brand bg-yt-tonal' : 'border-yt-outline')}>
      {icon && <span aria-hidden="true" className={CHIP_ICON}>{icon}</span>}
      {onSelect
        ? <button type="button" onClick={onSelect} aria-pressed={selected} className="min-w-0 max-w-56 cursor-pointer truncate py-1">{label}</button>
        : <span className="min-w-0 truncate">{label}</span>}
      <Tooltip content={removeText}>
        <button
          type="button"
          aria-label={removeText}
          onClick={onRemove}
          className="relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-yt-text-secondary transition-colors duration-150 after:absolute after:-inset-2 after:content-[''] hover:bg-yt-tonal hover:text-yt-text"
        >
          <CloseIcon size={18} />
        </button>
      </Tooltip>
    </span>
  );
}

/* ─── ChipBar ───────────────────────────────────────────────────────────── */

export interface ChipBarProps {
  /** aria-label of the toolbar. */
  label: string;
  children: ReactNode;
  /** Fixed at the right edge, outside the scrolling area (e.g. the selection-mode button). */
  trailing?: ReactNode;
  /**
   * Sticks below the top bar on the page background (and below the SelectionBar while it is shown:
   * top = var(--header-height) + var(--selection-bar-height, 0px)).
   */
  sticky?: boolean;
  /**
   * The edge fades use `--chipbar-fade` (default: the page background #0f0f0f).
   * On another surface pass e.g. `[--chipbar-fade:var(--color-yt-raised)]`.
   */
  className?: string;
}

const FADE_SOLID = 'bg-[color:var(--chipbar-fade,var(--color-yt-bg))]';

export function ChipBar({ label, children, trailing, sticky = false, className }: ChipBarProps) {
  const t = useTranslateSourceText();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });
  const finePointer = useMediaQuery(FINE_HOVER_MEDIA_QUERY);

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    const start = scroller.scrollLeft > 1;
    const end = scroller.scrollLeft < maxScroll - 1;
    setOverflow(previous => (previous.start === start && previous.end === end ? previous : { start, end }));
  }, []);

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measure());
    if (scrollerRef.current) observer.observe(scrollerRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [measure]);

  const scrollByPage = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const distance = Math.max(scroller.clientWidth - 96, scroller.clientWidth * 0.6);
    scroller.scrollBy({ left: direction * distance, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cx(
        'flex min-w-0 items-center gap-3',
        sticky && 'sticky top-[calc(var(--header-height,56px)_+_var(--selection-bar-height,0px))] z-[var(--z-sticky,20)] bg-yt-bg',
        className,
      )}
    >
      <div className="relative min-w-0 flex-1">
        {/* -m-1 p-1: room inside the scroll box for the focus ring (2px + 2px offset), which the
            box would clip otherwise; the bar's own size and the chips' positions stay the same. */}
        <div
          ref={scrollerRef}
          onScroll={measure}
          className="-m-1 scroll-px-12 overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div ref={contentRef} className="flex w-max items-center gap-3">
            {children}
          </div>
        </div>
        {/* The fades start 4px outside the bar, over the scroll box's focus-ring padding. */}
        {overflow.start && (
          <div className="pointer-events-none absolute inset-y-0 -left-1 flex items-stretch">
            <div className={cx('w-1', FADE_SOLID)} />
            {finePointer && (
              <div className={cx('flex items-center', FADE_SOLID)}>
                <IconButton
                  label={t('左へスクロール')}
                  icon={<ChevronLeftIcon />}
                  tabIndex={-1}
                  className="pointer-events-auto"
                  onClick={() => scrollByPage(-1)}
                />
              </div>
            )}
            <div className="w-12 bg-linear-to-r from-[color:var(--chipbar-fade,var(--color-yt-bg))] to-transparent" />
          </div>
        )}
        {overflow.end && (
          <div className="pointer-events-none absolute inset-y-0 -right-1 flex items-stretch">
            <div className="w-12 bg-linear-to-l from-[color:var(--chipbar-fade,var(--color-yt-bg))] to-transparent" />
            {finePointer && (
              <div className={cx('flex items-center', FADE_SOLID)}>
                <IconButton
                  label={t('右へスクロール')}
                  icon={<ChevronRightIcon />}
                  tabIndex={-1}
                  className="pointer-events-auto"
                  onClick={() => scrollByPage(1)}
                />
              </div>
            )}
            <div className={cx('w-1', FADE_SOLID)} />
          </div>
        )}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
    </div>
  );
}
