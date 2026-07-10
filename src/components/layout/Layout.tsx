import { Outlet, useLocation } from 'react-router-dom';
import TopNav from './TopNav';
import Sidebar from './Sidebar';
import GlobalPlayer from '../player/GlobalPlayer';
import HistoryDrawer from '../player/HistoryDrawer';
import SongDetailsModal from '../player/SongDetailsModal';
import { SaveToPlaylistModal } from '../playlist/SaveToPlaylistModal';
import { useUiStore } from '../../stores/uiStore';
import SelectionFAB from '../search/SelectionFAB';
import { useSelectionStore } from '../../stores/selectionStore';
import BackendStatusNotice from './BackendStatusNotice';

/**
 * メインレイアウト (YouTube風)
 *
 * TopNav (固定ヘッダー) + Sidebar (左) + メインコンテンツ
 *
 * WatchPage (/watch) ではサイドバーを非表示にし、全幅レイアウトを使用。
 * 再生中は GlobalPlayer が WatchPage に重なるか、右下にフローティングします。
 */
export default function Layout() {
  const location = useLocation();
  const { sidebarExpanded } = useUiStore();
  const visibleSongs = useSelectionStore(s => s.visibleSongs);

  const isWatchPage = location.pathname === '/watch';
  // /watch ではサイドバーを非表示
  const showSidebar = !isWatchPage;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg-primary)' }}>
      <TopNav />
      <BackendStatusNotice />
      <Sidebar />

      {/* メインコンテンツ */}
      <main
        className="flex-1 transition-all duration-300"
        style={{
          paddingTop: 'var(--header-height)',
          marginLeft: showSidebar
            ? `max(0px, ${sidebarExpanded ? 'var(--sidebar-width)' : 'var(--sidebar-collapsed-width)'})`
            : '0px',
          overflowX: 'clip',
        }}
      >
        {/* lg以上でサイドバーがある場合のマージン適用 */}
        <style>{`
          @media (max-width: 1023px) {
            main { margin-left: 0 !important; }
          }
        `}</style>
        <Outlet />
      </main>

      {/* グローバルプレイヤー (WatchPageの埋め込み or フローティングPiP) */}
      <GlobalPlayer />

      <HistoryDrawer />
      <SongDetailsModal />
      <SaveToPlaylistModal />
      <SelectionFAB visibleSongs={visibleSongs} />
    </div>
  );
}
