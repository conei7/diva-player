import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { Playlist, Song } from '../../types/vocadb';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { usePlayerStore } from '../../stores/playerStore';
import { usePlaylistStore, WATCH_LATER_ID, type RemovedSongsSnapshot, type SortKey } from '../../stores/playlistStore';
import { showToast } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { displayPlaylistName } from '../../utils/displayNames';
import { analyzePlaylistHealth, summarizePlaylistHealth } from '../../utils/playlistHealth';
import { isPlaylistEditable } from '../../utils/playlistPermissions';
import { sortPlaylistEntries, type PlaylistEntry } from '../../utils/playlistSorting';
import { getWideSongThumbnailCandidates } from '../../utils/songThumbnail';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import IconButton from '../ui/IconButton';
import InlineNotice from '../ui/InlineNotice';
import { PageShell } from '../ui/PageHeader';
import { SelectionBar } from '../ui/SelectionBar';
import Tooltip from '../ui/Tooltip';
import { DragHandleIcon, PlaylistAddIcon, PlaylistIcon, QueueMusicIcon, SearchIcon, SpinnerIcon, SyncIcon, TrashIcon, TuneIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import PlaylistHealthModal from './PlaylistHealthModal';
import PlaylistHero, { type SmartPlaylistRefreshStatus } from './PlaylistHero';
import PlaylistListHeader from './PlaylistListHeader';
import PlaylistSongRow, { VIRTUAL_THRESHOLD, type PlaylistRowActions } from './PlaylistSongRow';
import { getPlaylistSyncInfo } from './playlistDisplay';
import { addSongsToQueue } from './playlistQueue';

/** Below this width the selection bar's actions are icon buttons (three text buttons don't fit). */
const COMPACT_SELECTION_QUERY = '(max-width: 1023px)';

interface PlaylistDetailProps {
  playlist: Playlist;
  folderName?: string;
  smartStatus?: SmartPlaylistRefreshStatus;
  syncing: boolean;
  onBack: () => void;
  onEdit: (focus?: 'folder') => void;
  onShare: () => void;
  onExport: () => void;
  onDelete: () => void;
  onImportInto: () => void;
  onRefreshSmart: () => void;
  onEditRules: () => void;
  onSyncNow: () => void;
  onUnlinkSync: () => void;
}

interface Entry extends PlaylistEntry {
  /** Stable while songs move: song id + which copy of that song it is. */
  key: string;
}

function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => { ref.current = value; });
  return ref;
}

type RestoreOptions = { allowDuplicateIds?: boolean };

/** 元に戻す of a removal: puts the songs back where they were and says how many came back. */
async function restoreRemovedSongsWithToast(
  snapshot: RemovedSongsSnapshot,
  t: ReturnType<typeof useTranslateSourceText>,
  options?: RestoreOptions,
) {
  const restored = (await usePlaylistStore.getState().restoreRemovedSongs(snapshot, options));
  if (restored > 1) showToast(t('{count}曲を元に戻しました', { count: restored }));
  else if (restored === 1) showToast(t('1曲を元に戻しました'));
}

function SortableRow({ id, title, children }: { id: string; title: string; children: (handle: ReactNode) => ReactNode }) {
  const t = useTranslateSourceText();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    attributes: { roleDescription: t('並べ替えできる曲') },
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    position: 'relative',
    zIndex: isDragging ? 2 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  };
  const label = t('「{title}」を並べ替え', { title });
  const handle = (
    // No tooltip while the row is being moved (it would stay behind at the old place).
    <Tooltip content={isDragging ? '' : label}>
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={label}
        className="reveal-on-hover flex h-10 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-full text-yt-text-secondary transition-colors duration-150 hover:text-yt-text active:cursor-grabbing max-sm:-ml-2 max-sm:w-10"
      >
        <DragHandleIcon size={24} />
      </button>
    </Tooltip>
  );
  return <div ref={setNodeRef} style={style}>{children(handle)}</div>;
}

/** Window-scrolled virtual list for long playlists (no inner scroll box). */
function VirtualRows({ entries, estimate, renderRow }: {
  entries: Entry[];
  estimate: number;
  renderRow: (entry: Entry, position: number) => ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return undefined;
    const measure = () => setScrollMargin(element.getBoundingClientRect().top + window.scrollY);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(document.body);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: entries.length,
    estimateSize: () => estimate,
    overscan: 8,
    scrollMargin,
    getItemKey: index => entries[index]?.key ?? index,
  });

  return (
    <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map(item => {
        const entry = entries[item.index];
        if (!entry) return null;
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start - scrollMargin}px)` }}
          >
            {renderRow(entry, item.index)}
          </div>
        );
      })}
    </div>
  );
}

/** /playlists?list=<id>: hero on the left (≥1280px) or on top, songs on the right. */
export default function PlaylistDetail({
  playlist,
  folderName,
  smartStatus,
  syncing,
  onBack,
  onEdit,
  onShare,
  onExport,
  onDelete,
  onImportInto,
  onRefreshSmart,
  onEditRules,
  onSyncNow,
  onUnlinkSync,
}: PlaylistDetailProps) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const mobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const compactSelection = useMediaQuery(COMPACT_SELECTION_QUERY);
  const editable = isPlaylistEditable(playlist);
  const synced = getPlaylistSyncInfo(playlist) !== null;
  const name = displayPlaylistName(playlist, t);
  const currentSongId = usePlayerStore(state => state.currentSong?.id ?? null);

  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('addedOrder');
  const effectiveSort: SortKey = editable ? sortKey : 'addedOrder';
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [healthOpen, setHealthOpen] = useState(false);

  const allEntries = useMemo<Entry[]>(() => {
    const seen = new Map<number, number>();
    return playlist.songs.map((song, index) => {
      const copy = seen.get(song.id) ?? 0;
      seen.set(song.id, copy + 1);
      return { song, index, key: `${song.id}:${copy}` };
    });
  }, [playlist.songs]);

  const entries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matching = needle
      ? allEntries.filter(entry => entry.song.name.toLocaleLowerCase().includes(needle)
        || (entry.song.artistString ?? '').toLocaleLowerCase().includes(needle))
      : allEntries;
    return sortPlaylistEntries(matching, effectiveSort);
  }, [allEntries, effectiveSort, query]);
  const displayedSongs = useMemo(() => entries.map(entry => entry.song), [entries]);

  const health = useMemo(() => analyzePlaylistHealth(playlist.songs), [playlist.songs]);
  const healthSummary = summarizePlaylistHealth(health);

  // A refreshed / synced / reordered song list makes old positions meaningless. Re-reading the
  // same songs from storage (a new array with the same ids) keeps the selection.
  const songIdsKey = useMemo(() => playlist.songs.map(song => song.id).join(','), [playlist.songs]);
  useEffect(() => { setSelected(new Set()); }, [songIdsKey]);

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelected(new Set());
  }, []);

  useEffect(() => {
    if (!selectionMode) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) exitSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [exitSelection, selectionMode]);

  const removedToast = (snapshot: RemovedSongsSnapshot, options?: RestoreOptions) => {
    const count = snapshot.removed.length;
    showToast(count === 1 ? t('1曲を削除しました') : t('{count}曲を削除しました', { count }), {
      action: { label: t('元に戻す'), onAction: () => restoreRemovedSongsWithToast(snapshot, t, options) },
    });
  };

  // Row callbacks stay the same object so memoized rows only re-render when their own props change.
  const latest = useLatestRef({ playlist, displayedSongs, name });
  const rowActions = useMemo<PlaylistRowActions>(() => ({
    play: position => {
      const { playlist: current, displayedSongs: songs } = latest.current;
      usePlayerStore.getState().setQueue(songs, position, true, 'manual', current.name);
    },
    toggleSelect: index => {
      setSelected(previous => {
        const next = new Set(previous);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
    },
    remove: async index => {
      const { playlist: current, name: playlistName } = latest.current;
      const snapshot = (await usePlaylistStore.getState().removeSong(current.id, index));
      if (!snapshot) return;
      showToast(t('「{name}」から削除しました', { name: playlistName }), {
        // The snapshot keeps the exact position, so a removed duplicate comes back too.
        action: { label: t('元に戻す'), onAction: () => restoreRemovedSongsWithToast(snapshot, t) },
      });
    },
    moveToTop: async index => {
      (await usePlaylistStore.getState().reorderSongs(latest.current.playlist.id, index, 0));
    },
    moveToBottom: async index => {
      const current = latest.current.playlist;
      (await usePlaylistStore.getState().reorderSongs(current.id, index, current.songs.length - 1));
    },
    setThumbnail: async index => {
      const current = latest.current.playlist;
      const song = current.songs[index];
      if (!song) return;
      (await usePlaylistStore.getState().updatePlaylist(current.id, {
        coverArtUrl: song.thumbUrl ?? getWideSongThumbnailCandidates(song)[0],
      }));
    },
  }), [latest, t]);

  const playAll = () => {
    if (displayedSongs.length === 0) return;
    usePlayerStore.getState().setQueue(displayedSongs, 0, true, 'manual', playlist.name);
  };
  const shuffle = () => {
    if (playlist.songs.length === 0) return;
    usePlayerStore.getState().setQueueShuffled(playlist.songs, playlist.name);
  };
  const addAllToQueue = () => {
    if (playlist.songs.length === 0) return;
    addSongsToQueue(playlist.songs, playlist.name);
    showToast(t('キューに追加しました'));
  };

  const selectedSongs = (): Song[] => playlist.songs.filter((_, index) => selected.has(index));
  const queueSelected = () => {
    const songs = selectedSongs();
    if (songs.length === 0) return;
    addSongsToQueue(songs, playlist.name);
    showToast(t('キューに追加しました'));
    exitSelection();
  };
  const saveSelected = () => {
    const songs = selectedSongs();
    if (songs.length === 0) return;
    useUiStore.getState().openSaveToPlaylist(songs, { source: 'default', excludePlaylistId: playlist.id });
    exitSelection();
  };
  const { busy: saving, run: runSave } = useAsyncAction();
  const deleteSelected = async () => {
    const snapshot = (await usePlaylistStore.getState().removeSongs(playlist.id, [...selected]));
    exitSelection();
    if (snapshot) removedToast(snapshot);
  };
  const removeDuplicates = async () => {
    const snapshot = (await usePlaylistStore.getState().removeDuplicateSongsWithUndo(playlist.id));
    if (!snapshot) return;
    exitSelection();
    const count = snapshot.removed.length;
    showToast(count === 1 ? t('重複を1曲削除しました') : t('重複を{count}曲削除しました', { count }), {
      action: { label: t('元に戻す'), onAction: () => restoreRemovedSongsWithToast(snapshot, t, { allowDuplicateIds: true }) },
    });
  };
  const removeHealthIssues = async (indexes: number[]) => {
    setHealthOpen(false);
    if (indexes.length === 0) return;
    const snapshot = (await usePlaylistStore.getState().removeSongs(playlist.id, indexes));
    exitSelection();
    if (snapshot) removedToast(snapshot, { allowDuplicateIds: true });
  };

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Screen readers hear the song and its position, in the UI language (not dnd-kit's English and ids).
  const latestEntries = useLatestRef(entries);
  const lastDragOverRef = useRef<UniqueIdentifier | null>(null);
  const dragAccessibility = useMemo(() => {
    const describe = (id: UniqueIdentifier) => {
      const list = latestEntries.current;
      const index = list.findIndex(entry => entry.key === id);
      return { title: list[index]?.song.name ?? '', position: index + 1, total: list.length };
    };
    const screenReaderInstructions: ScreenReaderInstructions = {
      draggable: t('並べ替えるには Space キーで持ち上げ、上下の矢印キーで動かし、もう一度 Space キーで置きます。Esc キーで取り消します'),
    };
    const announcements: Announcements = {
      onDragStart: ({ active }) => {
        lastDragOverRef.current = active.id;
        return t('「{title}」を持ち上げました（{position} / {total}）', describe(active.id));
      },
      // dnd-kit reports the starting place right after the pickup; only say where it moves to.
      onDragOver: ({ active, over }) => {
        if (!over || over.id === lastDragOverRef.current) return undefined;
        lastDragOverRef.current = over.id;
        return t('「{title}」を{position}番目に移動中', { title: describe(active.id).title, position: describe(over.id).position });
      },
      onDragEnd: ({ active, over }) => (over
        ? t('「{title}」を{position}番目に移動しました', { title: describe(active.id).title, position: describe(over.id).position })
        : t('「{title}」の並べ替えを取り消しました', { title: describe(active.id).title })),
      onDragCancel: ({ active }) => t('「{title}」の並べ替えを取り消しました', { title: describe(active.id).title }),
    };
    return { screenReaderInstructions, announcements };
  }, [latestEntries, t]);
  const virtualized = entries.length > VIRTUAL_THRESHOLD;
  // Manual order is on screen (not sorted, not searched): moving songs means something.
  const reorderable = editable && effectiveSort === 'addedOrder' && query.trim() === '';
  const draggable = reorderable && !selectionMode && !virtualized;
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = entries.findIndex(entry => entry.key === active.id);
    const to = entries.findIndex(entry => entry.key === over.id);
    if (from < 0 || to < 0) return;
    (await usePlaylistStore.getState().reorderSongs(playlist.id, entries[from].index, entries[to].index));
  };

  const renderRow = (entry: Entry, position: number, dragHandle?: ReactNode) => (
    <PlaylistSongRow
      song={entry.song}
      index={entry.index}
      position={position}
      lastIndex={playlist.songs.length - 1}
      playlistName={name}
      editable={editable}
      reorderable={reorderable}
      watchLater={playlist.id === WATCH_LATER_ID}
      compact={mobile}
      active={entry.song.id === currentSongId}
      selectionMode={selectionMode}
      selected={selected.has(entry.index)}
      dragHandle={dragHandle}
      actions={rowActions}
    />
  );

  let list: ReactNode;
  if (playlist.songs.length === 0) {
    if (playlist.smartRule && smartStatus?.state === 'loading') {
      list = (
        <div className="flex justify-center py-16 text-yt-text-secondary" role="status" aria-label={t('読み込み中…')}>
          <SpinnerIcon size={32} />
        </div>
      );
    } else if (playlist.smartRule) {
      list = <EmptyState icon={<TuneIcon />} title={tk('playlistSmartEmpty')} action={{ label: t('条件を編集'), onClick: onEditRules }} />;
    } else if (synced) {
      list = <EmptyState icon={<SyncIcon />} title={t('登録済みの曲がまだありません')} action={{ label: t('今すぐ同期'), onClick: onSyncNow }} />;
    } else {
      list = <EmptyState icon={<PlaylistIcon />} title={t('まだ曲がありません')} action={{ label: t('曲を探す'), to: '/' }} />;
    }
  } else if (entries.length === 0) {
    list = <EmptyState icon={<SearchIcon />} title={t('「{query}」に一致する曲はありません', { query: query.trim() })} />;
  } else if (virtualized) {
    list = <VirtualRows entries={entries} estimate={mobile ? 72 : 111} renderRow={(entry, position) => renderRow(entry, position)} />;
  } else if (draggable) {
    list = (
      <DndContext sensors={sensors} collisionDetection={closestCenter} accessibility={dragAccessibility} onDragEnd={event => { void runSave(() => handleDragEnd(event)); }}>
        <SortableContext items={entries.map(entry => entry.key)} strategy={verticalListSortingStrategy}>
          {entries.map((entry, position) => (
            <SortableRow key={entry.key} id={entry.key} title={entry.song.name}>
              {handle => renderRow(entry, position, handle)}
            </SortableRow>
          ))}
        </SortableContext>
      </DndContext>
    );
  } else {
    list = entries.map((entry, position) => <div key={entry.key}>{renderRow(entry, position)}</div>);
  }

  const noticeParts = [
    healthSummary.unplayable > 0 ? t('再生できない曲 {count}', { count: healthSummary.unplayable }) : null,
    healthSummary.duplicates === 1 ? t('重複 1') : healthSummary.duplicates > 1 ? t('重複 {count}', { count: healthSummary.duplicates }) : null,
  ].filter((part): part is string => part !== null);
  const noticeText = noticeParts.length === 2
    ? t('{first}・{second}', { first: noticeParts[0], second: noticeParts[1] })
    : noticeParts[0];

  const nothingSelected = selected.size === 0;

  return (
    <PageShell>
      {/* ≥1280px: the sticky hero may only move inside this box, so it reaches into <main>'s bottom
          space for the mini player (the list keeps that space as its own padding). Otherwise the
          hero would be pushed off the top at the end of the list while a song is playing. */}
      <div className="pb-6 xl:-mb-[var(--floating-player-clearance,0px)] xl:flex xl:items-start xl:gap-6">
        <PlaylistHero
          playlist={playlist}
          folderName={folderName}
          editable={editable}
          duplicateCount={healthSummary.duplicates}
          smartStatus={smartStatus}
          syncing={syncing}
          onBack={mobile ? onBack : undefined}
          onPlayAll={playAll}
          onShuffle={shuffle}
          onAddToQueue={addAllToQueue}
          onEdit={onEdit}
          onShare={onShare}
          onExport={onExport}
          onDelete={onDelete}
          onImportInto={onImportInto}
          onCheckSongs={() => setHealthOpen(true)}
          onRemoveDuplicates={removeDuplicates}
          onRefreshSmart={onRefreshSmart}
          onEditRules={onEditRules}
          onSyncNow={onSyncNow}
          onUnlinkSync={onUnlinkSync}
        />

        <div className={cx('min-w-0 flex-1 xl:pb-[var(--floating-player-clearance,0px)]', mobile ? 'mt-1' : 'mt-4 xl:mt-0')}>
          {playlist.songs.length > 0 && (
            <PlaylistListHeader
              sortable={editable}
              sortKey={effectiveSort}
              onSortChange={setSortKey}
              query={query}
              onQueryChange={setQuery}
              resultCount={entries.length}
              totalCount={playlist.songs.length}
              selectionMode={selectionMode}
              onToggleSelection={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
              mobile={mobile}
            />
          )}
          {editable && noticeText && (
            <InlineNotice tone="warning" className="mb-2 mt-1" action={{ label: tk('playlistReviewIssues'), onClick: () => setHealthOpen(true) }}>
              {noticeText}
            </InlineNotice>
          )}
          <div className={cx(mobile ? '-mx-2' : '-mx-2 xl:mx-0', playlist.songs.length === 0 && 'pt-8')}>
            {list}
          </div>
        </div>
      </div>

      {selectionMode && (
        <SelectionBar
          count={selected.size}
          onClose={exitSelection}
          onSelectAll={() => setSelected(new Set(entries.map(entry => entry.index)))}
          data-testid="playlist-selection-bar"
        >
          {/* Same names and weights as the selection bar of home / song page / history. */}
          {compactSelection ? (
            <>
              <IconButton label={t('キューに追加')} icon={<QueueMusicIcon />} disabled={nothingSelected} onClick={queueSelected} />
              <IconButton label={t('プレイリストに保存')} icon={<PlaylistAddIcon />} disabled={nothingSelected} onClick={saveSelected} />
              {editable && <IconButton label={t('プレイリストから削除')} icon={<TrashIcon />} disabled={nothingSelected || saving} onClick={() => { void runSave(deleteSelected); }} />}
            </>
          ) : (
            <>
              <Button icon={<QueueMusicIcon />} disabled={nothingSelected} onClick={queueSelected}>{t('キューに追加')}</Button>
              <Button variant="primary" icon={<PlaylistAddIcon />} disabled={nothingSelected} onClick={saveSelected}>{t('プレイリストに保存')}</Button>
              {editable && <Button icon={<TrashIcon />} disabled={nothingSelected || saving} onClick={() => { void runSave(deleteSelected); }}>{t('プレイリストから削除')}</Button>}
            </>
          )}
        </SelectionBar>
      )}

      {healthOpen && (
        <PlaylistHealthModal songs={playlist.songs} onClose={() => setHealthOpen(false)} onRemove={indexes => { void runSave(() => removeHealthIssues(indexes)); }} />
      )}
    </PageShell>
  );
}
