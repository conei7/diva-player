import { useEffect, useMemo, useRef, useState } from 'react';
import type { Playlist, PlaylistFolder } from '../../types/vocadb';
import { storage } from '../../utils/storage';
import {
  DEFAULT_PLAYLIST_LIST_PREFERENCES,
  normalizePlaylistListPreferences,
  sortPlaylistsForDisplay,
  type PlaylistListDensity,
  type PlaylistListSortKey,
} from '../../utils/playlistListPreferences';
import PlaylistCover from './PlaylistCover';
import PlaylistPopoverMenu from './PlaylistPopoverMenu';

const PLAYLIST_LIST_PREFERENCES_KEY = 'playlistListPreferences';

type LibraryScope = 'all' | 'smart' | 'synced';

interface PlaylistLibrarySidebarProps {
  playlists: Playlist[];
  folders: PlaylistFolder[];
  selectedPlaylistId: string | null;
  selectedFolderId: string | null;
  hasSelectedPlaylist: boolean;
  onSelectPlaylist: (id: string) => void;
  onSelectFolder: (id: string | null) => void;
  onCreatePlaylist: (name: string, folderId?: string) => void;
  onCreateFolder: (name: string) => void;
  onDeleteFolder: (id: string) => void;
  onOpenSmartBuilder: () => void;
  onImportJson: (file: File) => void | Promise<void>;
  onExportAll: () => void;
}

function FolderRow({
  folder,
  selected,
  onSelect,
  onDelete,
}: {
  folder: PlaylistFolder;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-1 rounded-xl border transition-colors ${selected ? 'border-emerald-300/20 bg-emerald-300/10' : 'border-transparent hover:bg-white/[0.05]'}`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-xs text-neutral-300"
      >
        <svg className="h-3.5 w-3.5 flex-shrink-0 text-emerald-200/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className="truncate">{folder.name}</span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="mr-1 flex h-8 w-8 items-center justify-center rounded-lg text-neutral-600 opacity-0 transition-all hover:bg-red-400/10 hover:text-red-300 group-focus-within:opacity-100 group-hover:opacity-100"
        title={`${folder.name}を削除`}
        aria-label={`${folder.name}を削除`}
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function PlaylistLibraryItem({
  playlist,
  selected,
  compact,
  onSelect,
}: {
  playlist: Playlist;
  selected: boolean;
  compact: boolean;
  onSelect: () => void;
}) {
  const syncLabel = playlist.youtubeSync ? 'YouTube' : playlist.nicoSync ? 'ニコニコ' : null;
  const syncStatus = playlist.youtubeSync?.lastStatus ?? playlist.nicoSync?.lastStatus;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'page' : undefined}
      className={`group relative flex w-full items-center rounded-2xl border text-left transition-all duration-200 ${compact ? 'gap-2 p-1.5' : 'gap-3 p-2.5'} ${selected ? 'border-emerald-300/25 bg-gradient-to-r from-emerald-300/[0.12] to-cyan-300/[0.04] shadow-lg shadow-emerald-950/20' : 'border-transparent hover:border-white/10 hover:bg-white/[0.045]'}`}
    >
      {selected && <span className="absolute inset-y-3 left-0 w-0.5 rounded-r-full bg-emerald-300" />}
      <div className={`${compact ? 'h-10 w-10 rounded-xl' : 'h-14 w-14 rounded-2xl'} flex-shrink-0 overflow-hidden bg-black/30 shadow-lg ring-1 ring-white/10 transition-transform duration-200 group-hover:scale-[1.025]`}>
        <PlaylistCover playlist={playlist} />
      </div>
      <div className="min-w-0 flex-1">
        <p className={`${compact ? 'text-xs' : 'text-sm'} truncate font-semibold text-neutral-100`}>{playlist.name}</p>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-neutral-500">
          <span className="whitespace-nowrap">{playlist.songs.length}曲</span>
          {playlist.smartRule && (
            <span className="rounded-full bg-violet-300/10 px-1.5 py-0.5 text-violet-200">スマート</span>
          )}
          {syncLabel && (
            <span className={`truncate rounded-full px-1.5 py-0.5 ${syncStatus === 'error' ? 'bg-red-300/10 text-red-200' : 'bg-cyan-300/10 text-cyan-200'}`}>
              {syncStatus === 'error' ? '同期エラー' : syncLabel}
            </span>
          )}
        </div>
      </div>
      <svg className={`h-4 w-4 flex-shrink-0 transition-transform ${selected ? 'text-emerald-200' : 'text-neutral-700 group-hover:translate-x-0.5 group-hover:text-neutral-400'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  );
}

export default function PlaylistLibrarySidebar({
  playlists,
  folders,
  selectedPlaylistId,
  selectedFolderId,
  hasSelectedPlaylist,
  onSelectPlaylist,
  onSelectFolder,
  onCreatePlaylist,
  onCreateFolder,
  onDeleteFolder,
  onOpenSmartBuilder,
  onImportJson,
  onExportAll,
}: PlaylistLibrarySidebarProps) {
  const [folderScope, setFolderScope] = useState<'all' | 'folder'>('all');
  const [libraryScope, setLibraryScope] = useState<LibraryScope>('all');
  const [query, setQuery] = useState('');
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [preferences, setPreferences] = useState(() => normalizePlaylistListPreferences(
    storage.get(PLAYLIST_LIST_PREFERENCES_KEY) ?? DEFAULT_PLAYLIST_LIST_PREFERENCES,
  ));
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    storage.set(PLAYLIST_LIST_PREFERENCES_KEY, preferences);
  }, [preferences]);

  const regularPlaylists = playlists.filter(playlist => !playlist.isPinned);
  const pinnedPlaylists = playlists.filter(playlist => playlist.isPinned);
  const syncedCount = regularPlaylists.filter(playlist => playlist.youtubeSync || playlist.nicoSync).length;
  const songReferenceCount = playlists.reduce((sum, playlist) => sum + playlist.songs.length, 0);

  const visiblePlaylists = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('ja-JP');
    const inFolder = folderScope === 'all'
      ? regularPlaylists
      : selectedFolderId
        ? regularPlaylists.filter(playlist => playlist.folderId === selectedFolderId)
        : regularPlaylists.filter(playlist => !playlist.folderId);
    const inScope = inFolder.filter(playlist => {
      if (libraryScope === 'smart') return Boolean(playlist.smartRule);
      if (libraryScope === 'synced') return Boolean(playlist.youtubeSync || playlist.nicoSync);
      return true;
    });
    return sortPlaylistsForDisplay(inScope, preferences.sortKey, preferences.sortOrder)
      .filter(playlist => !normalizedQuery || playlist.name.toLocaleLowerCase('ja-JP').includes(normalizedQuery));
  }, [folderScope, libraryScope, preferences.sortKey, preferences.sortOrder, query, regularPlaylists, selectedFolderId]);

  const smartPlaylists = visiblePlaylists.filter(playlist => Boolean(playlist.smartRule));
  const standardPlaylists = visiblePlaylists.filter(playlist => !playlist.smartRule);
  const compact = preferences.density === 'compact';

  const submitPlaylist = () => {
    const name = newPlaylistName.trim();
    if (!name) return;
    onCreatePlaylist(name, folderScope === 'folder' ? selectedFolderId ?? undefined : undefined);
    setNewPlaylistName('');
  };

  const submitFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    onCreateFolder(name);
    setNewFolderName('');
    setShowFolderInput(false);
  };

  const selectAllFolders = () => {
    setFolderScope('all');
    onSelectFolder(null);
  };

  const selectFolder = (id: string | null) => {
    setFolderScope('folder');
    onSelectFolder(id);
  };

  return (
    <aside
      className={`min-h-0 w-full flex-shrink-0 flex-col overflow-hidden rounded-[1.5rem] border border-white/[0.08] bg-gradient-to-b from-white/[0.055] to-white/[0.018] shadow-2xl shadow-black/10 md:h-full md:w-[21rem] lg:w-[23rem] ${hasSelectedPlaylist ? 'hidden md:flex' : 'flex'}`}
      aria-label="プレイリストライブラリ"
    >
      <div className="border-b border-white/[0.07] p-3.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-200/60">Your library</p>
            <h2 className="mt-1 text-xl font-bold tracking-tight text-white">プレイリスト</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowFolderInput(current => !current)}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.045] text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
              title="フォルダーを作成"
              aria-label="フォルダーを作成"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <path d="M12 11v6m-3-3h6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onOpenSmartBuilder}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-300/20 bg-violet-300/10 text-violet-200 transition-colors hover:bg-violet-300/20 hover:text-white"
              title="スマートプレイリストを作成"
              aria-label="スマートプレイリストを作成"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
                <path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" />
              </svg>
            </button>
            <PlaylistPopoverMenu
              trigger={
                <button type="button" className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.045] text-neutral-400 transition-colors hover:bg-white/10 hover:text-white" title="ライブラリ操作" aria-label="ライブラリ操作">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
                </button>
              }
            >
              <button className="context-menu-item" onClick={() => importInputRef.current?.click()}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5-5 5 5M12 5v12" /></svg>
                <span>JSONを読み込む</span>
              </button>
              <button className="context-menu-item" onClick={onExportAll} disabled={playlists.length === 0}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5M12 15V3" /></svg>
                <span>全体をバックアップ</span>
              </button>
            </PlaylistPopoverMenu>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-1.5">
          <div className="rounded-xl border border-white/[0.07] bg-black/15 px-2.5 py-2">
            <p className="text-lg font-bold text-white">{regularPlaylists.length}</p>
            <p className="text-[10px] text-neutral-500">リスト</p>
          </div>
          <div className="rounded-xl border border-white/[0.07] bg-black/15 px-2.5 py-2">
            <p className="text-lg font-bold text-white">{songReferenceCount.toLocaleString('ja-JP')}</p>
            <p className="text-[10px] text-neutral-500">保存曲</p>
          </div>
          <div className="rounded-xl border border-white/[0.07] bg-black/15 px-2.5 py-2">
            <p className="text-lg font-bold text-white">{syncedCount}</p>
            <p className="text-[10px] text-neutral-500">同期中</p>
          </div>
        </div>

        {showFolderInput && (
          <div className="mt-3 flex gap-2 rounded-xl border border-white/[0.08] bg-black/20 p-2">
            <input
              type="text"
              value={newFolderName}
              onChange={event => setNewFolderName(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && submitFolder()}
              placeholder="フォルダー名"
              className="search-input min-w-0 flex-1 text-xs"
              autoFocus
            />
            <button type="button" className="rounded-lg bg-white px-3 text-xs font-bold text-black" onClick={submitFolder}>作成</button>
          </div>
        )}
      </div>

      <div className="space-y-3 border-b border-white/[0.07] p-3.5">
        <div className="relative">
          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="ライブラリを検索"
            className="search-input w-full rounded-xl py-2.5 pl-10 pr-9 text-sm"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-neutral-500 hover:bg-white/10 hover:text-white" aria-label="検索をクリア">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>

        <div className="flex rounded-xl bg-black/20 p-1" aria-label="プレイリスト種別">
          {([
            ['all', 'すべて'],
            ['smart', 'スマート'],
            ['synced', '同期中'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setLibraryScope(value)}
              aria-pressed={libraryScope === value}
              className={`min-h-9 flex-1 rounded-lg px-2 text-[11px] font-medium transition-colors ${libraryScope === value ? 'bg-white/10 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <select
            className="input min-w-0 flex-1 rounded-lg py-1.5 text-[11px]"
            value={preferences.sortKey}
            onChange={event => setPreferences(current => ({ ...current, sortKey: event.target.value as PlaylistListSortKey }))}
            aria-label="プレイリストの並べ替え"
          >
            <option value="updatedAt">更新順</option>
            <option value="name">名前順</option>
            <option value="songCount">曲数順</option>
          </select>
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-xs text-neutral-400 hover:bg-white/10 hover:text-white" onClick={() => setPreferences(current => ({ ...current, sortOrder: current.sortOrder === 'desc' ? 'asc' : 'desc' }))} title="並び順を反転" aria-label="並び順を反転">
            {preferences.sortOrder === 'desc' ? '↓' : '↑'}
          </button>
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={() => setPreferences(current => ({ ...current, density: current.density === 'comfortable' ? 'compact' : 'comfortable' as PlaylistListDensity }))} title="表示密度を切り替え" aria-label="表示密度を切り替え">
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {pinnedPlaylists.length > 0 && libraryScope === 'all' && !query && (
          <section className="mb-4 space-y-1.5">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-neutral-600">ピン留め</p>
            {pinnedPlaylists.map(playlist => (
              <PlaylistLibraryItem key={playlist.id} playlist={playlist} selected={selectedPlaylistId === playlist.id} compact={compact} onSelect={() => onSelectPlaylist(playlist.id)} />
            ))}
          </section>
        )}

        <section className="mb-4 rounded-2xl border border-white/[0.06] bg-black/10 p-1.5">
          <button
            type="button"
            onClick={selectAllFolders}
            className={`flex min-h-10 w-full items-center gap-2 rounded-xl px-2.5 text-left text-xs transition-colors ${folderScope === 'all' ? 'bg-white/[0.08] text-white' : 'text-neutral-400 hover:bg-white/[0.04]'}`}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 9 12 2l9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            すべてのフォルダー
          </button>
          <button
            type="button"
            onClick={() => selectFolder(null)}
            className={`flex min-h-10 w-full items-center gap-2 rounded-xl px-2.5 text-left text-xs transition-colors ${folderScope === 'folder' && selectedFolderId === null ? 'bg-white/[0.08] text-white' : 'text-neutral-400 hover:bg-white/[0.04]'}`}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
            未分類
          </button>
          {folders.map(folder => (
            <FolderRow
              key={folder.id}
              folder={folder}
              selected={folderScope === 'folder' && selectedFolderId === folder.id}
              onSelect={() => selectFolder(folder.id)}
              onDelete={() => onDeleteFolder(folder.id)}
            />
          ))}
        </section>

        <section className="space-y-4">
          {smartPlaylists.length > 0 && libraryScope !== 'synced' && (
            <div className="space-y-1.5">
              <p className="flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-violet-200/60">
                <span>スマート</span><span>{smartPlaylists.length}</span>
              </p>
              {smartPlaylists.map(playlist => (
                <PlaylistLibraryItem key={playlist.id} playlist={playlist} selected={selectedPlaylistId === playlist.id} compact={compact} onSelect={() => onSelectPlaylist(playlist.id)} />
              ))}
            </div>
          )}
          <div className="space-y-1.5">
            <p className="flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-neutral-600">
              <span>{libraryScope === 'synced' ? '外部同期' : 'プレイリスト'}</span><span>{standardPlaylists.length}</span>
            </p>
            {standardPlaylists.length === 0 && smartPlaylists.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center">
                <p className="text-xs font-medium text-neutral-400">該当するプレイリストはありません</p>
                <p className="mt-1 text-[10px] text-neutral-600">検索や表示条件を変更してください</p>
              </div>
            ) : standardPlaylists.map(playlist => (
              <PlaylistLibraryItem key={playlist.id} playlist={playlist} selected={selectedPlaylistId === playlist.id} compact={compact} onSelect={() => onSelectPlaylist(playlist.id)} />
            ))}
          </div>
        </section>
      </div>

      <div className="border-t border-white/[0.07] p-3.5">
        <div className="flex gap-2 rounded-2xl border border-white/[0.07] bg-black/20 p-2">
          <input
            type="text"
            value={newPlaylistName}
            onChange={event => setNewPlaylistName(event.target.value)}
            onKeyDown={event => event.key === 'Enter' && submitPlaylist()}
            placeholder={folderScope === 'folder' && selectedFolderId ? 'このフォルダーに新規作成' : '新しいプレイリスト'}
            className="search-input min-w-0 flex-1 text-xs"
          />
          <button type="button" className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-white text-black transition-colors hover:bg-neutral-200" onClick={submitPlaylist} title="プレイリストを作成" aria-label="プレイリストを作成">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) void onImportJson(file);
          event.currentTarget.value = '';
        }}
      />
    </aside>
  );
}
