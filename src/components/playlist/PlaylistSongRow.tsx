/**
 * PlaylistSongRow – プレイリスト内の曲行コンポーネント群
 *
 * - SortableSongRow: DnD対応の曲行（200件以下の追加順表示で使用）
 * - PlainSongRow: DnDなしの曲行（ソート済み表示・仮想リスト内で使用）
 * - VirtualSongList: 200件超のプレイリスト用仮想スクロールリスト
 */
import { useEffect, useState, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { usePlayerStore } from '../../stores/playerStore';
import type { Song } from '../../types/vocadb';

// ─── 共通メニューボタン ──────────────────────────────────────────────────────
function SongContextMenu({
  onPlay, onMoveTop, onMoveBottom, onSetCover, onRemove,
}: {
  onPlay: () => void;
  onMoveTop: () => void;
  onMoveBottom: () => void;
  onSetCover: () => void;
  onRemove: () => void;
}) {
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
  );
}

// ─── 曲行の共通コンテンツ ────────────────────────────────────────────────────
interface SongRowContentProps {
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
  /** DnD用のドラッグハンドルprops。undefinedの場合はドラッグハンドルなし。 */
  dragHandleProps?: Record<string, unknown>;
}

function SongRowContent({
  index, song, selectionMode, selected,
  onToggleSelect, onPlay, onRemove, onMoveTop, onMoveBottom, onSetCover,
  dragHandleProps,
}: SongRowContentProps) {
  return (
    <>
      {selectionMode ? (
        <input type="checkbox" checked={selected} onChange={onToggleSelect} className="accent-cyan-400 w-4 h-4 cursor-pointer flex-shrink-0" />
      ) : dragHandleProps ? (
        <span {...dragHandleProps} className="cursor-grab text-neutral-600 hover:text-neutral-400 touch-none flex-shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
          </svg>
        </span>
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
      <SongContextMenu onPlay={onPlay} onMoveTop={onMoveTop} onMoveBottom={onMoveBottom} onSetCover={onSetCover} onRemove={onRemove} />
    </>
  );
}

// ─── SortableSongRow ─────────────────────────────────────────────────────────
export interface SortableSongRowProps {
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

export function SortableSongRow({
  id, index, song,
  selectionMode, selected,
  onToggleSelect, onPlay, onRemove, onMoveTop, onMoveBottom, onSetCover,
}: SortableSongRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

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
      <SongRowContent
        index={index} song={song}
        selectionMode={selectionMode} selected={selected}
        onToggleSelect={onToggleSelect} onPlay={onPlay}
        onRemove={onRemove} onMoveTop={onMoveTop} onMoveBottom={onMoveBottom} onSetCover={onSetCover}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

// ─── PlainSongRow ────────────────────────────────────────────────────────────
export interface PlainSongRowProps {
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

export function PlainSongRow({
  index, song, selectionMode, selected,
  onToggleSelect, onPlay, onRemove, onMoveTop, onMoveBottom, onSetCover,
}: PlainSongRowProps) {
  return (
    <div
      className="group flex h-full min-h-0 items-center gap-2 overflow-hidden border-b border-white/[0.05] px-3 transition-colors hover:bg-white/[0.05]"
      style={{ background: selected ? 'rgba(6,182,212,0.08)' : undefined }}
    >
      <SongRowContent
        index={index} song={song}
        selectionMode={selectionMode} selected={selected}
        onToggleSelect={onToggleSelect} onPlay={onPlay}
        onRemove={onRemove} onMoveTop={onMoveTop} onMoveBottom={onMoveBottom} onSetCover={onSetCover}
      />
    </div>
  );
}

// ─── VirtualSongList ─────────────────────────────────────────────────────────
export const VIRTUAL_THRESHOLD = 200;

export interface VirtualSongListProps {
  songs: Song[];
  playlistId: string;
  selectionMode: boolean;
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onSetCover: (song: Song) => void;
  onRemoveSong: (globalIndex: number) => void;
  onMoveTop: (globalIndex: number) => void;
  onMoveBottom: (globalIndex: number) => void;
  allSongs: Song[];
}

export function VirtualSongList({
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
