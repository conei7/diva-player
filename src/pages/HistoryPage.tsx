import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { searchHistoryEntries, useHistoryStore, type HistoryEntry } from '../stores/historyStore';
import VideoGrid from '../components/home/VideoGrid';
import type { Song } from '../types/vocadb';
import { createHistoryCsv, getHistoryOverview, type HistoryOverview } from '../services/historyStats';
import { createHistoryBackup, importHistoryBackup } from '../services/historyBackup';
import { downloadCsv } from '../utils/csv';
import { downloadJson } from '../utils/playlistBackup';
import { useAutoPlaySessionStore } from '../stores/autoPlaySessionStore';
import { useAutoQueueDecisionStore } from '../stores/autoQueueDecisionStore';
import { useLanguageStore } from '../stores/languageStore';
import { useTranslateSourceText } from '../i18n';

type HistorySortMode = 'recent' | 'name' | 'artist';
type BackupMessage = { source: string; values?: Record<string, string | number> };

function formatDuration(seconds: number, language: 'ja' | 'en'): string {
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return language === 'ja' ? `${totalMinutes}分` : `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return language === 'ja'
    ? minutes > 0 ? `${hours}時間${minutes}分` : `${hours}時間`
    : minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

/**
 * HistoryPage - 視聴履歴ページ
 */
export default function HistoryPage() {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const { entries, totalPlays, hasHydrated, hasMoreEntries, isLoadingMore, clearHistory, reloadHistory, loadMoreHistory } = useHistoryStore();
  const [filterText, setFilterText] = useState('');
  const [searchedEntries, setSearchedEntries] = useState<HistoryEntry[] | null>(null);
  const [sortMode, setSortMode] = useState<HistorySortMode>('recent');
  const [overview, setOverview] = useState<HistoryOverview | null>(null);
  const [backupMessage, setBackupMessage] = useState<BackupMessage | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const autoPlaySession = useAutoPlaySessionStore(s => s.session);
  const autoQueueDecisionCount = useAutoQueueDecisionStore(s => s.decisions.length);
  const autoSkipRate = autoPlaySession
    ? autoPlaySession.autoSkippedCount / Math.max(1, autoPlaySession.autoCompletedCount + autoPlaySession.autoSkippedCount)
    : 0;

  useEffect(() => {
    const query = filterText.trim();
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
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filterText, hasHydrated, totalPlays]);

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

  const songs: Song[] = useMemo(() => {
    const sourceEntries = filterText.trim() ? (searchedEntries ?? []) : entries;
    const filtered = sourceEntries.map(e => e.song);

    if (sortMode === 'name') {
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    }
    if (sortMode === 'artist') {
      return [...filtered].sort((a, b) => (a.artistString ?? '').localeCompare(b.artistString ?? '', 'ja'));
    }
    return filtered;
  }, [entries, filterText, searchedEntries, sortMode]);

  const handleExport = async () => {
    try {
      const { payload, summary } = await createHistoryBackup();
      const date = payload.exportedAt.slice(0, 10);
      downloadJson(`diva-listening-history-${date}.json`, payload);
      setBackupMessage({ source: '{count} 件の再生履歴を保存しました。', values: { count: summary.eventCount.toLocaleString() } });
    } catch (error) {
      console.error('[History] Failed to export history', error);
      setBackupMessage({ source: '履歴のエクスポートに失敗しました。ブラウザの保存領域を確認してください。' });
    }
  };

  const handleCsvExport = async () => {
    setIsExportingCsv(true);
    try {
      const csv = await createHistoryCsv();
      const date = new Date().toISOString().slice(0, 10);
      downloadCsv(`diva-listening-history-${date}.csv`, csv);
      setBackupMessage({ source: '再生履歴CSVを保存しました。' });
    } catch (error) {
      console.error('[History] Failed to export CSV', error);
      setBackupMessage({ source: '再生履歴CSVのエクスポートに失敗しました。' });
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
      setBackupMessage({
        source: '{imported} 件を追加しました。重複 {duplicates} 件は除外しました。',
        values: { imported: result.imported.toLocaleString(), duplicates: result.duplicates.toLocaleString() },
      });
    } catch (error) {
      console.error('[History] Failed to import history', error);
      setBackupMessage({ source: '履歴を読み込めませんでした。DIVA Playerの履歴バックアップJSONを選択してください。' });
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="w-full px-4 sm:px-6 lg:px-8 py-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            {t('視聴履歴')}
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {language === 'ja' ? `${totalPlays} 件` : t('{count} 件', { count: totalPlays })}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 flex-wrap">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImport}
          />
          <button className="yt-action-btn" onClick={handleExport} title={t('履歴をJSONで保存')}>
            <span>{t('エクスポート')}</span>
          </button>
          <button
            className="yt-action-btn"
            onClick={handleCsvExport}
            disabled={isExportingCsv}
            title={t('履歴をCSVで保存')}
          >
            <span>{isExportingCsv ? t('CSV作成中…') : t('CSV保存')}</span>
          </button>
          <button
            className="yt-action-btn"
            onClick={() => importInputRef.current?.click()}
            disabled={isImporting}
            title={t('履歴バックアップを追加')}
          >
            <span>{isImporting ? t('読み込み中') : t('インポート')}</span>
          </button>
          {entries.length > 0 && (
            <button
              className="yt-action-btn"
              onClick={clearHistory}
              title={t('履歴を削除')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
              </svg>
              <span className="hidden sm:inline">{t('履歴を削除')}</span>
            </button>
          )}
        </div>
      </div>

      {backupMessage && (
        <p className="mb-4 text-sm" role="status" style={{ color: 'var(--color-text-secondary)' }}>
          {t(backupMessage.source, backupMessage.values)}
        </p>
      )}

      {overview && (
        <section
          aria-label={t('視聴統計')}
          className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('有効再生')}</p>
            <p className="mt-1 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>{overview.totalQualifiedPlays}</p>
          </div>
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('完走')}</p>
            <p className="mt-1 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>{overview.totalCompletes}</p>
          </div>
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('総再生時間')}</p>
            <p className="mt-1 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>{formatDuration(overview.totalListenedSeconds, language)}</p>
          </div>
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('開始回数')}</p>
            <p className="mt-1 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>{overview.totalStarts}</p>
          </div>
        </section>
      )}

      {(autoPlaySession || autoQueueDecisionCount > 0) && (
        <section
          aria-label={t('自動再生の状況')}
          className="mb-6 rounded-lg border p-4"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>{t('自動再生の状況')}</h2>
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('判断ログ: {count}件', { count: autoQueueDecisionCount })}</span>
          </div>
          {autoPlaySession ? (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('自動再生')}</p><p className="text-base font-semibold">{autoPlaySession.autoPlayedCount}</p></div>
              <div><p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('完走')}</p><p className="text-base font-semibold">{autoPlaySession.autoCompletedCount}</p></div>
              <div><p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('スキップ率')}</p><p className="text-base font-semibold">{Math.round(autoSkipRate * 100)}%</p></div>
              <div><p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('手動介入')}</p><p className="text-base font-semibold">{autoPlaySession.manualOverrideCount}</p></div>
            </div>
          ) : (
            <p className="mt-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>{t('直近の自動再生セッションはありません。')}</p>
          )}
        </section>
      )}

      {(entries.length > 0 || totalPlays > 0) && (
        <div className="mb-4 max-w-2xl">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="search"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder={t('履歴を検索')}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-primary)',
              }}
            />
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as HistorySortMode)}
              className="rounded-lg border px-3 py-2 text-sm outline-none sm:w-40"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-primary)',
              }}
            >
              <option value="recent">{t('最近')}</option>
              <option value="name">{t('曲名')}</option>
              <option value="artist">{t('アーティスト')}</option>
            </select>
          </div>
          {filterText.trim() && (
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {searchedEntries === null ? t('履歴を読み込み中…') : t('{visible} / {total} 件を表示中', { visible: songs.length, total: totalPlays })}
            </p>
          )}
        </div>
      )}

      {entries.length > 0 && !filterText.trim() && (
        <div className="mb-4 flex items-center gap-3">
          {hasMoreEntries ? (
            <button
              type="button"
              className="yt-action-btn"
              onClick={() => void loadMoreHistory()}
              disabled={isLoadingMore}
            >
              {isLoadingMore ? t('履歴を読み込み中…') : t('さらに読み込む')}
            </button>
          ) : (
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('全履歴を読み込み済み')}</span>
          )}
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {t('表示中 {loaded} / {total} 件', { loaded: entries.length.toLocaleString(), total: totalPlays.toLocaleString() })}
          </span>
        </div>
      )}

      <VideoGrid songs={songs} loading={false} />
    </div>
  );
}
