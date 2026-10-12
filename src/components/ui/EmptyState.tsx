import type { ReactNode } from 'react';
import { Link } from 'react-router';
import Button, { buttonClassName } from './Button';
import { cx } from './overlay';

export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  /** Renders a router link styled as a button. */
  to?: string;
  /** Default 'tonal'. */
  variant?: 'primary' | 'tonal';
}

export interface EmptyStateProps {
  /** Drawn at 64px (compact: 40px) in the disabled-text gray, whatever size the icon was given. */
  icon?: ReactNode;
  title: string;
  action?: EmptyStateAction;
  compact?: boolean;
}

/** Icon + one line + at most one button. There is deliberately no slot for a description. */
export default function EmptyState({ icon, title, action, compact = false }: EmptyStateProps) {
  const variant = action?.variant ?? 'tonal';

  return (
    <div className={cx('flex flex-col items-center px-4 text-center', compact ? 'py-6' : 'py-12')}>
      {icon && (
        <div
          aria-hidden="true"
          className={cx(
            'mb-4 flex text-yt-text-disabled',
            compact ? '[&>svg]:h-10 [&>svg]:w-10' : '[&>svg]:h-16 [&>svg]:w-16',
          )}
        >
          {icon}
        </div>
      )}
      <p className="m-0 max-w-md text-base leading-6 font-medium text-yt-text">{title}</p>
      {action && (
        <div className="mt-4">
          {action.to ? (
            <Link to={action.to} onClick={action.onClick} className={buttonClassName({ variant })}>
              {action.label}
            </Link>
          ) : (
            <Button variant={variant} onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
