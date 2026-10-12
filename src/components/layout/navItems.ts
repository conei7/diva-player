/**
 * Destinations shared by the guide, the mini guide, the drawer and the bottom nav
 * (DESIGN_SPEC §6.1.3–6.1.4). Labels are translated by the components (useNavLabels in GuideNav).
 */
import type { ComponentType } from 'react';
import {
  BarChartIcon,
  ChorusFilledIcon,
  ChorusIcon,
  ClockIcon,
  EyeOffIcon,
  HistoryFilledIcon,
  HistoryIcon,
  HomeFilledIcon,
  HomeIcon,
  PersonStarFilledIcon,
  PersonStarIcon,
  PlaylistFilledIcon,
  PlaylistIcon,
  ScatterIcon,
  StarFilledIcon,
  StarIcon,
  TreemapIcon,
} from '../ui/iconsChrome';
import type { IconProps } from '../ui/iconsChrome';
import { WATCH_LATER_ID } from '../../stores/playlistStore';
import { resetSearchIfLoaded } from '../../stores/searchReset';
import { useSelectionStore } from '../../stores/selectionStore';
import { playlistPath, playlistsPath } from '../../utils/routes';

export type NavId =
  | 'home'
  | 'chorus'
  | 'favoriteProducers'
  | 'history'
  | 'playlists'
  | 'watchLater'
  | 'ratings'
  | 'reports'
  | 'soundMap'
  | 'knowledgeMap'
  | 'hiddenSongs';

export interface NavItem {
  id: NavId;
  /** Router path (with a search for 後で聴く). */
  to: string;
  /** Outline icon (not selected). */
  icon: ComponentType<IconProps>;
  /** Filled icon (selected). Same as `icon` where no filled shape exists. */
  activeIcon: ComponentType<IconProps>;
}

export const NAV_ITEMS: Readonly<Record<NavId, NavItem>> = {
  home: { id: 'home', to: '/', icon: HomeIcon, activeIcon: HomeFilledIcon },
  chorus: { id: 'chorus', to: '/chorus-highlights', icon: ChorusIcon, activeIcon: ChorusFilledIcon },
  favoriteProducers: { id: 'favoriteProducers', to: '/favorite-producers', icon: PersonStarIcon, activeIcon: PersonStarFilledIcon },
  history: { id: 'history', to: '/history', icon: HistoryIcon, activeIcon: HistoryFilledIcon },
  playlists: { id: 'playlists', to: playlistsPath(), icon: PlaylistIcon, activeIcon: PlaylistFilledIcon },
  watchLater: { id: 'watchLater', to: playlistPath(WATCH_LATER_ID), icon: ClockIcon, activeIcon: ClockIcon },
  ratings: { id: 'ratings', to: '/favorites', icon: StarIcon, activeIcon: StarFilledIcon },
  reports: { id: 'reports', to: '/reports', icon: BarChartIcon, activeIcon: BarChartIcon },
  soundMap: { id: 'soundMap', to: '/sound-map', icon: ScatterIcon, activeIcon: ScatterIcon },
  knowledgeMap: { id: 'knowledgeMap', to: '/knowledge-map', icon: TreemapIcon, activeIcon: TreemapIcon },
  hiddenSongs: { id: 'hiddenSongs', to: '/settings/hidden-songs', icon: EyeOffIcon, activeIcon: EyeOffIcon },
};

/** The expanded guide and the drawer. Discovery mix and Settings are buttons, not links. */
export const GUIDE_SECTIONS = {
  main: ['home', 'chorus', 'favoriteProducers'],
  library: ['history', 'playlists', 'watchLater', 'ratings', 'reports'],
  explore: ['soundMap', 'knowledgeMap'],
  more: ['hiddenSongs'],
} as const satisfies Record<string, readonly NavId[]>;

/** The 72px mini guide: the five most used destinations. */
export const MINI_GUIDE_ITEMS: readonly NavId[] = ['home', 'chorus', 'favoriteProducers', 'playlists', 'history'];

/** The bottom nav (under 640px). The fifth cell is the Menu button. */
export const BOTTOM_NAV_ITEMS: readonly NavId[] = ['home', 'chorus', 'playlists', 'history'];

export interface NavLocation {
  pathname: string;
  search: string;
  /** history.state of the entry (react-router's `location.state`); marks an advanced-only search. */
  state?: unknown;
}

/**
 * history.state key of the entry an advanced-only search (no `q`) was applied in. SearchFilters sets
 * it and HomePage reads it as ADVANCED_SEARCH_ENTRY_STATE; the frame keeps its own copy because it
 * must not import the home page's code (DESIGN_SPEC §1-12).
 */
const ADVANCED_SEARCH_ENTRY_STATE = 'divaAdvancedSearch';

/** Splits 'path?search' into a location-like object. */
export function toNavLocation(to: string): NavLocation {
  const index = to.indexOf('?');
  return index < 0
    ? { pathname: to, search: '' }
    : { pathname: to.slice(0, index), search: to.slice(index) };
}

function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

/**
 * `/` showing search results or an artist's songs instead of the feed: `?q=…`, `?artistId=…`
 * (read the same way as HomePage) or an advanced-only search entry.
 */
export function isSearchResultsLocation(location: NavLocation): boolean {
  if (normalizePathname(location.pathname) !== '/') return false;
  const params = new URLSearchParams(location.search);
  if ((params.get('q') ?? '').trim()) return true;
  const artistId = params.get('artistId') ?? '';
  if (/^\d+$/.test(artistId) && Number.isSafeInteger(Number(artistId)) && Number(artistId) > 0) return true;
  const { state } = location;
  return Boolean(state && typeof state === 'object' && (state as Record<string, unknown>)[ADVANCED_SEARCH_ENTRY_STATE]);
}

/**
 * Which destination the location belongs to. 後で聴く is /playlists?list=watch-later; every other
 * /playlists URL (the library and the other lists) selects プレイリスト. Like YouTube, search
 * results select nothing (they are not the home feed).
 */
export function activeNavId(location: NavLocation): NavId | null {
  const pathname = normalizePathname(location.pathname);
  if (pathname === '/playlists') {
    return new URLSearchParams(location.search).get('list') === WATCH_LATER_ID ? 'watchLater' : 'playlists';
  }
  if (isSearchResultsLocation(location)) return null;
  const match = (Object.values(NAV_ITEMS) as NavItem[])
    .find(item => item.id !== 'watchLater' && normalizePathname(toNavLocation(item.to).pathname) === pathname);
  return match?.id ?? null;
}

/**
 * The selected cell of the navs without a 後で聴く item (mini guide, bottom nav): 後で聴く is the
 * first list of the playlist library, so プレイリスト stays selected there.
 */
export function compactNavId(id: NavId | null): NavId | null {
  return id === 'watchLater' ? 'playlists' : id;
}

/** Path + search of a location (what `pendingNavigation` stores). */
export function navTargetOf(location: NavLocation): string {
  return `${normalizePathname(location.pathname)}${location.search}`;
}

/** A plain left click (no modifier, not the middle button) that the SPA handles itself. */
export function isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Going home from the logo / Home: back to the feed (search results and selection mode end). */
export function resetHomeState(): void {
  resetSearchIfLoaded();
  const selection = useSelectionStore.getState();
  if (selection.isSelectionMode) selection.exitSelectionMode();
}

/** Guide row (expanded guide and drawer): 40px, 10px corners, 24px icon, 24px gap, 14px text. */
export const GUIDE_ROW_CLASS =
  'flex h-10 w-full min-w-0 items-center gap-6 rounded-row px-3 text-left text-sm leading-5 text-yt-text no-underline transition-colors duration-150 [-webkit-tap-highlight-color:transparent]';

/** Hover / selected backgrounds of a guide row (selected rows are also 500 weight). */
export function guideRowStateClass(active: boolean): string {
  return active ? 'bg-yt-tonal font-medium hover:bg-yt-tonal-hover' : 'hover:bg-yt-tonal';
}
