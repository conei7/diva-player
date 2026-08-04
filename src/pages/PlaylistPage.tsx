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
import { useNavigate, useSearchParams } from 'react-router';
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
import type { Playlist, Song } from '../types/vocadb';
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
import NicoImportModal from '../components/playlist/NicoImportModal';
import { createPlaylistShareUrl, decodePlaylistShare } from '../utils/playlistShare';
import { searchSmartPlaylistSongs } from '../api/vocadb';
import { filterSmartPlaylistSongs, normalizeSmartPlaylistRule } from '../utils/smartPlaylist';
import { sortPlaylistSongs } from '../utils/playlistSorting';
import {
  SortableSongRow,
  PlainSongRow,
  VirtualSongList,
  VIRTUAL_THRESHOLD,
} from '../components/playlist/PlaylistSongRow';
import PlaylistToast from '../components/playlist/PlaylistToast';
import { usePlaylistToast } from '../hooks/usePlaylistToast';
import SmartPlaylistBuilder, {
  type SmartPlaylistBuilderValues,
} from '../components/playlist/SmartPlaylistBuilder';
import PlaylistHealthModal from '../components/playlist/PlaylistHealthModal';
import { analyzePlaylistHealth } from '../utils/playlistHealth';
import { normalizeYouTubePlaylistUrl, type YouTubePlaylistSongsResponse } from '../api/youtubePlaylist';
import { syncYouTubePlaylist } from '../services/youtubePlaylistSync';
import { normalizeNicoPlaylistUrl, type NicoPlaylistSongsResponse } from '../api/nicoPlaylist';
import { syncNicoPlaylist } from '../services/nicoPlaylistSync';
import PlaylistLibrarySidebar from '../components/playlist/PlaylistLibrarySidebar';
import PlaylistHero from '../components/playlist/PlaylistHero';
import PlaylistToolbar from '../components/playlist/PlaylistToolbar';

// ─── メインコンポーネント ──────────────────────────────────────────────────────
export default function PlaylistPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    playlists, folders,
    loadPlaylists,
    createPlaylist, deletePlaylist, restoreDeletedPlaylist, updatePlaylist,
    createSmartPlaylist, createYouTubeLinkedPlaylist, unlinkYouTubeSync,
    createNicoLinkedPlaylist, unlinkNicoSync, replacePlaylistSongs,
    createFolder, deleteFolder,
    addSongs, removeSong, removeSongs, restoreRemovedSongs, reorderSongs, removeDuplicateSongsWithUndo,
  } = usePlaylistStore();
  const { setQueue, setQueueShuffled, addToQueue } = usePlayerStore();
  const openSaveToPlaylist = useUiStore(s => s.openSaveToPlaylist);

  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId]     = useState<string | null>(null);

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
  const [showNicoImport, setShowNicoImport] = useState(false);
  const [showHealthModal, setShowHealthModal] = useState(false);
  const [showSmartBuilder, setShowSmartBuilder] = useState(false);
  const [smartEditingPlaylist, setSmartEditingPlaylist] = useState<Playlist | null>(null);
  const [smartRefreshStatuses, setSmartRefreshStatuses] = useState<Record<string, {
    state: 'loading' | 'success' | 'empty' | 'error';
    refreshedAt?: number;
    matchedCount?: number;
    loadedCount?: number;
  }>>({});
  const smartRefreshRef = useRef<string | null>(null);
  const smartRefreshRetryRef = useRef(new Set<string>());
  const smartRefreshRetryTimerRef = useRef<number | null>(null);
  const [smartRefreshRetryTick, setSmartRefreshRetryTick] = useState(0);

  // 統一トースト
  const { toasts, showToast, dismissToast } = usePlaylistToast();

  useEffect(() => { loadPlaylists(); }, [loadPlaylists]);

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
  const isYouTubeLinked = selectedPlaylist?.youtubeSync?.enabled === true;
  const isNicoLinked = selectedPlaylist?.nicoSync?.enabled === true;
  const isExternalLinked = isYouTubeLinked || isNicoLinked;

  const refreshSmartPlaylist = useCallback(async (playlist: Playlist) => {
    if (!playlist.smartRule) return;
    setSmartRefreshStatuses(current => ({
      ...current,
      [playlist.id]: { state: 'loading' },
    }));
    try {
      const rule = normalizeSmartPlaylistRule(playlist.smartRule);
      const result = await searchSmartPlaylistSongs(rule, rule.maxSongs);
      const matchingSongs = filterSmartPlaylistSongs(result.items, rule);
      replacePlaylistSongs(playlist.id, matchingSongs);
      smartRefreshRetryRef.current.delete(playlist.id);
      setSmartRefreshStatuses(current => ({
        ...current,
        [playlist.id]: {
          state: matchingSongs.length > 0 ? 'success' : 'empty',
          refreshedAt: Date.now(),
          matchedCount: result.totalCount,
          loadedCount: matchingSongs.length,
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
  const selectedPlaylistHealth = useMemo(
    () => analyzePlaylistHealth(selectedPlaylist?.songs ?? []),
    [selectedPlaylist],
  );
  const selectedPlaylistDurationText = selectedPlaylist
    ? formatTotalDuration(selectedPlaylist.songs.reduce((sum, song) => sum + (song.lengthSeconds || 0), 0))
    : '';
  const selectedSmartRefreshStatus = selectedPlaylist
    ? smartRefreshStatuses[selectedPlaylist.id]
    : undefined;

  const filteredSongs = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const songs = (selectedPlaylist?.songs ?? []).filter(song => !q
      || song.name.toLowerCase().includes(q)
      || (song.artistString ?? '').toLowerCase().includes(q));
    return sortPlaylistSongs(songs, songSortKey);
  }, [filterText, selectedPlaylist, songSortKey]);

  const handleCreate = useCallback((name: string, folderId?: string) => {
    const p = createPlaylist(name, folderId);
    setSelectedPlaylistId(p.id);
  }, [createPlaylist]);

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

  const removeHealthIssues = useCallback((indexes: number[]) => {
    if (!selectedPlaylist || indexes.length === 0) return;
    const snapshot = removeSongs(selectedPlaylist.id, indexes);
    setShowHealthModal(false);
    if (!snapshot) return;
    showToast(`${snapshot.removed.length}曲を削除しました`, 'info', {
      label: '元に戻す',
      onAction: () => {
        const restored = restoreRemovedSongs(snapshot, { allowDuplicateIds: true });
        if (restored > 0) showToast(`${restored}曲を元に戻しました`, 'success');
      },
    });
  }, [removeSongs, restoreRemovedSongs, selectedPlaylist, showToast]);

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

  const handleYTLink = useCallback((response: YouTubePlaylistSongsResponse) => {
    const now = Date.now();
    const sync = {
      playlistId: response.playlistId,
      sourceUrl: normalizeYouTubePlaylistUrl(response.playlistId),
      enabled: true,
      intervalHours: 24,
      lastAttemptAt: now,
      lastSuccessfulAt: now,
      nextSyncAt: now + 24 * 60 * 60 * 1000,
      lastStatus: response.unmatchedVideoIds.length > 0 || response.truncated ? 'partial' as const : 'success' as const,
      lastVideoCount: response.videoCount,
      lastMatchedCount: response.matchedCount,
      lastUnmatchedCount: response.unmatchedVideoIds.length,
    };
    const linked = createYouTubeLinkedPlaylist(response.title, response.songs, sync, selectedFolderId ?? undefined);
    setSelectedPlaylistId(linked.id);
    showToast(`「${response.title}」を自動同期プレイリストとして追加しました`, 'success');
  }, [createYouTubeLinkedPlaylist, selectedFolderId, showToast]);

  const refreshYouTubePlaylist = useCallback(async () => {
    if (!selectedPlaylist) return;
    const result = await syncYouTubePlaylist(selectedPlaylist, { refresh: true });
    showToast(
      result === 'error' ? 'YouTubeプレイリストの同期に失敗しました'
        : result === 'partial' ? '同期しました（一部の動画はVocaDB未登録です）'
          : 'YouTubeプレイリストを同期しました',
      result === 'error' ? 'warning' : 'success',
    );
  }, [selectedPlaylist, showToast]);

  const handleNicoLink = useCallback((response: NicoPlaylistSongsResponse) => {
    const now = Date.now();
    const sync = {
      sourceKind: response.sourceKind,
      sourceId: response.sourceId,
      sourceUrl: normalizeNicoPlaylistUrl({ kind: response.sourceKind, id: response.sourceId }),
      enabled: true,
      intervalHours: 24,
      lastAttemptAt: now,
      lastSuccessfulAt: now,
      nextSyncAt: now + 24 * 60 * 60 * 1000,
      lastStatus: response.unmatchedVideoIds.length > 0 || response.truncated ? 'partial' as const : 'success' as const,
      lastVideoCount: response.videoCount,
      lastMatchedCount: response.matchedCount,
      lastUnmatchedCount: response.unmatchedVideoIds.length,
    };
    const linked = createNicoLinkedPlaylist(response.title, response.songs, sync, selectedFolderId ?? undefined);
    setSelectedPlaylistId(linked.id);
    showToast(`「${response.title}」をニコニコ自動同期プレイリストとして追加しました`, 'success');
  }, [createNicoLinkedPlaylist, selectedFolderId, showToast]);

  const refreshNicoPlaylist = useCallback(async () => {
    if (!selectedPlaylist) return;
    const result = await syncNicoPlaylist(selectedPlaylist, { refresh: true });
    showToast(
      result === 'error' ? 'ニコニコプレイリストの同期に失敗しました'
        : result === 'partial' ? '同期しました（一部の動画はVocaDB未登録です）'
          : 'ニコニコプレイリストを同期しました',
      result === 'error' ? 'warning' : 'success',
    );
  }, [selectedPlaylist, showToast]);

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
    setQueueShuffled(selectedPlaylist.songs, selectedPlaylist.name);
  }, [selectedPlaylist, setQueueShuffled]);

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

      <PlaylistLibrarySidebar
        playlists={playlists}
        folders={folders}
        selectedPlaylistId={selectedPlaylistId}
        selectedFolderId={selectedFolderId}
        hasSelectedPlaylist={Boolean(selectedPlaylist)}
        onSelectPlaylist={setSelectedPlaylistId}
        onSelectFolder={setSelectedFolderId}
        onCreatePlaylist={handleCreate}
        onCreateFolder={name => { createFolder(name); }}
        onDeleteFolder={deleteFolder}
        onOpenSmartBuilder={() => openSmartBuilder()}
        onImportJson={importPlaylistJson}
        onExportAll={exportAllPlaylists}
      />

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

            <PlaylistHero
              playlist={selectedPlaylist}
              durationText={selectedPlaylistDurationText}
              filteredSongCount={filteredSongs.length}
              isFiltered={Boolean(filterText) && filteredSongs.length !== selectedPlaylist.songs.length}
              smartRefreshStatus={selectedSmartRefreshStatus}
              onPlay={() => setQueue(selectedPlaylist.songs, 0, true, 'manual', selectedPlaylist.name)}
              onShuffle={handleShufflePlay}
              onEdit={() => openEdit(selectedPlaylist)}
              onDelete={() => handleDelete(selectedPlaylist)}
              onEditSmartRule={() => openSmartBuilder(selectedPlaylist)}
              onRefreshSmart={() => void refreshSmartPlaylist(selectedPlaylist).catch(() => undefined)}
              onRefreshYouTube={() => void refreshYouTubePlaylist()}
              onRefreshNico={() => void refreshNicoPlaylist()}
              onUnlinkYouTube={() => {
                if (unlinkYouTubeSync(selectedPlaylist.id)) showToast('同期を解除しました。現在の曲一覧は保持されます', 'info');
              }}
              onUnlinkNico={() => {
                if (unlinkNicoSync(selectedPlaylist.id)) showToast('同期を解除しました。現在の曲一覧は保持されます', 'info');
              }}
              onOpenYouTubeImport={() => setShowYTImport(true)}
              onOpenNicoImport={() => setShowNicoImport(true)}
              onExport={() => exportPlaylist(selectedPlaylist)}
              onShare={() => void sharePlaylist(selectedPlaylist)}
            />

            {selectedPlaylist.songs.length > 0 && (
              <PlaylistToolbar
                query={filterText}
                sortKey={songSortKey}
                resultCount={filteredSongs.length}
                totalCount={selectedPlaylist.songs.length}
                selectionMode={selectionMode}
                duplicateCount={selectedPlaylistDuplicateCount}
                healthIssueCount={selectedPlaylistHealth.entries.length}
                externalLinked={isExternalLinked}
                onQueryChange={setFilterText}
                onSortChange={setSongSortKey}
                onRemoveDuplicates={removeDuplicatesFromSelectedPlaylist}
                onOpenHealth={() => setShowHealthModal(true)}
                onToggleSelection={() => {
                  setSelectionMode(current => !current);
                  clearSelection();
                }}
                onSelectAll={selectAll}
              />
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
                            onPlay={() => setQueue(filteredSongs, filteredIdx, true, 'manual', selectedPlaylist.name)}
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
                          onPlay={() => setQueue(filteredSongs, filteredIdx, true, 'manual', selectedPlaylist.name)}
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

      {showHealthModal && selectedPlaylist && (
        <PlaylistHealthModal
          songs={selectedPlaylist.songs}
          onClose={() => setShowHealthModal(false)}
          onRemove={removeHealthIssues}
        />
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
        <YouTubeImportModal onClose={() => setShowYTImport(false)} onImport={handleYTImport} onLink={handleYTLink} />
      )}
      {showNicoImport && selectedPlaylist && (
        <NicoImportModal onClose={() => setShowNicoImport(false)} onImport={handleYTImport} onLink={handleNicoLink} />
      )}
    </div>
  );
}
