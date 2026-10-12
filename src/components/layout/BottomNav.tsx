import { Link } from 'react-router';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { useUiStore } from '../../stores/uiStore';
import { MenuIcon } from '../ui/iconsChrome';
import { cx } from '../ui/overlay';
import { BOTTOM_NAV_ITEMS, NAV_ITEMS, compactNavId } from './navItems';
import { useActiveNavId, useNavLabels, useNavLinkProps } from './navHooks';

const CELL_CLASS =
  'flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-yt-text no-underline [-webkit-tap-highlight-color:transparent] active:bg-yt-tonal';

/**
 * Bottom navigation under 640px except on the song page (DESIGN_SPEC §6.1.4): Home / Chorus
 * highlights / Playlists / History / Menu (opens the drawer). 48px + the safe area.
 */
export default function BottomNav() {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  // 後で聴く has no cell here: プレイリスト stays selected while it is open.
  const activeId = compactNavId(useActiveNavId());
  const { short } = useNavLabels();
  const linkProps = useNavLinkProps();
  const drawerOpen = useUiStore(state => state.mobileDrawerOpen);
  const toggleMobileDrawer = useUiStore(state => state.toggleMobileDrawer);

  return (
    <nav
      aria-label={t('メイン')}
      className="fixed inset-x-0 bottom-0 z-[var(--z-header)] border-t border-yt-divider bg-yt-bg pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="flex h-12">
        {BOTTOM_NAV_ITEMS.map(id => {
          const item = NAV_ITEMS[id];
          const active = activeId === id;
          const Icon = active ? item.activeIcon : item.icon;
          return (
            <li key={id} className="min-w-0 flex-1">
              <Link to={item.to} aria-current={active ? 'page' : undefined} className={cx(CELL_CLASS, active && 'font-medium')} {...linkProps(item)}>
                <Icon />
                <span className="max-w-full truncate text-[10px] leading-[14px]">{short[id]}</span>
              </Link>
            </li>
          );
        })}
        <li className="min-w-0 flex-1">
          <button
            type="button"
            aria-label={tk('menu')}
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            onClick={toggleMobileDrawer}
            className={cx(CELL_CLASS, 'cursor-pointer')}
          >
            <MenuIcon />
            <span aria-hidden="true" className="max-w-full truncate text-[10px] leading-[14px]">{tk('menu')}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
