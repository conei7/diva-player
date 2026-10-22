import { useId } from 'react';
import type { ReactNode } from 'react';
import { cx } from './overlay';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** One short line under the label; linked with aria-describedby. */
  description?: ReactNode;
  disabled?: boolean;
  /** id of the <input>. */
  id?: string;
  /** Only the switch is drawn; the label becomes its accessible name. */
  labelHidden?: boolean;
  /** Added to the row <label> (settings pass "setting-row"). */
  className?: string;
}

/**
 * The whole row is a <label>, so clicking anywhere toggles it. Inside is a real
 * <input type="checkbox" role="switch"> (tests and assistive tech see a checkbox).
 */
export default function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  id,
  labelHidden = false,
  className,
}: SwitchProps) {
  const generatedId = useId();
  const inputId = id ?? `${generatedId}-switch`;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const hiddenLabelText = labelHidden && typeof label === 'string' ? label : undefined;

  const control = (
    <span className="relative inline-flex h-5 w-9 shrink-0">
      <input
        id={inputId}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={hiddenLabelText}
        aria-describedby={descriptionId}
        onChange={event => onChange(event.target.checked)}
        className="peer absolute inset-0 m-0 h-full w-full cursor-[inherit] appearance-none rounded-full opacity-0"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-full bg-yt-outline transition-colors duration-150 peer-checked:bg-brand peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-yt-focus peer-disabled:opacity-40"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 peer-checked:translate-x-4 peer-disabled:opacity-70"
      />
    </span>
  );

  if (labelHidden) {
    return (
      <label
        className={cx(
          "ui-switch-row relative inline-flex items-center before:absolute before:-inset-2.5 before:content-['']",
          disabled ? 'cursor-default' : 'cursor-pointer',
          className,
        )}
      >
        {hiddenLabelText === undefined && <span className="sr-only">{label}</span>}
        {control}
        {description && <span id={descriptionId} className="sr-only">{description}</span>}
      </label>
    );
  }

  return (
    <label
      className={cx(
        'ui-switch-row flex min-w-0 items-center gap-4',
        disabled ? 'cursor-default' : 'cursor-pointer',
        className,
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={cx('block text-sm leading-5', disabled ? 'text-yt-text-disabled' : 'text-yt-text')}>{label}</span>
        {description && (
          <span id={descriptionId} className="mt-0.5 block text-xs leading-[18px] text-yt-text-secondary">
            {description}
          </span>
        )}
      </span>
      {control}
    </label>
  );
}
