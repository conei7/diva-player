import { useId } from 'react';
import type { ReactNode } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { useRootLayoutVariable } from '../../hooks/useRootLayoutVariable';
import Button from './Button';
import IconButton from './IconButton';
import Menu from './Menu';
import { CloseIcon, MoreVertIcon } from './icons';

export interface SelectionBarProps {
  count: number;
  /** × 「選択を解除」 (leave selection mode). */
  onClose: () => void;
  /** Shows the 「すべて選択」 text button. */
  onSelectAll?: () => void;
  /** Main actions (tonal / primary Buttons; pass IconButtons below 640px). */
  children?: ReactNode;
  /** MenuItems for the ⋮ at the end. */
  overflow?: ReactNode;
  'data-testid'?: string;
}

/** Height of the bar (h-14). Published as `--selection-bar-height` while the bar is shown. */
const SELECTION_BAR_HEIGHT = '3.5rem';

/**
 * Contextual bar for selection mode, fixed under the top bar:
 * [×] 「{count}曲を選択中」 [すべて選択] … [actions] [⋮]
 * While it is shown, <html> carries `--selection-bar-height` (0 otherwise) so <main> and the
 * sticky rows (ChipBar etc.: `top: calc(var(--header-height) + var(--selection-bar-height, 0px))`)
 * move below it instead of being covered.
 */
export function SelectionBar({
  count,
  onClose,
  onSelectAll,
  children,
  overflow,
  'data-testid': testId,
}: SelectionBarProps) {
  const t = useTranslateSourceText();
  const countId = useId();
  const moreLabel = t('その他の操作');
  useRootLayoutVariable('--selection-bar-height', SELECTION_BAR_HEIGHT);

  return (
    <div
      role="toolbar"
      aria-labelledby={countId}
      data-testid={testId}
      className="fixed left-[var(--guide-offset,0px)] right-[var(--music-panel-offset,0px)] top-[var(--header-height,56px)] z-[var(--z-selection,48)] flex h-14 items-center gap-0 border-b border-yt-divider bg-yt-raised px-1 text-yt-text sm:gap-2 sm:px-4"
    >
      <IconButton label={t('選択を解除')} icon={<CloseIcon />} onClick={onClose} />
      <span id={countId} aria-live="polite" className="min-w-0 truncate px-1 text-base leading-6 font-medium tabular-nums sm:px-0">
        {t('{count}曲を選択中', { count })}
      </span>
      {onSelectAll && (
        <Button variant="text" size="sm" className="shrink-0" onClick={onSelectAll}>
          {t('すべて選択')}
        </Button>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0 sm:gap-2">
        {children}
        {overflow && (
          <Menu
            trigger={<IconButton label={moreLabel} icon={<MoreVertIcon />} />}
            align="end"
            label={moreLabel}
          >
            {overflow}
          </Menu>
        )}
      </div>
    </div>
  );
}

export default SelectionBar;
