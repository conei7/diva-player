import { useSearchStore, type ExtendedSortRule } from '../../stores/searchStore';

const SORT_OPTIONS: { value: ExtendedSortRule; label: string }[] = [
  { value: 'FavoritedTimes', label: '人気順' },
  { value: 'RatingScore', label: '評価順' },
  { value: 'TotalViews', label: '合計再生数' },
  { value: 'YoutubeViews', label: 'YouTube再生' },
  { value: 'NicoViews', label: 'ニコニコ再生' },
  { value: 'PublishDate', label: '公開日' },
  { value: 'AdditionDate', label: '登録日' },
  { value: 'Name', label: '名前順' },
];

export default function SearchSortControls() {
  const { sort, sortOrder, setSort, setSortOrder, search } = useSearchStore();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="sort-select" className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
        並び替え
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
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <button
        id="sort-order-toggle"
        type="button"
        onClick={() => {
          setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
          search();
        }}
        title={sortOrder === 'desc' ? '降順から昇順へ' : '昇順から降順へ'}
        aria-label={sortOrder === 'desc' ? '現在は降順。昇順に変更' : '現在は昇順。降順に変更'}
        className="flex items-center justify-center rounded-lg transition-all"
        style={{
          width: '32px', height: '32px',
          background: 'rgba(255,255,255,0.05)',
          color: 'var(--color-text-secondary)',
          border: '1px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
        }}
      >
        {sortOrder === 'desc'
          ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 14l5-5 5 5z" transform="rotate(180 12 12)"/><path d="M7 10l5 5 5-5z"/></svg>
          : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 14l5-5 5 5z"/><path d="M7 10l5 5 5-5z" transform="rotate(180 12 12)"/></svg>
        }
      </button>
    </div>
  );
}
