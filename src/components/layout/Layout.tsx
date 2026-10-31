import { createElement, lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import TopNav from './TopNav';
import Sidebar, { type GuideMode } from './Sidebar';
import BottomNav from './BottomNav';
import TopLoadingBar from './TopLoadingBar';
import PageSkeleton from './PageSkeleton';
import RouteErrorBoundary, { DeferredBoundary, OverlayErrorBoundary } from './RouteErrorBoundary';
import { useUiStore } from '../../stores/uiStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useYouTubePlaylistSync } from '../../hooks/useYouTubePlaylistSync';
import { useMusicShell } from '../../hooks/useMusicLayout';
import { GUIDE_EXPANDED_MEDIA_QUERY, MOBILE_MEDIA_QUERY, MUSIC_LIBRARY_FULL_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { isWatchPath } from '../../utils/routes';
import { cx } from '../ui/overlay';
import { preloadMainRoutesWhenIdle } from '../../routes/routeLoaders';
import {
  RECOMMENDATION_DEBUG_STORAGE_KEY,
  useRecommendationDebugStore,
} from '../../stores/recommendationDebugStore';

// The connection band only shows when something is wrong; its checks start right after the first paint.
const BackendStatusNotice = lazy(() => import('./BackendStatusNotice'));
const QueueDrawer = lazy(() => import('../player/QueueDrawer'));
const SongDetailsModal = lazy(() => import('../player/SongDetailsModal'));
const SaveToPlaylistModal = lazy(() => import('../playlist/SaveToPlaylistModal').then(module => ({
  default: module.SaveToPlaylistModal,
})));
const SelectionFAB = lazy(() => import('../search/SelectionFAB'));
const SettingsModal = lazy(() => import('../settings/SettingsModal'));
const RecommendationDebugPanel = lazy(() => import('../debug/RecommendationDebugPanel'));

function closeQueueDrawer() {
  const player = usePlayerStore.getState();
  if (player.queueDrawerOpen) player.toggleQueueDrawer();
}

/**
 * The app frame (DESIGN_SPEC §6.1.1): top bar, connection band, guide (expanded 240px from
 * 1312px, mini 72px from 640px, none on phones and on the song page), drawer, bottom nav on
 * phones, and the page in <main>. `<html data-guide>` / `data-bottom-nav` set the layout
 * variables (--guide-offset, --bottom-nav-height) used by main, the band and fixed bars.
 * GlobalPlayer lives outside (App) so page changes never touch the playing iframe.
 *
 * The music layout (Settings > 見た目 > レイアウト) swaps only the guide and the bottom bars for its
 * library, 再生中 panel and player bar; <main> and the page stay mounted when the layout changes.
 */
export default function Layout() {
  const location = useLocation();
  const isWatch = isWatchPath(location.pathname);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const isWideGuide = useMediaQuery(GUIDE_EXPANDED_MEDIA_QUERY);
  const isWideMusicLibrary = useMediaQuery(MUSIC_LIBRARY_FULL_MEDIA_QUERY);
  const sidebarExpanded = useUiStore(s => s.sidebarExpanded);
  const drawerOpen = useUiStore(s => s.mobileDrawerOpen);
  const closeMobileDrawer = useUiStore(s => s.closeMobileDrawer);
  const finishNavigation = useUiStore(s => s.finishNavigation);
  const visibleSongs = useSelectionStore(s => s.visibleSongs);
  const isSelectionMode = useSelectionStore(s => s.isSelectionMode);
  const exitSelectionMode = useSelectionStore(s => s.exitSelectionMode);
  const queueDrawerOpen = usePlayerStore(s => s.queueDrawerOpen);
  const detailSong = useUiStore(s => s.detailSong);
  const closeSongDetail = useUiStore(s => s.closeSongDetail);
  const saveToPlaylistSongs = useUiStore(s => s.saveToPlaylistSongs);
  const closeSaveToPlaylist = useUiStore(s => s.closeSaveToPlaylist);
  const settingsDialog = useUiStore(s => s.settingsDialog);
  const closeSettings = useUiStore(s => s.closeSettings);
  const debugEnabled = useRecommendationDebugStore(s => s.enabled);
  const setDebugEnabled = useRecommendationDebugStore(s => s.setEnabled);
  const [queueDrawerMounted, setQueueDrawerMounted] = useState(false);
  const musicShell = useMusicShell();
  useYouTubePlaylistSync();

  const guideMode: GuideMode = musicShell || isWatch || isMobile ? 'none' : isWideGuide && sidebarExpanded ? 'expanded' : 'mini';
  // The drawer exists wherever the expanded guide is not shown next to the page. The music layout
  // always shows its library beside the page; the drawer (every destination by name) is for phones and
  // for the icon rail below 1280px.
  const drawerAvailable = musicShell ? isMobile || !isWideMusicLibrary : isWatch || !isWideGuide;
  const showBottomNav = !musicShell && isMobile && !isWatch;
  const isLocalSoundMapPreview = import.meta.env.DEV
    && location.pathname === '/sound-map'
    && ['demo', 'pilot'].some(parameter => new URLSearchParams(location.search).get(parameter) === '1');

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.guide = guideMode;
    if (showBottomNav) root.dataset.bottomNav = 'true';
    else delete root.dataset.bottomNav;
  }, [guideMode, showBottomNav]);

  useEffect(() => () => {
    const root = document.documentElement;
    delete root.dataset.guide;
    delete root.dataset.bottomNav;
  }, []);

  // A new page has rendered: stop the loading bar, close the drawer.
  useEffect(() => {
    finishNavigation();
    closeMobileDrawer();
  }, [location.key, finishNavigation, closeMobileDrawer]);

  useEffect(() => {
    if (!drawerAvailable && drawerOpen) closeMobileDrawer();
  }, [closeMobileDrawer, drawerAvailable, drawerOpen]);

  useEffect(() => preloadMainRoutesWhenIdle(), []);

  useEffect(() => {
    const requested = new URLSearchParams(location.search).get('recDebug');
    if (requested === '1') sessionStorage.setItem(RECOMMENDATION_DEBUG_STORAGE_KEY, '1');
    if (requested === '0') sessionStorage.removeItem(RECOMMENDATION_DEBUG_STORAGE_KEY);
    setDebugEnabled(requested === '1' || (requested !== '0' && sessionStorage.getItem(RECOMMENDATION_DEBUG_STORAGE_KEY) === '1'));
  }, [location.search, setDebugEnabled]);

  useEffect(() => {
    if (queueDrawerOpen) setQueueDrawerMounted(true);
  }, [queueDrawerOpen]);

  return (
    <div className={cx('flex min-h-dvh flex-col text-yt-text', musicShell ? 'music-frame' : 'bg-yt-bg')}>
      <TopLoadingBar />
      <TopNav />
      <div
        data-testid="backend-status-layout"
        className={cx(
          'pt-[calc(var(--header-height)_+_var(--selection-bar-height,0px))] ml-[var(--guide-offset)]',
          musicShell && 'mr-[var(--music-panel-offset,0px)]',
        )}
      >
        {!isLocalSoundMapPreview && (
          <DeferredBoundary>
            <Suspense fallback={null}>
              <BackendStatusNotice />
            </Suspense>
          </DeferredBoundary>
        )}
      </div>
      <Sidebar guideMode={guideMode} drawerAvailable={drawerAvailable} isMobile={isMobile} />
      {musicShell && !isMobile && createElement(musicShell.MusicLibrary)}

      {/*
        The selection bar sits under the top bar, above the page: keep it before <main> in the DOM
        so its actions come right after the top bar in the Tab order (not after the whole list).
        Each lazy overlay has its own Suspense boundary: one loading for the first time must not
        hide the others (React hides the shown siblings of a suspending child).
      */}
      {isSelectionMode && (
        <Suspense fallback={null}>
          <OverlayErrorBoundary onError={exitSelectionMode}>
            <SelectionFAB visibleSongs={visibleSongs} />
          </OverlayErrorBoundary>
        </Suspense>
      )}

      <main
        className={cx(
          'min-w-0 flex-1 ml-[var(--guide-offset)] pb-[calc(var(--floating-player-clearance,0px)_+_var(--bottom-nav-height,0px))] [overflow-x:clip]',
          musicShell && 'music-main mr-[var(--music-panel-offset,0px)]',
        )}
      >
        <RouteErrorBoundary resetKey={`${location.pathname}${location.search}`}>
          {/*
            Lazy page modules may suspend on their first visit. Keep that boundary inside the
            route content so GlobalPlayer never falls back with the page and its iframe remains
            visible and mounted during navigation.
          */}
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </RouteErrorBoundary>
      </main>

      {musicShell ? createElement(musicShell.MusicDock) : showBottomNav && <BottomNav />}

      {queueDrawerMounted && (
        <Suspense fallback={null}>
          <OverlayErrorBoundary onError={closeQueueDrawer} resetKey={queueDrawerOpen}>
            <QueueDrawer />
          </OverlayErrorBoundary>
        </Suspense>
      )}
      {detailSong && (
        <Suspense fallback={null}>
          <OverlayErrorBoundary onError={closeSongDetail} resetKey={detailSong}>
            <SongDetailsModal />
          </OverlayErrorBoundary>
        </Suspense>
      )}
      {saveToPlaylistSongs && (
        <Suspense fallback={null}>
          <OverlayErrorBoundary onError={closeSaveToPlaylist} resetKey={saveToPlaylistSongs}>
            <SaveToPlaylistModal />
          </OverlayErrorBoundary>
        </Suspense>
      )}
      {settingsDialog.open && (
        <Suspense fallback={null}>
          <OverlayErrorBoundary onError={closeSettings}>
            <SettingsModal isOpen initialTab={settingsDialog.tab} onClose={closeSettings} />
          </OverlayErrorBoundary>
        </Suspense>
      )}
      {debugEnabled && (
        <Suspense fallback={null}>
          <OverlayErrorBoundary onError={() => setDebugEnabled(false)}>
            <RecommendationDebugPanel />
          </OverlayErrorBoundary>
        </Suspense>
      )}
    </div>
  );
}
