import { useEffect, useMemo, useRef, useState } from 'react';
import type { Playlist, PlaylistFolder } from '../../types/vocadb';
import { storage } from '../../utils/storage';
import {
  DEFAULT_PLAYLIST_LIST_PREFERENCES,
  normalizePlaylistListPreferences,
  sortPlaylistsForDisplay,
  type PlaylistListSortKey,
} from '../../utils/playlistListPreferences';
import PlaylistCover from './PlaylistCover';
import PlaylistPopoverMenu from './PlaylistPopoverMenu';
import { useTranslateSourceText } from '../../i18n';

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
  onOpenNicoImport: () => void;
  onOpenYouTubeImport: () => void;
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
  const t = useTranslateSourceText();
  return (
    <div
      className={`group flex items-center gap-1 rounded-xl border transition-colors ${selected ? 'border-emerald-300/20 bg-emerald-300/10' : 'border-transparent hover:bg-white/[0.05]'}`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-xs text-neutral-300"
      >
        <svg className="h-3.5 w-3.5 flex-shrink-0 text-emerald-200/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className="truncate">{folder.name}</span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="mr-1 flex h-11 w-11 items-center justify-center rounded-lg text-neutral-600 opacity-0 transition-all hover:bg-red-400/10 hover:text-red-300 group-focus-within:opacity-100 group-hover:opacity-100"
        title={t('{name}を削除', { name: folder.name })}
        aria-label={t('{name}を削除', { name: folder.name })}
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
  const t = useTranslateSourceText();
  const syncLabel = playlist.youtubeSync ? 'YouTube' : playlist.nicoSync ? t('ニコニコ') : null;
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
          <span className="whitespace-nowrap">{t('{count}曲', { count: playlist.songs.length })}</span>
          {playlist.smartRule && (
            <span className="rounded-full bg-violet-300/10 px-1.5 py-0.5 text-violet-200">{t('スマート')}</span>
          )}
          {syncLabel && (
            <span className={`truncate rounded-full px-1.5 py-0.5 ${syncStatus === 'error' ? 'bg-red-300/10 text-red-200' : 'bg-cyan-300/10 text-cyan-200'}`}>
              {syncStatus === 'error' ? t('同期エラー') : syncLabel}
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
  playlists, folders, selectedPlaylistId, selectedFolderId, hasSelectedPlaylist,
  onSelectPlaylist, onSelectFolder, onCreatePlaylist, onCreateFolder, onDeleteFolder,
  onOpenSmartBuilder, onOpenNicoImport, onOpenYouTubeImport, onImportJson, onExportAll,
}: PlaylistLibrarySidebarProps) {
  const t = useTranslateSourceText();
  const [folderScope, setFolderScope] = useState<'all' | 'folder'>('all');
  const [libraryScope, setLibraryScope] = useState<LibraryScope>('all');
  const [query, setQuery] = useState('');
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [preferences, setPreferences] = useState(() => normalizePlaylistListPreferences(
    storage.get(PLAYLIST_LIST_PREFERENCES_KEY) ?? DEFAULT_PLAYLIST_LIST_PREFERENCES,
  ));
  const importInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { storage.set(PLAYLIST_LIST_PREFERENCES_KEY, preferences); }, [preferences]);
  const regularPlaylists = useMemo(() => playlists.filter(playlist => !playlist.isPinned), [playlists]);
  const visiblePlaylists = useMemo(() => {
    const inFolder = folderScope === 'all' ? regularPlaylists : regularPlaylists.filter(playlist => (playlist.folderId ?? null) === selectedFolderId);
    return sortPlaylistsForDisplay(inFolder.filter(playlist => libraryScope === 'smart' ? Boolean(playlist.smartRule)
      : libraryScope === 'synced' ? Boolean(playlist.youtubeSync || playlist.nicoSync) : true), preferences.sortKey, preferences.sortOrder)
      .filter(playlist => playlist.name.toLocaleLowerCase('ja-JP').includes(query.trim().toLocaleLowerCase('ja-JP')));
  }, [folderScope, libraryScope, preferences.sortKey, preferences.sortOrder, query, regularPlaylists, selectedFolderId]);
  const pinned = playlists.filter(playlist => playlist.isPinned && playlist.name.toLocaleLowerCase('ja-JP').includes(query.trim().toLocaleLowerCase('ja-JP')));
  const submitPlaylist = () => {
    if (!newPlaylistName.trim()) return;
    onCreatePlaylist(newPlaylistName.trim(), folderScope === 'folder' ? selectedFolderId ?? undefined : undefined);
    setNewPlaylistName(''); setShowCreate(false);
  };
  const submitFolder = () => {
    if (!newFolderName.trim()) return;
    onCreateFolder(newFolderName.trim()); setNewFolderName(''); setShowFolderInput(false);
  };
  const chooseFolder = (id: string | null, all = false) => { setFolderScope(all ? 'all' : 'folder'); onSelectFolder(id); };
  return (
    <aside className={`min-h-0 w-full flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025] xl:h-full xl:w-80 xl:flex-none ${hasSelectedPlaylist ? 'hidden xl:flex' : 'flex'}`} aria-label={t('プレイリストライブラリ')}>
      <header className="shrink-0 border-b border-white/10 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl font-bold">{t('プレイリスト')}</h2>
          <PlaylistPopoverMenu trigger={<button type="button" className="h-11 w-11 rounded-xl text-neutral-400 hover:bg-white/10" title={t('ライブラリ操作')} aria-label={t('ライブラリ操作')}>•••</button>}>
            <button className="context-menu-item" onClick={() => setShowFolderInput(true)}>{t('フォルダーを作成')}</button>
            <button className="context-menu-item" onClick={() => importInputRef.current?.click()}>{t('JSONを読み込む')}</button>
            <button className="context-menu-item" onClick={onExportAll} disabled={playlists.length === 0}>{t('全体をバックアップ')}</button>
          </PlaylistPopoverMenu>
        </div>
        <p className="mt-1 text-xs text-neutral-400">{t('保存曲')} {t('{count}曲', { count: playlists.reduce((sum, playlist) => sum + playlist.songs.length, 0) })} · {regularPlaylists.length} {t('リスト')}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" className="min-h-11 rounded-xl bg-white px-2 text-xs font-semibold text-black hover:bg-neutral-200" onClick={() => setShowCreate(value => !value)} aria-expanded={showCreate}>{t('新規作成')}</button>
          <button type="button" className="min-h-11 rounded-xl border border-violet-300/25 bg-violet-300/5 px-2 text-xs font-medium text-violet-100 hover:bg-violet-300/10" onClick={onOpenSmartBuilder} title={t('スマートプレイリストを作成')}>{t('条件で自動作成')}</button>
        </div>
        {showCreate && <form className="mt-3 space-y-2 rounded-xl border border-white/10 p-3" onSubmit={event => { event.preventDefault(); submitPlaylist(); }}>
          <label className="block text-xs text-neutral-300">{t('プレイリスト名')}<input className="playlist-field mt-1 w-full text-sm" placeholder={t('新しいプレイリスト')} value={newPlaylistName} onChange={event => setNewPlaylistName(event.target.value)} autoFocus /></label>
          <p className="text-xs leading-5 text-neutral-500">{t('空のリストを作成します。曲は検索画面などの保存ボタンから追加できます。')}</p>
          <button type="submit" disabled={!newPlaylistName.trim()} className="btn-primary flex min-h-11 w-full items-center justify-center text-xs" aria-label={t('プレイリストを作成')}>{t('作成')}</button>
        </form>}
        <PlaylistPopoverMenu align="left" trigger={<button type="button" className="mt-2 flex min-h-11 w-full items-center justify-between rounded-xl border border-white/10 px-3 text-xs text-neutral-200 hover:bg-white/5"><span>{t('外部から読み込む')}</span><span aria-hidden="true">↓</span></button>}>
          <button className="context-menu-item" onClick={onOpenNicoImport}>{t('ニコニコからインポート')}</button>
          <button className="context-menu-item" onClick={onOpenYouTubeImport}>{t('YouTubeからインポート')}</button>
          <button className="context-menu-item" onClick={() => importInputRef.current?.click()}>{t('JSONを読み込む')}</button>
        </PlaylistPopoverMenu>
        {showFolderInput && <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); submitFolder(); }}>
          <input className="playlist-field min-w-0 flex-1 text-sm" placeholder={t('フォルダー名')} aria-label={t('フォルダー名')} value={newFolderName} onChange={event => setNewFolderName(event.target.value)} autoFocus />
          <button type="submit" className="btn-secondary min-h-11 text-xs" disabled={!newFolderName.trim()}>{t('作成')}</button>
          <button type="button" onClick={() => setShowFolderInput(false)} aria-label={t('キャンセル')} className="px-2 text-neutral-400">×</button>
        </form>}
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <input type="search" placeholder={t('ライブラリを検索')} aria-label={t('ライブラリを検索')} value={query} onChange={event => setQuery(event.target.value)} className="playlist-field min-h-11 w-full text-sm" />
        <div className="flex gap-1 rounded-xl bg-black/20 p-1" aria-label={t('プレイリスト種別')}>
          {([['all', t('すべて')], ['smart', t('スマート')], ['synced', t('同期中')]] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setLibraryScope(value)} aria-pressed={libraryScope === value} className={`min-h-11 flex-1 rounded-lg px-2 text-xs ${libraryScope === value ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'}`}>{label}</button>)}
        </div>
        <details className="rounded-xl border border-white/[0.07] p-3">
          <summary className="cursor-pointer text-xs text-neutral-400">{t('フォルダー・表示設定')}{folderScope === 'folder' && ` · ${folders.find(folder => folder.id === selectedFolderId)?.name ?? t('フォルダーなし')}`}</summary>
          <div className="mt-3 space-y-2">
            <button type="button" onClick={() => chooseFolder(null, true)} aria-pressed={folderScope === 'all'} className="min-h-11 w-full rounded-lg px-2 text-left text-xs text-neutral-200 hover:bg-white/5">{t('すべてのフォルダー')}</button>
            <button type="button" onClick={() => chooseFolder(null)} aria-pressed={folderScope === 'folder' && !selectedFolderId} className="min-h-11 w-full rounded-lg px-2 text-left text-xs text-neutral-400 hover:bg-white/5">{t('フォルダーなし')}</button>
            {folders.map(folder => <FolderRow key={folder.id} folder={folder} selected={folderScope === 'folder' && selectedFolderId === folder.id} onSelect={() => chooseFolder(folder.id)} onDelete={() => onDeleteFolder(folder.id)} />)}
            <div className="flex gap-2 border-t border-white/10 pt-3">
              <select className="playlist-field min-w-0 flex-1 text-xs" value={preferences.sortKey} onChange={event => setPreferences(current => ({ ...current, sortKey: event.target.value as PlaylistListSortKey }))} aria-label={t('プレイリストの並べ替え')}>
                <option value="updatedAt">{t('更新順')}</option><option value="name">{t('名前順')}</option><option value="songCount">{t('曲数順')}</option>
              </select>
              <button type="button" className="h-11 w-11 rounded-lg border border-white/10" aria-label={t('並び順を反転')} onClick={() => setPreferences(current => ({ ...current, sortOrder: current.sortOrder === 'desc' ? 'asc' : 'desc' }))}>{preferences.sortOrder === 'desc' ? '↓' : '↑'}</button>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-xs text-neutral-400"><input type="checkbox" checked={preferences.density === 'compact'} onChange={event => setPreferences(current => ({ ...current, density: event.target.checked ? 'compact' : 'comfortable' }))} />{t('コンパクト表示')}</label>
          </div>
        </details>
        {pinned.length > 0 && libraryScope === 'all' && folderScope === 'all' && <section className="space-y-1"><h3 className="mb-2 text-xs text-neutral-500">{t('ピン留め')}</h3>{pinned.map(playlist => <PlaylistLibraryItem key={playlist.id} playlist={playlist} selected={selectedPlaylistId === playlist.id} compact={preferences.density === 'compact'} onSelect={() => onSelectPlaylist(playlist.id)} />)}</section>}
        <section className="space-y-1">
          <h3 className="mb-2 flex justify-between text-xs text-neutral-500"><span>{t('プレイリスト')}</span><span>{visiblePlaylists.length}</span></h3>
          {visiblePlaylists.map(playlist => <PlaylistLibraryItem key={playlist.id} playlist={playlist} selected={selectedPlaylistId === playlist.id} compact={preferences.density === 'compact'} onSelect={() => onSelectPlaylist(playlist.id)} />)}
          {visiblePlaylists.length === 0 && <div className="rounded-xl border border-dashed border-white/10 p-5 text-sm leading-6 text-neutral-400">{regularPlaylists.length === 0 ? t('まだプレイリストはありません。新規作成・外部読み込み・条件で自動作成から始められます。') : t('該当するプレイリストはありません')}<button type="button" className="mt-3 block min-h-11 text-xs text-cyan-300" onClick={() => { setQuery(''); setLibraryScope('all'); chooseFolder(null, true); }}>{t('表示条件をリセット')}</button></div>}
        </section>
      </div>
      <input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void onImportJson(file); event.currentTarget.value = ''; }} />
    </aside>
  );
}
