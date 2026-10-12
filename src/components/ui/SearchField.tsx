import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslateSourceText } from '../../i18n';
import IconButton from './IconButton';
import { CloseIcon, SearchIcon } from './icons';
import { cx } from './overlay';

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Required. aria-label of the input (and tooltip of the collapsed button). */
  label: string;
  /** Defaults to the label. */
  placeholder?: string;
  /** Default 'filled'. */
  variant?: 'filled' | 'underline';
  /** Collapsed to a 🔍 button until pressed; collapses again on Esc or when blurred while empty. */
  expandable?: boolean;
  /** Width in px (expandable: the expanded width, default 240). */
  width?: number;
  autoFocus?: boolean;
  /** Enter (outside IME composition). */
  onSubmit?: () => void;
  className?: string;
}

export default function SearchField({
  value,
  onChange,
  label,
  placeholder,
  variant = 'filled',
  expandable = false,
  width,
  autoFocus = false,
  onSubmit,
  className,
}: SearchFieldProps) {
  const t = useTranslateSourceText();
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [expandedByUser, setExpandedByUser] = useState(false);
  const focusToggleAfterCollapse = useRef(false);
  const expanded = !expandable || expandedByUser || value !== '';

  useEffect(() => {
    if (!expanded && focusToggleAfterCollapse.current) {
      focusToggleAfterCollapse.current = false;
      toggleRef.current?.focus();
    }
  }, [expanded]);

  const collapse = (restoreFocus: boolean) => {
    if (restoreFocus) focusToggleAfterCollapse.current = true;
    setExpandedByUser(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (event.key === 'Enter' && !composing) {
      if (onSubmit) {
        event.preventDefault();
        onSubmit();
      }
      return;
    }
    if (event.key !== 'Escape' || composing) return;
    if (value === '' && !expandable) return; // let a surrounding dialog handle Esc
    event.preventDefault();
    event.stopPropagation();
    if (value !== '') onChange('');
    if (expandable) collapse(true);
  };

  // A field that opened because it had a value stays open while it is being edited.
  const handleFocus = () => {
    if (expandable) setExpandedByUser(true);
  };

  const handleBlur = () => {
    if (expandable && value === '') collapse(false);
  };

  const clear = () => {
    onChange('');
    if (expandable) setExpandedByUser(true);
    inputRef.current?.focus();
  };

  if (!expanded) {
    return (
      <IconButton
        ref={toggleRef}
        label={label}
        icon={<SearchIcon />}
        className={className}
        onClick={() => setExpandedByUser(true)}
      />
    );
  }

  const fieldWidth = width ?? (expandable ? 240 : undefined);
  const filled = variant === 'filled';

  return (
    <div
      className={cx(
        'relative flex h-10 min-w-0 items-center text-yt-text',
        filled
          ? 'rounded-full bg-yt-tonal focus-within:bg-yt-tonal-hover focus-within:ring-1 focus-within:ring-yt-focus'
          : 'shadow-[inset_0_-1px_0_var(--color-yt-text-disabled)] focus-within:shadow-[inset_0_-2px_0_var(--color-yt-text)]',
        className,
      )}
      style={fieldWidth ? { width: fieldWidth, maxWidth: '100%' } : undefined}
    >
      <span aria-hidden="true" className={cx('pointer-events-none absolute flex text-yt-text-secondary', filled ? 'left-3' : 'left-1')}>
        <SearchIcon size={20} />
      </span>
      <input
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        autoFocus={autoFocus || (expandable && expandedByUser)}
        onChange={event => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={cx(
          'h-full w-full min-w-0 appearance-none bg-transparent text-base leading-5 text-yt-text placeholder:text-yt-text-secondary focus-visible:outline-none sm:text-sm',
          '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none',
          filled ? 'rounded-full pl-10' : 'pl-8',
          value ? 'pr-10' : filled ? 'pr-4' : 'pr-1',
        )}
      />
      {value && (
        <IconButton
          size="sm"
          label={t('検索をクリア')}
          icon={<CloseIcon size={20} />}
          className={cx('absolute', filled ? 'right-1' : 'right-0')}
          onClick={clear}
        />
      )}
    </div>
  );
}
