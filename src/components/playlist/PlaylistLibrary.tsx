import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { Playlist, PlaylistFolder } from '../../types/vocadb';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { FINE_HOVER_MEDIA_QUERY, MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { displayPlaylistName } from '../../utils/displayNames';
import {
  DEFAULT_PLAYLIST_LIST_PREFERENCES,
  getPlaylistLibrarySort,
  normalizePlaylistListPreferences,
  sortPlaylistsForDisplay,
  withPlaylistLibrarySort,
  type PlaylistLibrarySort,
} from '../../utils/playlistListPreferences';
import { isSyncedPlaylist } from '../../utils/playlistPermissions';
import { storage } from '../../utils/storage';
import Button from '../ui/Button';
import { Chip, ChipBar } from '../ui/Chip';
import EmptyState from '../ui/EmptyState';
import IconButton from '../ui/IconButton';
import Menu, { MenuDivider, MenuItem, MenuItemRadio, MenuLabel } from '../ui/Menu';
import { PageHeader, PageShell } from '../ui/PageHeader';
import SearchField from '../ui/SearchField';
import SortMenu from '../ui/SortMenu';
import {
  AddIcon,
  ArrowBackIcon,
  ChevronDownIcon,
  DownloadIcon,
  EditIcon,
  FolderIcon,
  GridIcon,
  LinkIcon,
  ListIcon,
  MoreVertIcon,
  PlaylistAddIcon,
  PlaylistIcon,
  SearchIcon,
  TrashIcon,
  TuneIcon,
  UploadIcon,
} from '../ui/icons';
import type { PlaylistActionHandlers } from './PlaylistActionsMenu';
import PlaylistCard from './PlaylistCard';
import PlaylistListRow from './PlaylistListRow';
import { folderIdOfFilter, type PlaylistLibraryFilter } from './playlistDisplay';

const PLAYLIST_LIST_PREFERENCES_KEY = 'playlistListPreferences';

interface PlaylistLibraryProps {
  playlists: Playlist[];
  folders: PlaylistFolder[];
  filter: PlaylistLibraryFilter;
  onFilterChange: (filter: PlaylistLibraryFilter) => void;
  query: string;
  onQueryChange: (query: string) => void;
  actions: PlaylistActionHandlers;
  /** Called right before a card opens its playlist. */
  onOpenPlaylist: () => void;
  onNewPlaylist: () => void;
  onNewSmartPlaylist: () => void;
  onImportFromUrl: () => void;
  onImportFromFile: () => void;
  onCreateFolder: () => void;
  onRenameFolder: (folder: PlaylistFolder) => void;
  onDeleteFolder: (folder: PlaylistFolder) => void;
  onExportAll: () => void;
}

/** /playlists — a grid of playlist cards (YouTube's 再生リスト library). */
export default function PlaylistLibrary({
  playlists,
  folders,
  filter,
  onFilterChange,
  query,
  onQueryChange,
  actions,
  onOpenPlaylist,
  onNewPlaylist,
  onNewSmartPlaylist,
  onImportFromUrl,
  onImportFromFile,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onExportAll,
}: PlaylistLibraryProps) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const mobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const hoverPlay = useMediaQuery(FINE_HOVER_MEDIA_QUERY);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [preferences, setPreferences] = useState(() => normalizePlaylistListPreferences(
    storage.get(PLAYLIST_LIST_PREFERENCES_KEY) ?? DEFAULT_PLAYLIST_LIST_PREFERENCES,
  ));
  useEffect(() => { storage.set(PLAYLIST_LIST_PREFERENCES_KEY, preferences); }, [preferences]);

  const sort = getPlaylistLibrarySort(preferences);
  const sortOptions: { value: PlaylistLibrarySort; label: string }[] = [
    { value: 'recent', label: t('最近更新した順') },
    { value: 'oldest', label: t('更新が古い順') },
    { value: 'name', label: t('名前順') },
    { value: 'songs', label: t('曲数の多い順') },
  ];
  const changeSort = (next: PlaylistLibrarySort) => setPreferences(current => withPlaylistLibrarySort(current, next));
  const compact = preferences.density === 'compact';

  const folderNames = useMemo(() => new Map(folders.map(folder => [folder.id, folder.name])), [folders]);
  const selectedFolderId = folderIdOfFilter(filter);
  const selectedFolder = selectedFolderId ? folders.find(folder => folder.id === selectedFolderId) ?? null : null;

  // A folder that was deleted (here or in another tab) falls back to すべて.
  useEffect(() => {
    if (selectedFolderId && !folderNames.has(selectedFolderId)) onFilterChange('all');
  }, [folderNames, onFilterChange, selectedFolderId]);

  const regularPlaylists = useMemo(() => playlists.filter(playlist => !playlist.isPinned), [playlists]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (playlist: Playlist) => !needle
      || playlist.name.toLocaleLowerCase().includes(needle)
      || displayPlaylistName(playlist, t).toLocaleLowerCase().includes(needle);
    const inScope = (playlist: Playlist) => {
      if (filter === 'all') return true;
      if (filter === 'smart') return Boolean(playlist.smartRule);
      if (filter === 'synced') return isSyncedPlaylist(playlist);
      if (filter === 'unfiled') return !playlist.folderId || !folderNames.has(playlist.folderId);
      return playlist.folderId === selectedFolderId;
    };
    // Normalized through the menu choice so an older saved order (名前 ↓ …) matches the ✓ in the menu.
    const order = withPlaylistLibrarySort(preferences, sort);
    const pinned = filter === 'all' ? playlists.filter(playlist => playlist.isPinned && matches(playlist)) : [];
    const rest = sortPlaylistsForDisplay(regularPlaylists.filter(playlist => inScope(playlist) && matches(playlist)), order.sortKey, order.sortOrder);
    return [...pinned, ...rest];
  }, [filter, folderNames, playlists, preferences, query, regularPlaylists, selectedFolderId, sort, t]);

  const filtered = filter !== 'all' || query.trim() !== '';
  const libraryEmpty = regularPlaylists.length === 0 && !filtered;
  const clearFilters = () => {
    onQueryChange('');
    onFilterChange('all');
    setMobileSearchOpen(false);
  };

  const newMenu = (trigger: ReactElement) => (
    <Menu trigger={trigger} align="end" label={t('新規作成')}>
      <MenuItem icon={<PlaylistAddIcon />} onSelect={onNewPlaylist}>{t('新しいプレイリスト')}</MenuItem>
      <MenuItem icon={<TuneIcon />} onSelect={onNewSmartPlaylist}>{t('スマートプレイリスト')}</MenuItem>
      <MenuDivider />
      <MenuItem icon={<LinkIcon />} onSelect={onImportFromUrl}>{t('URLからインポート')}</MenuItem>
      <MenuItem icon={<UploadIcon />} onSelect={onImportFromFile}>{t('ファイルからインポート')}</MenuItem>
    </Menu>
  );

  const libraryItems = (
    <>
      <MenuItem icon={<FolderIcon />} onSelect={onCreateFolder}>{t('フォルダーを作成')}</MenuItem>
      <MenuItem icon={<DownloadIcon />} disabled={playlists.length === 0} onSelect={onExportAll}>{t('すべてエクスポート')}</MenuItem>
    </>
  );

  const searchOpen = mobileSearchOpen || query !== '';
  const header = mobile ? (
    searchOpen ? (
      <div className="mb-3 flex h-12 items-center gap-1">
        <IconButton
          label={t('戻る')}
          icon={<ArrowBackIcon />}
          className="-ml-2"
          onClick={() => {
            onQueryChange('');
            setMobileSearchOpen(false);
          }}
        />
        <SearchField
          value={query}
          onChange={onQueryChange}
          label={t('プレイリストを検索')}
          autoFocus={mobileSearchOpen}
          className="flex-1"
        />
      </div>
    ) : (
      <div className="mb-3 flex h-12 items-center gap-1">
        <h1 className="m-0 min-w-0 flex-1 truncate text-xl font-bold leading-7 text-yt-text">{t('プレイリスト')}</h1>
        <IconButton label={t('プレイリストを検索')} icon={<SearchIcon />} onClick={() => setMobileSearchOpen(true)} />
        {newMenu(<IconButton label={t('新規作成')} icon={<AddIcon />} />)}
        <Menu trigger={<IconButton label={t('その他の操作')} icon={<MoreVertIcon />} className="-mr-2" />} align="end">
          <MenuLabel>{t('並べ替え')}</MenuLabel>
          {sortOptions.map(option => (
            <MenuItemRadio key={option.value} checked={option.value === sort} onSelect={() => changeSort(option.value)}>
              {option.label}
            </MenuItemRadio>
          ))}
          <MenuDivider />
          {libraryItems}
        </Menu>
      </div>
    )
  ) : (
    <PageHeader
      title={t('プレイリスト')}
      actions={(
        <>
          <SortMenu value={sort} options={sortOptions} onChange={changeSort} />
          <SearchField value={query} onChange={onQueryChange} label={t('プレイリストを検索')} expandable />
          <IconButton
            label={compact ? t('グリッド表示') : t('リスト表示')}
            icon={compact ? <GridIcon /> : <ListIcon />}
            onClick={() => setPreferences(current => ({ ...current, density: compact ? 'comfortable' : 'compact' }))}
          />
          {newMenu(
            <Button variant="primary" icon={<AddIcon />} trailingIcon={<ChevronDownIcon />}>
              {t('新規作成')}
            </Button>,
          )}
          <Menu trigger={<IconButton label={t('その他の操作')} icon={<MoreVertIcon />} />} align="end">
            {libraryItems}
          </Menu>
        </>
      )}
    />
  );

  const folderMenu = selectedFolder ? (
    <Menu trigger={<IconButton label={t('フォルダーの操作')} icon={<MoreVertIcon />} />} align="end" label={t('フォルダーの操作')}>
      <MenuItem icon={<EditIcon />} onSelect={() => onRenameFolder(selectedFolder)}>{t('名前を変更')}</MenuItem>
      <MenuItem icon={<TrashIcon />} onSelect={() => onDeleteFolder(selectedFolder)}>{t('フォルダーを削除')}</MenuItem>
    </Menu>
  ) : undefined;

  const folderNameOf = (playlist: Playlist) => (playlist.folderId ? folderNames.get(playlist.folderId) : undefined);

  let content;
  if (visible.length === 0 && filtered) {
    content = (
      <EmptyState
        icon={<SearchIcon />}
        title={t('見つかりませんでした')}
        action={{ label: t('フィルターをクリア'), onClick: clearFilters }}
      />
    );
  } else if (mobile) {
    content = (
      <div className="-mx-1 flex flex-col">
        {visible.map(playlist => (
          <PlaylistListRow
            key={playlist.id}
            playlist={playlist}
            folderName={folderNameOf(playlist)}
            actions={actions}
            onOpen={onOpenPlaylist}
            size="lg"
          />
        ))}
      </div>
    );
  } else if (compact) {
    content = (
      <div className="-mx-2 flex flex-col">
        {visible.map(playlist => (
          <PlaylistListRow
            key={playlist.id}
            playlist={playlist}
            folderName={folderNameOf(playlist)}
            actions={actions}
            onOpen={onOpenPlaylist}
          />
        ))}
      </div>
    );
  } else {
    content = (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-4 gap-y-8">
        {visible.map(playlist => (
          <PlaylistCard
            key={playlist.id}
            playlist={playlist}
            folderName={folderNameOf(playlist)}
            actions={actions}
            onOpen={onOpenPlaylist}
            hoverPlay={hoverPlay}
          />
        ))}
      </div>
    );
  }

  return (
    <PageShell className="max-sm:pt-0">
      <section aria-label={t('プレイリストライブラリ')} data-testid="playlist-library" className="pb-6">
        {header}
        <ChipBar label={t('プレイリストの絞り込み')} trailing={folderMenu}>
          <Chip selected={filter === 'all'} onClick={() => onFilterChange('all')}>{t('すべて')}</Chip>
          <Chip selected={filter === 'smart'} onClick={() => onFilterChange('smart')}>{t('スマート')}</Chip>
          <Chip selected={filter === 'synced'} onClick={() => onFilterChange('synced')}>{t('同期')}</Chip>
          {folders.length > 0 && <span aria-hidden="true" className="h-6 w-px shrink-0 bg-yt-divider" />}
          {folders.map(folder => (
            <Chip
              key={folder.id}
              icon={<FolderIcon />}
              selected={filter === `folder:${folder.id}`}
              onClick={() => onFilterChange(`folder:${folder.id}`)}
            >
              {folder.name}
            </Chip>
          ))}
          {folders.length > 0 && (
            <Chip selected={filter === 'unfiled'} onClick={() => onFilterChange('unfiled')}>{tk('playlistUnfiled')}</Chip>
          )}
        </ChipBar>
        <div className={mobile ? 'mt-3' : 'mt-6'}>
          {content}
          {libraryEmpty && (
            <EmptyState
              icon={<PlaylistIcon />}
              title={t('まだプレイリストはありません')}
              action={{ label: t('新しいプレイリスト'), onClick: onNewPlaylist, variant: 'primary' }}
            />
          )}
        </div>
      </section>
    </PageShell>
  );
}
