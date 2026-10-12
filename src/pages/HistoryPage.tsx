import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { searchHistoryEntries, useHistoryStore, type HistoryEntry } from '../stores/historyStore';
import { useHiddenSongStore } from '../stores/hiddenSongStore';
import { useLanguageStore } from '../stores/languageStore';
import { useSelectionStore } from '../stores/selectionStore';
import { confirmDialog } from '../stores/confirmStore';
import { showToast } from '../stores/toastStore';
import { createHistoryCsv, DEFAULT_TIME_ZONE, getHistoryOverview, type HistoryOverview } from '../services/historyStats';
import { createHistoryBackup, importHistoryBackup } from '../services/historyBackup';
import { downloadCsv } from '../utils/csv';
import { downloadJson } from '../utils/playlistBackup';
import { watchPath } from '../utils/routes';
import { formatArtistLine, formatCount, formatTotalDuration } from '../utils/songMeta';
import ViewCounts from '../components/ui/ViewCounts';
import { hasViewCounts, joinMetaParts } from '../components/ui/songMetaParts';
import { formatRelativeTime } from '../utils/relativeDate';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { useTranslate, useTranslateSourceText } from '../i18n';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import Menu, { MenuDivider, MenuItem, MenuItemRadio, MenuLabel } from '../components/ui/Menu';
import { PageHeader, PageShell } from '../components/ui/PageHeader';
import SearchField from '../components/ui/SearchField';
import { SkeletonListRow } from '../components/ui/Skeleton';
import SongActionsMenu from '../components/ui/SongActionsMenu';
import SongListRow, { type SongRowSize } from '../components/ui/SongListRow';
import {
  BarChartIcon,
  DownloadIcon,
  HistoryIcon,
  MoreVertIcon,
  SortIcon,
  SpinnerIcon,
  TrashIcon,
  UploadIcon,
} from '../components/ui/icons';
import { RailButton, RailDivider } from '../components/library/LibraryRail';
import RowBadge from '../components/library/RowBadge';
import {
  formatHistoryDayLabel,
  formatHistoryTime,
  groupHistoryByDay,
  latestPlayPerSong,
  type HistoryRowItem,
} from '../components/library/historyGroups';

type HistorySortMode = 'recent' | 'name' | 'artist';

const WIDE_MEDIA_QUERY = '(min-width: 1024px)';
const XL_MEDIA_QUERY = '(min-width: 1280px)';
const SEARCH_DEBOUNCE_MS = 180;

/**
 * HistoryPage - 再生履歴（日付ごとの一覧。1024px 以上は右に検索・操作・統計の列）
 */
export default function HistoryPage() {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const language = useLanguageStore(state => state.language);
  const navigate = useNavigate();
  const isWide = useMediaQuery(WIDE_MEDIA_QUERY);
  const isXl = useMediaQuery(XL_MEDIA_QUERY);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const rowSize: SongRowSize = isMobile || (isWide && !isXl) ? 'md' : 'lg';

  const entries = useHistoryStore(state => state.entries);
  const totalPlays = useHistoryStore(state => state.totalPlays);
  const hasHydrated = useHistoryStore(state => state.hasHydrated);
  const hasMoreEntries = useHistoryStore(state => state.hasMoreEntries);
  const isLoadingMore = useHistoryStore(state => state.isLoadingMore);
  const clearHistory = useHistoryStore(state => state.clearHistory);
  const reloadHistory = useHistoryStore(state => state.reloadHistory);
  const loadMoreHistory = useHistoryStore(state => state.loadMoreHistory);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const isSelectionMode = useSelectionStore(state => state.isSelectionMode);
  const selectedSongIds = useSelectionStore(state => state.selectedSongIds);
  const toggleSong = useSelectionStore(state => state.toggleSong);
  const setVisibleSongs = useSelectionStore(state => state.setVisibleSongs);

  const [filterText, setFilterText] = useState('');
  const [searchedEntries, setSearchedEntries] = useState<HistoryEntry[] | null>(null);
  const [sortMode, setSortMode] = useState<HistorySortMode>('recent');
  const [overview, setOverview] = useState<HistoryOverview | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const query = filterText.trim();
  const hasHistory = totalPlays > 0 || entries.length > 0;

  // The search covers the complete IndexedDB history, not only the loaded pages.
  useEffect(() => {
    if (!query || !hasHydrated) {
      setSearchedEntries(null);
      return;
    }

    let cancelled = false;
    setSearchedEntries(null);
    const timer = window.setTimeout(() => {
      void searchHistoryEntries(query).then(result => {
        if (!cancelled) setSearchedEntries(result);
      }).catch(error => {
        console.error('[History] Failed to search the complete history', error);
        if (!cancelled) setSearchedEntries([]);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, hasHydrated, totalPlays]);

  useEffect(() => {
    if (!hasHydrated) return;
    let cancelled = false;
    void getHistoryOverview().then(result => {
      if (!cancelled) setOverview(result);
    }).catch(error => {
      console.error('[History] Failed to load statistics', error);
    });
    return () => { cancelled = true; };
  }, [hasHydrated, totalPlays]);

  const sourceEntries = useMemo(() => (query ? (searchedEntries ?? []) : entries), [entries, query, searchedEntries]);
  const isSearching = query !== '' && searchedEntries === null;

  const groups = useMemo(
    () => (sortMode === 'recent' ? groupHistoryByDay(sourceEntries, DEFAULT_TIME_ZONE) : []),
    [sortMode, sourceEntries],
  );
  const flatRows = useMemo(() => {
    if (sortMode === 'recent') return [];
    const rows = latestPlayPerSong(sourceEntries);
    return sortMode === 'name'
      ? rows.sort((a, b) => a.song.name.localeCompare(b.song.name, 'ja'))
      : rows.sort((a, b) => (a.song.artistString ?? '').localeCompare(b.song.artistString ?? '', 'ja'));
  }, [sortMode, sourceEntries]);
  const orderedRows = useMemo(
    () => (sortMode === 'recent' ? groups.flatMap(group => group.items) : flatRows),
    [flatRows, groups, sortMode],
  );

  // The selection bar's "select all" works on what this page shows.
  const visibleSongs = useMemo(() => {
    const seen = new Set<number>();
    return orderedRows.flatMap(row => {
      if (seen.has(row.song.id)) return [];
      seen.add(row.song.id);
      return [row.song];
    });
  }, [orderedRows]);
  useEffect(() => {
    setVisibleSongs(visibleSongs);
  }, [setVisibleSongs, visibleSongs]);

  const loadMore = useCallback(async () => {
    const before = useHistoryStore.getState().entries.length;
    await loadMoreHistory();
    const after = useHistoryStore.getState();
    // loadMoreHistory reports failures only in the console: no new rows while more remain means it failed.
    setLoadMoreFailed(after.hasMoreEntries && after.entries.length === before);
  }, [loadMoreHistory]);

  const canAutoLoad = !query && hasMoreEntries && !isLoadingMore && !loadMoreFailed;
  useEffect(() => {
    const target = sentinelRef.current;
    if (!canAutoLoad || !target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(items => {
      if (!items.some(item => item.isIntersecting)) return;
      observer.disconnect();
      void loadMore();
    }, { rootMargin: '800px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [canAutoLoad, entries.length, loadMore]);

  const handleExport = async () => {
    try {
      const { payload } = await createHistoryBackup();
      downloadJson(`diva-listening-history-${payload.exportedAt.slice(0, 10)}.json`, payload);
      showToast(tk('libraryBackupSaved'));
    } catch (error) {
      console.error('[History] Failed to export history', error);
      showToast(tk('libraryBackupSaveFailed'));
    }
  };

  const handleCsvExport = async () => {
    setIsExportingCsv(true);
    try {
      const csv = await createHistoryCsv(DEFAULT_TIME_ZONE, language);
      downloadCsv(`diva-listening-history-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      showToast(t('CSVをエクスポートしました'));
    } catch (error) {
      console.error('[History] Failed to export CSV', error);
      showToast(t('CSVをエクスポートできませんでした'));
    } finally {
      setIsExportingCsv(false);
    }
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setIsImporting(true);
    try {
      const data: unknown = JSON.parse(await file.text());
      const result = await importHistoryBackup(data);
      await reloadHistory();
      const imported = formatCount(result.imported, 'item', language);
      showToast(result.duplicates > 0
        ? t('{imported}を追加しました（重複{duplicates}はスキップ）', {
          imported,
          duplicates: formatCount(result.duplicates, 'item', language),
        })
        : t('{imported}を追加しました', { imported }));
    } catch (error) {
      console.error('[History] Failed to import history', error);
      showToast(t('読み込めませんでした（DIVA Player の履歴バックアップを選んでください）'));
    } finally {
      setIsImporting(false);
    }
  };

  const openImport = () => importInputRef.current?.click();

  const handleClear = async () => {
    const confirmed = await confirmDialog({ title: t('再生履歴をすべて削除しますか？'), confirmLabel: t('削除') });
    if (!confirmed) return;
    try {
      await clearHistory();
      showToast(t('再生履歴を削除しました'));
    } catch (error) {
      console.error('[History] Failed to clear history', error);
      showToast(t('再生履歴を削除できませんでした'));
      // A failed clear may still have removed part of the data: show what is stored now.
      await reloadHistory().catch(reloadError => console.error('[History] Failed to reload history', reloadError));
    }
  };

  const sortOptions: Array<{ value: HistorySortMode; label: string }> = [
    { value: 'recent', label: t('新しい順') },
    { value: 'name', label: t('曲名順') },
    { value: 'artist', label: t('アーティスト順') },
  ];
  const sortLabel = sortOptions.find(option => option.value === sortMode)?.label ?? '';

  const now = Date.now();
  const renderRow = (row: HistoryRowItem) => {
    const playedText = sortMode === 'recent'
      ? formatHistoryTime(row.playedAt, DEFAULT_TIME_ZONE, language)
      : formatRelativeTime(row.playedAt, now, language);
    return (
      <SongListRow
        key={row.key}
        song={row.song}
        size={rowSize}
        onActivate={() => navigate(watchPath(row.song.id))}
        meta={[
          formatArtistLine(row.song, { withVocalists: true }),
          joinMetaParts([playedText, hasViewCounts(row.song) ? <ViewCounts key="views" song={row.song} /> : null]),
        ]}
        badges={hiddenSongs[String(row.song.id)] ? <RowBadge>{t('非表示中')}</RowBadge> : undefined}
        trailing={isSelectionMode ? undefined : <SongActionsMenu song={row.song} />}
        selectionMode={isSelectionMode}
        selected={selectedSongIds.has(row.song.id)}
        onToggleSelect={() => toggleSong(row.song)}
        className="-mx-2"
      />
    );
  };

  let list: ReactNode;
  if (!hasHydrated || isSearching) {
    list = (
      <div aria-busy="true" className="-mx-2">
        {Array.from({ length: isSearching ? 3 : 6 }, (_, index) => <SkeletonListRow key={index} size={rowSize} />)}
      </div>
    );
  } else if (orderedRows.length === 0) {
    list = query
      ? <EmptyState compact title={t('一致する曲はありません')} />
      : <EmptyState icon={<HistoryIcon />} title={t('再生履歴はありません')} action={{ label: t('曲を探す'), to: '/' }} />;
  } else {
    list = (
      <div aria-busy={isLoadingMore || undefined}>
        {sortMode === 'recent' ? groups.map((group, index) => (
          <section key={group.dayKey} aria-labelledby={`history-day-${group.dayKey}`} className={index > 0 ? 'mt-6' : undefined}>
            <h2 id={`history-day-${group.dayKey}`} className="m-0 mb-2 text-base leading-[22px] font-bold text-yt-text sm:text-xl sm:leading-7">
              {formatHistoryDayLabel(group.dayKey, now, DEFAULT_TIME_ZONE, language)}
            </h2>
            {group.items.map(renderRow)}
          </section>
        )) : flatRows.map(renderRow)}
        {!query && hasMoreEntries && (
          <div ref={sentinelRef} className="flex min-h-16 items-center justify-center py-4">
            {loadMoreFailed ? (
              <Button
                variant="text"
                onClick={() => {
                  setLoadMoreFailed(false);
                  void loadMore();
                }}
              >
                {t('さらに読み込む')}
              </Button>
            ) : (
              <SpinnerIcon className="text-yt-text-secondary" />
            )}
          </div>
        )}
      </div>
    );
  }

  const backupLabel = tk('libraryBackupSave');
  const csvLabel = isExportingCsv ? t('エクスポート中…') : t('CSVでエクスポート');
  const importLabel = isImporting ? t('読み込み中…') : t('バックアップを読み込む');

  const fileInput = (
    <input
      ref={importInputRef}
      type="file"
      accept="application/json,.json"
      className="hidden"
      tabIndex={-1}
      aria-hidden="true"
      onChange={handleImport}
    />
  );

  if (isWide) {
    return (
      <PageShell>
        {fileInput}
        <div className="flex items-start gap-6">
          <div className="min-w-0 flex-1">
            <PageHeader title={t('再生履歴')} />
            {list}
          </div>
          <div
            data-testid="history-actions"
            className="sticky top-[calc(var(--header-height,56px)_+_var(--selection-bar-height,0px)_+_24px)] w-[280px] shrink-0 pb-6 xl:w-[320px]"
          >
            {hasHistory && (
              <>
                <SearchField
                  variant="underline"
                  value={filterText}
                  onChange={setFilterText}
                  label={t('再生履歴を検索')}
                  className="mb-2"
                />
                <Menu
                  trigger={(
                    <RailButton icon={<SortIcon />}>
                      {t('並べ替え')}
                      <span className="ml-2 text-yt-text-secondary">{sortLabel}</span>
                    </RailButton>
                  )}
                  label={t('並べ替え')}
                >
                  {sortOptions.map(option => (
                    <MenuItemRadio
                      key={option.value}
                      checked={option.value === sortMode}
                      onSelect={() => setSortMode(option.value)}
                    >
                      {option.label}
                    </MenuItemRadio>
                  ))}
                </Menu>
                <RailDivider />
                <RailButton icon={<TrashIcon />} onClick={() => void handleClear()} data-testid="history-clear">
                  {t('すべての再生履歴を削除')}
                </RailButton>
                <RailButton icon={<DownloadIcon />} onClick={() => void handleExport()} data-testid="history-backup-export">
                  {backupLabel}
                </RailButton>
                <RailButton
                  icon={<DownloadIcon />}
                  loading={isExportingCsv}
                  onClick={() => void handleCsvExport()}
                  data-testid="history-csv-export"
                >
                  {csvLabel}
                </RailButton>
              </>
            )}
            <RailButton
              icon={<UploadIcon />}
              loading={isImporting}
              onClick={openImport}
              data-testid="history-backup-import"
            >
              {importLabel}
            </RailButton>
            {hasHistory && overview && overview.totalStarts > 0 && (
              <>
                <RailDivider />
                <section aria-label={t('視聴統計')} className="px-3">
                  <h2 className="m-0 mb-3 text-base leading-6 font-medium text-yt-text">{t('視聴統計')}</h2>
                  <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3">
                    <Stat label={t('再生回数')} value={overview.totalQualifiedPlays.toLocaleString()} />
                    <Stat label={t('再生時間')} value={formatTotalDuration(overview.totalListenedSeconds, language)} />
                    <Stat label={t('最後まで聴いた')} value={overview.totalCompletes.toLocaleString()} />
                    <Stat label={t('再生開始')} value={overview.totalStarts.toLocaleString()} />
                  </dl>
                  {/* The record count is not repeated here: it is the 再生開始 number above. */}
                  <p className="m-0 mt-3 text-xs leading-[18px]">
                    <Link to="/reports" className="text-yt-link no-underline hover:underline">{t('レポートを見る')}</Link>
                  </p>
                </section>
              </>
            )}
          </div>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      {fileInput}
      <PageHeader
        title={t('再生履歴')}
        actions={(
          <>
            {hasHistory && (
              <SearchField expandable value={filterText} onChange={setFilterText} label={t('再生履歴を検索')} width={220} />
            )}
            <Menu
              trigger={(
                <IconButton label={t('その他の操作')} icon={<MoreVertIcon />} data-testid="history-actions-menu" />
              )}
              align="end"
            >
              {hasHistory && (
                <>
                  <MenuLabel>{t('並べ替え')}</MenuLabel>
                  {sortOptions.map(option => (
                    <MenuItemRadio
                      key={option.value}
                      checked={option.value === sortMode}
                      onSelect={() => setSortMode(option.value)}
                    >
                      {option.label}
                    </MenuItemRadio>
                  ))}
                  <MenuDivider />
                  <MenuItem icon={<DownloadIcon />} onSelect={() => void handleExport()} data-testid="history-backup-export">
                    {backupLabel}
                  </MenuItem>
                  <MenuItem
                    icon={<DownloadIcon />}
                    disabled={isExportingCsv}
                    onSelect={() => void handleCsvExport()}
                    data-testid="history-csv-export"
                  >
                    {csvLabel}
                  </MenuItem>
                </>
              )}
              <MenuItem icon={<UploadIcon />} disabled={isImporting} onSelect={openImport} data-testid="history-backup-import">
                {importLabel}
              </MenuItem>
              {hasHistory && (
                <>
                  <MenuItem icon={<BarChartIcon />} href="/reports">{t('レポートを見る')}</MenuItem>
                  <MenuDivider />
                  <MenuItem icon={<TrashIcon />} onSelect={() => void handleClear()} data-testid="history-clear">
                    {t('すべての再生履歴を削除')}
                  </MenuItem>
                </>
              )}
            </Menu>
          </>
        )}
      />
      {list}
    </PageShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs leading-4 text-yt-text-secondary">{label}</dt>
      <dd className="m-0 mt-0.5 truncate text-base leading-6 font-medium text-yt-text tabular-nums">{value}</dd>
    </div>
  );
}
