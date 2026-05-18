import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useUiStore } from '../../stores/uiStore';
import { usePlayerStore } from '../../stores/playerStore';

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
  const { toggleSidebar, toggleMobileDrawer } = useUiStore();
  const { hiddenMode, toggleHiddenMode } = usePlayerStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

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
              // モバイルではドロワー、デスクトップではトグル
              if (window.innerWidth < 1024) {
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
          <form onSubmit={handleSearch} className="flex w-full">
            <div className="relative flex-1">
              <input
                ref={searchInputRef}
                type="text"
                placeholder="ボカロP名や曲名で検索"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                className="w-full h-10 pl-4 pr-4 rounded-l-full text-sm outline-none transition-all"
                style={{
                  background: searchFocused ? '#121212' : 'var(--color-bg-primary)',
                  border: `1px solid ${searchFocused ? 'var(--color-accent-purple)' : 'var(--color-border)'}`,
                  borderRight: 'none',
                  color: 'var(--color-text-primary)',
                }}
              />
              {searchFocused && (
                <div
                  className="absolute left-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                  </svg>
                </div>
              )}
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
