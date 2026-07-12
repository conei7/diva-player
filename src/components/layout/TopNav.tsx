import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useUiStore } from '../../stores/uiStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useSearchStore } from '../../stores/searchStore';
import { useSelectionStore } from '../../stores/selectionStore';
import {
  getSearchSuggestions,
  searchProducersByName,
  searchVocalistsByName,
  type SearchSuggestion,
} from '../../api/vocadb';

const SEARCH_HISTORY_KEY = 'divaSearchHistory';
const MAX_SEARCH_HISTORY = 10;

function readSearchHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_SEARCH_HISTORY);
  } catch {
    return [];
  }
}

function writeSearchHistory(history: string[]) {
  try {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Ignore storage failures; search itself should keep working.
  }
}

/**
 * TopNav - YouTube風のトップナビゲーションバー
 *
 * 左端: ハンバーガーメニュー + DIVAロゴ
 * 中央: 検索バー
 * 右端: ユーザーアイコン
 */
export default function TopNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const isWatchPage = location.pathname === '/watch';
  const { toggleSidebar, toggleMobileDrawer } = useUiStore();
  const { hiddenMode, toggleHiddenMode } = usePlayerStore();
  const {
    setQuery: setSearchStoreQuery,
    search: runSearch,
    searchTitleOnly,
    searchByArtistId,
    addVocalistFilter,
    setVocalistFilters,
    setVocalistMatchMode,
  } = useSearchStore();
  const isSelectionMode = useSelectionStore(s => s.isSelectionMode);
  const enterSelectionMode = useSelectionStore(s => s.enterSelectionMode);
  const exitSelectionMode  = useSelectionStore(s => s.exitSelectionMode);
  const selectedCount = useSelectionStore(s => s.selectedSongIds.size);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'auto' | 'song' | 'producer' | 'vocalist'>('auto');
  const [searchFocused, setSearchFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [isSuggestLoading, setIsSuggestLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => readSearchHistory());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchFormRef = useRef<HTMLFormElement>(null);
  const showRecentSearches = showSuggestions && searchQuery.trim().length === 0 && recentSearches.length > 0;

  const rememberSearch = (term: string) => {
    const normalized = term.trim();
    if (!normalized) return;

    setRecentSearches(current => {
      const next = [
        normalized,
        ...current.filter(item => item.toLowerCase() !== normalized.toLowerCase()),
      ].slice(0, MAX_SEARCH_HISTORY);
      writeSearchHistory(next);
      return next;
    });
  };

  const clearSearchHistory = () => {
    setRecentSearches([]);
    writeSearchHistory([]);
    setShowSuggestions(false);
  };

  // ロゴ5回クリックで隠しモードトグル
  const clickCountRef = useRef(0);
  const clickTimerRef = useRef<number | null>(null);
  const handleLogoClick = () => {
    clickCountRef.current += 1;
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      clickCountRef.current = 0;
    }, 1000);
    if (clickCountRef.current >= 5) {
      clickCountRef.current = 0;
      toggleHiddenMode();
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    if (!trimmed) return;

    rememberSearch(trimmed);
    setShowSuggestions(false);
    navigate('/');

    if (searchMode === 'song') {
      await searchTitleOnly(trimmed);
      return;
    }

    if (searchMode === 'producer') {
      const producers = await searchProducersByName(trimmed, 1);
      if (producers[0]) {
        await searchByArtistId(producers[0].id, producers[0].name);
      } else {
        await searchTitleOnly(trimmed);
      }
      return;
    }

    if (searchMode === 'vocalist') {
      const vocalists = await searchVocalistsByName(trimmed);
      const vocalist = vocalists[0];
      if (vocalist) {
        setSearchStoreQuery('');
        setVocalistFilters([{ id: vocalist.id, name: vocalist.name }]);
        setVocalistMatchMode('All');
        await runSearch();
      } else {
        await searchTitleOnly(trimmed);
      }
      return;
    }

    setSearchStoreQuery(trimmed);
    await runSearch();
  };

  useEffect(() => {
    const trimmed = searchQuery.trim();
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
          setShowSuggestions(document.activeElement === searchInputRef.current);
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
  }, [searchQuery]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!searchFormRef.current?.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSuggestionSelect = (suggestion: SearchSuggestion) => {
    rememberSearch(suggestion.label);
    setShowSuggestions(false);
    if (suggestion.kind === 'song') {
      setSearchQuery(suggestion.label);
      navigate(`/watch?v=${suggestion.id}`);
      return;
    }

    if (suggestion.kind === 'producer') {
      setSearchQuery(suggestion.label);
      searchByArtistId(suggestion.id, suggestion.label);
      navigate('/');
      return;
    }

    setSearchQuery('');
    setSearchStoreQuery('');
    addVocalistFilter({ id: suggestion.id, name: suggestion.label });
    runSearch();
    navigate('/');
  };

  const handleRecentSearchSelect = async (term: string) => {
    setSearchQuery(term);
    setShowSuggestions(false);
    rememberSearch(term);
    setSearchStoreQuery(term);
    navigate('/');
    await runSearch();
  };

  const kindLabel = (kind: SearchSuggestion['kind']) => {
    if (kind === 'song') return '曲';
    if (kind === 'producer') return 'P';
    return '歌';
  };

  const searchModes: Array<{ key: typeof searchMode; label: string; title: string }> = [
    { key: 'auto', label: '自動', title: '曲名とP名を自動判定' },
    { key: 'song', label: '曲', title: '曲名として検索' },
    { key: 'producer', label: 'P', title: 'P名として検索' },
    { key: 'vocalist', label: '歌', title: 'シンガー名として検索' },
  ];

  // キーボードショートカット: / で検索にフォーカス
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 glass-strong"
      style={{ height: 'var(--header-height)' }}
    >
      <div className="h-full flex items-center px-4 gap-3">

        {/* ─── 左: ハンバーガー + ロゴ ─── */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* ハンバーガーメニュー */}
          <button
            className="btn-ghost p-2 rounded-full"
            onClick={() => {
              // WatchPageまたはモバイルではドロワー、それ以外のデスクトップではサイドバートグル
              if (isWatchPage || window.innerWidth < 1024) {
                toggleMobileDrawer();
              } else {
                toggleSidebar();
              }
            }}
            title="メニュー"
            aria-label="メニュー"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
            </svg>
          </button>

          {/* ロゴ */}
          <Link
            to="/"
            aria-label="DIVA Player home"
            className="flex items-center gap-2 group"
            onClick={handleLogoClick}
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: hiddenMode ? 'rgba(100,100,100,0.5)' : 'var(--gradient-primary)' }}
            >
              <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
              </svg>
            </div>
            <span className="text-lg font-bold tracking-tight hidden sm:inline">
              <span
                className="glow-text"
                style={{ color: hiddenMode ? 'var(--color-text-muted)' : 'var(--color-accent-cyan)' }}
              >
                DIVA
              </span>
              <span style={{ color: 'var(--color-text-primary)' }}> Player</span>
            </span>
          </Link>
        </div>

        {/* ─── 中央: 検索バー ─── */}
        <div className="flex-1 flex justify-center max-w-2xl mx-auto">
          <form ref={searchFormRef} onSubmit={handleSearch} className="relative flex w-full">
            <div
              className="hidden sm:flex h-10 items-center rounded-l-full border border-r-0 px-1"
              style={{
                background: searchFocused ? '#121212' : 'var(--color-bg-primary)',
                borderColor: searchFocused ? 'var(--color-accent-purple)' : 'var(--color-border)',
              }}
            >
              {searchModes.map(mode => {
                const isActive = searchMode === mode.key;
                return (
                  <button
                    key={mode.key}
                    type="button"
                    title={mode.title}
                    className="h-7 min-w-8 rounded-full px-2 text-[11px] font-medium transition-colors"
                    style={{
                      background: isActive ? 'var(--color-accent-purple)' : 'transparent',
                      color: isActive ? '#fff' : 'var(--color-text-muted)',
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setSearchMode(mode.key)}
                  >
                    {mode.label}
                  </button>
                );
              })}
            </div>
            <div className="relative flex-1">
              <input
                ref={searchInputRef}
                type="text"
                placeholder="ボカロP名や曲名で検索"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (e.target.value.trim().length === 0 && recentSearches.length > 0) {
                    setShowSuggestions(true);
                  }
                }}
                onFocus={() => {
                  setSearchFocused(true);
                  if (searchQuery.trim().length >= 2 || recentSearches.length > 0) setShowSuggestions(true);
                }}
                onBlur={() => setSearchFocused(false)}
                className="w-full h-10 pl-4 pr-4 rounded-l-full sm:rounded-l-none text-sm outline-none transition-all"
                style={{
                  background: searchFocused ? '#121212' : 'var(--color-bg-primary)',
                  border: `1px solid ${searchFocused ? 'var(--color-accent-purple)' : 'var(--color-border)'}`,
                  borderRight: 'none',
                  color: 'var(--color-text-primary)',
                }}
              />
            </div>
            <button
              type="submit"
              className="px-5 h-10 rounded-r-full border border-l-0 flex items-center justify-center transition-colors"
              style={{
                background: 'var(--color-surface)',
                borderColor: searchFocused ? 'var(--color-accent-purple)' : 'var(--color-border)',
              }}
              aria-label="検索"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-secondary)' }}>
                <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
              </svg>
            </button>

            {showSuggestions && (showRecentSearches || suggestions.length > 0 || isSuggestLoading) && (
              <div
                className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-lg shadow-2xl"
                style={{
                  background: 'var(--color-surface-elevated)',
                  border: '1px solid var(--color-border)',
                }}
              >
                {showRecentSearches ? (
                  <div>
                    <div className="flex items-center justify-between px-4 py-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      <span>最近の検索</span>
                      <button
                        type="button"
                        className="transition-colors hover:text-white"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          clearSearchHistory();
                        }}
                      >
                        クリア
                      </button>
                    </div>
                    <ul className="max-h-96 overflow-y-auto py-1">
                      {recentSearches.map(term => (
                        <li key={term}>
                          <button
                            type="button"
                            className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/5"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              void handleRecentSearchSelect(term);
                            }}
                          >
                            <span
                              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full"
                              style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--color-text-muted)' }}
                            >
                              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="9" />
                                <path d="M12 7v5l3 2" />
                              </svg>
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                              {term}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : isSuggestLoading && suggestions.length === 0 ? (
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
        </div>

        {/* ─── 右: ユーザーアイコン ─── */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* 隠しモード表示 */}
          {hiddenMode && (
            <span
              className="text-[10px] font-bold px-2 py-1 rounded-full mr-1 hidden sm:inline"
              style={{ background: 'rgba(100,100,100,0.3)', color: 'var(--color-text-muted)' }}
            >
              隠しモード
            </span>
          )}
          {/* 複数選択モードトグルボタン */}
          <button
            onClick={() => isSelectionMode ? exitSelectionMode() : enterSelectionMode()}
            className="w-8 h-8 rounded-full flex items-center justify-center transition-all relative"
            style={{
              background: isSelectionMode
                ? 'var(--gradient-primary)'
                : 'rgba(255,255,255,0.07)',
              border: isSelectionMode
                ? 'none'
                : '1px solid var(--color-border)',
              color: isSelectionMode ? '#fff' : 'var(--color-text-secondary)',
            }}
            title={isSelectionMode ? `選択モード終了 (${selectedCount}曲選択中)` : '複数選択モード'}
            aria-label="複数選択モード"
            aria-pressed={isSelectionMode}
          >
            {isSelectionMode ? (
              /* チェック済みアイコン（アクティブ時） */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="3"/>
                <path d="M9 12l2 2 4-4"/>
              </svg>
            ) : (
              /* チェックボックスアイコン（非アクティブ時） */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="3"/>
                <path d="M9 12l2 2 4-4" strokeOpacity="0.4"/>
              </svg>
            )}
            {/* 選択数バッジ */}
            {isSelectionMode && selectedCount > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[16px] h-4 rounded-full text-[9px] font-bold flex items-center justify-center px-1"
                style={{ background: 'var(--color-accent-cyan)', color: '#000' }}
              >
                {selectedCount > 99 ? '99+' : selectedCount}
              </span>
            )}
          </button>

          <button
            className="w-8 h-8 rounded-full flex items-center justify-center overflow-hidden"
            style={{ background: 'var(--gradient-primary)' }}
            title="ユーザー"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
