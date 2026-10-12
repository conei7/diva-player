import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { SpinnerIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { useRefocusAfterLoading } from '../ui/useRefocusAfterLoading';

export type RailButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode;
  /** Shows a spinner instead of the icon and disables the row. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

/**
 * A row of the history page's right column: 24px icon + 14px label, 40px tall, tonal on hover.
 * It forwards ref / onClick / onKeyDown / aria-*, so it can also be a Menu trigger.
 */
export function RailButton({ icon, loading = false, disabled, className, children, type = 'button', ref, onClick, ...rest }: RailButtonProps) {
  // Disabled while loading: focus comes back to the button when the work it started ends.
  const focusKeeper = useRefocusAfterLoading(loading, ref, onClick);
  return (
    <button
      ref={focusKeeper.ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
      onClick={focusKeeper.onClick}
      className={cx(
        'flex min-h-10 w-full cursor-pointer select-none items-center gap-4 rounded-row px-3 py-2 text-left text-sm leading-5 text-yt-text transition-colors duration-150',
        'hover:bg-yt-tonal disabled:cursor-default disabled:text-yt-text-disabled disabled:hover:bg-transparent',
        className,
      )}
    >
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center [&>svg]:size-6">
        {loading ? <SpinnerIcon /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export function RailDivider() {
  return <div role="separator" className="my-3 h-px bg-yt-divider" />;
}
