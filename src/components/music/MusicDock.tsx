import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router';
import { MOBILE_MEDIA_QUERY, MUSIC_LIBRARY_FULL_MEDIA_QUERY, MUSIC_PANEL_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useMusicLayoutStore } from '../../stores/musicLayoutStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import { isWatchPath } from '../../utils/routes';
import BottomNav from '../layout/BottomNav';
import MusicMiniBar from './MusicMiniBar';
import MusicNowPlayingPanel from './MusicNowPlayingPanel';
import MusicPlayerBar from './MusicPlayerBar';

/**
 * The music layout's fixed parts below and beside the page: the 再生中 panel (from 1024px, while a
 * song is loaded and not on the song page), the player bar (from 640px) and, on phones, the mini bar
 * above the bottom nav. On phones the song page shows neither (like the standard layout): its own
 * video and controls fill the screen, and the top bar's ≡ opens the menu. `<html data-shell="music">` and its `data-music-*` set the layout variables
 * in index.css (area:music). They are removed in a layout effect, so the standard layout never sees them.
 */
export default function MusicDock() {
  const location = useLocation();
  const isWatch = isWatchPath(location.pathname);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const panelWide = useMediaQuery(MUSIC_PANEL_MEDIA_QUERY);
  const libraryWide = useMediaQuery(MUSIC_LIBRARY_FULL_MEDIA_QUERY);
  const sidebarExpanded = useUiStore(state => state.sidebarExpanded);
  const nowPlayingOpen = useMusicLayoutStore(state => state.nowPlayingOpen);
  const hasSong = usePlayerStore(state => state.currentSong !== null);

  const libraryFull = !isMobile && libraryWide && sidebarExpanded;
  const showPanel = !isMobile && panelWide && nowPlayingOpen && hasSong && !isWatch;
  const showBottomNav = isMobile && !isWatch;
  const showMiniBar = showBottomNav && hasSong;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.shell = 'music';
    root.dataset.musicLibrary = libraryFull ? 'full' : 'rail';
    root.dataset.musicPanel = showPanel ? 'open' : 'closed';
    if (showMiniBar) root.dataset.musicBar = 'true';
    else delete root.dataset.musicBar;
    if (isMobile && !showBottomNav) root.dataset.musicBottom = 'none';
    else delete root.dataset.musicBottom;
  }, [isMobile, libraryFull, showBottomNav, showPanel, showMiniBar]);

  useLayoutEffect(() => () => {
    const root = document.documentElement;
    delete root.dataset.shell;
    delete root.dataset.musicLibrary;
    delete root.dataset.musicPanel;
    delete root.dataset.musicBar;
    delete root.dataset.musicBottom;
  }, []);

  return (
    <>
      {showPanel && <MusicNowPlayingPanel />}
      {!isMobile && <MusicPlayerBar />}
      {showMiniBar && <MusicMiniBar />}
      {showBottomNav && <BottomNav className="music-bottom-nav" />}
    </>
  );
}
