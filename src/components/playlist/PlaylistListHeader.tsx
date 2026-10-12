import type { SortKey } from '../../stores/playlistStore';
import { useTranslateSourceText } from '../../i18n';
import IconButton from '../ui/IconButton';
import SearchField from '../ui/SearchField';
import SortMenu from '../ui/SortMenu';
import { SelectMultipleFilledIcon, SelectMultipleIcon } from '../ui/icons';
import { cx } from '../ui/overlay';

interface PlaylistListHeaderProps {
  /** Hand-editable lists can be sorted; smart and synced lists keep their source order. */
  sortable: boolean;
  sortKey: SortKey;
  onSortChange: (sortKey: SortKey) => void;
  query: string;
  onQueryChange: (query: string) => void;
  resultCount: number;
  totalCount: number;
  selectionMode: boolean;
  onToggleSelection: () => void;
  /** Phones: compact sort button, search on the right, not sticky. */
  mobile: boolean;
}

/** 48px bar above the songs: 並べ替え, search in this playlist, 選択. */
export default function PlaylistListHeader({
  sortable,
  sortKey,
  onSortChange,
  query,
  onQueryChange,
  resultCount,
  totalCount,
  selectionMode,
  onToggleSelection,
  mobile,
}: PlaylistListHeaderProps) {
  const t = useTranslateSourceText();
  const sortOptions: { value: SortKey; label: string }[] = [
    { value: 'addedOrder', label: t('手動') },
    { value: 'name', label: t('曲名順') },
    { value: 'artist', label: t('アーティスト順') },
    { value: 'publishDate', label: t('公開日（新しい順）') },
  ];
  const search = (
    <SearchField
      value={query}
      onChange={onQueryChange}
      label={t('プレイリスト内を検索')}
      expandable
      width={mobile ? 200 : 240}
    />
  );

  return (
    <div
      data-testid="playlist-list-header"
      className={cx(
        'flex h-12 min-w-0 items-center gap-2 bg-yt-bg',
        !mobile && 'sticky top-[calc(var(--header-height,56px)_+_var(--selection-bar-height,0px))] z-[var(--z-sticky,20)]',
      )}
    >
      {sortable && <SortMenu value={sortKey} options={sortOptions} onChange={onSortChange} compact={mobile} />}
      {!mobile && search}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        {query.trim() !== '' && (
          <span className="truncate text-xs leading-4 text-yt-text-secondary tabular-nums" aria-live="polite">
            {t('{result} / {total}曲を表示', { result: resultCount, total: totalCount })}
          </span>
        )}
        {mobile && search}
        <IconButton
          label={t('選択')}
          icon={selectionMode ? <SelectMultipleFilledIcon /> : <SelectMultipleIcon />}
          pressed={selectionMode}
          className="-mr-2"
          onClick={onToggleSelection}
        />
      </div>
    </div>
  );
}
