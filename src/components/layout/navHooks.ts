import { useCallback, useMemo } from 'react';
import type { MouseEvent } from 'react';
import { useLocation } from 'react-router';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { useUiStore } from '../../stores/uiStore';
import { preloadRoute } from '../../routes/routeLoaders';
import {
  activeNavId,
  isPlainLeftClick,
  navTargetOf,
  resetHomeState,
  toNavLocation,
} from './navItems';
import type { NavId, NavItem } from './navItems';

/** Full labels (expanded guide, drawer) and short labels (mini guide, bottom nav) of every destination. */
export function useNavLabels(): { full: Record<NavId, string>; short: Partial<Record<NavId, string>> } {
  const tk = useTranslate();
  const t = useTranslateSourceText();
  return useMemo(() => ({
    full: {
      home: tk('sidebarHome'),
      chorus: tk('sidebarChorus'),
      favoriteProducers: tk('sidebarFavoriteProducers'),
      history: tk('sidebarHistory'),
      playlists: tk('navPlaylists'),
      watchLater: t('後で聴く'),
      ratings: tk('sidebarRatings'),
      reports: tk('sidebarReports'),
      soundMap: tk('sidebarSoundMap'),
      knowledgeMap: tk('sidebarKnowledgeMap'),
      hiddenSongs: t('表示しない曲'),
    },
    short: {
      home: tk('sidebarHomeShort'),
      chorus: tk('sidebarChorusShort'),
      favoriteProducers: tk('sidebarFavoriteProducersShort'),
      playlists: tk('sidebarPlaylistsShort'),
      history: tk('sidebarHistoryShort'),
    },
  }), [t, tk]);
}

/**
 * The selected destination. While a page is still loading after a guide / bottom nav press,
 * the pressed destination is shown as selected (DESIGN_SPEC §6.1.3).
 */
export function useActiveNavId(): NavId | null {
  const location = useLocation();
  const pendingNavigation = useUiStore(state => state.pendingNavigation);
  return activeNavId(pendingNavigation ? toNavLocation(pendingNavigation) : location);
}

/**
 * Props for a destination link: preloads the page chunk on hover / focus / touch, and on a plain
 * click starts the loading bar, resets the search when going home, and calls `onNavigate`
 * (closing the drawer).
 */
export function useNavLinkProps(onNavigate?: () => void) {
  const location = useLocation();
  const startNavigation = useUiStore(state => state.startNavigation);
  return useCallback((item: NavItem) => {
    const preload = () => preloadRoute(item.to);
    return {
      onPointerEnter: preload,
      onFocus: preload,
      onTouchStart: preload,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        if (!isPlainLeftClick(event)) return;
        if (item.id === 'home') resetHomeState();
        if (navTargetOf(location) !== navTargetOf(toNavLocation(item.to))) startNavigation(item.to);
        onNavigate?.();
      },
    };
  }, [location, onNavigate, startNavigation]);
}
