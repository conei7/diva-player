import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { SpinnerIcon } from './iconsChrome';
import { cx } from './overlay';
import { useRefocusAfterLoading } from './useRefocusAfterLoading';

export type ButtonVariant = 'primary' | 'tonal' | 'outline' | 'text' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonClassNameOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  // 36px under 640px so small buttons stay tappable (DESIGN_SPEC §1.9).
  sm: 'h-8 px-3 max-sm:h-9',
  md: 'h-9 px-4',
  lg: 'h-10 px-4',
};

/** YouTube pulls the leading edge in when the pill starts with an icon. */
const ICON_PADDING: Record<ButtonSize, string> = {
  sm: 'pl-2',
  md: 'pl-3',
  lg: 'pl-3',
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-yt-inverse text-yt-on-inverse hover:bg-yt-inverse-hover disabled:bg-yt-tonal disabled:text-yt-text-disabled',
  tonal: 'bg-yt-tonal text-yt-text hover:bg-yt-tonal-hover disabled:bg-yt-tonal disabled:text-yt-text-disabled',
  outline: 'border border-yt-outline bg-transparent text-yt-text hover:bg-yt-tonal disabled:border-transparent disabled:bg-yt-tonal disabled:text-yt-text-disabled',
  text: 'bg-transparent text-yt-link hover:bg-yt-link/10 disabled:bg-transparent disabled:text-yt-text-disabled',
  ghost: 'bg-transparent text-yt-text hover:bg-yt-tonal disabled:bg-transparent disabled:text-yt-text-disabled',
};

/**
 * The Button look for elements that can't be a <button> (react-router <Link>, <a>).
 * Example: `<Link to="/" className={buttonClassName({ variant: 'tonal' })}>…</Link>`.
 */
// eslint-disable-next-line react-refresh/only-export-components -- part of the Button API (DESIGN_SPEC §4.1)
export function buttonClassName({ variant = 'tonal', size = 'md', fullWidth = false }: ButtonClassNameOptions = {}): string {
  return cx(
    fullWidth ? 'flex w-full' : 'inline-flex',
    'min-w-0 shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-sm font-medium leading-5 no-underline transition-colors duration-150 [-webkit-tap-highlight-color:transparent]',
    'disabled:cursor-default',
    SIZE_CLASS[size],
    VARIANT_CLASS[variant],
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Default 'tonal'. 'primary' (white) only for the screen's main action. */
  variant?: ButtonVariant;
  /** 32 / 36 / 40px (sm is 36px under 640px). Default 'md'. */
  size?: ButtonSize;
  /** Leading icon (20px for sm / md, 24px for lg). */
  icon?: ReactNode;
  /** Trailing icon such as ChevronDownIcon for a menu trigger. */
  trailingIcon?: ReactNode;
  /** display:flex; width:100%. */
  fullWidth?: boolean;
  /** Replaces the icon with a spinner and sets disabled + aria-busy. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

/** Pill button (DESIGN_SPEC §4.1). Replaces .btn-primary / .btn-secondary / .yt-action-btn. */
export default function Button({
  variant = 'tonal',
  size = 'md',
  icon,
  trailingIcon,
  fullWidth = false,
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ref,
  onClick,
  ...rest
}: ButtonProps) {
  const iconSize = size === 'lg' ? '[&>svg]:size-6' : '[&>svg]:size-5';
  const leading = loading ? <SpinnerIcon /> : icon;
  // Focus returns to the button when the loading it started ends (it is disabled meanwhile).
  const focusKeeper = useRefocusAfterLoading(loading, ref, onClick);

  return (
    <button
      ref={focusKeeper.ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
      onClick={focusKeeper.onClick}
      className={cx(buttonClassName({ variant, size, fullWidth }), leading ? ICON_PADDING[size] : null, className)}
    >
      {leading && <span aria-hidden="true" className={cx('flex shrink-0 items-center', iconSize)}>{leading}</span>}
      {children !== undefined && children !== null && children !== false && <span className="min-w-0 truncate">{children}</span>}
      {trailingIcon && <span aria-hidden="true" className={cx('-mr-1 flex shrink-0 items-center', iconSize)}>{trailingIcon}</span>}
    </button>
  );
}
