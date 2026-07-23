/**
 * PlaylistPage – YouTube 風プレイリスト管理ページ
 *
 * 追加機能:
 * - 後で聴く（削除不可ピン留め）を左サイドバー最上部に固定
 * - 右パネルに曲フィルター（名前・アーティスト）
 * - 一括選択モード（チェックボックス + フローティングバー）
 * - 曲行の ⋮ コンテキストメニュー（最上部/最下部へ移動、カバーに設定、削除）
 * - isPinned プレイリストの編集・削除を禁止
 */
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
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
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
import { searchSongs, getSongsByProducer } from '../api/vocadb';
import { applyDiscoveryFilterWithRelaxation } from '../utils/globalFilters';
import type { SmartPlaylistRule } from '../types/vocadb';
import { sortPlaylistSongs } from '../utils/playlistSorting';
import { storage } from '../utils/storage';
import {
  DEFAULT_PLAYLIST_LIST_PREFERENCES,
  normalizePlaylistListPreferences,
  sortPlaylistsForDisplay,
  type PlaylistListDensity,
  type PlaylistListSortKey,
} from '../utils/playlistListPreferences';

const PLAYLIST_LIST_PREFERENCES_KEY = 'playlistListPreferences';

function PlaylistCover({ playlist, className = '' }: { playlist: Playlist; className?: string }) {
  const thumbnails = Array.from(new Set(
    playlist.songs.map(song => song.thumbUrl).filter((url): url is string => Boolean(url)),
  )).slice(0, 4);

  if (playlist.coverArtUrl) {
    return <img src={playlist.coverArtUrl} alt="" className={`h-full w-full object-cover ${className}`} />;
  }

  if (!playlist.isPinned && thumbnails.length > 0) {
    const gridClass = thumbnails.length === 1 ? 'grid-cols-1' : 'grid-cols-2';
    return (
      <div className={`grid h-full w-full auto-rows-fr ${gridClass} overflow-hidden ${className}`}>
        {thumbnails.map((url, index) => (
          <img
            key={url}
            src={url}
            alt=""
            loading="lazy"
            className={`h-full min-h-0 w-full object-cover ${thumbnails.length === 3 && index === 0 ? 'row-span-2' : ''}`}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`flex h-full w-full items-center justify-center ${className}`}
      style={{ background: playlist.isPinned ? 'rgba(6,214,160,.14)' : 'var(--color-surface)' }}
    >
      {playlist.isPinned ? (
        <svg className="h-[42%] w-[42%]" style={{ color: 'var(--color-accent-cyan)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>
        </svg>
      ) : (
        <svg className="h-[42%] w-[42%] text-white/65" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
        </svg>
      )}
    </div>
  );
}

// ─── SortableSongRow ────────────────────────────────────────────────────────
interface SortableSongRowProps {
  id: string;
  index: number;
  song: Song;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onPlay: () => void;
  onRemove: () => void;
  onMoveTop: () => void;
  onMoveBottom: () => void;
  onSetCover: () => void;
}

function SortableSongRow({
  id, index, song,
  selectionMode, selected,
  onToggleSelect, onPlay, onRemove, onMoveTop, onMoveBottom, onSetCover,
}: SortableSongRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    background: selected ? 'rgba(6,182,212,0.08)' : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex h-16 items-center gap-2 overflow-hidden border-b border-white/[0.05] px-3 transition-colors hover:bg-white/[0.05]"
    >
      {selectionMode ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="accent-cyan-400 w-4 h-4 cursor-pointer flex-shrink-0"
        />
      ) : (
        <span
          {...attributes}
          {...listeners}
          className="cursor-grab text-neutral-600 hover:text-neutral-400 touch-none flex-shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
          </svg>
        </span>
      )}
      <span className="text-xs w-5 text-center text-neutral-500 flex-shrink-0">{index + 1}</span>
      <div
        className="h-11 w-11 flex-shrink-0 cursor-pointer overflow-hidden rounded-xl shadow-sm"
        style={{ background: 'var(--color-bg)' }}
        onClick={selectionMode ? onToggleSelect : onPlay}
      >
        {song.thumbUrl ? (
          <img src={song.thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-neutral-600">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          </div>
        )}
      </div>
      <div
        className="flex min-w-0 flex-1 cursor-pointer flex-col justify-center overflow-hidden"
        onClick={selectionMode ? onToggleSelect : onPlay}
      >
        <p className="truncate break-all text-sm font-medium leading-5">{song.name}</p>
        <p className="truncate break-all text-xs leading-4 text-neutral-400">{song.artistString}</p>
      </div>
      <div ref={menuRef} className="relative flex-shrink-0">
        <button
          onClick={() => setMenuOpen(v => !v)}
          className="opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity p-2 rounded-lg hover:bg-white/10 text-neutral-400 hover:text-white"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
          </svg>
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full mt-1 md:top-auto md:bottom-full md:mt-0 md:mb-1 z-50 rounded-xl overflow-hidden shadow-xl w-44"
            style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}
          >
            <button className="context-menu-item" onClick={() => { onPlay(); setMenuOpen(false); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              ここから再生
            </button>
            <button className="context-menu-item" onClick={() => { onMoveTop(); setMenuOpen(false); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>
              </svg>
              一番上に移動
            </button>
            <button className="context-menu-item" onClick={() => { onMoveBottom(); setMenuOpen(false); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>
              </svg>
              一番下に移動
            </button>
            <button className="context-menu-item" onClick={() => { onSetCover(); setMenuOpen(false); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
              カバーに設定
            </button>
            <div className="border-t" style={{ borderColor: 'var(--color-border)' }} />
            <button
              className="context-menu-item"
              style={{ color: 'var(--color-error)' }}
              onClick={() => { onRemove(); setMenuOpen(false); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
              </svg>
              削除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PlainSongRow (DnDなし、仮想リスト用) ────────────────────────────────────
const VIRTUAL_THRESHOLD = 200; // これを超えると仮想スクロールに切り替え

interface PlainSongRowProps {
  index: number;
  song: Song;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onPlay: () => void;
  onRemove: () => void;
  onMoveTop: () => void;
  onMoveBottom: () => void;
  onSetCover: () => void;
}

function PlainSongRow({
  index, song, selectionMode, selected,
  onToggleSelect, onPlay, onRemove, onMoveTop, onMoveBottom, onSetCover,
}: PlainSongRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div
      className="group flex h-full min-h-0 items-center gap-2 overflow-hidden border-b border-white/[0.05] px-3 transition-colors hover:bg-white/[0.05]"
      style={{ background: selected ? 'rgba(6,182,212,0.08)' : undefined }}
    >
      {selectionMode ? (
        <input type="checkbox" checked={selected} onChange={onToggleSelect} className="accent-cyan-400 w-4 h-4 cursor-pointer flex-shrink-0" />
      ) : (
        <span className="w-4 flex-shrink-0" />
      )}
      <span className="text-xs w-5 text-center text-neutral-500 flex-shrink-0">{index + 1}</span>
      <div
        className="h-11 w-11 flex-shrink-0 cursor-pointer overflow-hidden rounded-xl shadow-sm"
        style={{ background: 'var(--color-bg)' }}
        onClick={selectionMode ? onToggleSelect : onPlay}
      >
        {song.thumbUrl ? (
          <img src={song.thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-neutral-600">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 cursor-pointer flex-col justify-center overflow-hidden" onClick={selectionMode ? onToggleSelect : onPlay}>
        <p className="truncate break-all text-sm font-medium leading-5">{song.name}</p>
        <p className="truncate break-all text-xs leading-4 text-neutral-400">{song.artistString}</p>
      </div>
      <div ref={menuRef} className="relative flex-shrink-0">
        <button
          onClick={() => setMenuOpen(v => !v)}
          className="opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity p-2 rounded-lg hover:bg-white/10 text-neutral-400 hover:text-white"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
          </svg>
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 md:top-auto md:bottom-full md:mt-0 md:mb-1 z-50 rounded-xl overflow-hidden shadow-xl w-44"
            style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}>
            <button className="context-menu-item" onClick={() => { onPlay(); setMenuOpen(false); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              ここから再生
            </button>
            <button className="context-menu-item" onClick={() => { onMoveTop(); setMenuOpen(false); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>
              </svg>
              一番上に移動
            </button>
            <button className="context-menu-item" onClick={() => { onMoveBottom(); setMenuOpen(false); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>
              </svg>
              一番下に移動
            </button>
            <button className="context-menu-item" onClick={() => { onSetCover(); setMenuOpen(false); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
              カバーに設定
            </button>
            <div className="border-t" style={{ borderColor: 'var(--color-border)' }} />
            <button className="context-menu-item" style={{ color: 'var(--color-error)' }}
              onClick={() => { onRemove(); setMenuOpen(false); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
              </svg>
              削除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── VirtualSongList (200件超用) ─────────────────────────────────────────────
interface VirtualSongListProps {
  songs: Song[];
  playlistId: string;
  selectionMode: boolean;
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onSetCover: (song: Song) => void;
  onRemoveSong: (globalIndex: number) => void;
  onMoveTop: (globalIndex: number) => void;
  onMoveBottom: (globalIndex: number) => void;
  allSongs: Song[]; // for globalIndex lookup
}

function VirtualSongList({
  songs, selectionMode, selectedIds,
  onToggleSelect, onSetCover, onRemoveSong, onMoveTop, onMoveBottom, allSongs,
}: VirtualSongListProps) {
  const { setQueue } = usePlayerStore();
  const parentRef = useRef<HTMLDivElement>(null);
  const ROW_HEIGHT = 64;

  const rowVirtualizer = useVirtualizer({
    count: songs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div
      ref={parentRef}
      className="rounded-xl overflow-y-auto overflow-x-hidden"
      style={{
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-card)',
        height: 'min(calc(100dvh - 400px), 600px)',
        maxHeight: '600px',
      }}
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map(virtualItem => {
          const song = songs[virtualItem.index];
          const globalIndex = allSongs.findIndex(s => s.id === song.id);
          return (
            <div
              key={virtualItem.key}
              style={{
                position: 'absolute',
                top: virtualItem.start,
                width: '100%',
                height: ROW_HEIGHT,
              }}
            >
              <PlainSongRow
                index={virtualItem.index}
                song={song}
                selectionMode={selectionMode}
                selected={selectedIds.has(song.id)}
                onToggleSelect={() => onToggleSelect(song.id)}
                onPlay={() => setQueue(songs, virtualItem.index)}
                onRemove={() => onRemoveSong(globalIndex)}
                onMoveTop={() => onMoveTop(globalIndex)}
                onMoveBottom={() => onMoveBottom(globalIndex)}
                onSetCover={() => onSetCover(song)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

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

// ─── メインコンポーネント ──────────────────────────────────────────────────────
export default function PlaylistPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    playlists, folders,
    loadPlaylists,
    createPlaylist, deletePlaylist, updatePlaylist,
    createSmartPlaylist, replacePlaylistSongs,
    createFolder, deleteFolder,
    addSongs, removeSong, reorderSongs, removeDuplicateSongs,
  } = usePlaylistStore();
  const { setQueue, addToQueue } = usePlayerStore();
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

  const [dupWarning, setDupWarning] = useState<{ count: number } | null>(null);
  const [dedupeNotice, setDedupeNotice] = useState<{ count: number } | null>(null);
  const [importNotice, setImportNotice] = useState<{ name: string; count: number } | null>(null);
  const [showYTImport, setShowYTImport] = useState(false);
  const [shareNotice, setShareNotice] = useState('');
  const [showSmartBuilder, setShowSmartBuilder] = useState(false);
  const [smartName, setSmartName] = useState('');
  const [smartMinYoutube, setSmartMinYoutube] = useState(0);
  const [smartMinNico, setSmartMinNico] = useState(0);
  const [smartExcludeDerived, setSmartExcludeDerived] = useState(false);
  const [smartRefreshStatuses, setSmartRefreshStatuses] = useState<Record<string, {
    state: 'loading' | 'success' | 'error';
    refreshedAt?: number;
    relaxed?: boolean;
  }>>({});
  const smartRefreshRef = useRef<string | null>(null);
  const smartRefreshRetryRef = useRef(new Set<string>());
  const smartRefreshRetryTimerRef = useRef<number | null>(null);
  const [smartRefreshRetryTick, setSmartRefreshRetryTick] = useState(0);

  useEffect(() => { loadPlaylists(); }, [loadPlaylists]);

  useEffect(() => {
    storage.set(PLAYLIST_LIST_PREFERENCES_KEY, playlistListPreferences);
  }, [playlistListPreferences]);

  useEffect(() => {
    const encoded = searchParams.get('share');
    if (!encoded) return;
    const payload = decodePlaylistShare(encoded);
    if (!payload) {
      setShareNotice('共有リンクを読み込めませんでした。');
      navigate('/playlists', { replace: true });
      return;
    }
    const imported = createPlaylist(`${payload.name} (共有)`, selectedFolderId ?? undefined);
    updatePlaylist(imported.id, { description: payload.description, coverArtUrl: payload.coverArtUrl });
    addSongs(imported.id, payload.songs);
    setSelectedPlaylistId(imported.id);
    setShareNotice(`${payload.name} を共有リンクから追加しました。`);
    navigate('/playlists', { replace: true });
  }, [addSongs, createPlaylist, navigate, searchParams, selectedFolderId, updatePlaylist]);

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
      const raw = rule.producerId
        ? (await getSongsByProducer([rule.producerId], 0, 100, 0)).items
        : (await searchSongs({ sort: 'AdditionDate', maxResults: 100, start: 0, getTotalCount: false, onlyWithPVs: true })).items;
      const result = applyDiscoveryFilterWithRelaxation(raw, {
        settings: {
        enabled: true,
        minYoutubeViews: rule.minYoutubeViews,
        minNicoViews: rule.minNicoViews,
        excludedSongTypes: rule.excludedSongTypes,
        cooldownHours: 0,
        excludeRatedFromDiscovery: false,
        },
      }, 20);
      replacePlaylistSongs(playlist.id, result.items.slice(0, 200));
      smartRefreshRetryRef.current.delete(playlist.id);
      setSmartRefreshStatuses(current => ({
        ...current,
        [playlist.id]: {
          state: 'success',
          refreshedAt: Date.now(),
          relaxed: result.relaxedConditions.length > 0,
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

  const handleCreateSmart = useCallback(() => {
    const name = smartName.trim() || 'スマートプレイリスト';
    const rule: SmartPlaylistRule = {
      minYoutubeViews: Math.max(0, smartMinYoutube),
      minNicoViews: Math.max(0, smartMinNico),
      excludedSongTypes: smartExcludeDerived ? ['Cover', 'Remix', 'Arrangement', 'Mashup'] : [],
    };
    const playlist = createSmartPlaylist(name, rule, selectedFolderId ?? undefined);
    setSelectedPlaylistId(playlist.id);
    setSmartName('');
    setSmartMinYoutube(0);
    setSmartMinNico(0);
    setSmartExcludeDerived(false);
    setShowSmartBuilder(false);
  }, [createSmartPlaylist, selectedFolderId, smartExcludeDerived, smartMinNico, smartMinYoutube, smartName]);

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
    [...songs].reverse().forEach((s, revIdx) => {
      if (selectedIds.has(s.id)) removeSong(selectedPlaylist.id, songs.length - 1 - revIdx);
    });
    setSelectedIds(new Set());
    setSelectionMode(false);
  }, [selectedPlaylist, selectedIds, removeSong]);

  const removeDuplicatesFromSelectedPlaylist = useCallback(() => {
    if (!selectedPlaylist) return;
    const count = removeDuplicateSongs(selectedPlaylist.id);
    if (count > 0) {
      setSelectedIds(new Set());
      setSelectionMode(false);
      setDedupeNotice({ count });
      setTimeout(() => setDedupeNotice(null), 4000);
    }
  }, [selectedPlaylist, removeDuplicateSongs]);

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
      setDupWarning({ count: result.duplicates });
      setTimeout(() => setDupWarning(null), 4000);
    }
  }, [selectedPlaylist, addSongs]);

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
      setShareNotice('共有リンクをクリップボードにコピーしました。');
    } catch {
      setShareNotice(`共有リンク: ${url}`);
    }
    setTimeout(() => setShareNotice(''), 6000);
  }, []);

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

        setImportNotice({ name: 'プレイリストバックアップ', count: addedSongs });
        setTimeout(() => setImportNotice(null), 4000);
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
      setImportNotice({ name: playlist.name, count: result.added });
      setTimeout(() => setImportNotice(null), 4000);
    } catch {
      window.alert('プレイリストJSONを読み込めませんでした。DIVA PlayerからエクスポートしたJSONを選択してください。');
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
    }
  }, [addSongs, createFolder, createPlaylist, selectedFolderId, updatePlaylist]);

  const handleDelete = useCallback((p: Playlist) => {
    if (p.isPinned) return;
    if (!window.confirm(`"${p.name}" を削除してもよいですか?`)) return;
    deletePlaylist(p.id);
    setSelectedPlaylistId(null);
  }, [deletePlaylist]);

  // サイドバープレイリスト行（コンポーネント内関数）
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
      {shareNotice && (
        <p className="fixed left-1/2 top-20 z-50 -translate-x-1/2 rounded-xl px-4 py-2 text-sm shadow-lg" role="status" style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-accent-cyan)', border: '1px solid var(--color-border)' }}>
          {shareNotice}
        </p>
      )}

      {/* ─── 左サイドバー ───────────────────────────────────────────── */}
      <aside
        className={`w-full min-h-0 flex-shrink-0 flex-col gap-3 overflow-y-auto rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3 md:h-full md:w-72 lg:w-80 ${selectedPlaylist ? 'hidden md:flex' : 'flex'}`}
      >
        <div className="flex items-center justify-between px-1 pt-1">
          <div className="flex items-baseline gap-2">
            <h2 className="text-xl font-bold tracking-tight">プレイリスト</h2>
            <span className="text-xs text-neutral-500">{playlists.length}</span>
          </div>
          <button
            onClick={() => setShowFolderInput(!showFolderInput)}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-neutral-400 transition-all hover:border-white/20 hover:bg-white/10 hover:text-white"
            title="フォルダを作成"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
            </svg>
          </button>
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

        {playlists.some(p => !p.isPinned) && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.07] bg-black/10 p-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-neutral-400">
              <span className="shrink-0">並べ替え</span>
              <select
                className="input min-w-0 flex-1 py-1.5 text-xs"
                value={playlistListPreferences.sortKey}
                onChange={event => setPlaylistListPreferences(current => ({ ...current, sortKey: event.target.value as PlaylistListSortKey }))}
              >
                <option value="updatedAt">更新順</option>
                <option value="name">名前順</option>
                <option value="songCount">曲数順</option>
              </select>
            </label>
            <button
              type="button"
              className="rounded-lg border border-white/10 px-2 py-1.5 text-xs text-neutral-300 hover:bg-white/10"
              onClick={() => setPlaylistListPreferences(current => ({ ...current, sortOrder: current.sortOrder === 'desc' ? 'asc' : 'desc' }))}
              title="並び順を反転"
            >
              {playlistListPreferences.sortOrder === 'desc' ? '降順' : '昇順'}
            </button>
            <button
              type="button"
              className="rounded-lg border border-white/10 px-2 py-1.5 text-xs text-neutral-300 hover:bg-white/10"
              onClick={() => setPlaylistListPreferences(current => ({ ...current, density: current.density === 'comfortable' ? 'compact' : 'comfortable' as PlaylistListDensity }))}
              title="表示密度を切り替え"
            >
              {playlistListPreferences.density === 'comfortable' ? 'コンパクト' : 'ゆったり'}
            </button>
          </div>
        )}

        {/* ピン留め（後で聴く等） */}
        {pinnedPlaylists.length > 0 && (
          <section className="space-y-1">
            <p className="px-2 text-[11px] font-medium text-neutral-500">ピン留め</p>
            {pinnedPlaylists.map(p => <SidebarItem key={p.id} p={p} />)}
          </section>
        )}

        {/* フォルダフィルター */}
        <section className="rounded-2xl bg-black/10 p-1">
          <button
            onClick={() => { setShowAllFolders(true); setSelectedFolderId(null); }}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm transition-colors"
            style={{ background: showAllFolders ? 'rgba(255,255,255,.07)' : 'transparent', color: 'var(--color-text-secondary)' }}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            </svg>
            すべてのプレイリスト
          </button>

          <button
            onClick={() => { setShowAllFolders(false); setSelectedFolderId(null); }}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition-colors"
            style={{ background: !showAllFolders && selectedFolderId === null ? 'rgba(255,255,255,.07)' : 'transparent', color: 'var(--color-text-muted)' }}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4h16v16H4z" />
            </svg>
            フォルダなし
          </button>

          {folders.map(f => (
            <FolderItem key={f.id} folder={f} depth={0}
              selectedFolderId={selectedFolderId}
              onSelect={id => { setShowAllFolders(false); setSelectedFolderId(id); }}
              onDelete={deleteFolder}
            />
          ))}
        </section>

        {/* 通常プレイリスト */}
        <section className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          <p className="px-2 text-[11px] font-medium text-neutral-500">プレイリスト</p>
          {filteredSidebarPlaylists.length === 0 ? (
            <p className="text-xs text-center py-4 text-neutral-500">プレイリストがありません</p>
          ) : filteredSidebarPlaylists.map(p => <SidebarItem key={p.id} p={p} />)}
        </section>

        {/* 新規プレイリスト作成 */}
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
        <button
          type="button"
          className="rounded-xl border border-violet-400/20 bg-violet-400/[0.06] px-3 py-2 text-xs font-medium text-violet-200 transition-colors hover:bg-violet-400/10"
          onClick={() => setShowSmartBuilder(value => !value)}
          aria-expanded={showSmartBuilder}
        >
          {showSmartBuilder ? 'スマート条件を閉じる' : 'スマートプレイリスト+'}
        </button>
        {showSmartBuilder && (
          <div className="rounded-xl p-2 space-y-2" style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}>
            <input className="search-input text-xs w-full" value={smartName} onChange={event => setSmartName(event.target.value)} placeholder="名前（例: 定番曲）" />
            <label className="block text-xs">
              YouTube最低再生数
              <input className="input mt-1 w-full text-xs" type="number" min={0} value={smartMinYoutube} onChange={event => setSmartMinYoutube(Number(event.target.value) || 0)} />
            </label>
            <label className="block text-xs">
              ニコニコ最低再生数
              <input className="input mt-1 w-full text-xs" type="number" min={0} value={smartMinNico} onChange={event => setSmartMinNico(Number(event.target.value) || 0)} />
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={smartExcludeDerived} onChange={event => setSmartExcludeDerived(event.target.checked)} />
              カバー・派生曲を除外
            </label>
            <button type="button" className="btn-primary w-full text-xs" onClick={handleCreateSmart}>条件を保存</button>
          </div>
        )}
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
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-white/[0.07] bg-white/[0.025] px-2 py-2 text-xs text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-white"
            title="DIVA PlayerのプレイリストJSONをインポート"
          >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <path d="M7 10l5-5 5 5"/>
            <path d="M12 5v12"/>
          </svg>
            読み込む
          </button>
          <button
            type="button"
            onClick={exportAllPlaylists}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-white/[0.07] bg-white/[0.025] px-2 py-2 text-xs text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
            disabled={playlists.length === 0}
            title="すべてのプレイリストとフォルダをJSONでバックアップ"
          >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <path d="M7 10l5 5 5-5"/>
            <path d="M12 15V3"/>
          </svg>
            バックアップ
          </button>
        </div>
      </aside>

      {/* ─── 右パネル ────────────────────────────────────────────────── */}
      <main className={`min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto ${selectedPlaylist ? 'block' : 'hidden md:block'}`}>
        {!selectedPlaylist ? (
          <div className="flex h-full min-h-[360px] flex-col items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 text-center">
            <svg className="h-10 w-10 text-neutral-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
            </svg>
            <p className="mt-4 text-sm font-medium text-neutral-300">プレイリストを選択してください</p>
            <p className="mt-1 text-xs text-neutral-500">曲の確認や再生、編集ができます</p>
          </div>
        ) : (
          <>
            <button type="button" className="md:hidden self-start rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-neutral-300" onClick={() => setSelectedPlaylistId(null)}>← ライブラリ</button>
            {/* ヘッダー */}
            <section
              className="flex-shrink-0 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4"
            >
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
                          <>最終更新 {new Date(selectedSmartRefreshStatus.refreshedAt ?? Date.now()).toLocaleTimeString('ja-JP')}{selectedSmartRefreshStatus.relaxed ? '・候補不足のため再生数条件を緩和' : ''}</>
                        )}
                        {selectedSmartRefreshStatus?.state === 'error' && '更新に失敗しました。手動更新してください。'}
                        {!selectedSmartRefreshStatus && '開いたときに自動更新します'}
                      </p>
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
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {selectedPlaylist.songs.length > 0 && (
                      <button onClick={() => setQueue(selectedPlaylist.songs, 0)} className="flex h-10 items-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-black transition-colors hover:bg-neutral-200">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        再生
                      </button>
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
                    <button onClick={() => setShowYTImport(true)} className="flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 text-sm font-medium text-neutral-200 transition-colors hover:bg-white/10" title="YouTubeプレイリストからインポート">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#ff0000' }}>
                        <path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.51 3.5 12 3.5 12 3.5s-7.51 0-9.38.55A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14C4.49 20.5 12 20.5 12 20.5s7.51 0 9.38-.55a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.75 15.52V8.48L15.5 12l-5.75 3.52z"/>
                      </svg>
                      YouTube
                    </button>
                    <button onClick={() => exportPlaylist(selectedPlaylist)} className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-neutral-300 transition-colors hover:bg-white/10 hover:text-white" title="JSONエクスポート">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <path d="M7 10l5 5 5-5"/>
                        <path d="M12 15V3"/>
                      </svg>
                    </button>
                    <button onClick={() => void sharePlaylist(selectedPlaylist)} className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-neutral-300 transition-colors hover:bg-white/10 hover:text-white" title="共有リンクをコピー" aria-label="共有リンクをコピー">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                        <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>
                      </svg>
                    </button>
                    {!selectedPlaylist.isPinned && (
                      <>
                        <button onClick={() => openEdit(selectedPlaylist)} className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-neutral-300 transition-colors hover:bg-white/10 hover:text-white" title="編集">
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </button>
                        <button onClick={() => handleDelete(selectedPlaylist)} className="flex h-10 w-10 items-center justify-center rounded-full border border-red-400/15 bg-red-400/[0.04] transition-colors hover:bg-red-400/10" title="削除" style={{ color: 'var(--color-error)' }}>
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* ツールバー */}
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
                  className="rounded-lg border px-3 py-1.5 text-xs transition-colors"
                  style={{
                    borderColor: selectionMode ? '#06b6d4' : 'var(--color-border)',
                    color: selectionMode ? '#06b6d4' : 'var(--color-text-secondary)',
                    background: selectionMode ? 'rgba(6,182,212,0.1)' : 'transparent',
                  }}
                >{selectionMode ? '選択解除' : '選択'}</button>
                {selectionMode && (
                  <button onClick={selectAll} className="rounded-lg border px-3 py-1.5 text-xs transition-colors"
                    style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
                  >すべて選択</button>
                )}
              </div>
            )}

            {/* 重複警告 */}
            {dupWarning && (
              <div className="text-sm px-4 py-2 rounded-xl" style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}>
                {dupWarning.count} 曲は既にプレイリストにあるためスキップしました
              </div>
            )}
            {dedupeNotice && (
              <div className="text-sm px-4 py-2 rounded-xl" style={{ background: 'rgba(34,197,94,0.14)', color: '#86efac', border: '1px solid rgba(34,197,94,0.3)' }}>
                {dedupeNotice.count} 曲の重複を削除しました
              </div>
            )}
            {importNotice && (
              <div className="text-sm px-4 py-2 rounded-xl" style={{ background: 'rgba(34,211,238,0.12)', color: 'var(--color-accent-cyan)', border: '1px solid rgba(34,211,238,0.28)' }}>
                「{importNotice.name}」をインポートしました ({importNotice.count} 曲)
              </div>
            )}

            {/* 曲リスト */}
            {filteredSongs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-neutral-500">
                {filterText ? (
                  <>
                    <svg className="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                    </svg>
                    <p className="text-sm">「{filterText}」に一致する曲はありません</p>
                  </>
                ) : (
                  <>
                    <svg className="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                      <path d="M12 5v14m-7-7h14"/>
                    </svg>
                    <p className="text-sm">曲がありません</p>
                    <p className="text-xs">検索から曲を追加するか、YouTube インポートを使用してください</p>
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
                    onRemoveSong={idx => removeSong(selectedPlaylist.id, idx)}
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
                            onRemove={() => removeSong(selectedPlaylist.id, globalIndex)}
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
                          onRemove={() => removeSong(selectedPlaylist.id, globalIndex)}
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
          className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-2xl shadow-2xl"
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
          <div className="rounded-2xl p-6 w-full max-w-md flex flex-col gap-4"
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

      {/* ─── YouTube インポートモーダル ──────────────────────────────── */}
      {showYTImport && selectedPlaylist && (
        <YouTubeImportModal onClose={() => setShowYTImport(false)} onImport={handleYTImport} />
      )}
    </div>
  );
}

