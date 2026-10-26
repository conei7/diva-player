/**
 * PlaylistPage — /playlists (library grid) and /playlists?list=<id> (one playlist).
 * The open playlist lives in the URL, so Back, reload and shared links land on the same view.
 * This container owns the playlist-level actions and dialogs; the views are
 * PlaylistLibrary and PlaylistDetail.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router';
import { usePlaylistStore } from '../stores/playlistStore';
import { usePlayerStore } from '../stores/playerStore';
import { showToast } from '../stores/toastStore';
import { confirmDialog } from '../stores/confirmStore';
import type { NicoPlaylistSync, Playlist, PlaylistFolder, YouTubePlaylistSync } from '../types/vocadb';
import {
  createAllPlaylistsBackupPayload,
  createPlaylistExportPayload,
  downloadJson,
  parsePlaylistBackup,
  parsePlaylistImport,
  toSafeFileName,
  uniquePlaylistName,
} from '../utils/playlistBackup';
import { createPlaylistShareUrl, decodePlaylistShare, orderSharedSongs } from '../utils/playlistShare';
import { getSongsByIds } from '../api/vocadb';
import { searchSmartPlaylistSongs } from '../api/smartPlaylist';
import { filterSmartPlaylistSongs, isSameSmartPlaylistRule, normalizeSmartPlaylistRule } from '../utils/smartPlaylist';
import { normalizeYouTubePlaylistUrl, type YouTubePlaylistSongsResponse } from '../api/youtubePlaylist';
import { syncYouTubePlaylist } from '../services/youtubePlaylistSync';
import { normalizeNicoPlaylistUrl, type NicoPlaylistSongsResponse } from '../api/nicoPlaylist';
import { syncNicoPlaylist } from '../services/nicoPlaylistSync';
import { useTranslateSourceText } from '../i18n';
import { useLanguageStore } from '../stores/languageStore';
import { formatCount } from '../utils/songMeta';
import { displayPlaylistName } from '../utils/displayNames';
import { playlistPath, playlistsPath } from '../utils/routes';
import EmptyState from '../components/ui/EmptyState';
import { PageShell } from '../components/ui/PageHeader';
import { ErrorIcon, PlaylistIcon, SpinnerIcon } from '../components/ui/icons';
import PlaylistLibrary from '../components/playlist/PlaylistLibrary';
import PlaylistDetail from '../components/playlist/PlaylistDetail';
import type { PlaylistActionHandlers } from '../components/playlist/PlaylistActionsMenu';
import type { SmartPlaylistRefreshStatus } from '../components/playlist/PlaylistHero';
import NewPlaylistDialog from '../components/playlist/NewPlaylistDialog';
import PlaylistEditDialog, { type PlaylistEditValues } from '../components/playlist/PlaylistEditDialog';
import PlaylistFolderDialog from '../components/playlist/PlaylistFolderDialog';
import PlaylistShareDialog from '../components/playlist/PlaylistShareDialog';
import PlaylistImportDialog, { type PlaylistImportSaveOptions } from '../components/playlist/PlaylistImportDialog';
import SmartPlaylistBuilder, { type SmartPlaylistBuilderValues } from '../components/playlist/SmartPlaylistBuilder';
import type { PlaylistImportResult } from '../components/playlist/usePlaylistImport';
import { copyText, folderIdOfFilter, type PlaylistLibraryFilter } from '../components/playlist/playlistDisplay';
import { addSongsToQueue } from '../components/playlist/playlistQueue';

/** Library scroll position, restored when coming back from a playlist with the Back button. */
let savedLibraryScrollY = 0;

function youtubeSyncFrom(response: YouTubePlaylistSongsResponse): YouTubePlaylistSync {
  const now = Date.now();
  return {
    playlistId: response.playlistId,
    sourceUrl: normalizeYouTubePlaylistUrl(response.playlistId),
    enabled: true,
    intervalHours: 24,
    lastAttemptAt: now,
    lastSuccessfulAt: now,
    nextSyncAt: now + 24 * 60 * 60 * 1000,
    lastStatus: response.unmatchedVideoIds.length > 0 || response.truncated ? 'partial' : 'success',
    lastVideoCount: response.videoCount,
    lastMatchedCount: response.matchedCount,
    lastUnmatchedCount: response.unmatchedVideoIds.length,
  };
}

function nicoSyncFrom(response: NicoPlaylistSongsResponse): NicoPlaylistSync {
  const now = Date.now();
  return {
    sourceKind: response.sourceKind,
    sourceId: response.sourceId,
    sourceUrl: normalizeNicoPlaylistUrl({ kind: response.sourceKind, id: response.sourceId }),
    enabled: true,
    intervalHours: 24,
    lastAttemptAt: now,
    lastSuccessfulAt: now,
    nextSyncAt: now + 24 * 60 * 60 * 1000,
    lastStatus: response.unmatchedVideoIds.length > 0 || response.truncated ? 'partial' : 'success',
    lastVideoCount: response.videoCount,
    lastMatchedCount: response.matchedCount,
    lastUnmatchedCount: response.unmatchedVideoIds.length,
  };
}

type FolderDialogState = { mode: 'create' } | { mode: 'rename'; folder: PlaylistFolder };

export default function PlaylistPage() {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const [searchParams] = useSearchParams();
  const listId = searchParams.get('list');
  const shareParam = searchParams.get('share');

  const playlists = usePlaylistStore(state => state.playlists);
  const folders = usePlaylistStore(state => state.folders);
  const loadPlaylists = usePlaylistStore(state => state.loadPlaylists);
  const replacePlaylistSongs = usePlaylistStore(state => state.replacePlaylistSongs);

  const [libraryFilter, setLibraryFilter] = useState<PlaylistLibraryFilter>('all');
  const [libraryQuery, setLibraryQuery] = useState('');
  const [newPlaylistOpen, setNewPlaylistOpen] = useState(false);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [editState, setEditState] = useState<{ playlistId: string; focus?: 'folder' } | null>(null);
  const [smartBuilder, setSmartBuilder] = useState<{ playlistId: string | null } | null>(null);
  const [importState, setImportState] = useState<{ targetId: string | null } | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  /** The ?share= link whose songs could not be loaded (shown with 再試行). */
  const [shareFailed, setShareFailed] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [smartRefreshStatuses, setSmartRefreshStatuses] = useState<Record<string, SmartPlaylistRefreshStatus>>({});
  const smartRefreshRef = useRef<string | null>(null);
  const smartRequestRef = useRef<AbortController | null>(null);
  useEffect(() => () => { smartRequestRef.current?.abort(); }, [listId]);
  const smartRefreshRetryRef = useRef(new Set<string>());
  const smartRefreshRetryTimerRef = useRef<number | null>(null);
  const [smartRefreshRetryTick, setSmartRefreshRetryTick] = useState(0);
  const shareHandledRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadPlaylists(); }, [loadPlaylists]);
  // 後で聴く always exists once the playlists are loaded.
  const loaded = playlists.length > 0;
  const selectedPlaylist = listId ? playlists.find(playlist => playlist.id === listId) ?? null : null;
  const selectedFolderId = folderIdOfFilter(libraryFilter);
  const folderNames = useMemo(() => new Map(folders.map(folder => [folder.id, folder.name])), [folders]);

  // Opening a playlist starts at the top; Back to the library returns to where it was.
  useLayoutEffect(() => {
    if (!listId && navigationType === 'POP') window.scrollTo(0, savedLibraryScrollY);
    else window.scrollTo(0, 0);
    // Only when the view changes (navigationType belongs to that same navigation).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId]);

  /** Saved and shown names, so a new list never looks like a second 後で聴く (「Listen later」 in English). */
  const takenPlaylistNames = useCallback(() => {
    const current = usePlaylistStore.getState().playlists;
    return [...current.map(playlist => playlist.name), ...current.map(playlist => displayPlaylistName(playlist, t))];
  }, [t]);

  // ── Shared links (/playlists?share=…) ────────────────────────────────────
  const openSharedLink = useCallback(async (encoded: string) => {
    const shared = decodePlaylistShare(encoded);
    if (!shared) {
      showToast(t('共有リンクを開けませんでした'));
      navigate(playlistsPath(), { replace: true });
      return;
    }
    setShareFailed(null);
    let songs = shared.songs;
    if (!songs) {
      // Version 2 links carry only the song ids.
      const fetched = shared.songIds.length > 0 ? await getSongsByIds(shared.songIds).catch(() => []) : [];
      // Left the link while loading.
      if (new URLSearchParams(window.location.search).get('share') !== encoded) return;
      songs = orderSharedSongs(shared.songIds, fetched);
      if (shared.songIds.length > 0 && songs.length === 0) {
        setShareFailed(encoded);
        return;
      }
    }
    try {
      const store = usePlaylistStore.getState();
      const name = uniquePlaylistName(shared.name, takenPlaylistNames());
      const imported = store.createPlaylistWithSongs(name, songs, selectedFolderId ?? undefined, {
        description: shared.description,
        coverArtUrl: shared.coverArtUrl,
      });
      showToast(t('「{name}」を追加しました', { name }));
      navigate(playlistPath(imported.id), { replace: true });
    } catch {
      navigate(playlistsPath(), { replace: true });
    }
  }, [navigate, selectedFolderId, t, takenPlaylistNames]);

  useEffect(() => {
    if (!shareParam || shareHandledRef.current === shareParam || !loaded) return;
    shareHandledRef.current = shareParam;
    void openSharedLink(shareParam);
  }, [loaded, openSharedLink, shareParam]);

  // ── Smart playlists refresh every time they are opened ───────────────────
  const refreshSmartPlaylist = useCallback(async (playlist: Playlist) => {
    if (!playlist.smartRule) return;
    smartRequestRef.current?.abort();
    const controller = new AbortController();
    smartRequestRef.current = controller;
    setSmartRefreshStatuses(current => ({ ...current, [playlist.id]: { state: 'loading' } }));
    try {
      const rule = normalizeSmartPlaylistRule(playlist.smartRule);
      const result = await searchSmartPlaylistSongs(rule, undefined, controller.signal);
      const current = usePlaylistStore.getState().playlists.find(item => item.id === playlist.id);
      // Only a changed rule makes the result stale (the playlists may have been re-read meanwhile).
      if (!current || !isSameSmartPlaylistRule(current.smartRule, playlist.smartRule)) return;
      const matchingSongs = filterSmartPlaylistSongs(result.items, rule);
      replacePlaylistSongs(playlist.id, matchingSongs);
      smartRefreshRetryRef.current.delete(playlist.id);
      setSmartRefreshStatuses(statuses => ({
        ...statuses,
        [playlist.id]: {
          state: matchingSongs.length > 0 ? 'success' : 'empty',
          refreshedAt: Date.now(),
          matchedCount: result.totalCount,
          loadedCount: matchingSongs.length,
        },
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      smartRefreshRef.current = null;
      setSmartRefreshStatuses(statuses => ({ ...statuses, [playlist.id]: { state: 'error' } }));
      // One automatic retry after 5 seconds.
      if (!smartRefreshRetryRef.current.has(playlist.id)) {
        smartRefreshRetryRef.current.add(playlist.id);
        smartRefreshRetryTimerRef.current = window.setTimeout(() => {
          smartRefreshRetryTimerRef.current = null;
          setSmartRefreshRetryTick(tick => tick + 1);
        }, 5000);
      }
      throw error;
    }
  }, [replacePlaylistSongs]);

  useEffect(() => {
    smartRefreshRef.current = null;
    smartRefreshRetryRef.current.clear();
    if (smartRefreshRetryTimerRef.current !== null) {
      window.clearTimeout(smartRefreshRetryTimerRef.current);
      smartRefreshRetryTimerRef.current = null;
    }
  }, [listId]);

  useEffect(() => {
    if (!selectedPlaylist?.smartRule || smartRefreshRef.current === selectedPlaylist.id) return undefined;
    smartRefreshRef.current = selectedPlaylist.id;
    void refreshSmartPlaylist(selectedPlaylist).catch(() => undefined);
    return () => {
      if (smartRefreshRetryTimerRef.current !== null) {
        window.clearTimeout(smartRefreshRetryTimerRef.current);
        smartRefreshRetryTimerRef.current = null;
      }
    };
  }, [refreshSmartPlaylist, selectedPlaylist, smartRefreshRetryTick]);

  // ── Playlist-level actions ────────────────────────────────────────────────
  // Shared and exported under the shown name (後で聴く is 「Listen later」 in English).
  const exportPlaylist = useCallback((playlist: Playlist) => {
    const exportedAt = new Date().toISOString();
    const name = displayPlaylistName(playlist, t);
    downloadJson(`${toSafeFileName(name)}.diva-playlist.json`, createPlaylistExportPayload({ ...playlist, name }, exportedAt));
  }, [t]);

  const sharePlaylist = useCallback(async (playlist: Playlist) => {
    const url = createPlaylistShareUrl(playlist, { name: displayPlaylistName(playlist, t) });
    if (!url) {
      showToast(t('曲が多すぎて共有できません'), {
        action: { label: t('JSONでエクスポート'), onAction: () => exportPlaylist(playlist) },
      });
      return;
    }
    if (await copyText(url)) showToast(t('リンクをコピーしました'));
    else setShareUrl(url);
  }, [exportPlaylist, t]);

  const exportAllPlaylists = () => {
    const exportedAt = new Date().toISOString();
    const store = usePlaylistStore.getState();
    downloadJson(`diva-playlists-backup-${exportedAt.slice(0, 10)}.json`, createAllPlaylistsBackupPayload(store.folders, store.playlists, exportedAt));
  };

  const deletePlaylistWithUndo = useCallback((playlist: Playlist) => {
    if (playlist.isPinned) return;
    const snapshot = usePlaylistStore.getState().deletePlaylist(playlist.id);
    if (!snapshot) return;
    if (listId === playlist.id) navigate(playlistsPath(), { replace: true });
    showToast(t('プレイリストを削除しました'), {
      action: {
        label: t('元に戻す'),
        onAction: () => { usePlaylistStore.getState().restoreDeletedPlaylist(snapshot); },
      },
    });
  }, [listId, navigate, t]);

  const libraryActions = useMemo<PlaylistActionHandlers>(() => ({
    onPlayAll: playlist => {
      if (playlist.songs.length === 0) return;
      usePlayerStore.getState().setQueue(playlist.songs, 0, true, 'manual', playlist.name);
    },
    onShufflePlay: playlist => {
      if (playlist.songs.length === 0) return;
      usePlayerStore.getState().setQueueShuffled(playlist.songs, playlist.name);
    },
    onAddToQueue: playlist => {
      if (playlist.songs.length === 0) return;
      addSongsToQueue(playlist.songs, playlist.name);
      showToast(t('キューに追加しました'));
    },
    onEdit: (playlist, focus) => setEditState({ playlistId: playlist.id, focus }),
    onShare: playlist => { void sharePlaylist(playlist); },
    onExport: exportPlaylist,
    onDelete: deletePlaylistWithUndo,
  }), [deletePlaylistWithUndo, exportPlaylist, sharePlaylist, t]);

  const syncNow = useCallback(async (playlist: Playlist) => {
    setSyncingId(playlist.id);
    try {
      const result = playlist.youtubeSync?.enabled
        ? await syncYouTubePlaylist(playlist, { refresh: true })
        : await syncNicoPlaylist(playlist, { refresh: true });
      if (result === 'error') {
        showToast(t('同期できませんでした'), {
          action: {
            label: t('再試行'),
            onAction: () => {
              const latest = usePlaylistStore.getState().playlists.find(item => item.id === playlist.id);
              if (latest) void syncNow(latest);
            },
          },
        });
      } else if (result === 'partial') {
        showToast(t('同期しました（一部は未登録）'));
      } else if (result === 'success') {
        showToast(t('同期しました'));
      }
    } finally {
      setSyncingId(current => (current === playlist.id ? null : current));
    }
  }, [t]);

  const unlinkSync = (playlist: Playlist) => {
    const store = usePlaylistStore.getState();
    const unlinked = playlist.youtubeSync ? store.unlinkYouTubeSync(playlist.id) : store.unlinkNicoSync(playlist.id);
    if (unlinked) showToast(t('同期を解除しました'));
  };

  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(playlistsPath());
  };

  // ── Creating ──────────────────────────────────────────────────────────────
  const createPlaylist = (name: string, folderId?: string) => {
    const playlist = usePlaylistStore.getState().createPlaylist(name, folderId);
    setNewPlaylistOpen(false);
    navigate(playlistPath(playlist.id));
  };

  const submitSmartPlaylist = ({ name, rule }: SmartPlaylistBuilderValues) => {
    const store = usePlaylistStore.getState();
    const editing = smartBuilder?.playlistId ? store.playlists.find(playlist => playlist.id === smartBuilder.playlistId) : null;
    if (editing) {
      store.updatePlaylist(editing.id, { name, smartRule: rule });
      smartRefreshRef.current = null;
      smartRefreshRetryRef.current.delete(editing.id);
      setSmartRefreshStatuses(current => ({ ...current, [editing.id]: { state: 'loading' } }));
      showToast(t('条件を保存しました'));
    } else {
      const playlist = store.createSmartPlaylist(name, rule, selectedFolderId ?? undefined);
      navigate(playlistPath(playlist.id));
      showToast(t('「{title}」を作成しました', { title: name }));
    }
    setSmartBuilder(null);
  };

  const saveImport = (result: PlaylistImportResult, { sync, targetId }: PlaylistImportSaveOptions) => {
    const store = usePlaylistStore.getState();
    const names = takenPlaylistNames();
    const fallbackName = result.service === 'youtube' ? t('YouTubeのプレイリスト') : t('ニコニコのプレイリスト');
    const folderId = selectedFolderId ?? undefined;

    if (sync) {
      const name = uniquePlaylistName(result.title || fallbackName, names);
      let created: Playlist;
      if (result.service === 'youtube' && result.youtube) {
        created = store.createYouTubeLinkedPlaylist(name, result.songs, youtubeSyncFrom(result.youtube), folderId);
      } else if (result.service === 'niconico' && result.nico) {
        created = store.createNicoLinkedPlaylist(name, result.songs, nicoSyncFrom(result.nico), folderId);
      } else {
        throw new Error('sync source missing');
      }
      setImportState(null);
      navigate(playlistPath(created.id));
      showToast(t('「{name}」を追加しました', { name }));
      return;
    }

    if (targetId) {
      const target = store.playlists.find(playlist => playlist.id === targetId);
      if (!target) throw new Error('target missing');
      const added = store.addSongs(targetId, result.songs);
      if (!added.success) throw new Error('save failed');
      setImportState(null);
      const name = displayPlaylistName(target, t);
      const openAction = listId !== targetId
        ? { action: { label: t('開く'), onAction: () => navigate(playlistPath(targetId)) } }
        : undefined;
      if (added.added === 0) {
        showToast(added.duplicates === 1 ? t('1曲は追加済みです') : t('{count}曲は追加済みです', { count: added.duplicates }), openAction);
      } else {
        showToast(added.added === 1
          ? t('1曲を「{name}」に保存しました', { name })
          : t('{count}曲を「{name}」に保存しました', { name, count: added.added }), openAction);
      }
      return;
    }

    const name = uniquePlaylistName(result.title || fallbackName, names);
    const created = store.createPlaylistWithSongs(name, result.songs, folderId);
    setImportState(null);
    navigate(playlistPath(created.id));
    showToast(created.songs.length === 1
      ? t('1曲を「{name}」に保存しました', { name })
      : t('{count}曲を「{name}」に保存しました', { name, count: created.songs.length }));
  };

  const importJsonFile = async (file: File) => {
    try {
      const data: unknown = JSON.parse(await file.text());
      const store = usePlaylistStore.getState();
      const names = new Set(takenPlaylistNames());
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
          const created = store.createFolder(folder.name, folder.parentId ? folderIdMap.get(folder.parentId) : undefined);
          folderIdMap.set(folder.id, created.id);
        }
        let addedSongs = 0;
        backup.playlists.forEach(item => {
          const name = uniquePlaylistName(item.name, names);
          names.add(name);
          const playlist = usePlaylistStore.getState().createPlaylistWithSongs(
            name,
            item.songs,
            item.folderId ? folderIdMap.get(item.folderId) : selectedFolderId ?? undefined,
            { description: item.description, coverArtUrl: item.coverArtUrl, smartRule: item.smartRule },
          );
          addedSongs += playlist.songs.length;
        });
        showToast(t('バックアップをインポートしました（{songs}）', { songs: formatCount(addedSongs, 'song', language) }));
        return;
      }

      const parsed = parsePlaylistImport(data);
      if (!parsed) throw new Error('Invalid playlist JSON');
      const name = uniquePlaylistName(parsed.name, names);
      const playlist = store.createPlaylistWithSongs(name, parsed.songs, selectedFolderId ?? undefined, {
        description: parsed.description,
        coverArtUrl: parsed.coverArtUrl,
      });
      navigate(playlistPath(playlist.id));
      showToast(t('「{name}」をインポートしました（{songs}）', { name, songs: formatCount(playlist.songs.length, 'song', language) }));
    } catch {
      showToast(t('このファイルはインポートできません'));
    }
  };

  const openFilePicker = () => {
    setImportState(null);
    fileInputRef.current?.click();
  };

  // ── Folders ───────────────────────────────────────────────────────────────
  const submitFolder = (name: string) => {
    if (!folderDialog) return;
    const store = usePlaylistStore.getState();
    if (folderDialog.mode === 'create') store.createFolder(name);
    else store.renameFolder(folderDialog.folder.id, name);
    setFolderDialog(null);
  };

  const deleteFolder = async (folder: PlaylistFolder) => {
    const confirmed = await confirmDialog({
      title: t('フォルダー「{name}」を削除しますか？', { name: folder.name }),
      message: t('中のプレイリストは未分類に移ります'),
      confirmLabel: t('削除'),
    });
    if (!confirmed) return;
    usePlaylistStore.getState().deleteFolder(folder.id);
    setLibraryFilter(current => (current === `folder:${folder.id}` ? 'all' : current));
  };

  const saveEdit = (values: PlaylistEditValues) => {
    if (!editState) return;
    usePlaylistStore.getState().updatePlaylist(editState.playlistId, values);
    setEditState(null);
  };

  const editingPlaylist = editState ? playlists.find(playlist => playlist.id === editState.playlistId) ?? null : null;
  const smartEditingPlaylist = smartBuilder?.playlistId ? playlists.find(playlist => playlist.id === smartBuilder.playlistId) ?? null : null;

  let view;
  if (listId) {
    if (selectedPlaylist) {
      view = (
        <PlaylistDetail
          key={selectedPlaylist.id}
          playlist={selectedPlaylist}
          folderName={selectedPlaylist.folderId ? folderNames.get(selectedPlaylist.folderId) : undefined}
          smartStatus={smartRefreshStatuses[selectedPlaylist.id]}
          syncing={syncingId === selectedPlaylist.id}
          onBack={goBack}
          onEdit={focus => setEditState({ playlistId: selectedPlaylist.id, focus })}
          onShare={() => { void sharePlaylist(selectedPlaylist); }}
          onExport={() => exportPlaylist(selectedPlaylist)}
          onDelete={() => deletePlaylistWithUndo(selectedPlaylist)}
          onImportInto={() => setImportState({ targetId: selectedPlaylist.id })}
          onRefreshSmart={() => { void refreshSmartPlaylist(selectedPlaylist).catch(() => undefined); }}
          onEditRules={() => setSmartBuilder({ playlistId: selectedPlaylist.id })}
          onSyncNow={() => { void syncNow(selectedPlaylist); }}
          onUnlinkSync={() => unlinkSync(selectedPlaylist)}
        />
      );
    } else if (loaded && !shareParam) {
      view = (
        <PageShell>
          <EmptyState
            icon={<PlaylistIcon />}
            title={t('プレイリストが見つかりませんでした')}
            action={{ label: t('プレイリスト一覧に戻る'), to: playlistsPath() }}
          />
        </PageShell>
      );
    } else {
      view = null;
    }
  } else if (shareParam) {
    // Opening a shared link: its songs are being fetched (or could not be).
    view = (
      <PageShell>
        {shareFailed === shareParam ? (
          <EmptyState
            icon={<ErrorIcon />}
            title={t('共有リンクを開けませんでした')}
            action={{ label: t('再試行'), onClick: () => { void openSharedLink(shareParam); } }}
          />
        ) : (
          <div role="status" aria-label={t('読み込み中…')} className="flex justify-center py-16 text-yt-text-secondary">
            <SpinnerIcon size={32} />
          </div>
        )}
      </PageShell>
    );
  } else {
    view = (
      <PlaylistLibrary
        playlists={playlists}
        folders={folders}
        filter={libraryFilter}
        onFilterChange={setLibraryFilter}
        query={libraryQuery}
        onQueryChange={setLibraryQuery}
        actions={libraryActions}
        onOpenPlaylist={() => { savedLibraryScrollY = window.scrollY; }}
        onNewPlaylist={() => setNewPlaylistOpen(true)}
        onNewSmartPlaylist={() => setSmartBuilder({ playlistId: null })}
        onImportFromUrl={() => setImportState({ targetId: null })}
        onImportFromFile={openFilePicker}
        onCreateFolder={() => setFolderDialog({ mode: 'create' })}
        onRenameFolder={folder => setFolderDialog({ mode: 'rename', folder })}
        onDeleteFolder={folder => { void deleteFolder(folder); }}
        onExportAll={exportAllPlaylists}
      />
    );
  }

  return (
    <>
      {view}

      <NewPlaylistDialog
        open={newPlaylistOpen}
        folders={folders}
        defaultFolderId={selectedFolderId ?? undefined}
        onClose={() => setNewPlaylistOpen(false)}
        onCreate={createPlaylist}
      />
      {folderDialog && (
        <PlaylistFolderDialog
          mode={folderDialog.mode}
          initialName={folderDialog.mode === 'rename' ? folderDialog.folder.name : ''}
          onClose={() => setFolderDialog(null)}
          onSubmit={submitFolder}
        />
      )}
      {editingPlaylist && editState && (
        <PlaylistEditDialog
          // A sibling of <PlaylistDetail key={id}>, so the key must differ from it.
          key={`edit-${editingPlaylist.id}`}
          playlist={editingPlaylist}
          folders={folders}
          focus={editState.focus}
          onClose={() => setEditState(null)}
          onSave={saveEdit}
        />
      )}
      {smartBuilder && (smartBuilder.playlistId === null || smartEditingPlaylist) && (
        <SmartPlaylistBuilder
          mode={smartEditingPlaylist ? 'edit' : 'create'}
          initialName={smartEditingPlaylist?.name}
          initialRule={smartEditingPlaylist?.smartRule}
          onClose={() => setSmartBuilder(null)}
          onSubmit={submitSmartPlaylist}
        />
      )}
      {importState && (
        <PlaylistImportDialog
          initialTargetId={importState.targetId}
          playlists={playlists}
          onClose={() => setImportState(null)}
          onImportFile={openFilePicker}
          onSave={saveImport}
        />
      )}
      {shareUrl && <PlaylistShareDialog url={shareUrl} onClose={() => setShareUrl(null)} />}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) void importJsonFile(file);
          event.currentTarget.value = '';
        }}
      />
    </>
  );
}
