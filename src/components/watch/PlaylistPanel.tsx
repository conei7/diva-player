import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import { useQueueRecommendationStore } from '../../stores/queueRecommendationStore';
import { useRecommendationDisplayStore } from '../../stores/recommendationDisplayStore';
import { useAutoQueueStatusStore } from '../../stores/autoQueueStatusStore';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { displayQueueTitle } from '../../utils/displayNames';
import IconButton from '../ui/IconButton';
import Menu, { MenuItem } from '../ui/Menu';
import Dialog from '../ui/Dialog';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  MoreVertIcon,
  PlaylistAddIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  SkipNextIcon,
  SkipPreviousIcon,
  SpinnerIcon,
  TrashIcon,
} from '../ui/icons';
import { cx } from '../ui/overlay';
import QueueRow from './QueueRow';
import type { QueueView } from './queueView';
import { useQueueView } from './useQueueView';

/** 「4 / 28」, or 「自動再生」 while an autoplay song plays. */
function usePositionLabel(view: QueueView): string {
  const tk = useTranslate();
  if (view.position) return `${view.position.current} / ${view.position.total}`;
  return view.currentIsAuto ? tk('watchAutoplayDivider') : '';
}

/* ─── ⋮ ─────────────────────────────────────────────────────────────────── */

export function QueueMoreMenu({ view }: { view: QueueView }) {
  const t = useTranslateSourceText();
  const queue = usePlayerStore(state => state.queue);
  const queueIndex = usePlayerStore(state => state.queueIndex);
  const removeDuplicateQueueSongs = usePlayerStore(state => state.removeDuplicateQueueSongs);
  const openSaveToPlaylist = useUiStore(state => state.openSaveToPlaylist);
  const label = t('キューのその他の操作');

  return (
    <Menu trigger={<IconButton label={label} icon={<MoreVertIcon />} />} align="end" label={label}>
      <MenuItem
        icon={<PlaylistAddIcon />}
        disabled={queue.length === 0}
        onSelect={() => openSaveToPlaylist(queue, { source: 'queue', queueIndex })}
      >
        {t('キューをプレイリストに保存')}
      </MenuItem>
      {view.duplicateCount > 0 && (
        <MenuItem icon={<TrashIcon />} onSelect={() => removeDuplicateQueueSongs()}>
          {t('重複を削除（{count}曲）', { count: view.duplicateCount })}
        </MenuItem>
      )}
    </Menu>
  );
}

/* ─── Header ────────────────────────────────────────────────────────────── */

interface QueueHeaderProps {
  view: QueueView;
  /** Queue name (already passed through displayQueueTitle). Omitted when a dialog shows it. */
  title?: string;
  /** Collapse / close button at the right of the title. */
  end?: ReactNode;
  className?: string;
}

/** Queue name, 「{current} / {total}」, previous · next · repeat · shuffle and ⋮. */
export function QueueHeader({ view, title, end, className }: QueueHeaderProps) {
  const t = useTranslateSourceText();
  const queueLength = usePlayerStore(state => state.queue.length);
  const previous = usePlayerStore(state => state.previous);
  const next = usePlayerStore(state => state.next);
  const loopMode = usePlayerStore(state => state.loopMode);
  const toggleLoopMode = usePlayerStore(state => state.toggleLoopMode);
  const shuffleEnabled = usePlayerStore(state => state.shuffleEnabled);
  const toggleShuffle = usePlayerStore(state => state.toggleShuffle);
  const position = usePositionLabel(view);
  const loopLabel = loopMode === 'one' ? t('ループ: 1曲') : loopMode === 'all' ? t('ループ: すべて') : t('ループ: オフ');
  const canGoNext = Boolean(view.nextSong) || (queueLength > 0 && loopMode !== 'none');

  return (
    <div className={cx('shrink-0 px-4 pb-1 pt-3', className)}>
      {(title !== undefined || end) && (
        <div className="flex items-start gap-2">
          {title !== undefined && (
            <h2 className="min-w-0 flex-1 truncate text-xl font-bold leading-7 text-yt-text">{title}</h2>
          )}
          {end && <div className="-mr-2 -mt-1.5 ml-auto flex shrink-0 items-center">{end}</div>}
        </div>
      )}
      {position && <p className="text-xs leading-[18px] text-yt-text-secondary tabular-nums">{position}</p>}
      <div className="-ml-2 mt-1 flex items-center">
        <IconButton label={t('前の曲')} icon={<SkipPreviousIcon />} onClick={previous} disabled={queueLength === 0} />
        <IconButton label={t('次の曲')} icon={<SkipNextIcon />} onClick={next} disabled={!canGoNext} />
        <IconButton
          label={loopLabel}
          icon={loopMode === 'one' ? <RepeatOneIcon /> : <RepeatIcon />}
          pressed={loopMode !== 'none'}
          onClick={toggleLoopMode}
        />
        <IconButton
          label={t('シャッフル')}
          icon={<ShuffleIcon />}
          pressed={shuffleEnabled}
          onClick={toggleShuffle}
          disabled={queueLength < 2 && !shuffleEnabled}
        />
        <div className="-mr-2 ml-auto">
          <QueueMoreMenu view={view} />
        </div>
      </div>
    </div>
  );
}

/* ─── List ──────────────────────────────────────────────────────────────── */

interface QueueListProps {
  view: QueueView;
  /** true: the list is its own scroll area (panel, drawer). false: the surrounding dialog scrolls. */
  scroll?: boolean;
  /** Changing this scrolls the playing row to the top of the list (e.g. when the drawer opens). */
  revealKey?: unknown;
  onJumped?: () => void;
  className?: string;
}

/** Rows (window of ten played songs + the rest), a 「自動再生」 divider before autoplay songs, and the refill state. */
export function QueueList({ view, scroll = true, revealKey, onJumped, className }: QueueListProps) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const queueIndex = usePlayerStore(state => state.queueIndex);
  const jumpToIndex = usePlayerStore(state => state.jumpToIndex);
  const recommendations = useQueueRecommendationStore(state => state.recommendations);
  const showHints = useRecommendationDisplayStore(state => state.showHints);
  const status = useAutoQueueStatusStore(state => state.status);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);

  // Keep the playing row visible inside the list without scrolling the page.
  useEffect(() => {
    const container = containerRef.current;
    const row = currentRef.current;
    if (!scroll || !container || !row) return;
    const box = container.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < box.top) container.scrollTop += rowBox.top - box.top;
    else if (rowBox.bottom > box.bottom) container.scrollTop += rowBox.bottom - box.bottom;
  }, [queueIndex, scroll]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const row = currentRef.current;
    if (!row || revealKey === undefined || revealKey === false) return;
    if (scroll && container) {
      container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top;
    } else if (!scroll) {
      // Inside a dialog (the dialog panel scrolls): bring the playing row into the middle.
      row.scrollIntoView({ block: 'center' });
    }
  }, [revealKey, scroll]);

  const jump = (index: number) => {
    jumpToIndex(index);
    onJumped?.();
  };

  const body = (
    <>
      {view.segments.map(segment => (
        <Fragment key={`${segment.auto ? 'auto' : 'own'}-${segment.entries[0]?.index ?? 0}`}>
          {segment.auto && (
            <div className="px-4 pb-1 pt-3 text-xs font-medium leading-4 text-yt-text-secondary">
              {tk('watchAutoplayDivider')}
            </div>
          )}
          <ul className="px-1">
            {segment.entries.map(entry => (
              <QueueRow
                key={`${entry.song.id}-${entry.index}`}
                song={entry.song}
                index={entry.index}
                current={entry.index === queueIndex}
                hint={showHints ? recommendations[String(entry.song.id)]?.reasonText : undefined}
                onJump={jump}
                rowRef={entry.index === queueIndex ? currentRef : undefined}
              />
            ))}
          </ul>
        </Fragment>
      ))}
      {(status === 'fetching' || status === 'reranking') && (
        <div className="flex items-center gap-2 px-4 py-3 text-xs leading-4 text-yt-text-secondary">
          <SpinnerIcon size={16} />
          {t('曲を追加中…')}
        </div>
      )}
      {status === 'exhausted' && (
        <p className="px-4 py-3 text-xs leading-4 text-yt-text-secondary">{t('追加できる曲がありません')}</p>
      )}
    </>
  );

  if (!scroll) return <div className={cx('pb-2', className)}>{body}</div>;
  return (
    <div ref={containerRef} className={cx('min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2', className)}>
      {body}
    </div>
  );
}

/* ─── Collapsed bar ─────────────────────────────────────────────────────── */

function CollapsedBar({ view, title, expandLabel, onExpand, className }: {
  view: QueueView;
  title: string;
  expandLabel: string;
  onExpand: () => void;
  className?: string;
}) {
  const t = useTranslateSourceText();
  const next = usePlayerStore(state => state.next);
  const position = usePositionLabel(view);
  const meta = position ? `${title} · ${position}` : title;

  return (
    <div className={cx('flex items-center gap-1 py-2 pl-4 pr-2', className)}>
      <button
        type="button"
        onClick={onExpand}
        aria-expanded={false}
        className="min-h-10 min-w-0 flex-1 cursor-pointer rounded-chip text-left outline-none focus-visible:outline-2 focus-visible:outline-yt-focus"
      >
        <span className="block truncate text-sm font-bold leading-5 text-yt-text">
          {view.nextSong ? t('次の曲: {song}', { song: view.nextSong.name }) : t('最後の曲です')}
        </span>
        <span className="block truncate text-xs leading-[18px] text-yt-text-secondary tabular-nums">{meta}</span>
      </button>
      <IconButton label={t('次の曲')} icon={<SkipNextIcon />} onClick={next} disabled={!view.nextSong} />
      <IconButton label={expandLabel} icon={<ChevronDownIcon />} onClick={onExpand} aria-expanded={false} />
    </div>
  );
}

/* ─── Panel ─────────────────────────────────────────────────────────────── */

interface PlaylistPanelProps {
  /**
   * inline: collapsible box (watch page side column, or under the video on tablets).
   * sheet: a bar under the video that opens the list in a bottom sheet (phones).
   */
  variant?: 'inline' | 'sheet';
  /** Start collapsed even for playlists (single-column layouts keep the title in view). */
  startCollapsed?: boolean;
  className?: string;
}

/**
 * 再生中リスト (DESIGN_SPEC §6.4.1 / §6.4.2). Shown while the queue has two or more songs.
 * Playlists start expanded, mixes (autoplay / discovery / chorus highlights) collapsed.
 */
export default function PlaylistPanel({ variant = 'inline', startCollapsed = false, className }: PlaylistPanelProps) {
  const t = useTranslateSourceText();
  const { queue, queueTitle, view } = useQueueView();
  const title = displayQueueTitle(queueTitle, t) || t('キュー');
  const defaultExpanded = variant === 'inline' && !startCollapsed && !view.isMix;
  // Reset to the default whenever another queue (another name) starts.
  const [expandState, setExpandState] = useState({ identity: queueTitle, expanded: defaultExpanded });
  const expanded = expandState.identity === queueTitle ? expandState.expanded : defaultExpanded;
  const setExpanded = (value: boolean) => setExpandState({ identity: queueTitle, expanded: value });
  const [sheetOpen, setSheetOpen] = useState(false);

  if (queue.length < 2) return null;

  if (variant === 'sheet') {
    return (
      <section aria-label={title} className={cx('bg-yt-raised', className)}>
        <CollapsedBar view={view} title={title} expandLabel={t('キューを開く')} onExpand={() => setSheetOpen(true)} />
        <Dialog
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title={title}
          mobile="sheet"
          size="md"
          bodyClassName="px-0!"
        >
          <QueueHeader view={view} className="pt-0" />
          <QueueList view={view} scroll={false} revealKey={sheetOpen} onJumped={() => setSheetOpen(false)} />
        </Dialog>
      </section>
    );
  }

  if (!expanded) {
    return (
      <section aria-label={title} className={cx('overflow-hidden rounded-card border border-yt-divider bg-yt-raised', className)}>
        <CollapsedBar view={view} title={title} expandLabel={t('キューを展開')} onExpand={() => setExpanded(true)} />
      </section>
    );
  }

  return (
    <section
      aria-label={title}
      className={cx(
        'flex max-h-[min(560px,calc(100dvh-176px))] flex-col overflow-hidden rounded-card border border-yt-divider',
        className,
      )}
    >
      <QueueHeader
        view={view}
        title={title}
        className="bg-yt-raised"
        end={(
          <IconButton
            label={t('キューを折りたたむ')}
            icon={<ChevronUpIcon />}
            aria-expanded
            onClick={() => setExpanded(false)}
          />
        )}
      />
      <QueueList view={view} />
    </section>
  );
}
