import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useHistoryStore } from '../stores/historyStore';
import VideoGrid from '../components/home/VideoGrid';
import type { Song } from '../types/vocadb';
import { getHistoryOverview, type HistoryOverview } from '../services/historyStats';
import { createHistoryBackup, importHistoryBackup } from '../services/historyBackup';
import { downloadJson } from '../utils/playlistBackup';
import { useAutoPlaySessionStore } from '../stores/autoPlaySessionStore';
import { useAutoQueueDecisionStore } from '../stores/autoQueueDecisionStore';

type HistorySortMode = 'recent' | 'name' | 'artist';

function formatDuration(seconds: number): string {
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}分`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}時間${minutes}分` : `${hours}時間`;
}

/**
 * HistoryPage - 視聴履歴ページ
 */
export default function HistoryPage() {
  const { entries, totalPlays, hasHydrated, clearHistory, reloadHistory } = useHistoryStore();
  const [filterText, setFilterText] = useState('');
  const [sortMode, setSortMode] = useState<HistorySortMode>('recent');
  const [overview, setOverview] = useState<HistoryOverview | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const autoPlaySession = useAutoPlaySessionStore(s => s.session);
  const autoQueueDecisionCount = useAutoQueueDecisionStore(s => s.decisions.length);
  const autoSkipRate = autoPlaySession
    ? autoPlaySession.autoSkippedCount / Math.max(1, autoPlaySession.autoCompletedCount + autoPlaySession.autoSkippedCount)
    : 0;

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
    const normalizedFilter = filterText.trim().toLowerCase();
    const historySongs = entries.map(e => e.song);
    const filtered = normalizedFilter
      ? historySongs.filter(song =>
          song.name.toLowerCase().includes(normalizedFilter) ||
          (song.artistString ?? '').toLowerCase().includes(normalizedFilter)
        )
      : historySongs;

    if (sortMode === 'name') {
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    }
    if (sortMode === 'artist') {
      return [...filtered].sort((a, b) => (a.artistString ?? '').localeCompare(b.artistString ?? '', 'ja'));
    }
    return filtered;
  }, [entries, filterText, sortMode]);

  const handleExport = async () => {
    try {
      const { payload, summary } = await createHistoryBackup();
      const date = payload.exportedAt.slice(0, 10);
      downloadJson(`diva-listening-history-${date}.json`, payload);
      setBackupMessage(`${summary.eventCount.toLocaleString()} 件の再生履歴を保存しました。`);
    } catch (error) {
      console.error('[History] Failed to export history', error);
      setBackupMessage('履歴のエクスポートに失敗しました。ブラウザの保存領域を確認してください。');
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
      setBackupMessage(
        `${result.imported.toLocaleString()} 件を追加しました。重複 ${result.duplicates.toLocaleString()} 件は除外しました。`,
      );
    } catch (error) {
      console.error('[History] Failed to import history', error);
      setBackupMessage('履歴を読み込めませんでした。DIVA Playerの履歴バックアップJSONを選択してください。');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="w-full px-4 sm:px-6 lg:px-8 py-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            視聴履歴
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {totalPlays} 件
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImport}
          />
          <button className="yt-action-btn" onClick={handleExport} title="履歴をJSONで保存">
            <span>エクスポート</span>
          </button>
          <button
            className="yt-action-btn"
            onClick={() => importInputRef.current?.click()}
            disabled={isImporting}
            title="履歴バックアップを追加"
          >
            <span>{isImporting ? '読み込み中' : 'インポート'}</span>
          </button>
          {entries.length > 0 && (
            <button
              className="yt-action-btn"
              onClick={clearHistory}
              title="履歴を削除"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
              </svg>
              <span className="hidden sm:inline">履歴を削除</span>
            </button>
          )}
        </div>
      </div>

      {backupMessage && (
        <p className="mb-4 text-sm" role="status" style={{ color: 'var(--color-text-secondary)' }}>
          {backupMessage}
        </p>
      )}

      {overview && (
        <section
          aria-label="視聴統計"
          className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>有効再生</p>
            <p className="mt-1 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>{overview.totalQualifiedPlays}</p>
          </div>
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>完走</p>
            <p className="mt-1 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>{overview.totalCompletes}</p>
          </div>
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>総再生時間</p>
            <p className="mt-1 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>{formatDuration(overview.totalListenedSeconds)}</p>
          </div>
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>開始回数</p>
            <p className="mt-1 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>{overview.totalStarts}</p>
          </div>
        </section>
      )}

      {(autoPlaySession || autoQueueDecisionCount > 0) && (
        <section
          aria-label="自動再生の状況"
          className="mb-6 rounded-lg border p-4"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>自動再生の状況</h2>
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>判断ログ: {autoQueueDecisionCount}件</span>
          </div>
          {autoPlaySession ? (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>自動再生</p><p className="text-base font-semibold">{autoPlaySession.autoPlayedCount}</p></div>
              <div><p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>完走</p><p className="text-base font-semibold">{autoPlaySession.autoCompletedCount}</p></div>
              <div><p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>スキップ率</p><p className="text-base font-semibold">{Math.round(autoSkipRate * 100)}%</p></div>
              <div><p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>手動介入</p><p className="text-base font-semibold">{autoPlaySession.manualOverrideCount}</p></div>
            </div>
          ) : (
            <p className="mt-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>直近の自動再生セッションはありません。</p>
          )}
        </section>
      )}

      {entries.length > 0 && (
        <div className="mb-4 max-w-2xl">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="search"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder="履歴を検索"
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
              <option value="recent">最近</option>
              <option value="name">曲名</option>
              <option value="artist">アーティスト</option>
            </select>
          </div>
          {filterText.trim() && (
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {songs.length} / {entries.length} 件を表示中
            </p>
          )}
        </div>
      )}

      <VideoGrid songs={songs} loading={false} />
    </div>
  );
}
