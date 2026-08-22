import { lazy, Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import TopNav from './TopNav';
import Sidebar from './Sidebar';
import { useUiStore } from '../../stores/uiStore';
import { useSelectionStore } from '../../stores/selectionStore';
import BackendStatusNotice from './BackendStatusNotice';
import { usePlayerStore } from '../../stores/playerStore';
import { useYouTubePlaylistSync } from '../../hooks/useYouTubePlaylistSync';
import {
  RECOMMENDATION_DEBUG_STORAGE_KEY,
  useRecommendationDebugStore,
} from '../../stores/recommendationDebugStore';

const HistoryDrawer = lazy(() => import('../player/HistoryDrawer'));
const QueueDrawer = lazy(() => import('../player/QueueDrawer'));
const SongDetailsModal = lazy(() => import('../player/SongDetailsModal'));
const SaveToPlaylistModal = lazy(() => import('../playlist/SaveToPlaylistModal').then(module => ({
  default: module.SaveToPlaylistModal,
})));
const SelectionFAB = lazy(() => import('../search/SelectionFAB'));
const RecommendationDebugPanel = lazy(() => import('../debug/RecommendationDebugPanel'));

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
  const isSelectionMode = useSelectionStore(s => s.isSelectionMode);
  const historyDrawerOpen = usePlayerStore(s => s.historyDrawerOpen);
  const queueDrawerOpen = usePlayerStore(s => s.queueDrawerOpen);
  const detailSong = useUiStore(s => s.detailSong);
  const saveToPlaylistSongs = useUiStore(s => s.saveToPlaylistSongs);
  const debugEnabled = useRecommendationDebugStore(s => s.enabled);
  const setDebugEnabled = useRecommendationDebugStore(s => s.setEnabled);
  const [mountedOverlays, setMountedOverlays] = useState({ history: false, queue: false });
  useYouTubePlaylistSync();

  const isWatchPage = location.pathname === '/watch';
  // /watch ではサイドバーを非表示
  const showSidebar = !isWatchPage;

  useEffect(() => {
    const requested = new URLSearchParams(location.search).get('recDebug');
    if (requested === '1') sessionStorage.setItem(RECOMMENDATION_DEBUG_STORAGE_KEY, '1');
    if (requested === '0') sessionStorage.removeItem(RECOMMENDATION_DEBUG_STORAGE_KEY);
    setDebugEnabled(requested === '1' || (requested !== '0' && sessionStorage.getItem(RECOMMENDATION_DEBUG_STORAGE_KEY) === '1'));
  }, [location.search, setDebugEnabled]);

  useEffect(() => {
    if (!historyDrawerOpen && !queueDrawerOpen) return;
    setMountedOverlays(current => ({
      history: current.history || historyDrawerOpen,
      queue: current.queue || queueDrawerOpen,
    }));
  }, [historyDrawerOpen, queueDrawerOpen]);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg-primary)' }}>
      <TopNav />
      <div
        data-testid="backend-status-layout"
        style={{ paddingTop: 'var(--header-height)' }}
      >
        <BackendStatusNotice />
      </div>
      <Sidebar />

      {/* メインコンテンツ */}
      <main
        className="flex-1 transition-all duration-300"
        style={{
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
        {/*
          Lazy page modules may suspend on their first visit. Keep that boundary
          inside the route content so GlobalPlayer never falls back with the page
          and its iframe remains visible and mounted during navigation.
        */}
        <Suspense fallback={<div className="min-h-screen bg-zinc-950" aria-busy="true" />}>
          <Outlet />
        </Suspense>
      </main>

      <Suspense fallback={null}>
        {mountedOverlays.history && <HistoryDrawer />}
        {mountedOverlays.queue && <QueueDrawer />}
        {detailSong && <SongDetailsModal />}
        {saveToPlaylistSongs && <SaveToPlaylistModal />}
        {isSelectionMode && <SelectionFAB visibleSongs={visibleSongs} />}
        {debugEnabled && <RecommendationDebugPanel />}
      </Suspense>
    </div>
  );
}
