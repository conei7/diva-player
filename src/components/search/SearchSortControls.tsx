import { useSearchStore, type ExtendedSortRule } from '../../stores/searchStore';
import { useTranslate } from '../../i18n';

const SORT_OPTIONS: { value: ExtendedSortRule; labelKey: 'sortPopular' | 'sortRating' | 'sortTotalViews' | 'sortYoutubeViews' | 'sortNicoViews' | 'sortPublishDate' | 'sortAddedDate' | 'sortName' | 'sortRandom' }[] = [
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

export default function SearchSortControls() {
  const t = useTranslate();
  const { sort, sortOrder, setSort, setSortOrder, search } = useSearchStore();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="sort-select" className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
        {t('sortBy')}
      </label>
      <select
        id="sort-select"
        value={sort}
        onChange={(event) => {
          setSort(event.target.value as ExtendedSortRule);
          search();
        }}
        className="ui-select"
      >
        {SORT_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
        ))}
      </select>
      <button
        id="sort-order-toggle"
        type="button"
        onClick={() => {
          if (sort === 'Random') setSort('Random');
          else setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
          search();
        }}
        title={sort === 'Random' ? t('randomizeSort') : sortOrder === 'desc' ? t('switchAsc') : t('switchDesc')}
        aria-label={sort === 'Random' ? t('randomizeSort') : sortOrder === 'desc' ? t('descendingNow') : t('ascendingNow')}
        className="flex items-center justify-center rounded-lg transition-all"
        style={{
          width: '32px', height: '32px',
          background: 'rgba(255,255,255,0.05)',
          color: 'var(--color-text-secondary)',
          border: '1px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
        }}
      >
        {sort === 'Random'
          ? <span aria-hidden="true">↻</span>
          : sortOrder === 'desc'
          ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 14l5-5 5 5z" transform="rotate(180 12 12)"/><path d="M7 10l5 5 5-5z"/></svg>
          : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 14l5-5 5 5z"/><path d="M7 10l5 5 5-5z" transform="rotate(180 12 12)"/></svg>
        }
      </button>
    </div>
  );
}
