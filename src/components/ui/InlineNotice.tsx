import type { ReactNode } from 'react';
import Button from './Button';
import { InfoIcon, WarningIcon } from './icons';
import { cx } from './overlay';

export interface InlineNoticeAction {
  label: string;
  onClick: () => void;
}

export interface InlineNoticeProps {
  /** Only the icon takes the tone color (warning #ffb74d / error #ff4e45). Default 'neutral'. */
  tone?: 'neutral' | 'warning' | 'error';
  /** Defaults to ⓘ (neutral) or ⚠ (warning / error). Pass null for no icon. */
  icon?: ReactNode;
  children: ReactNode;
  /** Text button at the end. */
  action?: InlineNoticeAction;
  /** Text button before the main action. */
  secondaryAction?: InlineNoticeAction;
  /** Optional live-region role when the notice appears in response to something. */
  role?: 'status' | 'alert';
  className?: string;
}

const TONE_CLASS = {
  neutral: 'text-yt-text-secondary',
  warning: 'text-yt-warning',
  error: 'text-yt-danger',
} as const;

/** One-line notice: 40px min height, 8px 12px padding, 8px radius, faint background, 14px text. */
export function InlineNotice({
  tone = 'neutral',
  icon,
  children,
  action,
  secondaryAction,
  role,
  className,
}: InlineNoticeProps) {
  const iconNode = icon === undefined
    ? (tone === 'neutral' ? <InfoIcon size={20} /> : <WarningIcon size={20} />)
    : icon;

  return (
    <div
      role={role}
      className={cx(
        'flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 rounded-chip bg-white/5 px-3 py-2 text-sm leading-5 text-yt-text',
        className,
      )}
    >
      {iconNode && (
        <span aria-hidden="true" className={cx('flex shrink-0 [&>svg]:h-5 [&>svg]:w-5', TONE_CLASS[tone])}>
          {iconNode}
        </span>
      )}
      <div className="min-w-0 flex-1 basis-48">{children}</div>
      {(action || secondaryAction) && (
        <div className="-my-1 ml-auto flex shrink-0 items-center gap-1">
          {secondaryAction && (
            <Button variant="text" size="sm" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
          {action && (
            <Button variant="text" size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default InlineNotice;
