import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslateSourceText } from '../../../i18n';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { preloadRoute } from '../../../routes/routeLoaders';
import { usePlaylistStore } from '../../../stores/playlistStore';
import type { Playlist } from '../../../types/vocadb';
import { displayPlaylistName } from '../../../utils/displayNames';
import { playlistPath, playlistsPath } from '../../../utils/routes';
import { NAV_ITEMS } from '../../layout/navItems';
import { OverlayErrorBoundary } from '../../layout/RouteErrorBoundary';
import type { NavId, NavItem } from '../../layout/navItems';
import { useNavLabels } from '../../layout/navHooks';
import { getPlaylistCoverCandidates } from '../../playlist/playlistDisplay';
import { usePlaylistText } from '../../playlist/usePlaylistText';
import IconButton from '../../ui/IconButton';
import { SkeletonBlock } from '../../ui/Skeleton';
import Tooltip from '../../ui/Tooltip';
import { AddIcon, ChevronDownIcon, FolderIcon, PlaylistFilledIcon, PlaylistIcon } from '../../ui/icons';
import { cx } from '../../ui/overlay';
import SquareArt from '../SquareArt';
import { useLibraryFolderStore, useStoredPlaylistOrder } from './libraryHooks';
import {
  LIBRARY_ROW_CLASS,
  RAIL_NAME_TOOLTIP_MEDIA_QUERY,
  buildLibraryModel,
  folderHoldsList,
  libraryRowStateClass,
} from './libraryModel';
import type { LibraryFolderGroup, LibrarySelection } from './libraryModel';
import { LibraryIconTile, LibraryLink, RailTooltip } from './LibraryRow';
import type { NavLinkHandlers } from './LibraryRow';

// The new-playlist dialog is only fetched for a ＋ press (warmed on hover / focus), not with the frame.
const loadNewPlaylistDialog = () => import('../../playlist/NewPlaylistDialog');
const NewPlaylistDialog = lazy(loadNewPlaylistDialog);
const preloadNewPlaylistDialog = () => void loadNewPlaylistDialog().catch(() => undefined);
const CREATE_WARM_PROPS = {
  onPointerEnter: preloadNewPlaylistDialog,
  onFocus: preloadNewPlaylistDialog,
  onTouchStart: preloadNewPlaylistDialog,
};

/** Fixed entries above the user's playlists (プレイリスト一覧 is the heading's link). */
const FIXED_ENTRIES: readonly NavId[] = ['watchLater', 'ratings', 'history', 'favoriteProducers', 'reports'];

/** Thin scrollbar that shows while the column is hovered or focused (like the guide). */
const SCROLL_CLASS =
  'overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:var(--color-yt-text-disabled)_transparent] focus-within:[scrollbar-color:var(--color-yt-text-disabled)_transparent]';

interface LibraryListProps {
  rail: boolean;
  selection: LibrarySelection & { navId: NavId | null };
  linkProps: (item: NavItem) => NavLinkHandlers;
}

function PlaylistEntry({
  playlist,
  rail,
  nested,
  active,
  meta,
  tooltip,
  handlers,
}: {
  playlist: Playlist;
  rail: boolean;
  /** Inside an open folder: in the rail its cover is a little smaller than the folder's tile. */
  nested: boolean;
  active: boolean;
  meta: ReactNode;
  tooltip: boolean;
  handlers: NavLinkHandlers;
}) {
  const t = useTranslateSourceText();
  const candidates = useMemo(() => getPlaylistCoverCandidates(playlist), [playlist]);
  return (
    <LibraryLink
      to={playlistPath(playlist.id)}
      label={displayPlaylistName(playlist, t)}
      meta={meta}
      art={(
        <SquareArt
          candidates={candidates}
          className={rail && !nested ? 'size-12' : 'size-10'}
          fallbackIcon={<PlaylistIcon size={20} />}
        />
      )}
      active={active}
      rail={rail}
      tooltip={tooltip}
      handlers={handlers}
    />
  );
}

function FolderEntry({
  group,
  open,
  rail,
  holdsActive,
  tooltip,
  onToggle,
  children,
}: {
  group: LibraryFolderGroup;
  open: boolean;
  rail: boolean;
  tooltip: boolean;
  /** The open playlist is in this folder (a closed folder is then shown as selected). */
  holdsActive: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const t = useTranslateSourceText();
  const text = usePlaylistText();
  const listId = useId();
  const name = group.folder.name;
  const count = group.playlists.length;
  return (
    <li className={rail && open ? 'rounded-lg ring-1 ring-inset ring-yt-divider' : undefined}>
      <RailTooltip rail={rail && tooltip} label={name}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={rail ? name : undefined}
          onClick={onToggle}
          className={cx(
            LIBRARY_ROW_CLASS,
            libraryRowStateClass(holdsActive && !open),
            'h-14 cursor-pointer',
            rail ? 'justify-center' : 'gap-3 px-2',
          )}
        >
          <LibraryIconTile rail={rail}><FolderIcon /></LibraryIconTile>
          {!rail && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium leading-5">{name}</span>
                <span className="block truncate text-xs leading-[18px] text-yt-text-secondary">
                  {t('フォルダー')} · {count === 1 ? t('1件') : t('{count}件', { count: text.number(count) })}
                </span>
              </span>
              <ChevronDownIcon
                size={20}
                className={cx(
                  'text-yt-text-secondary transition-transform duration-150 motion-reduce:transition-none',
                  !open && '-rotate-90',
                )}
              />
            </>
          )}
        </button>
      </RailTooltip>
      {open && (
        <ul id={listId} className={cx('flex flex-col gap-0.5', rail ? 'pb-1' : 'ml-4 border-l border-yt-divider pl-1')}>
          {children}
        </ul>
      )}
    </li>
  );
}

/** Quiet placeholder rows while the saved playlists are being read. */
function LibraryPlaceholder({ rail }: { rail: boolean }) {
  const t = useTranslateSourceText();
  return (
    <div className="flex flex-col gap-0.5" data-testid="music-library-loading">
      <span className="sr-only">{t('読み込み中…')}</span>
      {[0, 1, 2].map(index => (
        <div key={index} aria-hidden="true" className={cx('flex h-14 items-center', rail ? 'justify-center' : 'gap-3 px-2')}>
          <SkeletonBlock className={cx('shrink-0 rounded-[4px]', rail ? 'size-12' : 'size-10')} />
          {!rail && (
            <div className="min-w-0 flex-1 space-y-1.5">
              <SkeletonBlock className="h-3.5 w-3/4 rounded-badge" />
              <SkeletonBlock className="h-3 w-1/2 rounded-badge" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The library part of the column (scrolls inside it): the 「ライブラリ」 heading with ＋ (new playlist)
 * and the link to the playlist library, the fixed entries (後で聴く, 評価した曲, 履歴, お気に入りP,
 * レポート) and the user's playlists in the library page's saved order, grouped under their folders.
 * Reads the playlist store as it is (the app loads it); only ＋ adds a playlist, through the library
 * page's own dialog, and then opens it.
 */
export default function LibraryList({ rail, selection, linkProps }: LibraryListProps) {
  const t = useTranslateSourceText();
  const headingId = useId();
  const { full } = useNavLabels();
  const text = usePlaylistText();
  const playlists = usePlaylistStore(state => state.playlists);
  const folders = usePlaylistStore(state => state.folders);
  const hasHydrated = usePlaylistStore(state => state.hasHydrated);
  const collapsedFolderIds = useLibraryFolderStore(state => state.collapsedFolderIds);
  const toggleFolder = useLibraryFolderStore(state => state.toggleFolder);
  const nameTooltips = useMediaQuery(RAIL_NAME_TOOLTIP_MEDIA_QUERY);
  const order = useStoredPlaylistOrder();
  const model = useMemo(() => buildLibraryModel(playlists, folders, order), [folders, order, playlists]);
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);

  // The scrollbar only shows on hover, so a fade at the bottom says the list goes on (laptop heights
  // and the rail often hide the user's playlists below the fixed entries).
  const measureOverflow = useCallback(() => {
    const list = scrollRef.current;
    if (list) setMoreBelow(list.scrollTop + list.clientHeight < list.scrollHeight - 1);
  }, []);
  useEffect(() => {
    measureOverflow();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measureOverflow());
    if (scrollRef.current) observer.observe(scrollRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [measureOverflow]);

  // Opening a playlist from elsewhere (a home shelf, the library page) brings its row into view.
  // Only this list scrolls (not the window, which belongs to the page).
  const selectedKey = `${selection.navId ?? ''}|${selection.listId ?? ''}`;
  useEffect(() => {
    const list = scrollRef.current;
    const row = list?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!list || !row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top) list.scrollTop -= listRect.top - rowRect.top + 8;
    else if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom + 8;
  }, [selectedKey, hasHydrated, rail]);

  const playlistMeta = (playlist: Playlist) => {
    const count = playlist.songs.length;
    return (
      <>
        {text.syncFailed(playlist) ? <span className="text-yt-danger">{t('同期エラー')}</span> : text.kind(playlist)}
        {' · '}
        {count === 1 ? t('1曲') : t('{count}曲', { count: text.number(count) })}
      </>
    );
  };

  const renderPlaylist = (playlist: Playlist, nested = false) => (
    <li key={playlist.id}>
      <PlaylistEntry
        playlist={playlist}
        rail={rail}
        nested={nested}
        active={selection.listId === playlist.id}
        meta={playlistMeta(playlist)}
        tooltip={nameTooltips}
        handlers={linkProps({ ...NAV_ITEMS.playlists, to: playlistPath(playlist.id) })}
      />
    </li>
  );

  const libraryLabel = t('プレイリスト一覧');
  const LibraryIcon = selection.libraryPage ? PlaylistFilledIcon : PlaylistIcon;
  const createLabel = t('プレイリストを作成');

  const openCreate = () => {
    // The new list opens right after 作成: fetch its page while the name is typed.
    preloadRoute(playlistsPath());
    setCreateOpen(true);
  };
  const createPlaylist = async (name: string, folderId?: string) => {
    const playlist = await usePlaylistStore.getState().createPlaylist(name, folderId);
    setCreateOpen(false);
    // Its row then becomes the selected one and scrolls into view (selectedKey).
    navigate(playlistPath(playlist.id));
  };

  /** The rail's ＋ tile (the full column has ＋ in its heading row). */
  const railCreateTile = (emptyLibrary: boolean) => (
    <RailTooltip rail label={createLabel}>
      <button
        type="button"
        aria-label={createLabel}
        aria-haspopup="dialog"
        data-testid={emptyLibrary ? 'music-library-empty' : undefined}
        onClick={openCreate}
        className={cx(LIBRARY_ROW_CLASS, libraryRowStateClass(false), 'h-12 cursor-pointer justify-center')}
        {...CREATE_WARM_PROPS}
      >
        <LibraryIconTile rail compact><AddIcon /></LibraryIconTile>
      </button>
    </RailTooltip>
  );

  return (
    <section aria-labelledby={headingId} className="relative flex min-h-[168px] flex-1 flex-col">
      <div className={cx('flex shrink-0 items-center', rail ? 'px-2 pb-1 pt-2' : 'h-12 gap-2 pl-4 pr-2 pt-1')}>
        <h2 id={headingId} className={rail ? 'sr-only' : 'm-0 min-w-0 flex-1 truncate text-base font-bold leading-6 text-yt-text'}>
          {t('ライブラリ')}
        </h2>
        {/* Full column only: the rail is short of height, so its ＋ is a tile after the playlists. */}
        {!rail && (
          <IconButton
            label={createLabel}
            icon={<AddIcon />}
            tooltipPlacement="bottom"
            aria-haspopup="dialog"
            onClick={openCreate}
            {...CREATE_WARM_PROPS}
          />
        )}
        <Tooltip content={libraryLabel} placement={rail ? 'right' : 'bottom'}>
          <Link
            to={playlistsPath()}
            aria-label={libraryLabel}
            aria-current={selection.libraryPage ? 'page' : undefined}
            className={cx(
              'flex shrink-0 items-center justify-center text-yt-text no-underline transition-colors duration-150',
              rail ? 'h-11 w-full rounded-lg' : 'size-10 rounded-full',
              selection.libraryPage ? 'bg-yt-tonal hover:bg-yt-tonal-hover' : 'hover:bg-yt-tonal',
            )}
            {...linkProps(NAV_ITEMS.playlists)}
          >
            <LibraryIcon />
          </Link>
        </Tooltip>
      </div>

      {/* scroll-pb-8: a row reached with Tab stops above the bottom fade, not under it. */}
      <div
        ref={scrollRef}
        onScroll={measureOverflow}
        className={cx('min-h-0 flex-1 scroll-pb-8 pb-2 pt-1', rail ? 'px-1' : 'px-2', SCROLL_CLASS)}
        data-testid="music-library-list"
      >
        {/* Observed for its height: a folder opening or the playlists arriving can start the overflow. */}
        <div ref={contentRef}>
          <ul className="flex flex-col gap-0.5">
            {FIXED_ENTRIES.map(id => {
              const item = NAV_ITEMS[id];
              const active = selection.navId === id;
              const Icon = active ? item.activeIcon : item.icon;
              const watchLater = id === 'watchLater' ? model.watchLater : null;
              return (
                <li key={id}>
                  <LibraryLink
                    to={item.to}
                    label={full[id]}
                    meta={watchLater ? playlistMeta(watchLater) : undefined}
                    art={<LibraryIconTile rail={rail} compact><Icon /></LibraryIconTile>}
                    active={active}
                    rail={rail}
                    compact
                    handlers={linkProps(item)}
                  />
                </li>
              );
            })}
          </ul>

          <hr aria-hidden="true" className="mx-2 my-2 h-px border-0 bg-yt-divider" />

          {!hasHydrated ? (
            <LibraryPlaceholder rail={rail} />
          ) : model.count === 0 ? (
            rail ? railCreateTile(true) : (
              <div className="rounded-lg bg-yt-tonal px-4 py-3" data-testid="music-library-empty">
                <p className="m-0 text-sm font-medium leading-5 text-yt-text">{t('まだプレイリストはありません')}</p>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  onClick={openCreate}
                  className="mt-3 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-yt-inverse pl-3 pr-4 text-sm font-medium leading-5 text-yt-on-inverse transition-colors duration-150 hover:bg-yt-inverse-hover"
                  {...CREATE_WARM_PROPS}
                >
                  <AddIcon size={20} />
                  {createLabel}
                </button>
              </div>
            )
          ) : (
            <>
              <ul aria-label={t('プレイリスト')} className="flex flex-col gap-0.5">
                {model.pinned.map(playlist => renderPlaylist(playlist))}
                {model.folders.map(group => {
                  const open = !collapsedFolderIds.includes(group.folder.id);
                  return (
                    <FolderEntry
                      key={`folder:${group.folder.id}`}
                      group={group}
                      open={open}
                      rail={rail}
                      holdsActive={folderHoldsList(group, selection.listId)}
                      tooltip={nameTooltips}
                      onToggle={() => toggleFolder(group.folder.id)}
                    >
                      {group.playlists.map(playlist => renderPlaylist(playlist, true))}
                    </FolderEntry>
                  );
                })}
                {model.unfiled.map(playlist => renderPlaylist(playlist))}
              </ul>
              {rail && <div className="mt-0.5">{railCreateTile(false)}</div>}
            </>
          )}
        </div>
      </div>

      {moreBelow && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-yt-bg to-transparent" />
      )}

      {/* The column sits outside the route boundary: a dialog chunk that fails to load closes the dialog only. */}
      {createOpen && (
        <Suspense fallback={null}>
          <OverlayErrorBoundary onError={() => setCreateOpen(false)}>
            <NewPlaylistDialog open folders={folders} onClose={() => setCreateOpen(false)} onCreate={createPlaylist} />
          </OverlayErrorBoundary>
        </Suspense>
      )}
    </section>
  );
}
