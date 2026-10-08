/**
 * PlaylistSongRow – プレイリスト内の曲行コンポーネント群
 *
 * - SortableSongRow: DnD対応の曲行（200件以下の追加順表示で使用）
 * - PlainSongRow: DnDなしの曲行（ソート済み表示・仮想リスト内で使用）
 * - VirtualSongList: 200件超のプレイリスト用仮想スクロールリスト
 */
import { useRef } from 'react';
import PlaylistPopoverMenu from './PlaylistPopoverMenu';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { usePlayerStore } from '../../stores/playerStore';
import { useRatingStore } from '../../stores/ratingStore';
import type { Song } from '../../types/vocadb';
import StarRating from '../player/StarRating';
import { useTranslateSourceText } from '../../i18n';

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
  const t = useTranslateSourceText();
  return (
    <PlaylistPopoverMenu trigger={<button type="button" className="flex h-11 w-9 items-center justify-center rounded-lg text-neutral-400 hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-cyan-300" title={t('曲の操作')} aria-label={t('曲の操作')}>•••</button>}>
      <button className="context-menu-item" onClick={onPlay}>{t('ここから再生')}</button>
      <button className="context-menu-item" onClick={onMoveTop}>{t('一番上に移動')}</button>
      <button className="context-menu-item" onClick={onMoveBottom}>{t('一番下に移動')}</button>
      <button className="context-menu-item" onClick={onSetCover}>{t('カバーに設定')}</button>
      <button className="context-menu-item text-red-300" onClick={onRemove}>{t('削除')}</button>
    </PlaylistPopoverMenu>
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
  const rating = useRatingStore(state => state.ratings[String(song.id)] ?? 0);
  const setRating = useRatingStore(state => state.setRating);

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
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate break-all text-xs leading-4 text-neutral-400">{song.artistString}</p>
          <StarRating
            size="sm"
            rating={rating}
            onRate={nextRating => setRating(song.id, nextRating)}
          />
        </div>
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
