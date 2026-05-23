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
import { useEffect, useState, useRef, useCallback } from 'react';
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
import type { Playlist, PlaylistFolder, Song } from '../types/vocadb';
import YouTubeImportModal from '../components/playlist/YouTubeImportModal';

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
      className="flex items-center gap-2 px-3 py-2 rounded-lg group hover:bg-white/5 transition-colors"
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
        className="w-9 h-9 rounded flex-shrink-0 overflow-hidden cursor-pointer"
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
        className="flex-1 min-w-0 cursor-pointer"
        onClick={selectionMode ? onToggleSelect : onPlay}
      >
        <p className="text-sm font-medium truncate">{song.name}</p>
        <p className="text-xs truncate text-neutral-400">{song.artistString}</p>
      </div>
      <div ref={menuRef} className="relative flex-shrink-0">
        <button
          onClick={() => setMenuOpen(v => !v)}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg hover:bg-white/10 text-neutral-400 hover:text-white"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
          </svg>
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 bottom-full mb-1 z-50 rounded-xl overflow-hidden shadow-xl w-44"
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
      className="flex items-center gap-2 px-3 py-2 rounded-lg group hover:bg-white/5 transition-colors"
      style={{ background: selected ? 'rgba(6,182,212,0.08)' : undefined }}
    >
      {selectionMode ? (
        <input type="checkbox" checked={selected} onChange={onToggleSelect} className="accent-cyan-400 w-4 h-4 cursor-pointer flex-shrink-0" />
      ) : (
        <span className="w-4 flex-shrink-0" />
      )}
      <span className="text-xs w-5 text-center text-neutral-500 flex-shrink-0">{index + 1}</span>
      <div
        className="w-9 h-9 rounded flex-shrink-0 overflow-hidden cursor-pointer"
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
      <div className="flex-1 min-w-0 cursor-pointer" onClick={selectionMode ? onToggleSelect : onPlay}>
        <p className="text-sm font-medium truncate">{song.name}</p>
        <p className="text-xs truncate text-neutral-400">{song.artistString}</p>
      </div>
      <div ref={menuRef} className="relative flex-shrink-0">
        <button
          onClick={() => setMenuOpen(v => !v)}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg hover:bg-white/10 text-neutral-400 hover:text-white"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
          </svg>
        </button>
        {menuOpen && (
          <div className="absolute right-0 bottom-full mb-1 z-50 rounded-xl overflow-hidden shadow-xl w-44"
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
  const ROW_HEIGHT = 52;

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
        height: 'min(calc(100vh - 400px), 600px)',
        maxHeight: '600px',
      }}
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map(virtualItem => {
          const song = songs[virtualItem.index];
          const globalIndex = allSongs.findIndex(s => s.id === song.id);
          return (
            <div
              key={song.id}
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
  const {
    playlists, folders,
    loadPlaylists,
    createPlaylist, deletePlaylist, updatePlaylist,
    createFolder, deleteFolder,
    addSongs, removeSong, reorderSongs, sortSongs,
  } = usePlaylistStore();
  const { setQueue, addToQueue } = usePlayerStore();

  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId]     = useState<string | null>(null);
  const [newName, setNewName]                       = useState('');
  const [newFolderName, setNewFolderName]           = useState('');
  const [showFolderInput, setShowFolderInput]       = useState(false);

  const [filterText, setFilterText]     = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds]   = useState<Set<number>>(new Set());

  const [editingPlaylist, setEditingPlaylist] = useState<Playlist | null>(null);
  const [editName, setEditName]   = useState('');
  const [editDesc, setEditDesc]   = useState('');
  const [editCover, setEditCover] = useState('');
  const [editFolderId, setEditFolderId] = useState<string>('');

  const [dupWarning, setDupWarning] = useState<{ count: number } | null>(null);
  const [showYTImport, setShowYTImport] = useState(false);

  useEffect(() => { loadPlaylists(); }, [loadPlaylists]);

  useEffect(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setFilterText('');
  }, [selectedPlaylistId]);

  const selectedPlaylist = playlists.find(p => p.id === selectedPlaylistId) ?? null;
  const pinnedPlaylists = playlists.filter(p => p.isPinned);
  const filteredSidebarPlaylists = selectedFolderId
    ? playlists.filter(p => !p.isPinned && p.folderId === selectedFolderId)
    : playlists.filter(p => !p.isPinned && !p.folderId);

  const filteredSongs = (selectedPlaylist?.songs ?? []).filter(s => {
    if (!filterText.trim()) return true;
    const q = filterText.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.artistString ?? '').toLowerCase().includes(q);
  });

  const handleCreate = useCallback(() => {
    if (!newName.trim()) return;
    const p = createPlaylist(newName.trim(), selectedFolderId ?? undefined);
    setNewName('');
    setSelectedPlaylistId(p.id);
  }, [newName, selectedFolderId, createPlaylist]);

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
    const fromIndex = songs.findIndex(s => String(s.id) === active.id);
    const toIndex   = songs.findIndex(s => String(s.id) === over.id);
    if (fromIndex !== -1 && toIndex !== -1) reorderSongs(selectedPlaylist.id, fromIndex, toIndex);
  }, [selectedPlaylist, reorderSongs]);

  const toggleSelect = useCallback((songId: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(songId) ? next.delete(songId) : next.add(songId);
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

  const addSelectedToQueue = useCallback(() => {
    if (!selectedPlaylist) return;
    selectedPlaylist.songs.filter(s => selectedIds.has(s.id)).forEach(s => addToQueue(s));
    setSelectedIds(new Set());
    setSelectionMode(false);
  }, [selectedPlaylist, selectedIds, addToQueue]);

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

  const handleDelete = useCallback((p: Playlist) => {
    if (p.isPinned) return;
    if (!window.confirm(`"${p.name}" を削除してもよいですか?`)) return;
    deletePlaylist(p.id);
    setSelectedPlaylistId(null);
  }, [deletePlaylist]);

  // サイドバープレイリスト行（コンポーネント内関数）
  const SidebarItem = ({ p }: { p: Playlist }) => (
    <button
      onClick={() => setSelectedPlaylistId(p.id)}
      className="w-full flex items-center gap-2 px-2 py-2 rounded-xl text-left group"
      style={{
        background: selectedPlaylistId === p.id ? 'var(--color-bg-hover)' : 'transparent',
        color: 'var(--color-text-primary)',
        border: p.isPinned && selectedPlaylistId !== p.id ? '1px solid rgba(6,182,212,0.15)' : '1px solid transparent',
      }}
    >
      <div
        className="w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center overflow-hidden"
        style={{ background: 'var(--color-bg)' }}
      >
        {p.isPinned ? (
          <svg className="w-4 h-4" style={{ color: 'var(--color-accent-cyan)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
        ) : p.coverArtUrl ? (
          <img src={p.coverArtUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <svg className="w-4 h-4 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
          </svg>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{p.name}</p>
        <p className="text-xs text-neutral-500">{p.songs.length} 曲</p>
      </div>
    </button>
  );

  return (
    <div className="flex gap-4 px-4 py-4" style={{ minHeight: 'calc(100vh - 160px)' }}>

      {/* ─── 左サイドバー ───────────────────────────────────────────── */}
      <div className="w-64 flex-shrink-0 flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 180px)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">プレイリスト</h2>
          <button
            onClick={() => setShowFolderInput(!showFolderInput)}
            className="p-1 rounded hover:text-white text-neutral-500 transition-colors"
            title="フォルダを作成"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
            </svg>
          </button>
        </div>

        {showFolderInput && (
          <div className="flex gap-1">
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

        {/* ピン留め（後で聴く等） */}
        {pinnedPlaylists.map(p => <SidebarItem key={p.id} p={p} />)}
        {pinnedPlaylists.length > 0 && <div className="border-t" style={{ borderColor: 'var(--color-border)' }} />}

        {/* フォルダフィルター */}
        <button
          onClick={() => setSelectedFolderId(null)}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-left"
          style={{ background: selectedFolderId === null ? 'var(--color-bg-hover)' : 'transparent', color: 'var(--color-text-secondary)' }}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
          すべて
        </button>

        {folders.map(f => (
          <FolderItem key={f.id} folder={f} depth={0}
            selectedFolderId={selectedFolderId}
            onSelect={id => setSelectedFolderId(id)}
            onDelete={deleteFolder}
          />
        ))}

        <div className="border-t" style={{ borderColor: 'var(--color-border)' }} />

        {/* 通常プレイリスト */}
        <div className="space-y-0.5 flex-1">
          {filteredSidebarPlaylists.length === 0 ? (
            <p className="text-xs text-center py-4 text-neutral-500">プレイリストがありません</p>
          ) : filteredSidebarPlaylists.map(p => <SidebarItem key={p.id} p={p} />)}
        </div>

        {/* 新規プレイリスト作成 */}
        <div className="flex gap-1 mt-auto pt-2">
          <input
            type="text" value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder="新しいプレイリスト..." className="search-input text-xs flex-1"
            style={{ paddingLeft: '0.5rem' }}
          />
          <button className="btn-primary text-xs px-2" onClick={handleCreate}>+</button>
        </div>
      </div>

      {/* ─── 右パネル ────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 180px)' }}>
        {!selectedPlaylist ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-neutral-500">
            <svg className="w-16 h-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
            </svg>
            <p>プレイリストを選択してください</p>
          </div>
        ) : (
          <>
            {/* ヘッダー */}
            <div className="flex items-start gap-4">
              <div
                className="w-28 h-28 rounded-2xl flex-shrink-0 flex items-center justify-center overflow-hidden"
                style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}
              >
                {selectedPlaylist.isPinned ? (
                  <svg className="w-12 h-12" style={{ color: 'var(--color-accent-cyan)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                ) : selectedPlaylist.coverArtUrl ? (
                  <img src={selectedPlaylist.coverArtUrl} alt="" className="w-full h-full object-cover" />
                ) : selectedPlaylist.songs[0]?.thumbUrl ? (
                  <img src={selectedPlaylist.songs[0].thumbUrl} alt="" className="w-full h-full object-cover opacity-60" />
                ) : (
                  <svg className="w-12 h-12 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">

                    <h1 className="text-2xl font-bold truncate">{selectedPlaylist.name}</h1>
                    {selectedPlaylist.description && (
                      <p className="text-sm mt-1 line-clamp-2 text-neutral-400">{selectedPlaylist.description}</p>
                    )}
                    <p className="text-sm mt-1 text-neutral-500">
                      {selectedPlaylist.songs.length} 曲
                      {filterText && filteredSongs.length !== selectedPlaylist.songs.length && (
                        <span className="ml-2 text-cyan-400">（フィルター中: {filteredSongs.length} 曲）</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {selectedPlaylist.songs.length > 0 && (
                      <button onClick={() => setQueue(selectedPlaylist.songs, 0)} className="btn-primary flex items-center gap-1.5 text-sm px-3 py-2">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        再生
                      </button>
                    )}
                    <button onClick={() => setShowYTImport(true)} className="btn-secondary flex items-center gap-1.5 text-sm px-3 py-2" title="YouTubeプレイリストからインポート">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#ff0000' }}>
                        <path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.51 3.5 12 3.5 12 3.5s-7.51 0-9.38.55A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14C4.49 20.5 12 20.5 12 20.5s7.51 0 9.38-.55a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.75 15.52V8.48L15.5 12l-5.75 3.52z"/>
                      </svg>
                      YT
                    </button>
                    {!selectedPlaylist.isPinned && (
                      <>
                        <button onClick={() => openEdit(selectedPlaylist)} className="btn-ghost p-2 rounded-xl" title="編集">
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </button>
                        <button onClick={() => handleDelete(selectedPlaylist)} className="btn-ghost p-2 rounded-xl" title="削除" style={{ color: 'var(--color-error)' }}>
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
            </div>

            {/* ツールバー */}
            {selectedPlaylist.songs.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                  </svg>
                  <input
                    type="text" value={filterText} onChange={e => setFilterText(e.target.value)}
                    placeholder="曲をフィルター..." className="search-input text-xs pl-8 pr-6 py-1.5 w-48"
                  />
                  {filterText && (
                    <button onClick={() => setFilterText('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                  )}
                </div>
                <span className="text-xs text-neutral-500">並べ替え:</span>
                {(['addedOrder', 'name', 'artist', 'publishDate'] as SortKey[]).map(key => (
                  <button key={key} onClick={() => sortSongs(selectedPlaylist.id, key)}
                    className="text-xs px-2 py-1 rounded-lg border hover:bg-white/5 transition-colors"
                    style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
                  >
                    {{ addedOrder: '追加順', name: '曲名', artist: 'アーティスト', publishDate: '公開日' }[key]}
                  </button>
                ))}
                <div className="flex-1" />
                <button
                  onClick={() => { setSelectionMode(v => !v); clearSelection(); }}
                  className="text-xs px-3 py-1 rounded-lg border transition-colors"
                  style={{
                    borderColor: selectionMode ? '#06b6d4' : 'var(--color-border)',
                    color: selectionMode ? '#06b6d4' : 'var(--color-text-secondary)',
                    background: selectionMode ? 'rgba(6,182,212,0.1)' : 'transparent',
                  }}
                >{selectionMode ? '選択解除' : '選択'}</button>
                {selectionMode && (
                  <button onClick={selectAll} className="text-xs px-3 py-1 rounded-lg border transition-colors"
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
                    {filteredSongs.length} 件（大きいプレイリストは仮想スクロール表示・並べ替え不可）
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
              ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={filteredSongs.map(s => String(s.id))} strategy={verticalListSortingStrategy}>
                  <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--color-border)', background: 'var(--color-bg-card)' }}>
                    {filteredSongs.map((song, filteredIdx) => {
                      const globalIndex = selectedPlaylist.songs.findIndex(s => s.id === song.id);
                      return (
                        <SortableSongRow
                          key={song.id}
                          id={String(song.id)}
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
              )
            )}
          </>
        )}
      </div>

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

