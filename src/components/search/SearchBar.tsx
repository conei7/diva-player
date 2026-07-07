import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSearchSuggestions, type SearchSuggestion } from '../../api/vocadb';
import { useSearchStore } from '../../stores/searchStore';

/**
 * SearchBar - 検索入力コンポーネント
 */
export default function SearchBar() {
  const navigate = useNavigate();
  const {
    query,
    setQuery,
    search,
    isLoading,
    searchByArtistId,
    addVocalistFilter,
  } = useSearchStore();
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [isSuggestLoading, setIsSuggestLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const rootRef = useRef<HTMLFormElement>(null);

  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    setShowSuggestions(false);
    search();
  }, [search]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setIsSuggestLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsSuggestLoading(true);
      try {
        const results = await getSearchSuggestions(trimmed);
        if (!controller.signal.aborted) {
          setSuggestions(results);
          setShowSuggestions(document.activeElement?.id === 'search-input');
        }
      } catch {
        if (!controller.signal.aborted) setSuggestions([]);
      } finally {
        if (!controller.signal.aborted) setIsSuggestLoading(false);
      }
    }, 220);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSuggestionSelect = useCallback((suggestion: SearchSuggestion) => {
    setShowSuggestions(false);
    if (suggestion.kind === 'song') {
      setQuery(suggestion.label);
      navigate(`/watch?v=${suggestion.id}`);
      return;
    }
    if (suggestion.kind === 'producer') {
      searchByArtistId(suggestion.id, suggestion.label);
      return;
    }

    setQuery('');
    addVocalistFilter({ id: suggestion.id, name: suggestion.label });
    search();
  }, [addVocalistFilter, navigate, search, searchByArtistId, setQuery]);

  const kindLabel = (kind: SearchSuggestion['kind']) => {
    if (kind === 'song') return '曲';
    if (kind === 'producer') return 'P';
    return '歌';
  };

  return (
    <form ref={rootRef} onSubmit={handleSubmit} className="relative w-full max-w-2xl mx-auto">
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
          onFocus={() => query.trim().length >= 2 && setShowSuggestions(true)}
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

      {showSuggestions && (suggestions.length > 0 || isSuggestLoading) && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-lg shadow-2xl"
          style={{
            background: 'var(--color-surface-elevated)',
            border: '1px solid var(--color-border)',
          }}
        >
          {isSuggestLoading && suggestions.length === 0 ? (
            <div className="px-4 py-3 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              候補を検索中...
            </div>
          ) : (
            <ul className="max-h-96 overflow-y-auto py-1">
              {suggestions.map((suggestion) => (
                <li key={`${suggestion.kind}-${suggestion.id}`}>
                  <button
                    type="button"
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/5"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSuggestionSelect(suggestion);
                    }}
                  >
                    <span
                      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                      style={{
                        background: suggestion.kind === 'song'
                          ? 'rgba(34, 211, 238, 0.15)'
                          : suggestion.kind === 'producer'
                            ? 'rgba(139, 92, 246, 0.18)'
                            : 'rgba(59, 130, 246, 0.16)',
                        color: suggestion.kind === 'song'
                          ? 'var(--color-accent-cyan)'
                          : suggestion.kind === 'producer'
                            ? 'var(--color-accent-purple)'
                            : '#60a5fa',
                      }}
                    >
                      {kindLabel(suggestion.kind)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                        {suggestion.label}
                      </span>
                      <span className="block truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        {suggestion.sublabel}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
