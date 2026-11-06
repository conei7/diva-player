import { lazy, Suspense, useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';
import { useTranslate } from '../../i18n';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { useUiStore } from '../../stores/uiStore';
import { whenIdle } from '../../routes/routeLoaders';
import IconButton from '../ui/IconButton';
import { MenuIcon } from '../ui/iconsChrome';
import { cx } from '../ui/overlay';
import BrandLogo from './BrandLogo';
import GuideNav, { MiniGuideNav } from './GuideNav';
import { DeferredBoundary } from './RouteErrorBoundary';
import { isPlainLeftClick, resetHomeState } from './navItems';

// The phone rows at the end of the drawer (and the language sheet they open) load after the first
// paint, outside the initial JavaScript (§1-12): the drawer is closed and off screen until then.
const loadDrawerPhoneItems = () => import('./DrawerPhoneItems');
const DrawerPhoneItems = lazy(loadDrawerPhoneItems);
const preloadDrawerPhoneItems = () => void loadDrawerPhoneItems().catch(() => undefined);

export type GuideMode = 'expanded' | 'mini' | 'none';

const GUIDE_ASIDE_CLASS =
  'fixed bottom-0 left-0 top-[var(--header-height)] z-[var(--z-guide)] overflow-y-auto overflow-x-hidden overscroll-contain bg-yt-bg text-yt-text [scrollbar-color:transparent_transparent] [scrollbar-width:thin] hover:[scrollbar-color:#717171_transparent]';

/**
 * The guide drawer (DESIGN_SPEC §6.1.3): under 1312px, on phones and on the song page. It stays in
 * the DOM while closed (moved off screen, `inert`, `aria-hidden`) and is a modal dialog while open
 * (Esc, focus trap, scroll lock and focus return through useDialogFocus).
 */
function GuideDrawer({ open, onClose, isMobile }: { open: boolean; onClose: () => void; isMobile: boolean }) {
  const tk = useTranslate();
  const drawerRef = useRef<HTMLElement>(null);
  useDialogFocus(drawerRef, open, onClose);

  // Phones: the rows are usually here long before a tap opens the drawer; opening it fetches them too.
  useEffect(() => (isMobile ? whenIdle(preloadDrawerPhoneItems) : undefined), [isMobile]);
  useEffect(() => {
    if (open && isMobile) preloadDrawerPhoneItems();
  }, [open, isMobile]);

  // useDialogFocus has focused the close button (and remembered the opener); start on Home instead.
  useEffect(() => {
    if (!open) return;
    drawerRef.current?.querySelector<HTMLElement>('nav a[href]')?.focus({ preventScroll: true });
  }, [open]);

  const onLogoClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(event)) return;
    resetHomeState();
    onClose();
  };

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={cx(
          'fixed inset-0 z-[var(--z-drawer)] bg-overlay transition-opacity duration-200 motion-reduce:transition-none',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <aside
        ref={drawerRef}
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        aria-label={tk('menu')}
        aria-hidden={open ? undefined : true}
        inert={!open}
        tabIndex={-1}
        className={cx(
          'fixed inset-y-0 left-0 z-[var(--z-drawer)] flex w-60 flex-col bg-yt-bg text-yt-text outline-none transition-transform duration-200 ease-out motion-reduce:transition-none max-sm:w-[min(280px,85vw)]',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-4 pl-4 pr-3 max-sm:h-12 max-sm:pl-3">
          <IconButton label={tk('menuClose')} icon={<MenuIcon />} onClick={onClose} />
          <BrandLogo onClick={onLogoClick} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <GuideNav
            inDrawer
            onNavigate={onClose}
            extraItems={isMobile ? (
              <DeferredBoundary fallback={null}>
                <Suspense fallback={null}><DrawerPhoneItems /></Suspense>
              </DeferredBoundary>
            ) : null}
          />
        </div>
      </aside>
    </>
  );
}

/**
 * The left guide (DESIGN_SPEC §6.1.1): expanded 240px or mini 72px next to the page, plus the
 * drawer where the expanded guide does not fit.
 */
export default function Sidebar({
  guideMode,
  drawerAvailable,
  isMobile,
}: {
  guideMode: GuideMode;
  drawerAvailable: boolean;
  isMobile: boolean;
}) {
  const drawerOpen = useUiStore(state => state.mobileDrawerOpen);
  const closeMobileDrawer = useUiStore(state => state.closeMobileDrawer);

  return (
    <>
      {guideMode === 'expanded' && (
        <aside className={cx(GUIDE_ASIDE_CLASS, 'w-60')}>
          <GuideNav />
        </aside>
      )}
      {guideMode === 'mini' && (
        <aside className={cx(GUIDE_ASIDE_CLASS, 'w-[72px]')}>
          <MiniGuideNav />
        </aside>
      )}
      {drawerAvailable && <GuideDrawer open={drawerOpen} onClose={closeMobileDrawer} isMobile={isMobile} />}
    </>
  );
}
