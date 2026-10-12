import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import Tooltip from './Tooltip';
import type { TooltipPlacement } from './Tooltip';
import { cx } from './overlay';

export type IconButtonSize = 'sm' | 'md' | 'lg';
export type IconButtonVariant = 'ghost' | 'tonal' | 'filled' | 'overlay';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  /** Required. Used for aria-label and the tooltip (they are always the same string). */
  label: string;
  icon: ReactNode;
  /** 32 / 40 / 48px (icon 20 / 24 / 24); sm is 40px under 640px. Default 'md'. */
  size?: IconButtonSize;
  /** Default 'ghost'. 'filled' = white circle (play), 'overlay' = dark circle on top of thumbnails. */
  variant?: IconButtonVariant;
  /** Passing a boolean makes it a toggle (aria-pressed + brand-colored icon + a dot under it). */
  pressed?: boolean;
  /** Count in the top-right corner (numbers above 99 show as 99+). */
  badge?: number | string;
  /** 8px brand-colored dot in the top-right corner. */
  dot?: boolean;
  /** Defaults to `label`. `false` hides the tooltip. */
  tooltip?: string | false;
  tooltipPlacement?: TooltipPlacement;
  ref?: Ref<HTMLButtonElement>;
};

const SIZE_CLASS: Record<IconButtonSize, string> = {
  // Under 640px the small size still gives a 40px tap target (DESIGN_SPEC §1.9).
  sm: 'size-8 max-sm:size-10 [&_[data-icon]>svg]:size-5',
  md: 'size-10 [&_[data-icon]>svg]:size-6',
  lg: 'size-12 [&_[data-icon]>svg]:size-6',
};

/** Distance from the button's center to just below the icon (icon half + 4px). */
const DOT_OFFSET: Record<IconButtonSize, string> = {
  sm: 'top-[calc(50%+14px)]',
  md: 'top-[calc(50%+16px)]',
  lg: 'top-[calc(50%+16px)]',
};

const VARIANT_CLASS: Record<IconButtonVariant, string> = {
  ghost: 'bg-transparent hover:bg-yt-tonal active:bg-yt-tonal-hover disabled:bg-transparent',
  tonal: 'bg-yt-tonal hover:bg-yt-tonal-hover active:bg-yt-tonal-hover disabled:bg-yt-tonal',
  filled: 'bg-yt-inverse hover:bg-yt-inverse-hover active:bg-yt-inverse-hover disabled:bg-yt-tonal',
  overlay: 'bg-black/60 hover:bg-black/80 active:bg-black/80 disabled:bg-black/60',
};

/** Kept apart from VARIANT_CLASS so `pressed` can swap the color without two competing text utilities. */
const VARIANT_TEXT: Record<IconButtonVariant, string> = {
  ghost: 'text-yt-text',
  tonal: 'text-yt-text',
  filled: 'text-yt-on-inverse',
  overlay: 'text-white',
};

function formatBadge(badge: number | string): string {
  return typeof badge === 'number' && badge > 99 ? '99+' : String(badge);
}

/** Round icon-only button. The tooltip text and aria-label are always `label` (no `title`). */
export default function IconButton({
  label,
  icon,
  size = 'md',
  variant = 'ghost',
  pressed,
  badge,
  dot = false,
  tooltip,
  tooltipPlacement,
  className,
  type = 'button',
  ref,
  ...rest
}: IconButtonProps) {
  const showBadge = badge !== undefined && badge !== null && badge !== '' && badge !== 0;
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      {...rest}
      className={cx(
        'relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center rounded-full transition-colors duration-150 [-webkit-tap-highlight-color:transparent]',
        'disabled:cursor-default disabled:text-yt-text-disabled',
        SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        pressed ? 'text-brand' : VARIANT_TEXT[variant],
        className,
      )}
    >
      <span data-icon="" aria-hidden="true" className="flex items-center justify-center">{icon}</span>
      {pressed && (
        <span aria-hidden="true" className={cx('pointer-events-none absolute left-1/2 size-1 -translate-x-1/2 rounded-full bg-brand', DOT_OFFSET[size])} />
      )}
      {dot && (
        <span aria-hidden="true" className="pointer-events-none absolute right-1.5 top-1.5 size-2 rounded-full bg-brand" />
      )}
      {showBadge && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-yt-inverse px-1 text-xs font-medium leading-4 tabular-nums text-yt-on-inverse"
        >
          {formatBadge(badge)}
        </span>
      )}
    </button>
  );
  const tooltipText = tooltip === false ? '' : (tooltip ?? label);
  if (!tooltipText) return button;
  return <Tooltip content={tooltipText} placement={tooltipPlacement}>{button}</Tooltip>;
}
