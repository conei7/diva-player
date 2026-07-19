import { useEffect, useRef, useState } from 'react';
import {
  createFullBackup,
  downloadFullBackup,
  executeFullBackupImport,
  parseFullBackup,
  type FullBackupPreview,
} from '../../services/fullBackup';
import {
  DEFAULT_GLOBAL_FILTER_SETTINGS,
  SONG_TYPES,
  getGlobalFilterSettings,
  useGlobalFilterStore,
} from '../../stores/globalFilterStore';
import type { GlobalFilterSettings } from '../../stores/globalFilterStore';
import { useSearchStore } from '../../stores/searchStore';
import {
  areGlobalFilterSettingsEqual,
  getGlobalFilterSummary,
  hasConfiguredSongFilters,
  isGlobalSongFilterActive,
  SONG_TYPE_LABELS,
} from '../../utils/globalFilters';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<FullBackupPreview | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [ratingPriority, setRatingPriority] = useState<'backup' | 'current'>('backup');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftFilters, setDraftFilters] = useState<GlobalFilterSettings>(DEFAULT_GLOBAL_FILTER_SETTINGS);
  const globalFilterState = useGlobalFilterStore();
  const setGlobalFilterSettings = useGlobalFilterStore(state => state.setSettings);
  const resetGlobalFilterSettings = useGlobalFilterStore(state => state.resetSettings);
  const hasSearched = useSearchStore(state => state.hasSearched);
  const refreshSearch = useSearchStore(state => state.search);

  useEffect(() => {
    if (!isOpen) {
      setPreview(null);
      setMessage('');
    } else {
      setDraftFilters(getGlobalFilterSettings());
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const savedFilters: GlobalFilterSettings = {
    enabled: globalFilterState.enabled,
    minYoutubeViews: globalFilterState.minYoutubeViews,
    minNicoViews: globalFilterState.minNicoViews,
    excludedSongTypes: globalFilterState.excludedSongTypes,
    cooldownHours: globalFilterState.cooldownHours,
    excludeRatedFromDiscovery: globalFilterState.excludeRatedFromDiscovery,
  };
  const filtersAreDirty = !areGlobalFilterSettingsEqual(draftFilters, savedFilters);

  const exportBackup = async () => {
    setBusy(true);
    setMessage('バックアップを作成中…');
    try {
      downloadFullBackup(await createFullBackup());
      setMessage('バックアップを保存しました。');
    } catch (error) {
      console.error(error);
      setMessage('バックアップの作成に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const readBackup = (file: File) => {
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseFullBackup(JSON.parse(String(reader.result)));
        setPreview(parsed);
        setMessage(parsed ? '内容を確認してください。' : '対応していないバックアップです。');
      } catch {
        setPreview(null);
        setMessage('JSONを読み込めませんでした。');
      } finally {
        setBusy(false);
      }
    };
    reader.onerror = () => {
      setBusy(false);
      setMessage('ファイルを読み込めませんでした。');
    };
    reader.readAsText(file);
  };

  const importBackup = async () => {
    if (!preview) return;
    if (mode === 'replace' && !window.confirm('現在の履歴・評価・プレイリストを置き換えます。続行しますか？')) return;
    setBusy(true);
    setMessage('復元中…');
    try {
      await executeFullBackupImport(preview, { mode, ratingPriority });
      setPreview(null);
      setMessage('復元が完了しました。');
    } catch (error) {
      console.error(error);
      setMessage('復元に失敗しました。現在のデータは維持されています。');
    } finally {
      setBusy(false);
    }
  };

  const updateDraft = <K extends keyof GlobalFilterSettings>(key: K, value: GlobalFilterSettings[K]) => {
    setDraftFilters(current => {
      const next = { ...current, [key]: value };
      if ((key === 'minYoutubeViews' || key === 'minNicoViews' || key === 'excludedSongTypes')
        && hasConfiguredSongFilters(next)) {
        next.enabled = true;
      }
      return next;
    });
  };

  const applyFilters = () => {
    setGlobalFilterSettings(draftFilters);
    if (hasSearched) void refreshSearch();
    const summary = getGlobalFilterSummary(draftFilters);
    setMessage(summary.length > 0
      ? `表示・発見設定を適用しました: ${summary.join(' / ')}`
      : '表示・発見設定を適用しました（フィルター停止）。');
  };

  const resetFilters = () => {
    resetGlobalFilterSettings();
    setDraftFilters(DEFAULT_GLOBAL_FILTER_SETTINGS);
    if (hasSearched) void refreshSearch();
    setMessage('表示・発見設定を初期化しました。');
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="設定・バックアップ">
      <button type="button" className="absolute inset-0 bg-black/70" aria-label="閉じる" onClick={onClose} />
      <div className="relative max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl p-5 shadow-2xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <div className="flex items-center justify-between gap-3 mb-5">
          <h2 className="text-lg font-bold">設定・バックアップ</h2>
          <button type="button" className="btn-ghost rounded-lg px-2 py-1" onClick={onClose} aria-label="閉じる">×</button>
        </div>
        <div className="flex flex-col gap-3">
          <section className="rounded-xl p-3" style={{ background: 'var(--color-bg-secondary)' }}>
            <h3 className="font-semibold">表示・発見フィルター</h3>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draftFilters.enabled} onChange={event => updateDraft('enabled', event.target.checked)} />
              再生数・楽曲種別フィルターを有効にする
            </label>
            <p className="mt-1 text-xs opacity-70">
              指定した値以上の曲だけを検索・おすすめに表示します。再生数が不明な曲は除外されます。
              {!draftFilters.enabled && hasConfiguredSongFilters(draftFilters) && ' 現在は停止中です。'}
            </p>
            {isGlobalSongFilterActive(savedFilters) && (
              <p className="mt-2 rounded-lg px-2 py-1.5 text-xs" style={{ background: 'rgba(34, 211, 238, 0.1)', color: 'var(--color-accent-cyan)' }}>
                適用中: {getGlobalFilterSummary(savedFilters).join(' / ')}
              </p>
            )}
            {filtersAreDirty && (
              <p className="mt-2 rounded-lg px-2 py-1.5 text-xs text-amber-200" role="status" style={{ background: 'rgba(251, 191, 36, 0.1)' }}>
                未適用の変更あり: {isGlobalSongFilterActive(draftFilters)
                  ? getGlobalFilterSummary(draftFilters).join(' / ')
                  : 'フィルター停止'}
              </p>
            )}
            <div className={`mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 ${draftFilters.enabled ? '' : 'opacity-50'}`}>
              <label className="text-sm">
                YouTube最低再生数
                <select className="input mt-1 w-full" defaultValue="" onChange={event => { if (event.target.value) updateDraft('minYoutubeViews', Number(event.target.value)); }}>
                  <option value="">プリセットを選択</option>
                  <option value={10_000}>1万</option>
                  <option value={50_000}>5万</option>
                  <option value={100_000}>10万</option>
                  <option value={500_000}>50万</option>
                  <option value={1_000_000}>100万</option>
                </select>
                <input className="input mt-1 w-full" type="number" min={0} step={1} value={draftFilters.minYoutubeViews} onChange={event => updateDraft('minYoutubeViews', Math.max(0, Number(event.target.value) || 0))} />
              </label>
              <label className="text-sm">
                ニコニコ最低再生数
                <select className="input mt-1 w-full" defaultValue="" onChange={event => { if (event.target.value) updateDraft('minNicoViews', Number(event.target.value)); }}>
                  <option value="">プリセットを選択</option>
                  <option value={1_000}>1千</option>
                  <option value={5_000}>5千</option>
                  <option value={10_000}>1万</option>
                  <option value={50_000}>5万</option>
                  <option value={100_000}>10万</option>
                </select>
                <input className="input mt-1 w-full" type="number" min={0} step={1} value={draftFilters.minNicoViews} onChange={event => updateDraft('minNicoViews', Math.max(0, Number(event.target.value) || 0))} />
              </label>
            </div>
            <div className="mt-3">
              <span className="text-sm">除外する楽曲種別</span>
              <div className={`mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 ${draftFilters.enabled ? '' : 'opacity-50'}`}>
                {SONG_TYPES.map(songType => (
                  <label key={songType} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={draftFilters.excludedSongTypes.includes(songType)}
                      onChange={event => updateDraft('excludedSongTypes', event.target.checked
                        ? [...draftFilters.excludedSongTypes, songType]
                        : draftFilters.excludedSongTypes.filter(type => type !== songType))}
                    />
                    {SONG_TYPE_LABELS[songType]} <span className="opacity-60">({songType})</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="text-sm">
                再生クールダウン
                <select className="input mt-1 w-full" value={draftFilters.cooldownHours} onChange={event => updateDraft('cooldownHours', Number(event.target.value))}>
                  <option value={0}>指定なし</option>
                  <option value={1}>1時間</option>
                  <option value={6}>6時間</option>
                  <option value={24}>24時間</option>
                  <option value={72}>3日</option>
                  <option value={168}>7日</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm sm:mt-6">
                <input type="checkbox" checked={draftFilters.excludeRatedFromDiscovery} onChange={event => updateDraft('excludeRatedFromDiscovery', event.target.checked)} />
                評価済み楽曲を発見候補から除外
              </label>
            </div>
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn-primary flex-1" disabled={busy || !filtersAreDirty} onClick={applyFilters}>適用</button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={resetFilters}>初期化</button>
            </div>
          </section>
          <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => void exportBackup()}>履歴・評価・プレイリストをバックアップ</button>
          <input ref={inputRef} className="hidden" type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) readBackup(file); }} />
          <button type="button" className="btn-secondary w-full" disabled={busy} onClick={() => inputRef.current?.click()}>完全バックアップを選択</button>
          {preview && (
            <div className="rounded-xl p-3 text-sm" style={{ background: 'var(--color-bg-secondary)' }}>
              {preview.preferencesIncluded && <p className="mb-1 text-xs opacity-70">表示・発見設定を含むバックアップです。</p>}
              <p>履歴 {preview.historyCount.toLocaleString()}件 / 評価 {preview.ratingCount.toLocaleString()}件 / プレイリスト {preview.playlistCount.toLocaleString()}件 / フォルダ {preview.folderCount.toLocaleString()}件</p>
              {preview.invalidItems > 0 && <p className="mt-1 text-amber-300">無効項目 {preview.invalidItems}件を除外</p>}
              <div className="flex flex-wrap gap-3 mt-3">
                <label><input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} /> 追加</label>
                <label><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> 置換</label>
              </div>
              {mode === 'merge' && (
                <div className="flex flex-wrap gap-3 mt-2">
                  <span>評価の優先:</span>
                  <label><input type="radio" checked={ratingPriority === 'backup'} onChange={() => setRatingPriority('backup')} /> バックアップ</label>
                  <label><input type="radio" checked={ratingPriority === 'current'} onChange={() => setRatingPriority('current')} /> 現在</label>
                </div>
              )}
              <button type="button" className="btn-primary mt-3 w-full" disabled={busy} onClick={() => void importBackup()}>この内容を復元</button>
            </div>
          )}
          {message && <p className="text-sm text-center" role="status">{message}</p>}
        </div>
      </div>
    </div>
  );
}
