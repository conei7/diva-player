import { Link, useLocation } from 'react-router-dom';
import { useUiStore } from '../../stores/uiStore';

/**
 * Sidebar - YouTube風の左サイドバー
 *
 * PC: 常時表示（展開 or 縮小アイコンのみ）
 * モバイル: ドロワーとしてオーバーレイ表示
 */

interface MenuItem {
  path: string;
  label: string;
  icon: React.ReactNode;
}

const menuItems: MenuItem[] = [
  {
    path: '/',
    label: 'ホーム',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
      </svg>
    ),
  },
  {
    path: '/history',
    label: '履歴',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
      </svg>
    ),
  },
  {
    path: '/favorites',
    label: '高評価した曲',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
      </svg>
    ),
  },
  {
    path: '/playlists',
    label: 'プレイリスト',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
      </svg>
    ),
  },
  {
    path: '/reports',
    label: 'レポート',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M5 19h14v2H5zM7 17H5V9h2zm6 0h-2V3h2zm6 0h-2v-5h2z" />
      </svg>
    ),
  },
  {
    path: '/favorite-producers',
    label: 'お気に入りP',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3z" />
      </svg>
    ),
  },
];

export default function Sidebar() {
  const location = useLocation();
  const isWatchPage = location.pathname === '/watch';
  const { sidebarExpanded, mobileDrawerOpen, closeMobileDrawer } = useUiStore();

  const content = (
    <nav className="flex flex-col py-2 h-full">
      {menuItems.map((item) => {
        const isActive = location.pathname === item.path;
        return (
          <Link
            key={item.path}
            to={item.path}
            className="flex items-center gap-5 px-3 py-2.5 mx-2 rounded-xl transition-all duration-150"
            style={{
              color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              background: isActive ? 'var(--color-surface)' : 'transparent',
              fontWeight: isActive ? 600 : 400,
              fontSize: sidebarExpanded ? '14px' : '10px',
              flexDirection: sidebarExpanded ? 'row' : 'column',
              justifyContent: sidebarExpanded ? 'flex-start' : 'center',
              padding: sidebarExpanded ? '10px 12px' : '14px 0 10px 0',
            }}
            onClick={() => closeMobileDrawer()}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.background = 'var(--color-surface-hover)';
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.background = 'transparent';
            }}
          >
            <span className="flex-shrink-0" style={{ opacity: isActive ? 1 : 0.7 }}>
              {item.icon}
            </span>
            <span className={sidebarExpanded ? '' : 'text-center mt-0.5'}>{item.label}</span>
          </Link>
        );
      })}

      {/* 下部区切り線 + ブランディング */}
      {sidebarExpanded && (
        <div className="mt-auto px-4 pb-4">
          <div className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              DIVA Player v0.1
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              Powered by VocaDB API
            </p>
          </div>
        </div>
      )}
    </nav>
  );

  return (
    <>
      {/* デスクトップサイドバー (WatchPageでは非表示) */}
      {!isWatchPage && (
      <aside
        className="hidden lg:flex flex-col fixed top-0 left-0 z-40 transition-all duration-300"
        style={{
          width: sidebarExpanded ? 'var(--sidebar-width)' : 'var(--sidebar-collapsed-width)',
          top: 'var(--header-height)',
          bottom: 'var(--player-bar-height)',
          background: 'var(--color-bg-primary)',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {content}
      </aside>
      )}

      {/* モバイルオーバーレイ (WatchPageではデスクトップでも表示) */}
      <div
        className={`sidebar-overlay ${isWatchPage ? '' : 'lg:hidden'} ${mobileDrawerOpen ? 'active' : ''}`}
        onClick={closeMobileDrawer}
        style={{ zIndex: 49 }}
      />

      {/* モバイルドロワー (WatchPageではデスクトップでも表示) */}
      <aside
        className={`${isWatchPage ? '' : 'lg:hidden'} fixed top-0 left-0 z-50 flex flex-col transition-transform duration-300`}
        style={{
          width: 'var(--sidebar-width)',
          height: '100dvh',
          background: 'var(--color-bg-secondary)',
          transform: mobileDrawerOpen ? 'translateX(0)' : 'translateX(-100%)',
        }}
      >
        {/* ドロワーヘッダー */}
        <div className="h-14 flex items-center px-4 gap-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <button
            className="btn-ghost p-2 rounded-full"
            onClick={closeMobileDrawer}
            aria-label="メニューを閉じる"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
            </svg>
          </button>
          <span className="text-lg font-bold">
            <span style={{ color: 'var(--color-accent-cyan)' }}>DIVA</span>
            <span> Player</span>
          </span>
        </div>
        {content}
      </aside>
    </>
  );
}
