import { useSearchStore, type ExtendedSortRule } from '../../stores/searchStore';
import { useTranslate, type TranslationKey } from '../../i18n';
import IconButton from '../ui/IconButton';
import { ArrowDownwardIcon, ArrowUpwardIcon, ChevronDownIcon, RefreshIcon, SortIcon } from '../ui/icons';
import { cx } from '../ui/overlay';

const SORT_OPTIONS: { value: ExtendedSortRule; labelKey: TranslationKey }[] = [
  { value: 'FavoritedTimes', labelKey: 'sortPopular' },
  { value: 'RatingScore', labelKey: 'sortRating' },
  { value: 'TotalViews', labelKey: 'sortTotalViews' },
  { value: 'YoutubeViews', labelKey: 'sortYoutubeViews' },
  { value: 'NicoViews', labelKey: 'sortNicoViews' },
  { value: 'PublishDate', labelKey: 'sortPublishDate' },
  { value: 'AdditionDate', labelKey: 'sortAddedDate' },
  { value: 'Name', labelKey: 'sortName' },
  { value: 'Random', labelKey: 'sortRandom' },
];

/**
 * Sort order of the search results: a native select styled as a tonal pill (#sort-select) and the
 * ascending / descending toggle (#sort-order-toggle; "reshuffle" for the random order).
 */
export default function SearchSortControls({ compact = false }: { compact?: boolean }) {
  const t = useTranslate();
  const sort = useSearchStore(state => state.sort);
  const sortOrder = useSearchStore(state => state.sortOrder);
  const setSort = useSearchStore(state => state.setSort);
  const setSortOrder = useSearchStore(state => state.setSortOrder);
  const search = useSearchStore(state => state.search);
  const orderLabel = sort === 'Random'
    ? t('randomizeSort')
    : sortOrder === 'desc' ? t('switchAsc') : t('switchDesc');

  return (
    <div className={cx('flex items-center gap-1', compact ? 'min-w-0 flex-1' : 'shrink-0')}>
      <label htmlFor="sort-select" className="sr-only">{t('sortBy')}</label>
      <div
        className={cx(
          'relative flex h-9 items-center rounded-full bg-yt-tonal text-yt-text transition-colors duration-150 hover:bg-yt-tonal-hover focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-yt-focus max-sm:h-10',
          compact && 'min-w-0 flex-1',
        )}
      >
        {!compact && (
          <span aria-hidden="true" className="pointer-events-none absolute left-3 flex text-yt-text">
            <SortIcon size={20} />
          </span>
        )}
        <select
          id="sort-select"
          value={sort}
          onChange={(event) => {
            setSort(event.target.value as ExtendedSortRule);
            void search();
          }}
          className={cx(
            'h-full cursor-pointer appearance-none rounded-full bg-transparent pr-9 text-sm leading-5 font-medium text-yt-text outline-none',
            compact ? 'w-full min-w-0 truncate pl-4' : 'pl-10',
          )}
        >
          {SORT_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
          ))}
        </select>
        <span aria-hidden="true" className="pointer-events-none absolute right-3 flex text-yt-text">
          <ChevronDownIcon size={20} />
        </span>
      </div>
      <IconButton
        id="sort-order-toggle"
        label={orderLabel}
        icon={sort === 'Random' ? <RefreshIcon /> : sortOrder === 'desc' ? <ArrowDownwardIcon /> : <ArrowUpwardIcon />}
        onClick={() => {
          if (sort === 'Random') setSort('Random');
          else setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
          void search();
        }}
      />
    </div>
  );
}
