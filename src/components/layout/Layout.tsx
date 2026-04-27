import { Outlet } from 'react-router-dom';
import Header from './Header';
import PlayerBar from './PlayerBar';

/**
 * メインレイアウト
 * Header + Main Content + 固定PlayerBar の3層構造。
 * ページ遷移してもPlayerBarは維持され、音楽が途切れない。
 */
export default function Layout() {
  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg-primary)' }}>
      <Header />
      
      <main
        className="flex-1 overflow-y-auto"
        style={{
          paddingTop: 'var(--header-height)',
          paddingBottom: 'calc(var(--player-bar-height) + 16px)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <Outlet />
        </div>
      </main>

      <PlayerBar />
    </div>
  );
}
