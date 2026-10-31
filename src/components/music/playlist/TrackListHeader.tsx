import type { ReactNode } from 'react';
import type { SortKey } from '../../../stores/playlistStore';
import { useTranslateSourceText } from '../../../i18n';
import { ArrowDownwardIcon, ArrowUpwardIcon } from '../../ui/icons';
import { cx } from '../../ui/overlay';
import {
  nextTrackSortKey,
  TRACK_COLUMN,
  TRACK_ROW_GRID,
  trackAriaSort,
  trackLeadColumnClass,
  type TrackLeadKind,
  type TrackSortColumn,
} from './trackTable';

interface TrackListHeaderProps {
  /** Hand-editable lists can be sorted by clicking a column name; smart and synced lists cannot. */
  sortable: boolean;
  sortKey: SortKey;
  onSortChange: (sortKey: SortKey) => void;
  /** Same as the rows' first column, so the columns line up. */
  lead: TrackLeadKind;
}

/**
 * Column names of the music layout's track table, sticky right under the playlist's 48px
 * 並べ替え / search bar (which is itself sticky under the top bar). Not shown on phones, where a
 * row is only artwork, title and ⋮ (sorting stays in the 並べ替え menu).
 */
export default function TrackListHeader({ sortable, sortKey, onSortChange, lead }: TrackListHeaderProps) {
  const t = useTranslateSourceText();

  const label = (column: TrackSortColumn, text: string, align: 'start' | 'end' | 'center' = 'start'): ReactNode => {
    if (!sortable) return <span className="truncate">{text}</span>;
    const sorted = trackAriaSort(column, sortKey);
    // The manual order is the default: no arrow on # for it.
    const arrow = sorted && column !== 'number'
      ? (sorted === 'descending' ? <ArrowDownwardIcon size={16} /> : <ArrowUpwardIcon size={16} />)
      : null;
    return (
      <button
        type="button"
        onClick={() => onSortChange(nextTrackSortKey(column, sortKey))}
        className={cx(
          '-mx-1 inline-flex h-8 pointer-coarse:h-10 min-w-0 max-w-[calc(100%+0.5rem)] cursor-pointer items-center gap-1 rounded-[4px] px-1 transition-colors duration-150 hover:text-yt-text focus-visible:outline-2 focus-visible:outline-yt-focus',
          align === 'center' && 'justify-center',
          sorted && column !== 'number' && 'text-yt-text',
        )}
      >
        <span className="truncate">{text}</span>
        {arrow}
      </button>
    );
  };
  const sortAttribute = (column: TrackSortColumn) => (sortable ? trackAriaSort(column, sortKey) : undefined);

  return (
    <div
      role="rowgroup"
      data-testid="music-track-list-header"
      className="sticky top-[calc(var(--header-height,56px)_+_var(--selection-bar-height,0px)_+_3rem)] z-[var(--z-sticky,20)] mb-2 border-b border-yt-divider bg-yt-bg max-sm:hidden"
    >
      <div role="row" aria-rowindex={1} className={cx(TRACK_ROW_GRID, 'h-9 text-sm leading-5 text-yt-text-secondary')}>
        <div role="columnheader" aria-sort={sortAttribute('number')} className={trackLeadColumnClass(lead)}>
          {lead === 'handle' && <span aria-hidden="true" className="w-6 shrink-0" />}
          {lead === 'select' ? (
            <span className="flex w-10 shrink-0 justify-center"><span className="sr-only">#</span></span>
          ) : (
            <span className={TRACK_COLUMN.number}>{label('number', '#', 'center')}</span>
          )}
        </div>
        <div role="columnheader" aria-sort={sortAttribute('title')} className={TRACK_COLUMN.title}>
          {label('title', t('タイトル'))}
        </div>
        <div role="columnheader" aria-sort={sortAttribute('producer')} className={cx(TRACK_COLUMN.producer, 'flex')}>
          {label('producer', t('プロデューサー'))}
        </div>
        <div role="columnheader" aria-sort={sortAttribute('date')} className={cx(TRACK_COLUMN.date, 'flex')}>
          {label('date', t('公開日'))}
        </div>
        {/* No ellipsis: a longer translation may reach into the free space on its left. */}
        <div role="columnheader" className={cx(TRACK_COLUMN.duration, 'whitespace-nowrap')}>
          {t('長さ')}
        </div>
        <div role="columnheader" className={TRACK_COLUMN.actions}>
          <span className="sr-only">{t('その他の操作')}</span>
        </div>
      </div>
    </div>
  );
}
