import { Link } from 'react-router';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { MOBILE_MEDIA_QUERY, MUSIC_LIBRARY_FULL_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useUiStore } from '../../stores/uiStore';
import { NAV_ITEMS } from '../layout/navItems';
import type { NavId, NavItem } from '../layout/navItems';
import { useNavLabels, useNavLinkProps } from '../layout/navHooks';
import { SettingsIcon } from '../ui/iconsChrome';
import { cx } from '../ui/overlay';
import LibraryList from './library/LibraryList';
import LibraryNav from './library/LibraryNav';
import { LIBRARY_ROW_CLASS, libraryNavStateClass } from './library/libraryModel';
import { useLibrarySelection } from './library/libraryHooks';
import { RailTooltip } from './library/LibraryRow';
import type { NavLinkHandlers } from './library/LibraryRow';

/** Bottom of the column (does not scroll): 表示しない曲 and 設定. */
function LibraryFooter({
  rail,
  activeId,
  linkProps,
}: {
  rail: boolean;
  activeId: NavId | null;
  linkProps: (item: NavItem) => NavLinkHandlers;
}) {
  const tk = useTranslate();
  const { full } = useNavLabels();
  const openSettings = useUiStore(state => state.openSettings);
  const hiddenSongs = NAV_ITEMS.hiddenSongs;
  const hiddenActive = activeId === 'hiddenSongs';
  const HiddenIcon = hiddenActive ? hiddenSongs.activeIcon : hiddenSongs.icon;
  const rowClass = rail ? 'h-11 justify-center' : 'h-10 min-w-0 flex-1 gap-2 px-2.5 text-[13px] leading-5';

  return (
    <div className={cx('flex shrink-0 gap-0.5 border-t border-yt-divider p-2', rail && 'flex-col')}>
      <RailTooltip rail={rail} label={full.hiddenSongs}>
        <Link
          to={hiddenSongs.to}
          aria-current={hiddenActive ? 'page' : undefined}
          aria-label={rail ? full.hiddenSongs : undefined}
          className={cx(LIBRARY_ROW_CLASS, libraryNavStateClass(hiddenActive), rowClass)}
          {...linkProps(hiddenSongs)}
        >
          <HiddenIcon size={20} />
          {!rail && <span className="min-w-0 flex-1 truncate">{full.hiddenSongs}</span>}
        </Link>
      </RailTooltip>
      <RailTooltip rail={rail} label={tk('settings')}>
        {/*
          No aria-label (also in the rail, where the text is visually hidden): the top bar's ⚙ is the one
          button[aria-label="設定"] that tests and screen readers find.
        */}
        <button
          type="button"
          className={cx(LIBRARY_ROW_CLASS, libraryNavStateClass(false), rowClass, 'cursor-pointer')}
          onClick={() => openSettings()}
        >
          <SettingsIcon size={20} />
          <span className={rail ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{tk('settings')}</span>
        </button>
      </RailTooltip>
    </div>
  );
}

/**
 * The music layout's library column (from 640px; phones keep the drawer): the main destinations,
 * the library (fixed entries and the user's playlists by folder) and 表示しない曲 / 設定. 280px with
 * names when the window is wide (MUSIC_LIBRARY_FULL_MEDIA_QUERY) and the top bar's ≡ has the guide
 * expanded, otherwise a 72px rail of icons and covers whose names are tooltips. The width itself
 * comes from `<html data-music-library>` (set by MusicDock with the same rule) and index.css.
 */
export default function MusicLibrary() {
  const t = useTranslateSourceText();
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const libraryWide = useMediaQuery(MUSIC_LIBRARY_FULL_MEDIA_QUERY);
  const sidebarExpanded = useUiStore(state => state.sidebarExpanded);
  const rail = !(!isMobile && libraryWide && sidebarExpanded);
  const selection = useLibrarySelection();
  const linkProps = useNavLinkProps();

  return (
    <aside className="music-side-panel music-library" aria-label={t('ライブラリ')} data-testid="music-library">
      {/*
        The library list scrolls by itself; this outer box only scrolls when the window is too short
        for the fixed parts, so 表示しない曲 and 設定 stay reachable.
      */}
      <div
        className={cx(
          'flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain',
          '[scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:var(--color-yt-text-disabled)_transparent]',
        )}
      >
        <LibraryNav rail={rail} activeId={selection.navId} linkProps={linkProps} />
        <hr aria-hidden="true" className="mx-3 my-0 h-px shrink-0 border-0 bg-yt-divider" />
        <LibraryList rail={rail} selection={selection} linkProps={linkProps} />
        <LibraryFooter rail={rail} activeId={selection.navId} linkProps={linkProps} />
      </div>
    </aside>
  );
}
