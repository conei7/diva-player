/**
 * Playlist Store - プレイリストの永続管理
 *
 * LocalStorage と同期し、プレイリスト／フォルダのCRUD操作を提供。
 */

import { create } from 'zustand';
import type { Playlist, PlaylistFolder, Song, SmartPlaylistRule } from '../types/vocadb';
import { storage } from '../utils/storage';
import { createStableId } from '../utils/id';

const PLAYLISTS_KEY = 'playlists';
const FOLDERS_KEY   = 'playlistFolders';

/** 後で聴くプレイリストの固定 ID */
export const WATCH_LATER_ID = 'watch-later';

// ─── 追加結果 ───────────────────────────────────────────────────────────────
export interface AddSongResult {
  success: boolean;
  isDuplicate: boolean;
}

export interface AddSongsResult {
  added: number;
  duplicates: number;
}

export interface RemovedSong {
  song: Song;
  index: number;
}

export interface RemovedSongsSnapshot {
  playlistId: string;
  removed: RemovedSong[];
  previousCoverArtUrl?: string;
  kind: 'remove' | 'duplicates';
}

export interface DeletedPlaylistSnapshot {
  playlist: Playlist;
  index: number;
}

// ─── 並べ替えキー ────────────────────────────────────────────────────────────
export type SortKey = 'name' | 'artist' | 'publishDate' | 'addedOrder';

interface PlaylistState {
  playlists: Playlist[];
  folders: PlaylistFolder[];

  // ロード
  loadPlaylists: () => void;

  // プレイリスト CRUD
  createPlaylist: (name: string, folderId?: string) => Playlist;
  deletePlaylist: (id: string) => DeletedPlaylistSnapshot | null;
  restoreDeletedPlaylist: (snapshot: DeletedPlaylistSnapshot) => boolean;
  updatePlaylist: (id: string, patch: Partial<Pick<Playlist, 'name' | 'description' | 'coverArtUrl' | 'folderId' | 'smartRule'>>) => void;
  createSmartPlaylist: (name: string, rule: SmartPlaylistRule, folderId?: string) => Playlist;
  replacePlaylistSongs: (playlistId: string, songs: Song[]) => void;

  // フォルダ CRUD
  createFolder: (name: string, parentId?: string) => PlaylistFolder;
  deleteFolder: (id: string) => void;
  renameFolder: (id: string, name: string) => void;

  // 曲操作
  /** 追加。戸り値で重複を通知。 */
  addSong: (playlistId: string, song: Song) => AddSongResult;
  /** 複数曲を一括追加。 */
  addSongs: (playlistId: string, songs: Song[]) => AddSongsResult;
  removeSong: (playlistId: string, songIndex: number) => RemovedSongsSnapshot | null;
  removeSongs: (playlistId: string, songIndexes: number[]) => RemovedSongsSnapshot | null;
  restoreRemovedSongs: (snapshot: RemovedSongsSnapshot, options?: { allowDuplicateIds?: boolean }) => number;
  removeSongById: (playlistId: string, songId: number) => void;
  reorderSongs: (playlistId: string, fromIndex: number, toIndex: number) => void;
  sortSongs: (playlistId: string, by: SortKey) => void;
  removeDuplicateSongs: (playlistId: string) => number;
  removeDuplicateSongsWithUndo: (playlistId: string) => RemovedSongsSnapshot | null;

  /** ソングが存在しなければ追加、存在すれば削除。true = 追加, false = 削除 */
  toggleSongInPlaylist: (playlistId: string, song: Song) => boolean;
  /** ソングがプレイリストに存在するかチェック */
  isSongInPlaylist: (playlistId: string, songId: number) => boolean;

  /** 「後で聴く」プレイリストを取得（なければ作成） */
  getOrCreateWatchLater: () => Playlist;
}

// ─── 保存用スリム化 ─────────────────────────────────────────────────────────
// artists 配列は詳細表示用で再取得可能。localStorageの容量節約のため保存時に除去。
// pvs は再生に必須なので保持するが、description・author 等の重いフィールドを削除。
function slimSongForStorage(song: Song): Song {
  return {
    ...song,
    artists: undefined,
    pvs: song.pvs?.map(pv => ({
      id: pv.id,
      pvId: pv.pvId,
      service: pv.service,
      pvType: pv.pvType,
      url: pv.url,
      disabled: pv.disabled,
      length: pv.length,
      name: pv.name,
    } as typeof pv)),
  };
}

// ─── 永続化ヘルパー ─────────────────────────────────────────────────────────
function save(playlists: Playlist[], folders: PlaylistFolder[]): void {
  const slimmedPlaylists = playlists.map(pl => ({
    ...pl,
    songs: pl.songs.map(slimSongForStorage),
  }));
  const ok = storage.set(PLAYLISTS_KEY, slimmedPlaylists);
  if (!ok) {
    // ユーザーへの通知（非同期で表示）
    setTimeout(() => {
      alert(
        '⚠ プレイリストの保存に失敗しました。\n' +
        'ブラウザのストレージ容量が不足している可能性があります。\n' +
        'ページを再読み込みするとデータが失われることがあります。'
      );
    }, 0);
  }
  storage.set(FOLDERS_KEY, folders);
}

// ─── ソート実装 ─────────────────────────────────────────────────────────────
function sortSongsBy(songs: Song[], by: SortKey): Song[] {
  const copy = [...songs];
  switch (by) {
    case 'name':
      return copy.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    case 'artist':
      return copy.sort((a, b) => (a.artistString ?? '').localeCompare(b.artistString ?? '', 'ja'));
    case 'publishDate':
      return copy.sort((a, b) => (a.publishDate ?? '').localeCompare(b.publishDate ?? ''));
    case 'addedOrder':
    default:
      return copy; // 追加順はそのまま
  }
}

export const usePlaylistStore = create<PlaylistState>((set, get) => ({
  playlists: [],
  folders:   [],

  // ─── ロード ────────────────────────────────────────────────────────────────
  loadPlaylists: () => {
    const stored = storage.get<Playlist[]>(PLAYLISTS_KEY) ?? [];
    const folders = storage.get<PlaylistFolder[]>(FOLDERS_KEY) ?? [];
    // 「後で聴く」がなければ作成
    const hasWL = stored.some(p => p.id === WATCH_LATER_ID);
    const playlists = hasWL ? stored : [
      { id: WATCH_LATER_ID, name: '後で聴く', songs: [], isPinned: true, createdAt: Date.now(), updatedAt: Date.now() },
      ...stored,
    ];
    if (!hasWL) {
      save(playlists, folders);
    }
    set({ playlists, folders });
  },

  // ─── プレイリスト CRUD ──────────────────────────────────────────────────────
  createPlaylist: (name, folderId) => {
    const p: Playlist = {
      id: createStableId('playlist'),
      name,
      songs: [],
      folderId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const updated = [...get().playlists, p];
    const { folders } = get();
    set({ playlists: updated });
    save(updated, folders);
    return p;
  },

  deletePlaylist: (id) => {
    // isPinned のプレイリストは削除不可
    const current = get().playlists;
    const index = current.findIndex(p => p.id === id);
    const target = index >= 0 ? current[index] : undefined;
    if (!target || target.isPinned) return null;
    const updated = current.filter(p => p.id !== id);
    set({ playlists: updated });
    save(updated, get().folders);
    return { playlist: target, index };
  },

  restoreDeletedPlaylist: (snapshot) => {
    const current = get().playlists;
    if (current.some(p => p.id === snapshot.playlist.id)) return false;
    const index = Math.max(0, Math.min(snapshot.index, current.length));
    const updated = [...current];
    updated.splice(index, 0, snapshot.playlist);
    set({ playlists: updated });
    save(updated, get().folders);
    return true;
  },

  updatePlaylist: (id, patch) => {
    const updated = get().playlists.map(p =>
      p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p
    );
    set({ playlists: updated });
    save(updated, get().folders);
  },

  // ─── フォルダ CRUD ───────────────────────────────────────────────────────────
  createFolder: (name, parentId) => {
    const f: PlaylistFolder = {
      id: createStableId('folder'),
      name,
      parentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const updated = [...get().folders, f];
    set({ folders: updated });
    save(get().playlists, updated);
    return f;
  },

  deleteFolder: (id) => {
    // フォルダ削除 → 所属プレイリストをルートへ移動、子フォルダも削除
    const allFolders = get().folders;

    // 削除対象フォルダと子孫を収集
    const toDelete = new Set<string>([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of allFolders) {
        if (f.parentId && toDelete.has(f.parentId) && !toDelete.has(f.id)) {
          toDelete.add(f.id);
          changed = true;
        }
      }
    }

    const updatedFolders = allFolders.filter(f => !toDelete.has(f.id));
    const updatedPlaylists = get().playlists.map(p =>
      p.folderId && toDelete.has(p.folderId) ? { ...p, folderId: undefined } : p
    );
    set({ folders: updatedFolders, playlists: updatedPlaylists });
    save(updatedPlaylists, updatedFolders);
  },

  renameFolder: (id, name) => {
    const updated = get().folders.map(f =>
      f.id === id ? { ...f, name, updatedAt: Date.now() } : f
    );
    set({ folders: updated });
    save(get().playlists, updated);
  },

  // ─── 曲操作 ─────────────────────────────────────────────────────────────────
  addSong: (playlistId, song) => {
    let isDuplicate = false;
    const updated = get().playlists.map(p => {
      if (p.id !== playlistId) return p;
      if (p.songs.some(s => s.id === song.id)) {
        isDuplicate = true;
        return p;
      }
      // カバーアート自動設定（未設定かつ初曲のとき）
      const newCover = (!p.coverArtUrl && p.songs.length === 0) ? song.thumbUrl : p.coverArtUrl;
      return { ...p, songs: [...p.songs, song], coverArtUrl: newCover, updatedAt: Date.now() };
    });
    if (!isDuplicate) {
      set({ playlists: updated });
      save(updated, get().folders);
    }
    return { success: !isDuplicate, isDuplicate };
  },

  addSongs: (playlistId, songs) => {
    let added = 0;
    let duplicates = 0;
    const updated = get().playlists.map(p => {
      if (p.id !== playlistId) return p;
      const existingIds = new Set(p.songs.map(s => s.id));
      const newSongs = songs.filter(s => {
        if (existingIds.has(s.id)) { duplicates++; return false; }
        existingIds.add(s.id);
        added++;
        return true;
      });
      return { ...p, songs: [...p.songs, ...newSongs], updatedAt: Date.now() };
    });
    set({ playlists: updated });
    save(updated, get().folders);
    return { added, duplicates };
  },

  removeSong: (playlistId, songIndex) => get().removeSongs(playlistId, [songIndex]),
  removeSongs: (playlistId, songIndexes) => {
    const current = get().playlists;
    const target = current.find(p => p.id === playlistId);
    if (!target) return null;
    const indexes = [...new Set(songIndexes)]
      .filter(index => Number.isInteger(index) && index >= 0 && index < target.songs.length)
      .sort((a, b) => a - b);
    if (indexes.length === 0) return null;

    const indexSet = new Set(indexes);
    const snapshot: RemovedSongsSnapshot = {
      playlistId,
      removed: indexes.map(index => ({ song: target.songs[index], index })),
      previousCoverArtUrl: target.coverArtUrl,
      kind: 'remove',
    };
    const songs = target.songs.filter((_, index) => !indexSet.has(index));
    const removedCover = snapshot.removed.some(item => item.song.thumbUrl === target.coverArtUrl);
    const updated = current.map(p => p.id !== playlistId ? p : {
      ...p,
      songs,
      coverArtUrl: removedCover ? songs[0]?.thumbUrl : p.coverArtUrl,
      updatedAt: Date.now(),
    });
    set({ playlists: updated });
    save(updated, get().folders);
    return snapshot;
  },

  restoreRemovedSongs: (snapshot, options) => {
    const current = get().playlists;
    const target = current.find(p => p.id === snapshot.playlistId);
    if (!target) return 0;

    const allowDuplicateIds = options?.allowDuplicateIds ?? false;
    const existingIds = new Set(target.songs.map(song => song.id));
    const restored = [...target.songs];
    let count = 0;
    for (const removed of [...snapshot.removed].sort((a, b) => a.index - b.index)) {
      if (!allowDuplicateIds && existingIds.has(removed.song.id)) continue;
      const index = Math.max(0, Math.min(removed.index, restored.length));
      restored.splice(index, 0, removed.song);
      if (!allowDuplicateIds) existingIds.add(removed.song.id);
      count++;
    }
    if (count === 0) return 0;

    const currentFirstThumb = target.songs[0]?.thumbUrl;
    const coverWasAutoUpdated = target.coverArtUrl === currentFirstThumb || target.coverArtUrl === undefined;
    const updated = current.map(p => p.id !== snapshot.playlistId ? p : {
      ...p,
      songs: restored,
      coverArtUrl: coverWasAutoUpdated ? snapshot.previousCoverArtUrl : p.coverArtUrl,
      updatedAt: Date.now(),
    });
    set({ playlists: updated });
    save(updated, get().folders);
    return count;
  },

  removeSongById: (playlistId, songId) => {
    const updated = get().playlists.map(p => {
      if (p.id !== playlistId) return p;
      return { ...p, songs: p.songs.filter(s => s.id !== songId), updatedAt: Date.now() };
    });
    set({ playlists: updated });
    save(updated, get().folders);
  },

  reorderSongs: (playlistId, fromIndex, toIndex) => {
    const updated = get().playlists.map(p => {
      if (p.id !== playlistId) return p;
      const songs = [...p.songs];
      const [moved] = songs.splice(fromIndex, 1);
      songs.splice(toIndex, 0, moved);
      return { ...p, songs, updatedAt: Date.now() };
    });
    set({ playlists: updated });
    save(updated, get().folders);
  },

  sortSongs: (playlistId, by) => {
    const updated = get().playlists.map(p => {
      if (p.id !== playlistId) return p;
      return { ...p, songs: sortSongsBy(p.songs, by), updatedAt: Date.now() };
    });
    set({ playlists: updated });
    save(updated, get().folders);
  },

  createSmartPlaylist: (name, smartRule, folderId) => {
    const playlist: Playlist = {
      id: createStableId('playlist'),
      name,
      songs: [],
      folderId,
      smartRule,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const updated = [...get().playlists, playlist];
    set({ playlists: updated });
    save(updated, get().folders);
    return playlist;
  },

  replacePlaylistSongs: (playlistId, songs) => {
    const updated = get().playlists.map(playlist => playlist.id === playlistId
      ? { ...playlist, songs, updatedAt: Date.now() }
      : playlist);
    set({ playlists: updated });
    save(updated, get().folders);
  },

  removeDuplicateSongs: (playlistId) => get().removeDuplicateSongsWithUndo(playlistId)?.removed.length ?? 0,

  removeDuplicateSongsWithUndo: (playlistId) => {
    const target = get().playlists.find(p => p.id === playlistId);
    if (!target) return null;
    const seen = new Set<number>();
    const indexes = target.songs.flatMap((song, index) => {
      if (seen.has(song.id)) return [index];
      seen.add(song.id);
      return [];
    });
    const snapshot = get().removeSongs(playlistId, indexes);
    return snapshot ? { ...snapshot, kind: 'duplicates' } : null;
  },

  toggleSongInPlaylist: (playlistId, song) => {
    const p = get().playlists.find(pl => pl.id === playlistId);
    if (!p) return false;
    const exists = p.songs.some(s => s.id === song.id);
    if (exists) {
      get().removeSongById(playlistId, song.id);
      return false;
    } else {
      get().addSong(playlistId, song);
      return true;
    }
  },

  isSongInPlaylist: (playlistId, songId) => {
    const p = get().playlists.find(pl => pl.id === playlistId);
    return p?.songs.some(s => s.id === songId) ?? false;
  },

  getOrCreateWatchLater: () => {
    const existing = get().playlists.find(p => p.id === WATCH_LATER_ID);
    if (existing) return existing;
    const wl: Playlist = {
      id: WATCH_LATER_ID,
      name: '後で聴く',
      songs: [],
      isPinned: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const updated = [wl, ...get().playlists];
    set({ playlists: updated });
    save(updated, get().folders);
    return wl;
  },
}));
