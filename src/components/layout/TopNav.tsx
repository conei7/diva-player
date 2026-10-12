import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useLocation } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { useUiStore } from '../../stores/uiStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useGlobalFilterStore } from '../../stores/globalFilterStore';
import { getGlobalFilterSummary, isDiscoveryFilterActive } from '../../utils/globalFilters';
import { useLanguageStore } from '../../stores/languageStore';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { GUIDE_EXPANDED_MEDIA_QUERY, MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { isWatchPath } from '../../utils/routes';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import {
  CloseIcon,
  MenuIcon,
  MoreVertIcon,
  SelectMultipleFilledIcon,
  SelectMultipleIcon,
  SettingsIcon,
} from '../ui/iconsChrome';
import { whenIdle } from '../../routes/routeLoaders';
import BrandLogo from './BrandLogo';
import { DeferredBoundary } from './RouteErrorBoundary';
import SearchBox from './SearchBox';
import { useFocusHandoff } from './focusHandoff';
import { isPlainLeftClick, resetHomeState } from './navItems';

const HIDDEN_MODE_CLICKS = 5;

/** Pages whose song lists use the shared multi-select (the selection bar under the top bar). */
const SELECTION_PATHS = new Set(['/', '/history', '/favorites']);
const HIDDEN_MODE_CLICK_WINDOW_MS = 1000;

// The ⋮ menu (and the Menu code) loads after the first paint, outside the initial JavaScript (§1-12).
const loadMoreMenu = () => import('./TopNavMoreMenu');
const TopNavMoreMenu = lazy(loadMoreMenu);
const preloadMoreMenu = () => void loadMoreMenu().catch(() => undefined);

/**
 * Top bar (DESIGN_SPEC §6.1.2). Desktop 56px: [≡][logo][hidden mode chip] … [search][advanced search] … [☑][⋮][⚙].
 * Mobile 48px, one row: [≡ only on the song page][logo mark][search field][☑][⚙].
 * ☑ (multi-select) shows on the pages with selectable song lists (home / search, song page, history, rated songs).
 * Opaque #0f0f0f without a bottom border, blur or glow.
 */
export default function TopNav() {
  const location = useLocation();
  const tk = useTranslate();
  const t = useTranslateSourceText();
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const isWideGuide = useMediaQuery(GUIDE_EXPANDED_MEDIA_QUERY);
  const isWatch = isWatchPath(location.pathname);
  const language = useLanguageStore(state => state.language);
  const toggleSidebar = useUiStore(state => state.toggleSidebar);
  const toggleMobileDrawer = useUiStore(state => state.toggleMobileDrawer);
  const drawerOpen = useUiStore(state => state.mobileDrawerOpen);
  const openSettings = useUiStore(state => state.openSettings);
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const toggleHiddenMode = usePlayerStore(state => state.toggleHiddenMode);
  const isSelectionMode = useSelectionStore(state => state.isSelectionMode);
  const enterSelectionMode = useSelectionStore(state => state.enterSelectionMode);
  const exitSelectionMode = useSelectionStore(state => state.exitSelectionMode);
  const showSelectionToggle = isWatch || SELECTION_PATHS.has(location.pathname.replace(/(.)\/+$/, '$1'));
  const globalFilterSettings = useGlobalFilterStore(useShallow(state => ({
    enabled: state.enabled,
    minYoutubeViews: state.minYoutubeViews,
    minNicoViews: state.minNicoViews,
    excludedSongTypes: state.excludedSongTypes,
    excludeSelfCovers: state.excludeSelfCovers,
    vocalistFilters: state.vocalistFilters,
    vocalistMatchMode: state.vocalistMatchMode,
    cooldownHours: state.cooldownHours,
    excludeRatedFromDiscovery: state.excludeRatedFromDiscovery,
  })));
  const filtersActive = isDiscoveryFilterActive(globalFilterSettings);
  const filterStatusId = useId();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  // The loaded ⋮ replaces the placeholder button; a keyboard focus on it moves along.
  const moreMenuTriggerRef = useFocusHandoff<HTMLButtonElement>();
  useEffect(() => (isMobile ? undefined : whenIdle(preloadMoreMenu)), [isMobile]);

  // The menu button opens the drawer on the song page and under 1312px; above that it switches
  // the guide between expanded and mini. On phones (except the song page) the bottom nav has it.
  const menuOpensDrawer = isWatch || !isWideGuide;
  const showMenuButton = !isMobile || isWatch;

  // Logo: a plain click resets the search; five clicks within a second toggle hidden mode.
  const logoClicksRef = useRef(0);
  const logoTimerRef = useRef<number | undefined>(undefined);
  const handleLogoClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(event)) return;
    resetHomeState();
    logoClicksRef.current += 1;
    window.clearTimeout(logoTimerRef.current);
    logoTimerRef.current = window.setTimeout(() => {
      logoClicksRef.current = 0;
    }, HIDDEN_MODE_CLICK_WINDOW_MS);
    if (logoClicksRef.current >= HIDDEN_MODE_CLICKS) {
      logoClicksRef.current = 0;
      toggleHiddenMode();
    }
  };

  const filterSummary = filtersActive ? getGlobalFilterSummary(globalFilterSettings, language) : [];

  // The same ⋮ button until the menu code has loaded; a press made meanwhile opens the menu once it
  // is here, and a focus on it moves to the loaded button (moreMenuTriggerRef on both).
  const openMoreMenu = () => {
    preloadMoreMenu();
    setMoreMenuOpen(true);
  };
  const moreMenuFallback = (
    <IconButton
      ref={moreMenuTriggerRef}
      label={t('その他の操作')}
      icon={<MoreVertIcon />}
      className="topnav-action-btn"
      aria-haspopup="menu"
      aria-expanded={moreMenuOpen}
      onPointerEnter={preloadMoreMenu}
      onFocus={preloadMoreMenu}
      onClick={openMoreMenu}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        openMoreMenu();
      }}
    />
  );

  return (
    <header className="fixed inset-x-0 top-0 z-[var(--z-header)] h-[var(--header-height)] bg-yt-bg text-yt-text">
      <div className="flex h-full items-center gap-4 px-4 max-sm:gap-2 max-sm:pl-3 max-sm:pr-1">
        <div className="flex shrink-0 items-center gap-4 max-sm:gap-2">
          {showMenuButton && (
            <IconButton
              label={tk('menu')}
              icon={<MenuIcon />}
              aria-haspopup={menuOpensDrawer ? 'dialog' : undefined}
              aria-expanded={menuOpensDrawer ? drawerOpen : undefined}
              onClick={menuOpensDrawer ? toggleMobileDrawer : toggleSidebar}
            />
          )}
          <BrandLogo showText={!isMobile} onClick={handleLogoClick} />
          {hiddenMode && !isMobile && (
            <Tooltip content={t('隠しモードを終了')}>
              <button
                type="button"
                aria-label={t('隠しモードを終了')}
                onClick={toggleHiddenMode}
                className="ml-[-8px] inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-chip bg-yt-tonal pl-2.5 pr-1.5 text-xs font-medium leading-4 text-yt-text transition-colors duration-150 hover:bg-yt-tonal-hover"
              >
                {tk('hiddenMode')}
                <CloseIcon size={16} />
              </button>
            </Tooltip>
          )}
        </div>

        <div className="flex min-w-0 flex-1 justify-center">
          <SearchBox compact={isMobile} />
        </div>

        <div className="flex shrink-0 items-center gap-2 max-sm:gap-0">
          {showSelectionToggle && (
            <IconButton
              label={tk('multiSelect')}
              icon={isSelectionMode ? <SelectMultipleFilledIcon /> : <SelectMultipleIcon />}
              pressed={isSelectionMode}
              className="topnav-action-btn max-sm:size-11!"
              onClick={() => (isSelectionMode ? exitSelectionMode() : enterSelectionMode())}
              // The selection bar returns focus here when selection mode ends.
              data-selection-toggle=""
            />
          )}
          {!isMobile && (
            <DeferredBoundary fallback={moreMenuFallback}>
              <Suspense fallback={moreMenuFallback}>
                <TopNavMoreMenu open={moreMenuOpen} onOpenChange={setMoreMenuOpen} triggerRef={moreMenuTriggerRef} />
              </Suspense>
            </DeferredBoundary>
          )}
          <IconButton
            label={tk('settings')}
            icon={<SettingsIcon />}
            className="topnav-action-btn max-sm:size-11!"
            dot={filtersActive}
            tooltip={filtersActive ? t('設定・表示フィルター適用中') : undefined}
            aria-describedby={filtersActive ? filterStatusId : undefined}
            onClick={() => openSettings()}
          />
          {filtersActive && (
            <span id={filterStatusId} className="sr-only">
              {filterSummary.length > 0 ? `${tk('filtersActive')}: ${filterSummary.join(' / ')}` : tk('filtersActive')}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
