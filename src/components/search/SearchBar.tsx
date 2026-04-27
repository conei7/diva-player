import { useCallback, type FormEvent } from 'react';
import { useSearchStore } from '../../stores/searchStore';

/**
 * SearchBar - 検索入力コンポーネント
 */
export default function SearchBar() {
  const { query, setQuery, search, isLoading } = useSearchStore();

  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    search();
  }, [search]);

  return (
    <form onSubmit={handleSubmit} className="relative w-full max-w-2xl mx-auto">
      <div className="relative">
        {/* 検索アイコン */}
        <div className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none"
             style={{ color: 'var(--color-text-muted)' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </div>

        <input
          id="search-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="曲名・アーティスト名で検索..."
          className="search-input pr-28"
          autoComplete="off"
        />

        {/* 検索ボタン */}
        <button
          type="submit"
          className="btn-primary absolute right-1.5 top-1/2 -translate-y-1/2 text-sm py-1.5 px-5"
          disabled={isLoading}
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              検索中
            </span>
          ) : (
            '検索'
          )}
        </button>
      </div>
    </form>
  );
}
