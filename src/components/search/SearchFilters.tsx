import { useSearchStore } from '../../stores/searchStore';
import type { SongSortRule } from '../../types/vocadb';

const SORT_OPTIONS: { value: SongSortRule; label: string }[] = [
  { value: 'FavoritedTimes', label: '人気順' },
  { value: 'RatingScore', label: '評価順' },
  { value: 'PublishDate', label: '公開日順' },
  { value: 'AdditionDate', label: '登録日順' },
  { value: 'Name', label: '名前順' },
];

/**
 * SearchFilters - ソート順などの検索フィルター
 */
export default function SearchFilters() {
  const { sort, setSort, search, totalCount, hasSearched } = useSearchStore();

  return (
    <div className="flex items-center justify-between flex-wrap gap-3">
      {/* 結果件数 */}
      {hasSearched && (
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          <span style={{ color: 'var(--color-accent-cyan)' }} className="font-semibold">
            {totalCount.toLocaleString()}
          </span>
          {' '}件の結果
        </p>
      )}

      <div className="flex items-center gap-2 ml-auto">
        <label htmlFor="sort-select" className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          並び替え:
        </label>
        <select
          id="sort-select"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as SongSortRule);
            search();
          }}
          className="text-sm rounded-lg px-3 py-1.5 outline-none cursor-pointer transition-colors"
          style={{
            background: 'var(--color-surface)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border)',
          }}
        >
          {SORT_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
