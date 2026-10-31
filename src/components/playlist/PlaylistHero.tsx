import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Playlist } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { getSongsRefreshedAt, usePlaylistStore } from '../../stores/playlistStore';
import { displayPlaylistName } from '../../utils/displayNames';
import { canEditPlaylistDetails } from '../../utils/playlistPermissions';
import { describeSmartPlaylistRule } from '../../utils/smartPlaylist';
import { formatCount, formatTotalDuration } from '../../utils/songMeta';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Menu, { MenuDivider, MenuItem } from '../ui/Menu';
import Tooltip from '../ui/Tooltip';
import {
  ArrowBackIcon,
  CheckCircleIcon,
  DownloadIcon,
  EditIcon,
  FolderIcon,
  MoreVertIcon,
  OpenInNewIcon,
  PlayIcon,
  QueueMusicIcon,
  RefreshIcon,
  ShareIcon,
  ShuffleIcon,
  SpinnerIcon,
  SyncIcon,
  TrashIcon,
  TuneIcon,
  UploadIcon,
} from '../ui/icons';
import { cx } from '../ui/overlay';
import { useIsMusicLayout } from '../../hooks/useMusicLayout';
import PlaylistThumbnail from './PlaylistThumbnail';
import { formatSmartRuleItem, getPlaylistCoverCandidates, getPlaylistSyncInfo } from './playlistDisplay';
import { usePlaylistText } from './usePlaylistText';

export interface SmartPlaylistRefreshStatus {
  state: 'loading' | 'success' | 'empty' | 'error';
  refreshedAt?: number;
  matchedCount?: number;
  loadedCount?: number;
}

interface PlaylistHeroProps {
  playlist: Playlist;
  folderName?: string;
  /** Songs can be changed by hand (not smart / synced). */
  editable: boolean;
  duplicateCount: number;
  smartStatus?: SmartPlaylistRefreshStatus;
  syncing: boolean;
  /** Phones only: ← back to the library. */
  onBack?: () => void;
  onPlayAll: () => void;
  onShuffle: () => void;
  onAddToQueue: () => void;
  onEdit: (focus?: 'folder') => void;
  onShare: () => void;
  onExport: () => void;
  onDelete: () => void;
  onImportInto: () => void;
  onCheckSongs: () => void;
  onRemoveDuplicates: () => void;
  onRefreshSmart: () => void;
  onEditRules: () => void;
  onSyncNow: () => void;
  onUnlinkSync: () => void;
}

/**
 * The blurred cover behind the hero (falls through to the next image when one fails). Without an
 * image (empty list, hidden mode, every image failed) a grey surface keeps the hero a panel.
 */
function HeroBackdrop({ playlist }: { playlist: Playlist }) {
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const { coverArtUrl, songs } = playlist;
  const candidates = useMemo(() => getPlaylistCoverCandidates({ coverArtUrl, songs }), [coverArtUrl, songs]);
  const signature = candidates.join('\u0000');
  const [failure, setFailure] = useState({ signature, index: 0 });
  const imageUrl = hiddenMode ? undefined : candidates[failure.signature === signature ? failure.index : 0];
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {imageUrl ? (
        <>
          <img
            key={imageUrl}
            src={imageUrl}
            alt=""
            decoding="async"
            className="absolute inset-0 h-full w-full scale-[1.2] object-cover opacity-50 blur-[48px]"
            onError={() => setFailure(previous => ({
              signature,
              index: (previous.signature === signature ? previous.index : 0) + 1,
            }))}
          />
          <div className="absolute inset-0 bg-[image:var(--hero-gradient)]" />
        </>
      ) : (
        <div data-testid="playlist-hero-surface" className="absolute inset-0 bg-[linear-gradient(to_bottom,var(--color-yt-raised),var(--color-yt-bg))]" />
      )}
    </div>
  );
}

function HeroDescription({ text }: { text: string }) {
  const t = useTranslateSourceText();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return undefined;
    const check = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="mt-3">
      <p ref={ref} className={cx('m-0 whitespace-pre-line text-sm leading-5 text-yt-text-secondary [overflow-wrap:anywhere]', !expanded && 'line-clamp-2')}>
        {text}
      </p>
      {(overflowing || expanded) && (
        <Button variant="text" size="sm" className="-ml-3 mt-1" onClick={() => setExpanded(value => !value)}>
          {expanded ? t('一部を表示') : t('もっと見る')}
        </Button>
      )}
    </div>
  );
}

const RULE_CHIP_CLASS = 'h-6 shrink-0 whitespace-nowrap rounded-badge bg-yt-tonal px-2 text-xs leading-6 text-yt-text';
const RULE_CHIP_GAP = 4;
const RULE_MORE_WIDTH = 36;

/** One line of rule chips: as many as fit, then 「+N」. Pressing it opens the rule editor. */
function RuleChips({ items, onEdit }: { items: string[]; onEdit: () => void }) {
  const t = useTranslateSourceText();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const row = measureRef.current;
    if (!button || !row) return undefined;
    const measure = () => {
      const available = button.clientWidth - 8;
      const widths = [...row.children].map(child => (child as HTMLElement).offsetWidth);
      let used = 0;
      let count = 0;
      for (let index = 0; index < widths.length; index += 1) {
        const rest = widths.length - index - 1;
        const next = used + (count > 0 ? RULE_CHIP_GAP : 0) + widths[index];
        if (next + (rest > 0 ? RULE_CHIP_GAP + RULE_MORE_WIDTH : 0) > available) break;
        used = next;
        count += 1;
      }
      setVisibleCount(Math.max(1, count));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(button);
    return () => observer.disconnect();
  }, [items]);

  const shown = items.slice(0, visibleCount);
  return (
    <Tooltip content={t('条件を編集')}>
      <button
        ref={buttonRef}
        type="button"
        onClick={onEdit}
        className="relative -mx-1 mt-3 flex min-h-10 w-[calc(100%+8px)] cursor-pointer items-center gap-1 overflow-hidden rounded-chip px-1 text-left transition-colors duration-150 hover:bg-yt-tonal"
      >
        {/* Off-screen copy used to measure every chip. */}
        <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex gap-1">
          {items.map(item => <span key={item} className={RULE_CHIP_CLASS}>{item}</span>)}
        </div>
        {shown.map(item => (
          <span key={item} className={cx(RULE_CHIP_CLASS, 'min-w-0 max-w-full truncate')}>{item}</span>
        ))}
        {items.length > shown.length && (
          <span className={cx(RULE_CHIP_CLASS, 'tabular-nums')}>+{items.length - shown.length}</span>
        )}
      </button>
    </Tooltip>
  );
}

/** Meta items joined with 「 · 」 (items may be styled elements). */
function MetaLine({ items, className }: { items: ReactNode[]; className?: string }) {
  const visible = items.filter(item => item !== null && item !== undefined && item !== false && item !== '');
  if (visible.length === 0) return null;
  return (
    <div className={cx('flex flex-wrap items-center gap-x-0 text-sm leading-5', className)}>
      {visible.map((item, index) => (
        <span key={index} className="inline-flex items-center">
          {index > 0 && <span aria-hidden="true" className="px-1">·</span>}
          {item}
        </span>
      ))}
    </div>
  );
}

/** Left column (≥1280px) / top block of /playlists?list=<id>. */
export default function PlaylistHero({
  playlist,
  folderName,
  editable,
  duplicateCount,
  smartStatus,
  syncing,
  onBack,
  onPlayAll,
  onShuffle,
  onAddToQueue,
  onEdit,
  onShare,
  onExport,
  onDelete,
  onImportInto,
  onCheckSongs,
  onRemoveDuplicates,
  onRefreshSmart,
  onEditRules,
  onSyncNow,
  onUnlinkSync,
}: PlaylistHeroProps) {
  const t = useTranslateSourceText();
  const text = usePlaylistText();
  const titleId = useId();
  const name = displayPlaylistName(playlist, t);
  const songCount = playlist.songs.length;
  const hasSongs = songCount > 0;
  const sync = getPlaylistSyncInfo(playlist);
  const smart = Boolean(playlist.smartRule);
  const detailsEditable = canEditPlaylistDetails(playlist);
  // Without folders there is nowhere to move to (folders are made from the library's ⋮).
  const hasFolders = usePlaylistStore(state => state.folders.length > 0);
  const smartLoading = smartStatus?.state === 'loading';
  const totalSeconds = playlist.songs.reduce((sum, song) => sum + (song.lengthSeconds || 0), 0);
  const countText = formatCount(songCount, 'song', text.language);

  let meta: ReactNode[];
  if (smart) {
    if (smartLoading) {
      meta = [t('更新中…')];
    } else if (smartStatus?.state === 'error') {
      meta = [
        <span key="error" className="text-yt-danger">{t('更新できませんでした')}</span>,
        <Button key="retry" variant="text" size="sm" className="-my-1.5" onClick={onRefreshSmart}>{t('再試行')}</Button>,
      ];
    } else if (smartStatus && typeof smartStatus.matchedCount === 'number') {
      const matched = smartStatus.matchedCount;
      const loaded = smartStatus.loadedCount ?? songCount;
      const refreshed = text.refreshed(smartStatus.refreshedAt ?? Date.now());
      // Nothing matched: the list below already says so (「条件に合う曲がありません」).
      meta = matched === 0 || loaded === 0 ? [refreshed] : [
        matched === 1 ? t('1曲が一致') : t('{count}曲が一致', { count: text.number(matched) }),
        playlist.smartRule?.maxSongs === 'all' ? formatCount(loaded, 'song', text.language) : t('上位{count}曲', { count: text.number(loaded) }),
        refreshed,
      ];
    } else {
      meta = [countText, text.refreshed(getSongsRefreshedAt(playlist) ?? playlist.updatedAt)];
    }
  } else if (sync) {
    meta = [
      countText,
      sync.status === 'error'
        ? <span key="error" className="text-yt-danger">{t('同期エラー')}</span>
        : sync.lastSuccessfulAt ? text.synced(sync.lastSuccessfulAt) : null,
      sync.unmatchedCount > 0 ? t('{count}本は未登録', { count: text.number(sync.unmatchedCount) }) : null,
    ];
  } else {
    meta = [countText, hasSongs ? formatTotalDuration(totalSeconds, text.language) : null, text.updated(playlist)];
  }

  const smartRule = playlist.smartRule;
  const language = text.language;
  const ruleItems = useMemo(
    () => (smartRule ? describeSmartPlaylistRule(smartRule).map(item => formatSmartRuleItem(item, t, language)) : []),
    [language, smartRule, t],
  );

  const iconButtonClass = 'shrink-0';
  // The music layout keeps the header above the track table at every width (its library and 再生中
  // panel already take the side columns), instead of a sticky 360px column from 1280px.
  const sideColumn = !useIsMusicLayout();
  const moreLabel = t('その他の操作');

  return (
    <section
      aria-labelledby={titleId}
      className={cx(
        'relative isolate overflow-hidden',
        'max-sm:-mx-3 max-sm:-mt-6',
        'sm:rounded-panel',
        sideColumn && 'xl:sticky xl:top-[calc(var(--header-height,56px)_+_var(--selection-bar-height,0px)_+_24px)] xl:h-[calc(100dvh_-_var(--header-height,56px)_-_var(--selection-bar-height,0px)_-_var(--bottom-nav-height,0px)_-_48px)] xl:w-[360px] xl:shrink-0',
      )}
    >
      <HeroBackdrop playlist={playlist} />
      <div className={cx('relative flex h-full flex-col px-3 pb-4 pt-2 sm:flex-row sm:gap-6 sm:p-6', sideColumn && 'xl:flex-col xl:gap-0 xl:overflow-y-auto xl:overscroll-contain')}>
        {onBack && (
          <IconButton
            label={t('プレイリスト一覧に戻る')}
            icon={<ArrowBackIcon />}
            className="-ml-2 mb-2 self-start"
            onClick={onBack}
          />
        )}
        <PlaylistThumbnail
          playlist={playlist}
          stacked={false}
          showCount={false}
          loading="eager"
          className={cx('w-full', sideColumn ? 'sm:w-80 xl:w-full' : 'sm:w-56 lg:w-64')}
        >
          {hasSongs && (
            <button
              type="button"
              onClick={onPlayAll}
              className="absolute inset-0 flex cursor-pointer items-center justify-center gap-1.5 bg-black/60 text-sm font-medium leading-5 text-white opacity-0 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
            >
              <PlayIcon size={24} />
              {t('すべて再生')}
            </button>
          )}
        </PlaylistThumbnail>

        <div className={cx('mt-4 flex min-w-0 flex-1 flex-col sm:mt-0', sideColumn && 'xl:mt-4')}>
          <h1 id={titleId} className="m-0 line-clamp-3 text-[22px] font-bold leading-[30px] text-yt-text [overflow-wrap:anywhere] sm:text-[28px] sm:leading-9">
            {name}
          </h1>
          <p className="m-0 mt-3 truncate text-sm font-medium leading-5 text-yt-text">
            {text.kind(playlist)}
            {folderName ? ` · ${folderName}` : ''}
          </p>
          <MetaLine items={meta} className="mt-1 text-yt-text-secondary tabular-nums" />
          {playlist.description && <HeroDescription text={playlist.description} />}

          {ruleItems.length > 0 && <RuleChips items={ruleItems} onEdit={onEditRules} />}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {detailsEditable && (
              <IconButton variant="tonal" label={t('編集')} icon={<EditIcon />} className={iconButtonClass} onClick={() => onEdit()} />
            )}
            <IconButton variant="tonal" label={t('共有')} icon={<ShareIcon />} className={iconButtonClass} onClick={onShare} />
            {smart && (
              <>
                <IconButton
                  variant="tonal"
                  label={t('今すぐ更新')}
                  icon={smartLoading ? <SpinnerIcon /> : <RefreshIcon />}
                  disabled={smartLoading}
                  className={iconButtonClass}
                  onClick={onRefreshSmart}
                />
                <IconButton variant="tonal" label={t('条件を編集')} icon={<TuneIcon />} className={iconButtonClass} onClick={onEditRules} />
              </>
            )}
            {sync && (
              <>
                <IconButton
                  variant="tonal"
                  label={t('今すぐ同期')}
                  icon={syncing ? <SpinnerIcon /> : <SyncIcon />}
                  disabled={syncing}
                  className={iconButtonClass}
                  onClick={onSyncNow}
                />
                <Tooltip content={t('{service}で開く', { service: text.serviceName(sync.service) })}>
                  <a
                    href={sync.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('{service}で開く', { service: text.serviceName(sync.service) })}
                    className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-yt-tonal text-yt-text transition-colors duration-150 hover:bg-yt-tonal-hover"
                  >
                    <OpenInNewIcon size={24} />
                  </a>
                </Tooltip>
              </>
            )}
            <Menu trigger={<IconButton variant="tonal" label={moreLabel} icon={<MoreVertIcon />} className={iconButtonClass} />} label={moreLabel}>
              <MenuItem icon={<QueueMusicIcon />} disabled={!hasSongs} onSelect={onAddToQueue}>{t('キューに追加')}</MenuItem>
              {editable && (
                <MenuItem icon={<UploadIcon />} onSelect={onImportInto}>{t('このプレイリストにインポート')}</MenuItem>
              )}
              <MenuItem icon={<DownloadIcon />} onSelect={onExport}>{t('JSONでエクスポート')}</MenuItem>
              {detailsEditable && hasFolders && (
                <MenuItem icon={<FolderIcon />} onSelect={() => onEdit('folder')}>{t('フォルダーに移動')}</MenuItem>
              )}
              {editable && hasSongs && (
                <MenuItem icon={<CheckCircleIcon />} onSelect={onCheckSongs}>{t('曲をチェック')}</MenuItem>
              )}
              {editable && duplicateCount > 0 && (
                <MenuItem icon={<TrashIcon />} onSelect={onRemoveDuplicates}>
                  {t('重複を削除（{count}曲）', { count: duplicateCount })}
                </MenuItem>
              )}
              {sync && <MenuItem icon={<SyncIcon />} onSelect={onUnlinkSync}>{t('同期を解除')}</MenuItem>}
              {detailsEditable && (
                <>
                  <MenuDivider />
                  <MenuItem icon={<TrashIcon />} onSelect={onDelete}>{t('プレイリストを削除')}</MenuItem>
                </>
              )}
            </Menu>
          </div>

          {hasSongs && (
            <div className="mt-4 flex gap-2">
              <Button variant="primary" size="lg" icon={<PlayIcon />} className="flex-1" onClick={onPlayAll}>
                {t('すべて再生')}
              </Button>
              <Button variant="tonal" size="lg" icon={<ShuffleIcon />} className="flex-1" onClick={onShuffle}>
                {t('シャッフル')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
