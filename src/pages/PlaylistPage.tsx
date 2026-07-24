/**
 * PlaylistPage – プレイリスト管理ページ
 *
 * UI改善版:
 * - サイドバーの情報整理（⋯メニューにスマート作成・インポート・エクスポートを格納）
 * - 右パネルヘッダーのアクションボタン整理（テキスト付き + ⋯メニュー）
 * - 統一トースト通知
 * - フォルダフィルターの「フォルダなし」→「未分類」
 * - 空状態UI改善
 * - モバイル遷移アニメーション
 * - シャッフル再生ボタン
 */
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { usePlaylistStore, type SortKey } from '../stores/playlistStore';
import { usePlayerStore } from '../stores/playerStore';
import { useUiStore } from '../stores/uiStore';
import type { Playlist, PlaylistFolder, Song } from '../types/vocadb';
import {
  createAllPlaylistsBackupPayload,
  createPlaylistExportPayload,
  downloadJson,
  formatTotalDuration,
  parsePlaylistBackup,
  parsePlaylistImport,
  toSafeFileName,
} from '../utils/playlistBackup';
import YouTubeImportModal from '../components/playlist/YouTubeImportModal';
import { createPlaylistShareUrl, decodePlaylistShare } from '../utils/playlistShare';
import { searchSmartPlaylistSongs } from '../api/vocadb';
import { filterSmartPlaylistSongs } from '../utils/smartPlaylist';
import { sortPlaylistSongs } from '../utils/playlistSorting';
import { storage } from '../utils/storage';
import {
  DEFAULT_PLAYLIST_LIST_PREFERENCES,
  normalizePlaylistListPreferences,
  sortPlaylistsForDisplay,
  type PlaylistListDensity,
  type PlaylistListSortKey,
} from '../utils/playlistListPreferences';
import PlaylistCover from '../components/playlist/PlaylistCover';
import {
  SortableSongRow,
  PlainSongRow,
  VirtualSongList,
  VIRTUAL_THRESHOLD,
} from '../components/playlist/PlaylistSongRow';
import PlaylistToast from '../components/playlist/PlaylistToast';
import { usePlaylistToast } from '../hooks/usePlaylistToast';
import SmartPlaylistBuilder, {
  SmartPlaylistRuleSummary,
  type SmartPlaylistBuilderValues,
} from '../components/playlist/SmartPlaylistBuilder';

const PLAYLIST_LIST_PREFERENCES_KEY = 'playlistListPreferences';

// ─── FolderItem ─────────────────────────────────────────────────────────────
function FolderItem({
  folder, depth, selectedFolderId, onSelect, onDelete,
}: {
  folder: PlaylistFolder;
  depth: number;
  selectedFolderId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
}) {
  const isSelected = selectedFolderId === folder.id;
  return (
    <button
      onClick={() => onSelect(isSelected ? null : folder.id)}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-left group"
      style={{
        paddingLeft: `${(depth + 1) * 12}px`,
        background: isSelected ? 'var(--color-bg-hover)' : 'transparent',
        color: 'var(--color-text-secondary)',
      }}
    >
      {isSelected && <span className="absolute left-0 h-5 w-[3px] rounded-r-full bg-emerald-400" />}
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <span className="flex-1 truncate">{folder.name}</span>
      <span
        onClick={e => { e.stopPropagation(); onDelete(folder.id); }}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-red-400 transition-colors"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </span>
    </button>
  );
}

// ─── ポップオーバーメニュー ──────────────────────────────────────────────────
function PopoverMenu({ trigger, children, align = 'right' }: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen(v => !v)}>{trigger}</div>
      {open && (
        <div
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full mt-1 z-50 rounded-xl overflow-hidden shadow-xl min-w-[200px]`}
          style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ─── メインコンポーネント ──────────────────────────────────────────────────────
export default function PlaylistPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    playlists, folders,
    loadPlaylists,
    createPlaylist, deletePlaylist, restoreDeletedPlaylist, updatePlaylist,
    createSmartPlaylist, replacePlaylistSongs,
    createFolder, deleteFolder,
    addSongs, removeSong, removeSongs, restoreRemovedSongs, reorderSongs, removeDuplicateSongsWithUndo,
  } = usePlaylistStore();
  const { setQueue, setQueueShuffled, addToQueue } = usePlayerStore();
  const openSaveToPlaylist = useUiStore(s => s.openSaveToPlaylist);

  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId]     = useState<string | null>(null);
  const [showAllFolders, setShowAllFolders] = useState(true);
  const [playlistListPreferences, setPlaylistListPreferences] = useState(() => normalizePlaylistListPreferences(
    storage.get(PLAYLIST_LIST_PREFERENCES_KEY) ?? DEFAULT_PLAYLIST_LIST_PREFERENCES,
  ));
  const importInputRef = useRef<HTMLInputElement>(null);
  const [newName, setNewName]                       = useState('');
  const [newFolderName, setNewFolderName]           = useState('');
  const [showFolderInput, setShowFolderInput]       = useState(false);
  const [playlistFilterText, setPlaylistFilterText] = useState('');

  const [filterText, setFilterText]     = useState('');
  const [songSortKey, setSongSortKey] = useState<SortKey>('addedOrder');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds]   = useState<Set<number>>(new Set());

  const [editingPlaylist, setEditingPlaylist] = useState<Playlist | null>(null);
  const [editName, setEditName]   = useState('');
  const [editDesc, setEditDesc]   = useState('');
  const [editCover, setEditCover] = useState('');
  const [editFolderId, setEditFolderId] = useState<string>('');

  const [showYTImport, setShowYTImport] = useState(false);
  const [showSmartBuilder, setShowSmartBuilder] = useState(false);
  const [smartEditingPlaylist, setSmartEditingPlaylist] = useState<Playlist | null>(null);
  const [smartRefreshStatuses, setSmartRefreshStatuses] = useState<Record<string, {
    state: 'loading' | 'success' | 'empty' | 'error';
    refreshedAt?: number;
    matchedCount?: number;
  }>>({});
  const smartRefreshRef = useRef<string | null>(null);
  const smartRefreshRetryRef = useRef(new Set<string>());
  const smartRefreshRetryTimerRef = useRef<number | null>(null);
  const [smartRefreshRetryTick, setSmartRefreshRetryTick] = useState(0);

  // 統一トースト
  const { toasts, showToast, dismissToast } = usePlaylistToast();

  useEffect(() => { loadPlaylists(); }, [loadPlaylists]);

  useEffect(() => {
    storage.set(PLAYLIST_LIST_PREFERENCES_KEY, playlistListPreferences);
  }, [playlistListPreferences]);

  useEffect(() => {
    const encoded = searchParams.get('share');
    if (!encoded) return;
    const payload = decodePlaylistShare(encoded);
    if (!payload) {
      showToast('共有リンクを読み込めませんでした。', 'warning');
      navigate('/playlists', { replace: true });
      return;
    }
    const imported = createPlaylist(`${payload.name} (共有)`, selectedFolderId ?? undefined);
    updatePlaylist(imported.id, { description: payload.description, coverArtUrl: payload.coverArtUrl });
    addSongs(imported.id, payload.songs);
    setSelectedPlaylistId(imported.id);
    showToast(`${payload.name} を共有リンクから追加しました。`, 'info');
    navigate('/playlists', { replace: true });
  }, [addSongs, createPlaylist, navigate, searchParams, selectedFolderId, showToast, updatePlaylist]);

  useEffect(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setFilterText('');
    setSongSortKey('addedOrder');
    smartRefreshRef.current = null;
    smartRefreshRetryRef.current.clear();
    if (smartRefreshRetryTimerRef.current !== null) {
      window.clearTimeout(smartRefreshRetryTimerRef.current);
      smartRefreshRetryTimerRef.current = null;
    }
  }, [selectedPlaylistId]);

  const selectedPlaylist = playlists.find(p => p.id === selectedPlaylistId) ?? null;

  const refreshSmartPlaylist = useCallback(async (playlist: Playlist) => {
    if (!playlist.smartRule) return;
    setSmartRefreshStatuses(current => ({
      ...current,
      [playlist.id]: { state: 'loading' },
    }));
    try {
      const rule = playlist.smartRule;
      const result = await searchSmartPlaylistSongs(rule, 200);
      const matchingSongs = filterSmartPlaylistSongs(result.items, rule);
      replacePlaylistSongs(playlist.id, matchingSongs);
      smartRefreshRetryRef.current.delete(playlist.id);
      setSmartRefreshStatuses(current => ({
        ...current,
        [playlist.id]: {
          state: matchingSongs.length > 0 ? 'success' : 'empty',
          refreshedAt: Date.now(),
          matchedCount: matchingSongs.length,
        },
      }));
    } catch (error) {
      smartRefreshRef.current = null;
      setSmartRefreshStatuses(current => ({
        ...current,
        [playlist.id]: { state: 'error' },
      }));
      if (!smartRefreshRetryRef.current.has(playlist.id)) {
        smartRefreshRetryRef.current.add(playlist.id);
        smartRefreshRetryTimerRef.current = window.setTimeout(() => {
          smartRefreshRetryTimerRef.current = null;
          setSmartRefreshRetryTick(current => current + 1);
        }, 5000);
      }
      throw error;
    }
  }, [replacePlaylistSongs]);

  useEffect(() => {
    if (!selectedPlaylist?.smartRule || smartRefreshRef.current === selectedPlaylist.id) return;
    smartRefreshRef.current = selectedPlaylist.id;
    void refreshSmartPlaylist(selectedPlaylist).catch(() => undefined);
    return () => {
      if (smartRefreshRetryTimerRef.current !== null) {
        window.clearTimeout(smartRefreshRetryTimerRef.current);
        smartRefreshRetryTimerRef.current = null;
      }
    };
  }, [refreshSmartPlaylist, selectedPlaylist, smartRefreshRetryTick]);

  const selectedPlaylistDuplicateCount = selectedPlaylist
    ? selectedPlaylist.songs.length - new Set(selectedPlaylist.songs.map(s => s.id)).size
    : 0;
  const selectedPlaylistDurationText = selectedPlaylist
    ? formatTotalDuration(selectedPlaylist.songs.reduce((sum, song) => sum + (song.lengthSeconds || 0), 0))
    : '';
  const selectedSmartRefreshStatus = selectedPlaylist
    ? smartRefreshStatuses[selectedPlaylist.id]
    : undefined;
  const pinnedPlaylists = playlists.filter(p => p.isPinned);
  const folderScopedPlaylists = showAllFolders
    ? playlists.filter(p => !p.isPinned)
    : selectedFolderId
      ? playlists.filter(p => !p.isPinned && p.folderId === selectedFolderId)
      : playlists.filter(p => !p.isPinned && !p.folderId);
  const filteredSidebarPlaylists = sortPlaylistsForDisplay(folderScopedPlaylists, playlistListPreferences.sortKey, playlistListPreferences.sortOrder).filter(p => {
    const q = playlistFilterText.trim().toLowerCase();
    if (!q) return true;
    return p.name.toLowerCase().includes(q);
  });
  const smartSidebarPlaylists = filteredSidebarPlaylists.filter(playlist => Boolean(playlist.smartRule));
  const regularSidebarPlaylists = filteredSidebarPlaylists.filter(playlist => !playlist.smartRule);

  const filteredSongs = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const songs = (selectedPlaylist?.songs ?? []).filter(song => !q
      || song.name.toLowerCase().includes(q)
      || (song.artistString ?? '').toLowerCase().includes(q));
    return sortPlaylistSongs(songs, songSortKey);
  }, [filterText, selectedPlaylist, songSortKey]);

  const handleCreate = useCallback(() => {
    if (!newName.trim()) return;
    const p = createPlaylist(newName.trim(), selectedFolderId ?? undefined);
    setNewName('');
    setSelectedPlaylistId(p.id);
  }, [newName, selectedFolderId, createPlaylist]);

  const openSmartBuilder = useCallback((playlist?: Playlist) => {
    setSmartEditingPlaylist(playlist ?? null);
    setShowSmartBuilder(true);
  }, []);

  const closeSmartBuilder = useCallback(() => {
    setShowSmartBuilder(false);
    setSmartEditingPlaylist(null);
  }, []);

  const handleSmartSubmit = useCallback(({ name, rule }: SmartPlaylistBuilderValues) => {
    if (smartEditingPlaylist) {
      updatePlaylist(smartEditingPlaylist.id, { name, smartRule: rule });
      smartRefreshRef.current = null;
      setSmartRefreshStatuses(current => ({ ...current, [smartEditingPlaylist.id]: { state: 'loading' } }));
      showToast('スマートプレイリストの条件を更新しました', 'success');
    } else {
      const playlist = createSmartPlaylist(name, rule, selectedFolderId ?? undefined);
      setSelectedPlaylistId(playlist.id);
      showToast('スマートプレイリストを作成しました', 'success');
    }
    closeSmartBuilder();
  }, [closeSmartBuilder, createSmartPlaylist, selectedFolderId, showToast, smartEditingPlaylist, updatePlaylist]);

  const handleCreateFolder = useCallback(() => {
    if (!newFolderName.trim()) return;
    createFolder(newFolderName.trim());
    setNewFolderName('');
    setShowFolderInput(false);
  }, [newFolderName, createFolder]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    if (!selectedPlaylist) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const songs = selectedPlaylist.songs;
    const readDisplayedIndex = (id: string | number) => Number(String(id).split('-').at(-1));
    const activeSong = filteredSongs[readDisplayedIndex(active.id)];
    const overSong = filteredSongs[readDisplayedIndex(over.id)];
    const fromIndex = activeSong ? songs.findIndex(s => s.id === activeSong.id) : -1;
    const toIndex = overSong ? songs.findIndex(s => s.id === overSong.id) : -1;
    if (fromIndex !== -1 && toIndex !== -1) reorderSongs(selectedPlaylist.id, fromIndex, toIndex);
  }, [filteredSongs, selectedPlaylist, reorderSongs]);

  const toggleSelect = useCallback((songId: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(songId)) {
        next.delete(songId);
      } else {
        next.add(songId);
      }
      return next;
    });
  }, []);

  const selectAll    = useCallback(() => setSelectedIds(new Set(filteredSongs.map(s => s.id))), [filteredSongs]);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const deleteSelected = useCallback(() => {
    if (!selectedPlaylist) return;
    const songs = selectedPlaylist.songs;
    const indexes = songs.flatMap((song, index) => selectedIds.has(song.id) ? [index] : []);
    const snapshot = removeSongs(selectedPlaylist.id, indexes);
    setSelectedIds(new Set());
    setSelectionMode(false);
    if (snapshot) {
      showToast(`${snapshot.removed.length} 曲を削除しました`, 'info', {
        label: '元に戻す',
        onAction: () => {
          const restored = restoreRemovedSongs(snapshot);
          if (restored > 0) showToast(`${restored} 曲を元に戻しました`, 'success');
        },
      });
    }
  }, [selectedPlaylist, selectedIds, removeSongs, restoreRemovedSongs, showToast]);

  const removeDuplicatesFromSelectedPlaylist = useCallback(() => {
    if (!selectedPlaylist) return;
    const snapshot = removeDuplicateSongsWithUndo(selectedPlaylist.id);
    if (snapshot) {
      const count = snapshot.removed.length;
      setSelectedIds(new Set());
      setSelectionMode(false);
      showToast(`${count} 曲の重複を削除しました`, 'success', {
        label: '元に戻す',
        onAction: () => {
          const restored = restoreRemovedSongs(snapshot, { allowDuplicateIds: true });
          if (restored > 0) showToast(`${restored} 曲を元に戻しました`, 'success');
        },
      });
    }
  }, [selectedPlaylist, removeDuplicateSongsWithUndo, restoreRemovedSongs, showToast]);

  const removeSongWithUndo = useCallback((playlistId: string, songIndex: number) => {
    const snapshot = removeSong(playlistId, songIndex);
    if (!snapshot) return;
    const title = snapshot.removed[0]?.song.name;
    showToast(title ? `「${title}」を削除しました` : '曲を削除しました', 'info', {
      label: '元に戻す',
      onAction: () => {
        const restored = restoreRemovedSongs(snapshot);
        if (restored > 0) showToast(`${restored} 曲を元に戻しました`, 'success');
      },
    });
  }, [removeSong, restoreRemovedSongs, showToast]);

  const addSelectedToQueue = useCallback(() => {
    if (!selectedPlaylist) return;
    selectedPlaylist.songs.filter(s => selectedIds.has(s.id)).forEach(s => addToQueue(s));
    setSelectedIds(new Set());
    setSelectionMode(false);
  }, [selectedPlaylist, selectedIds, addToQueue]);

  const copySelectedToPlaylist = useCallback(() => {
    if (!selectedPlaylist) return;
    const songs = selectedPlaylist.songs.filter(s => selectedIds.has(s.id));
    if (songs.length === 0) return;
    openSaveToPlaylist(songs);
    setSelectedIds(new Set());
    setSelectionMode(false);
  }, [selectedPlaylist, selectedIds, openSaveToPlaylist]);

  const handleYTImport = useCallback((songs: Song[]) => {
    if (!selectedPlaylist) return;
    const result = addSongs(selectedPlaylist.id, songs);
    if (result.duplicates > 0) {
      showToast(`${result.duplicates} 曲は既にプレイリストにあるためスキップしました`, 'warning');
    }
  }, [selectedPlaylist, addSongs, showToast]);

  const handleSetCover   = useCallback((song: Song) => {
    if (!selectedPlaylist) return;
    updatePlaylist(selectedPlaylist.id, { coverArtUrl: song.thumbUrl });
  }, [selectedPlaylist, updatePlaylist]);

  const moveToTop    = useCallback((idx: number) => {
    if (selectedPlaylist) reorderSongs(selectedPlaylist.id, idx, 0);
  }, [selectedPlaylist, reorderSongs]);

  const moveToBottom = useCallback((idx: number) => {
    if (selectedPlaylist) reorderSongs(selectedPlaylist.id, idx, selectedPlaylist.songs.length - 1);
  }, [selectedPlaylist, reorderSongs]);

  const openEdit = useCallback((p: Playlist) => {
    setEditingPlaylist(p);
    setEditName(p.name);
    setEditDesc(p.description ?? '');
    setEditCover(p.coverArtUrl ?? '');
    setEditFolderId(p.folderId ?? '');
  }, []);

  const saveEdit = useCallback(() => {
    if (!editingPlaylist) return;
    updatePlaylist(editingPlaylist.id, {
      name: editName.trim() || editingPlaylist.name,
      description: editDesc.trim() || undefined,
      coverArtUrl: editCover.trim() || undefined,
      folderId: editFolderId || undefined,
    });
    setEditingPlaylist(null);
  }, [editingPlaylist, editName, editDesc, editCover, editFolderId, updatePlaylist]);

  const exportPlaylist = useCallback((playlist: Playlist) => {
    const exportedAt = new Date().toISOString();
    downloadJson(`${toSafeFileName(playlist.name)}.diva-playlist.json`, createPlaylistExportPayload(playlist, exportedAt));
  }, []);

  const sharePlaylist = useCallback(async (playlist: Playlist) => {
    const url = createPlaylistShareUrl(playlist);
    try {
      await navigator.clipboard.writeText(url);
      showToast('共有リンクをクリップボードにコピーしました', 'info');
    } catch {
      showToast(`共有リンク: ${url}`, 'info');
    }
  }, [showToast]);

  const exportAllPlaylists = useCallback(() => {
    const exportedAt = new Date().toISOString();
    downloadJson(`diva-playlists-backup-${exportedAt.slice(0, 10)}.json`, createAllPlaylistsBackupPayload(folders, playlists, exportedAt));
  }, [folders, playlists]);

  const importPlaylistJson = useCallback(async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const backup = parsePlaylistBackup(data);
      if (backup) {
        const folderIdMap = new Map<string, string>();
        const pendingFolders = [...backup.folders];

        while (pendingFolders.length > 0) {
          const folder = pendingFolders.shift();
          if (!folder) break;
          const parentReady = !folder.parentId || folderIdMap.has(folder.parentId);
          if (!parentReady && pendingFolders.length > 0) {
            pendingFolders.push(folder);
            continue;
          }
          const created = createFolder(folder.name, folder.parentId ? folderIdMap.get(folder.parentId) : undefined);
          folderIdMap.set(folder.id, created.id);
        }

        let addedSongs = 0;
        backup.playlists.forEach(item => {
          const playlist = createPlaylist(`${item.name} (import)`, item.folderId ? folderIdMap.get(item.folderId) : selectedFolderId ?? undefined);
          updatePlaylist(playlist.id, {
            description: item.description,
            coverArtUrl: item.coverArtUrl,
            smartRule: item.smartRule,
          });
          addedSongs += addSongs(playlist.id, item.songs).added;
        });

        showToast(`プレイリストバックアップをインポートしました (${addedSongs} 曲)`, 'success');
        return;
      }

      const parsed = parsePlaylistImport(data);
      if (!parsed) throw new Error('Invalid playlist JSON');

      const playlist = createPlaylist(`${parsed.name} (import)`, selectedFolderId ?? undefined);
      updatePlaylist(playlist.id, {
        description: parsed.description,
        coverArtUrl: parsed.coverArtUrl,
      });
      const result = addSongs(playlist.id, parsed.songs);
      setSelectedPlaylistId(playlist.id);
      showToast(`「${playlist.name}」をインポートしました (${result.added} 曲)`, 'success');
    } catch {
      window.alert('プレイリストJSONを読み込めませんでした。DIVA PlayerからエクスポートしたJSONを選択してください。');
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
    }
  }, [addSongs, createFolder, createPlaylist, selectedFolderId, showToast, updatePlaylist]);

  const handleDelete = useCallback((p: Playlist) => {
    if (p.isPinned) return;
    if (!window.confirm(`「${p.name}」を削除してもよいですか？`)) return;
    const snapshot = deletePlaylist(p.id);
    setSelectedPlaylistId(null);
    if (snapshot) {
      showToast(`「${p.name}」を削除しました`, 'info', {
        label: '元に戻す',
        onAction: () => {
          if (restoreDeletedPlaylist(snapshot)) {
            setSelectedPlaylistId(snapshot.playlist.id);
            showToast(`「${snapshot.playlist.name}」を元に戻しました`, 'success');
          }
        },
      });
    }
  }, [deletePlaylist, restoreDeletedPlaylist, showToast]);

  const handleShufflePlay = useCallback(() => {
    if (!selectedPlaylist || selectedPlaylist.songs.length === 0) return;
    setQueueShuffled(selectedPlaylist.songs);
  }, [selectedPlaylist, setQueueShuffled]);

  // サイドバープレイリスト行
  const SidebarItem = ({ p }: { p: Playlist }) => {
    const compact = playlistListPreferences.density === 'compact';
    return (
    <button
      onClick={() => setSelectedPlaylistId(p.id)}
      className={`group flex w-full items-center rounded-2xl border text-left transition-all duration-200 ${compact ? 'gap-2 px-2 py-1.5' : 'gap-3 px-2.5 py-2'}`}
      style={{
        background: selectedPlaylistId === p.id ? 'rgba(255,255,255,.08)' : 'transparent',
        color: 'var(--color-text-primary)',
        borderColor: selectedPlaylistId === p.id ? 'rgba(6,214,160,.28)' : p.isPinned ? 'rgba(6,214,160,.12)' : 'transparent',
      }}
    >
      <div className={`${compact ? 'h-9 w-9 rounded-lg' : 'h-12 w-12 rounded-xl'} flex-shrink-0 overflow-hidden bg-black/20 shadow-md transition-transform duration-200 group-hover:scale-[1.03]`}>
        <PlaylistCover playlist={p} />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`${compact ? 'text-xs' : 'text-sm'} truncate font-semibold`}>{p.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-neutral-500">
          <span>{p.songs.length}曲</span>
          {p.smartRule && <span className="rounded-full bg-cyan-400/10 px-1.5 py-0.5 text-cyan-300">スマート</span>}
        </p>
      </div>
      {selectedPlaylistId === p.id && <span className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-300" />}
    </button>
    );
  };

  return (
    <div
      className="flex min-h-0 flex-col gap-4 px-3 py-3 md:flex-row md:px-4 md:py-4"
      style={{
        height: 'calc(100dvh - var(--header-height))',
        paddingBottom: 'calc(var(--player-bar-height) + 24px)',
      }}
    >
      {/* ─── 統一トースト ───────────────────────────────────────────── */}
      <PlaylistToast toasts={toasts} onDismiss={dismissToast} />

      {/* ─── 左サイドバー ───────────────────────────────────────────── */}
      <aside
        className={`w-full min-h-0 flex-shrink-0 flex-col gap-3 overflow-y-auto rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3 md:h-full md:w-72 lg:w-80 ${selectedPlaylist ? 'hidden md:flex' : 'flex'}`}
      >
        {/* ── ヘッダー ── */}
        <div className="flex items-center justify-between px-1 pt-1">
          <div className="flex items-baseline gap-2">
            <h2 className="text-xl font-bold tracking-tight">プレイリスト</h2>
            <span className="text-xs text-neutral-500">{playlists.length}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowFolderInput(!showFolderInput)}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-neutral-400 transition-all hover:border-white/20 hover:bg-white/10 hover:text-white"
              title="フォルダを作成"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
              </svg>
            </button>
            <button
              type="button"
              onClick={() => openSmartBuilder()}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-violet-300/20 bg-violet-300/10 text-violet-200 transition-all hover:border-violet-200/40 hover:bg-violet-300/20 hover:text-white"
              title="スマートプレイリストを作成"
              aria-label="スマートプレイリストを作成"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
                <path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" />
              </svg>
            </button>
            {/* ⋯ その他メニュー */}
            <PopoverMenu
              trigger={
                <button
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-neutral-400 transition-all hover:border-white/20 hover:bg-white/10 hover:text-white"
                  title="その他の操作"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
                  </svg>
                </button>
              }
            >
              <button
                className="context-menu-item"
                onClick={() => importInputRef.current?.click()}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <path d="M7 10l5-5 5 5"/><path d="M12 5v12"/>
                </svg>
                <span>JSONを読み込む</span>
              </button>
              <button
                className="context-menu-item"
                onClick={exportAllPlaylists}
                disabled={playlists.length === 0}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>
                </svg>
                <span>全体をバックアップ</span>
              </button>
            </PopoverMenu>
          </div>
        </div>

        {showFolderInput && (
          <div className="flex gap-2 rounded-2xl border border-white/[0.07] bg-black/15 p-2">
            <input
              type="text" value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateFolder()}
              placeholder="フォルダ名..." className="search-input text-xs flex-1"
              style={{ paddingLeft: '0.5rem' }} autoFocus
            />
            <button className="btn-primary text-xs px-2" onClick={handleCreateFolder}>OK</button>
          </div>
        )}

        {/* ── プレイリスト検索 ── */}
        {playlists.some(p => !p.isPinned) && (
          <div className="relative">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="search"
              value={playlistFilterText}
              onChange={e => setPlaylistFilterText(e.target.value)}
              placeholder="プレイリストを検索"
              className="search-input w-full rounded-2xl py-2.5 pl-10 pr-8 text-sm"
            />
            {playlistFilterText && (
              <button
                type="button"
                onClick={() => setPlaylistFilterText('')}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded text-neutral-500 hover:text-white transition-colors"
                title="クリア"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* ── 並べ替え・密度設定（コンパクト化） ── */}
        {playlists.some(p => !p.isPinned) && (
          <div className="flex items-center gap-1.5 px-1">
            <select
              className="input min-w-0 flex-1 rounded-lg py-1 text-[11px]"
              value={playlistListPreferences.sortKey}
              onChange={event => setPlaylistListPreferences(current => ({ ...current, sortKey: event.target.value as PlaylistListSortKey }))}
            >
              <option value="updatedAt">更新順</option>
              <option value="name">名前順</option>
              <option value="songCount">曲数順</option>
            </select>
            <button
              type="button"
              className="rounded-lg border border-white/10 px-1.5 py-1 text-[11px] text-neutral-400 hover:bg-white/10 hover:text-white transition-colors"
              onClick={() => setPlaylistListPreferences(current => ({ ...current, sortOrder: current.sortOrder === 'desc' ? 'asc' : 'desc' }))}
              title="並び順を反転"
            >
              {playlistListPreferences.sortOrder === 'desc' ? '↓' : '↑'}
            </button>
            <button
              type="button"
              className="rounded-lg border border-white/10 px-1.5 py-1 text-[11px] text-neutral-400 hover:bg-white/10 hover:text-white transition-colors"
              onClick={() => setPlaylistListPreferences(current => ({ ...current, density: current.density === 'comfortable' ? 'compact' : 'comfortable' as PlaylistListDensity }))}
              title="表示密度を切り替え"
            >
              {playlistListPreferences.density === 'comfortable' ? '密' : '疎'}
            </button>
          </div>
        )}

        {/* ── ピン留め ── */}
        {pinnedPlaylists.length > 0 && (
          <section className="space-y-1">
            <p className="px-2 text-[11px] font-medium text-neutral-500">ピン留め</p>
            {pinnedPlaylists.map(p => <SidebarItem key={p.id} p={p} />)}
          </section>
        )}

        {/* ── フォルダフィルター ── */}
        <section className="rounded-2xl bg-black/10 p-1">
          <button
            onClick={() => { setShowAllFolders(true); setSelectedFolderId(null); }}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm transition-colors"
            style={{ background: showAllFolders ? 'rgba(255,255,255,.07)' : 'transparent', color: 'var(--color-text-secondary)' }}
          >
            {showAllFolders && <span className="absolute left-0 h-5 w-[3px] rounded-r-full bg-emerald-400" />}
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            </svg>
            すべて
          </button>

          <button
            onClick={() => { setShowAllFolders(false); setSelectedFolderId(null); }}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition-colors"
            style={{ background: !showAllFolders && selectedFolderId === null ? 'rgba(255,255,255,.07)' : 'transparent', color: 'var(--color-text-muted)' }}
          >
            {!showAllFolders && selectedFolderId === null && <span className="absolute left-0 h-5 w-[3px] rounded-r-full bg-emerald-400" />}
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4h16v16H4z" />
            </svg>
            未分類
          </button>

          {folders.map(f => (
            <FolderItem key={f.id} folder={f} depth={0}
              selectedFolderId={selectedFolderId}
              onSelect={id => { setShowAllFolders(false); setSelectedFolderId(id); }}
              onDelete={deleteFolder}
            />
          ))}
        </section>

        {/* ── プレイリスト ── */}
        <section className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {smartSidebarPlaylists.length > 0 && (
            <div className="space-y-1">
              <p className="flex items-center gap-1.5 px-2 text-[11px] font-medium text-violet-200/80">
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
                </svg>
                スマートプレイリスト
                <span className="text-[10px] text-neutral-500">{smartSidebarPlaylists.length}</span>
              </p>
              {smartSidebarPlaylists.map(p => <SidebarItem key={p.id} p={p} />)}
            </div>
          )}
          <div className="space-y-1">
            <p className="px-2 text-[11px] font-medium text-neutral-500">プレイリスト</p>
            {regularSidebarPlaylists.length === 0 && smartSidebarPlaylists.length === 0 ? (
              <p className="py-4 text-center text-xs text-neutral-500">プレイリストがありません</p>
            ) : regularSidebarPlaylists.map(p => <SidebarItem key={p.id} p={p} />)}
          </div>
        </section>

        {/* ── 新規作成 ── */}
        <div className="mt-auto flex gap-2 rounded-2xl border border-white/[0.07] bg-black/15 p-2">
          <input
            type="text" value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder="新しいプレイリスト" className="search-input min-w-0 flex-1 text-xs"
          />
          <button
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-white p-0 text-black transition-colors hover:bg-neutral-200"
            onClick={handleCreate}
            title="プレイリストを作成"
            aria-label="プレイリストを作成"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importPlaylistJson(file);
          }}
        />
      </aside>

      {/* ─── 右パネル ────────────────────────────────────────────────── */}
      <main className={`min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto ${selectedPlaylist ? 'block animate-slide-in-right md:animate-none' : 'hidden md:block'}`}>
        {!selectedPlaylist ? (
          /* ── 空状態 ── */
          <div className="flex h-full min-h-[360px] flex-col items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 text-center">
            <div className="relative mb-6">
              <svg className="h-16 w-16 text-neutral-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
              </svg>
              <div className="absolute -bottom-1 -right-1 rounded-full bg-emerald-500/20 p-1">
                <svg className="h-5 w-5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </div>
            </div>
            <p className="text-base font-medium text-neutral-300">プレイリストを選んで始めましょう</p>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-neutral-500">
              左のサイドバーからプレイリストを選択すると、曲の再生・編集・共有ができます
            </p>
          </div>
        ) : (
          <>
            {/* ── モバイル戻るボタン（固定） ── */}
            <button
              type="button"
              className="md:hidden sticky top-0 z-10 self-start rounded-full border border-white/10 bg-black/80 backdrop-blur-sm px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-white/10"
              onClick={() => setSelectedPlaylistId(null)}
            >
              ← ライブラリ
            </button>

            {/* ── ヘッダー ── */}
            <section className="flex-shrink-0 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="aspect-square w-28 flex-shrink-0 overflow-hidden rounded-xl bg-black/25 ring-1 ring-white/10 sm:w-32 lg:w-36">
                  <PlaylistCover playlist={selectedPlaylist} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="mb-1.5 text-xs text-neutral-500">{selectedPlaylist.smartRule ? 'スマートプレイリスト' : selectedPlaylist.isPinned ? 'ピン留め' : 'プレイリスト'}</p>
                  <h1 className="break-words text-2xl font-bold leading-tight text-white sm:text-3xl">{selectedPlaylist.name}</h1>
                    {selectedPlaylist.smartRule && (
                      <p className="mt-3 text-xs" style={{ color: 'var(--color-accent-cyan)' }}>
                        {selectedSmartRefreshStatus?.state === 'loading' && '条件を再計算中…'}
                        {selectedSmartRefreshStatus?.state === 'success' && (
                          <>
                            最終更新 {new Date(selectedSmartRefreshStatus.refreshedAt ?? Date.now()).toLocaleTimeString('ja-JP')}
                            ・条件一致 {selectedSmartRefreshStatus.matchedCount ?? selectedPlaylist.songs.length}曲
                          </>
                        )}
                        {selectedSmartRefreshStatus?.state === 'empty' && '条件に一致する曲はありません。条件を変更して再更新してください。'}
                        {selectedSmartRefreshStatus?.state === 'error' && '更新に失敗しました。手動更新してください。'}
                        {!selectedSmartRefreshStatus && '開いたときに自動更新します'}
                      </p>
                    )}
                    {selectedPlaylist.smartRule && (
                      <div className="mt-3 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.05] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-200/70">更新条件</p>
                          <button
                            type="button"
                            className="text-xs font-medium text-cyan-200 transition-colors hover:text-white"
                            onClick={() => openSmartBuilder(selectedPlaylist)}
                          >
                            条件を編集
                          </button>
                        </div>
                        <div className="mt-2">
                          <SmartPlaylistRuleSummary rule={selectedPlaylist.smartRule} />
                        </div>
                      </div>
                    )}
                    {selectedPlaylist.description && (
                      <p className="mt-3 line-clamp-2 max-w-2xl text-sm leading-6 text-neutral-300">{selectedPlaylist.description}</p>
                    )}
                    <p className="mt-3 text-sm font-medium text-neutral-400">
                      <span className="text-white">{selectedPlaylist.songs.length}曲</span>
                      {selectedPlaylist.songs.length > 0 && (
                        <span className="ml-2">• {selectedPlaylistDurationText}</span>
                      )}
                      {filterText && filteredSongs.length !== selectedPlaylist.songs.length && (
                        <span className="ml-2 text-cyan-400">（フィルター中: {filteredSongs.length} 曲）</span>
                      )}
                    </p>

                  {/* ── アクションボタン ── */}
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {selectedPlaylist.songs.length > 0 && (
                      <>
                        <button onClick={() => setQueue(selectedPlaylist.songs, 0)} className="flex h-10 items-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-black transition-colors hover:bg-neutral-200">
                          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                          再生
                        </button>
                        <button
                          onClick={handleShufflePlay}
                          className="flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 text-sm font-medium text-neutral-200 transition-colors hover:bg-white/10"
                          title="シャッフル再生"
                        >
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>
                          </svg>
                          シャッフル
                        </button>
                      </>
                    )}
                    {selectedPlaylist.smartRule && (
                      <button
                        type="button"
                        className="h-10 rounded-full border border-white/10 bg-white/[0.05] px-4 text-sm font-medium text-neutral-200 transition-colors hover:bg-white/10"
                        disabled={selectedSmartRefreshStatus?.state === 'loading'}
                        onClick={() => void refreshSmartPlaylist(selectedPlaylist).catch(() => undefined)}
                        title="スマートプレイリストを今すぐ更新"
                      >
                        {selectedSmartRefreshStatus?.state === 'loading' ? '更新中…' : '条件を再更新'}
                      </button>
                    )}

                    {/* 編集・削除（テキスト付き） */}
                    {!selectedPlaylist.isPinned && (
                      <>
                        <button
                          onClick={() => openEdit(selectedPlaylist)}
                          className="flex h-10 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
                          title="編集"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                          編集
                        </button>
                        <button
                          onClick={() => handleDelete(selectedPlaylist)}
                          className="flex h-10 items-center gap-1.5 rounded-full border border-red-400/15 bg-red-400/[0.04] px-4 text-sm transition-colors hover:bg-red-400/10"
                          title="削除"
                          style={{ color: 'var(--color-error)' }}
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                          </svg>
                          削除
                        </button>
                      </>
                    )}

                    {/* ⋯ メニュー（エクスポート・共有・YouTubeインポート） */}
                    <PopoverMenu
                      trigger={
                        <button className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-neutral-300 transition-colors hover:bg-white/10 hover:text-white" title="その他の操作">
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
                          </svg>
                        </button>
                      }
                    >
                      <button className="context-menu-item" onClick={() => setShowYTImport(true)}>
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#ff0000' }}>
                          <path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.51 3.5 12 3.5 12 3.5s-7.51 0-9.38.55A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14C4.49 20.5 12 20.5 12 20.5s7.51 0 9.38-.55a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.75 15.52V8.48L15.5 12l-5.75 3.52z"/>
                        </svg>
                        <span>YouTubeからインポート</span>
                      </button>
                      <button className="context-menu-item" onClick={() => exportPlaylist(selectedPlaylist)}>
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                          <path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>
                        </svg>
                        <span>JSONエクスポート</span>
                      </button>
                      <button className="context-menu-item" onClick={() => void sharePlaylist(selectedPlaylist)}>
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                          <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>
                        </svg>
                        <span>共有リンクをコピー</span>
                      </button>
                    </PopoverMenu>
                  </div>
                </div>
              </div>
            </section>

            {/* ── ツールバー ── */}
            {selectedPlaylist.songs.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-2">
                <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
                  <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                  </svg>
                  <input
                    type="text" value={filterText} onChange={e => setFilterText(e.target.value)}
                    placeholder="このプレイリストを検索" className="search-input w-full rounded-xl py-2 pl-9 pr-7 text-xs"
                  />
                  {filterText && (
                    <button onClick={() => setFilterText('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                  )}
                </div>

                {/* セパレーター */}
                <div className="hidden h-6 w-px bg-white/10 sm:block" />

                <span className="hidden text-xs text-neutral-500 lg:inline">並べ替え</span>
                {(['addedOrder', 'name', 'artist', 'publishDate'] as SortKey[]).map(key => (
                  <button key={key} onClick={() => setSongSortKey(key)} aria-pressed={songSortKey === key}
                    className="rounded-lg border px-2.5 py-1.5 text-xs transition-colors hover:bg-white/5"
                    style={{
                      borderColor: songSortKey === key ? 'rgba(255,255,255,.35)' : 'var(--color-border)',
                      color: songSortKey === key ? 'white' : 'var(--color-text-secondary)',
                      background: songSortKey === key ? 'rgba(255,255,255,.08)' : 'transparent',
                    }}
                  >
                    {{ addedOrder: '追加順', name: '曲名', artist: 'アーティスト', publishDate: '公開日' }[key]}
                  </button>
                ))}
                {selectedPlaylistDuplicateCount > 0 && (
                  <button
                    onClick={removeDuplicatesFromSelectedPlaylist}
                    className="text-xs px-2 py-1 rounded-lg border transition-colors hover:bg-white/5"
                    style={{ borderColor: 'rgba(251,191,36,0.45)', color: '#fbbf24' }}
                    title="同じ曲IDの2件目以降を削除"
                  >
                    重複削除 ({selectedPlaylistDuplicateCount})
                  </button>
                )}
                <div className="flex-1" />
                <button
                  onClick={() => { setSelectionMode(v => !v); clearSelection(); }}
                  className="rounded-lg border px-3 py-1.5 text-xs transition-colors flex items-center gap-1.5"
                  style={{
                    borderColor: selectionMode ? '#06b6d4' : 'var(--color-border)',
                    color: selectionMode ? '#06b6d4' : 'var(--color-text-secondary)',
                    background: selectionMode ? 'rgba(6,182,212,0.1)' : 'transparent',
                  }}
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    {selectionMode && <polyline points="9 11 12 14 22 4"/>}
                  </svg>
                  {selectionMode ? '選択解除' : '選択'}
                </button>
                {selectionMode && (
                  <button onClick={selectAll} className="rounded-lg border px-3 py-1.5 text-xs transition-colors"
                    style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
                  >すべて選択</button>
                )}
              </div>
            )}

            {/* ── 曲リスト ── */}
            {filteredSongs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-500">
                {filterText ? (
                  <>
                    <svg className="w-12 h-12 text-neutral-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                    </svg>
                    <p className="text-sm font-medium text-neutral-400">「{filterText}」に一致する曲はありません</p>
                  </>
                ) : (
                  <>
                    <div className="rounded-2xl border border-dashed border-white/10 p-6">
                      <svg className="w-12 h-12 text-neutral-600 mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                        <path d="M12 5v14m-7-7h14"/>
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-neutral-400">曲がまだありません</p>
                    <p className="text-xs max-w-xs text-center leading-relaxed">
                      検索画面から曲を追加するか、ヘッダーの「⋯」メニューからYouTubeプレイリストをインポートしてみましょう
                    </p>
                  </>
                )}
              </div>
            ) : (
              filteredSongs.length > VIRTUAL_THRESHOLD ? (
                <>
                  <p className="text-xs text-neutral-500 mb-1">
                    {filteredSongs.length} 件（表示を軽くするため仮想スクロールを使用）
                  </p>
                  <VirtualSongList
                    songs={filteredSongs}
                    playlistId={selectedPlaylist.id}
                    selectionMode={selectionMode}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    onSetCover={handleSetCover}
                    onRemoveSong={idx => removeSongWithUndo(selectedPlaylist.id, idx)}
                    onMoveTop={moveToTop}
                    onMoveBottom={moveToBottom}
                    allSongs={selectedPlaylist.songs}
                  />
                </>
              ) : songSortKey === 'addedOrder' ? (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={filteredSongs.map((song, index) => `${song.id}-${index}`)} strategy={verticalListSortingStrategy}>
                    <div className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.025]">
                      {filteredSongs.map((song, filteredIdx) => {
                        const globalIndex = selectedPlaylist.songs.findIndex(s => s.id === song.id);
                        return (
                          <SortableSongRow
                            key={`${song.id}-${filteredIdx}`}
                            id={`${song.id}-${filteredIdx}`}
                            index={filteredIdx}
                            song={song}
                            selectionMode={selectionMode}
                            selected={selectedIds.has(song.id)}
                            onToggleSelect={() => toggleSelect(song.id)}
                            onPlay={() => setQueue(filteredSongs, filteredIdx)}
                            onRemove={() => removeSongWithUndo(selectedPlaylist.id, globalIndex)}
                            onMoveTop={() => moveToTop(globalIndex)}
                            onMoveBottom={() => moveToBottom(globalIndex)}
                            onSetCover={() => handleSetCover(song)}
                          />
                        );
                      })}
                    </div>
                  </SortableContext>
                </DndContext>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.025]">
                  {filteredSongs.map((song, filteredIdx) => {
                    const globalIndex = selectedPlaylist.songs.findIndex(s => s.id === song.id);
                    return (
                      <div key={`${song.id}-${filteredIdx}`} className="h-16">
                        <PlainSongRow
                          index={filteredIdx}
                          song={song}
                          selectionMode={selectionMode}
                          selected={selectedIds.has(song.id)}
                          onToggleSelect={() => toggleSelect(song.id)}
                          onPlay={() => setQueue(filteredSongs, filteredIdx)}
                          onRemove={() => removeSongWithUndo(selectedPlaylist.id, globalIndex)}
                          onMoveTop={() => moveToTop(globalIndex)}
                          onMoveBottom={() => moveToBottom(globalIndex)}
                          onSetCover={() => handleSetCover(song)}
                        />
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </>
        )}
      </main>

      {/* ─── 一括選択フローティングバー ───────────────────────────────── */}
      {selectionMode && selectedIds.size > 0 && (
        <div
          className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-2xl shadow-2xl animate-slide-up"
          style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}
        >
          <span className="text-sm font-medium">{selectedIds.size} 件選択中</span>
          <button onClick={addSelectedToQueue} className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
            キューに追加
          </button>
          <button onClick={copySelectedToPlaylist} className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 7h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>
              <path d="M4 15H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            コピー
          </button>
          <button onClick={deleteSelected}
            className="text-xs px-3 py-1.5 rounded-xl flex items-center gap-1.5 transition-colors hover:bg-red-900/30"
            style={{ color: 'var(--color-error)', border: '1px solid var(--color-error)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
            </svg>
            削除
          </button>
          <button onClick={clearSelection} className="text-xs text-neutral-400 hover:text-white transition-colors">✕</button>
        </div>
      )}

      {/* ─── 編集モーダル ─────────────────────────────────────────────── */}
      {editingPlaylist && !editingPlaylist.isPinned && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={e => e.target === e.currentTarget && setEditingPlaylist(null)}
        >
          <div className="rounded-2xl p-6 w-full max-w-md flex flex-col gap-4 animate-slide-up"
               style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}>
            <h2 className="text-lg font-bold">プレイリストを編集</h2>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-neutral-400">名前</span>
              <input className="search-input text-sm" style={{ paddingLeft: '0.75rem' }}
                value={editName} onChange={e => setEditName(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-neutral-400">説明</span>
              <textarea className="search-input text-sm resize-none" style={{ paddingLeft: '0.75rem', height: '80px' }}
                value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="プレイリストの説明..." />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-neutral-400">カバーアート URL</span>
              <input className="search-input text-sm" style={{ paddingLeft: '0.75rem' }}
                value={editCover} onChange={e => setEditCover(e.target.value)} placeholder="https://..." />
              {editCover && <img src={editCover} alt="" className="mt-1 w-16 h-16 rounded object-cover" />}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-neutral-400">フォルダ</span>
              <select className="search-input text-sm" style={{ paddingLeft: '0.75rem' }}
                value={editFolderId} onChange={e => setEditFolderId(e.target.value)}>
                <option value="">なし（ルート）</option>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
            <div className="flex gap-3 justify-end">
              <button className="btn-secondary text-sm" onClick={() => setEditingPlaylist(null)}>キャンセル</button>
              <button className="btn-primary text-sm" onClick={saveEdit}>保存</button>
            </div>
          </div>
        </div>
      )}

      {showSmartBuilder && (
        <SmartPlaylistBuilder
          mode={smartEditingPlaylist ? 'edit' : 'create'}
          initialName={smartEditingPlaylist?.name}
          initialRule={smartEditingPlaylist?.smartRule}
          onClose={closeSmartBuilder}
          onSubmit={handleSmartSubmit}
        />
      )}

      {/* ─── YouTube インポートモーダル ──────────────────────────────── */}
      {showYTImport && selectedPlaylist && (
        <YouTubeImportModal onClose={() => setShowYTImport(false)} onImport={handleYTImport} />
      )}
    </div>
  );
}
