import { useEffect, useRef, useState } from 'react';
import {
  createFullBackup,
  downloadFullBackup,
  executeFullBackupImport,
  parseFullBackup,
  readCurrentBackupCounts,
  type FullBackupCounts,
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
import { usePlayerStore } from '../../stores/playerStore';
import { useSelectionStore } from '../../stores/selectionStore';
import type { PVPreference, SongType } from '../../types/vocadb';
import {
  areGlobalFilterSettingsEqual,
  getGlobalFilterSummary,
  hasConfiguredSongFilters,
  isGlobalSongFilterActive,
  SONG_TYPE_LABELS,
} from '../../utils/globalFilters';

/* ─── 共通UIパーツ ─── */

function ToggleSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="ui-switch" style={disabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} disabled={disabled} />
      <span className="ui-switch-track" />
    </label>
  );
}

/* ─── SettingsModal ─── */

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<FullBackupPreview | null>(null);
  const [currentCounts, setCurrentCounts] = useState<FullBackupCounts | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [ratingPriority, setRatingPriority] = useState<'backup' | 'current'>('backup');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftFilters, setDraftFilters] = useState<GlobalFilterSettings>(DEFAULT_GLOBAL_FILTER_SETTINGS);
  const [activeTab, setActiveTab] = useState<'filter' | 'playback' | 'data'>('filter');
  const globalFilterState = useGlobalFilterStore();
  const setGlobalFilterSettings = useGlobalFilterStore(state => state.setSettings);
  const resetGlobalFilterSettings = useGlobalFilterStore(state => state.resetSettings);
  const hasSearched = useSearchStore(state => state.hasSearched);
  const refreshSearch = useSearchStore(state => state.search);
  const pvPreference = usePlayerStore(state => state.pvPreference);
  const setPVPreference = usePlayerStore(state => state.setPVPreference);
  const longPressSelectionEnabled = useSelectionStore(state => state.longPressSelectionEnabled);
  const setLongPressSelectionEnabled = useSelectionStore(state => state.setLongPressSelectionEnabled);

  useEffect(() => {
    if (!isOpen) {
      setPreview(null);
      setCurrentCounts(null);
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
        setCurrentCounts(null);
        if (parsed) {
          void readCurrentBackupCounts().then(setCurrentCounts).catch(error => {
            console.error('[FullBackup] Current count read failed', error);
          });
        }
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
      const result = await executeFullBackupImport(preview, { mode, ratingPriority });
      setPreview(null);
      setCurrentCounts(result.after);
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
      ? `適用: ${summary.join(' / ')}`
      : 'フィルターを停止しました。');
  };

  const resetFilters = () => {
    resetGlobalFilterSettings();
    setDraftFilters(DEFAULT_GLOBAL_FILTER_SETTINGS);
    if (hasSearched) void refreshSearch();
    setMessage('フィルターを初期化しました。');
  };

  const toggleExcludedType = (songType: SongType) => {
    updateDraft('excludedSongTypes',
      draftFilters.excludedSongTypes.includes(songType)
        ? draftFilters.excludedSongTypes.filter(t => t !== songType)
        : [...draftFilters.excludedSongTypes, songType]);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="設定・バックアップ">
      <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-label="閉じる" onClick={onClose} />

      <div className="relative max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl shadow-2xl"
           style={{ background: 'var(--color-bg-secondary)', border: '1px solid rgba(255,255,255,0.06)' }}>

        {/* ヘッダー */}
        <div className="sticky top-0 z-10 px-5 pt-5 pb-3" style={{ background: 'var(--color-bg-secondary)' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold" style={{ color: 'var(--color-text-primary)' }}>設定</h2>
            <button type="button" className="btn-ghost rounded-full w-8 h-8 flex items-center justify-center" onClick={onClose} aria-label="閉じる">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>

          {/* 3タブ */}
          <div className="settings-tab-bar" role="tablist" aria-label="設定カテゴリ">
            <button type="button" role="tab" id="settings-tab-filter" aria-controls="settings-panel-filter" aria-selected={activeTab === 'filter'} className="settings-tab" data-active={activeTab === 'filter'} onClick={() => setActiveTab('filter')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>
              表示・発見
            </button>
            <button type="button" role="tab" id="settings-tab-playback" aria-controls="settings-panel-playback" aria-selected={activeTab === 'playback'} className="settings-tab" data-active={activeTab === 'playback'} onClick={() => setActiveTab('playback')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
              再生・操作
            </button>
            <button type="button" role="tab" id="settings-tab-data" aria-controls="settings-panel-data" aria-selected={activeTab === 'data'} className="settings-tab" data-active={activeTab === 'data'} onClick={() => setActiveTab('data')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              データ
            </button>
          </div>
        </div>

        {/* タブコンテンツ */}
        <div className="px-5 pb-5 flex flex-col gap-4">

          {/* ========== 表示・発見タブ ========== */}
          {activeTab === 'filter' && (
            <div id="settings-panel-filter" role="tabpanel" aria-labelledby="settings-tab-filter" tabIndex={0} className="flex flex-col gap-4">
              {/* フィルター有効/無効 */}
              <div className="settings-section">
                <div className="settings-section-title">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>
                  フィルター
                </div>

                <div className="setting-row">
                  <div className="setting-row-info">
                    <span className="setting-row-title">再生数・楽曲種別フィルター</span>
                    <span className="setting-row-desc">
                      指定値以上の曲だけを検索・おすすめに表示
                      {!draftFilters.enabled && hasConfiguredSongFilters(draftFilters) && '（停止中）'}
                    </span>
                  </div>
                  <ToggleSwitch checked={draftFilters.enabled} onChange={v => updateDraft('enabled', v)} />
                </div>

                {isGlobalSongFilterActive(savedFilters) && (
                  <p className="rounded-lg px-2.5 py-1.5 text-[11px] mt-1" style={{ background: 'rgba(6, 214, 160, 0.08)', color: 'var(--color-accent-cyan)' }}>
                    適用中: {getGlobalFilterSummary(savedFilters).join(' / ')}
                  </p>
                )}
                {filtersAreDirty && (
                  <p className="rounded-lg px-2.5 py-1.5 text-[11px] mt-1 text-amber-200" role="status" style={{ background: 'rgba(251, 191, 36, 0.08)' }}>
                    未適用の変更あり
                  </p>
                )}
              </div>

              {/* 再生数閾値 */}
              <div className="settings-section" style={draftFilters.enabled ? undefined : { opacity: 0.45 }}>
                <div className="settings-section-title">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6h-6z"/></svg>
                  最低再生数
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>YouTube</span>
                    <select className="ui-select w-full" defaultValue="" onChange={e => { if (e.target.value) updateDraft('minYoutubeViews', Number(e.target.value)); }}>
                      <option value="">プリセット</option>
                      <option value={10_000}>1万</option>
                      <option value={50_000}>5万</option>
                      <option value={100_000}>10万</option>
                      <option value={500_000}>50万</option>
                      <option value={1_000_000}>100万</option>
                    </select>
                    <input className="ui-number-input" type="number" min={0} step={1} value={draftFilters.minYoutubeViews} onChange={e => updateDraft('minYoutubeViews', Math.max(0, Number(e.target.value) || 0))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>ニコニコ</span>
                    <select className="ui-select w-full" defaultValue="" onChange={e => { if (e.target.value) updateDraft('minNicoViews', Number(e.target.value)); }}>
                      <option value="">プリセット</option>
                      <option value={1_000}>1千</option>
                      <option value={5_000}>5千</option>
                      <option value={10_000}>1万</option>
                      <option value={50_000}>5万</option>
                      <option value={100_000}>10万</option>
                    </select>
                    <input className="ui-number-input" type="number" min={0} step={1} value={draftFilters.minNicoViews} onChange={e => updateDraft('minNicoViews', Math.max(0, Number(e.target.value) || 0))} />
                  </div>
                </div>
              </div>

              {/* 除外する楽曲種別 */}
              <div className="settings-section" style={draftFilters.enabled ? undefined : { opacity: 0.45 }}>
                <div className="settings-section-title">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                  除外する楽曲種別
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {SONG_TYPES.map(songType => (
                    <button
                      key={songType}
                      type="button"
                      className="ui-chip-toggle"
                      data-active={draftFilters.excludedSongTypes.includes(songType)}
                      data-variant="danger"
                      onClick={() => toggleExcludedType(songType)}
                    >
                      {SONG_TYPE_LABELS[songType]}
                    </button>
                  ))}
                </div>
              </div>

              {/* その他のフィルター */}
              <div className="settings-section">
                <div className="setting-row" style={{ paddingTop: 0 }}>
                  <div className="setting-row-info">
                    <span className="setting-row-title">再生クールダウン</span>
                    <span className="setting-row-desc">最近聴いた曲を一定時間、おすすめから除外</span>
                  </div>
                  <select className="ui-select" value={draftFilters.cooldownHours} onChange={e => updateDraft('cooldownHours', Number(e.target.value))}>
                    <option value={0}>なし</option>
                    <option value={1}>1時間</option>
                    <option value={6}>6時間</option>
                    <option value={24}>24時間</option>
                    <option value={72}>3日</option>
                    <option value={168}>7日</option>
                  </select>
                </div>
                <div className="setting-row" style={{ paddingBottom: 0 }}>
                  <div className="setting-row-info">
                    <span className="setting-row-title">評価済みを発見候補から除外</span>
                    <span className="setting-row-desc">すでに評価した曲をおすすめに出さない</span>
                  </div>
                  <ToggleSwitch checked={draftFilters.excludeRatedFromDiscovery} onChange={v => updateDraft('excludeRatedFromDiscovery', v)} />
                </div>
              </div>

              {/* 適用/初期化 */}
              <div className="flex gap-2">
                <button type="button" className="btn-primary flex-1" disabled={busy || !filtersAreDirty} onClick={applyFilters}>
                  適用
                </button>
                <button type="button" className="btn-secondary px-4" disabled={busy} onClick={resetFilters}>
                  初期化
                </button>
              </div>
            </div>
          )}

          {/* ========== 再生・操作タブ ========== */}
          {activeTab === 'playback' && (
            <div id="settings-panel-playback" role="tabpanel" aria-labelledby="settings-tab-playback" tabIndex={0} className="flex flex-col gap-4">
              <div className="settings-section">
                <div className="settings-section-title">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.11 0-2 .89-2 2v14c0 1.11.89 2 2 2h18c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm-9 8H3V5h9v6z"/></svg>
                  PV設定
                </div>
                <div className="setting-row" style={{ paddingTop: 0, paddingBottom: 0 }}>
                  <div className="setting-row-info">
                    <span className="setting-row-title">優先するサービス</span>
                    <span className="setting-row-desc">曲ごとの再生画面で個別選択も可能</span>
                  </div>
                  <select
                    className="ui-select"
                    value={pvPreference}
                    onChange={e => setPVPreference(e.target.value as PVPreference)}
                  >
                    <option value="auto">自動</option>
                    <option value="Youtube">YouTube</option>
                    <option value="NicoNicoDouga">ニコニコ</option>
                  </select>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 11.24V7.5C9 6.12 10.12 5 11.5 5S14 6.12 14 7.5v3.74c1.21-.81 2-2.18 2-3.74C16 5.01 13.99 3 11.5 3S7 5.01 7 7.5c0 1.56.79 2.93 2 3.74zm9.84 4.63l-4.54-2.26c-.17-.07-.35-.11-.54-.11H13v-6c0-.83-.67-1.5-1.5-1.5S10 6.67 10 7.5v10.74l-3.43-.72c-.08-.01-.15-.03-.24-.03-.31 0-.59.13-.79.33l-.79.8 4.94 4.94c.27.27.65.44 1.06.44h6.79c.75 0 1.33-.55 1.44-1.28l.75-5.27c.01-.07.02-.14.02-.2 0-.62-.38-1.16-.91-1.38z"/></svg>
                  操作
                </div>
                <div className="setting-row" style={{ paddingTop: 0, paddingBottom: 0 }}>
                  <div className="setting-row-info">
                    <span className="setting-row-title">長押しで複数選択</span>
                    <span className="setting-row-desc">曲カードの長押しで選択モードを開始</span>
                  </div>
                  <ToggleSwitch checked={longPressSelectionEnabled} onChange={setLongPressSelectionEnabled} />
                </div>
              </div>
            </div>
          )}

          {/* ========== データタブ ========== */}
          {activeTab === 'data' && (
            <div id="settings-panel-data" role="tabpanel" aria-labelledby="settings-tab-data" tabIndex={0} className="flex flex-col gap-4">
              <div className="settings-section">
                <div className="settings-section-title">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z"/></svg>
                  エクスポート
                </div>
                <p className="text-[11px] mb-3" style={{ color: 'var(--color-text-muted)' }}>
                  履歴・評価・プレイリスト・設定をJSONとして保存します。
                </p>
                <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => void exportBackup()}>
                  バックアップを作成
                </button>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM5 10h4v6h6v-6h4l-7-7-7 7z"/></svg>
                  インポート
                </div>
                <p className="text-[11px] mb-3" style={{ color: 'var(--color-text-muted)' }}>
                  保存したJSONファイルからデータを復元します。
                </p>
                <input ref={inputRef} className="hidden" type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) readBackup(file); }} />
                <button type="button" className="btn-secondary w-full" disabled={busy} onClick={() => inputRef.current?.click()}>
                  ファイルを選択
                </button>

                {preview && (
                  <div className="mt-3 rounded-xl p-3 text-sm" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    {preview.preferencesIncluded && <p className="mb-1 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>設定を含むバックアップ</p>}
                    <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                      履歴 {preview.historyCount.toLocaleString()} / 評価 {preview.ratingCount.toLocaleString()} / PL {preview.playlistCount.toLocaleString()} / 曲 {preview.playlistSongCount.toLocaleString()} / フォルダ {preview.folderCount.toLocaleString()}
                    </p>
                    {currentCounts && (
                      <p className="mt-1 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                        現在: PL {currentCounts.playlistCount.toLocaleString()} / 曲 {currentCounts.playlistSongCount.toLocaleString()} / 評価 {currentCounts.ratingCount.toLocaleString()}
                      </p>
                    )}
                    {preview.validationMessages.map(msg => (
                      <p key={msg} className="mt-1 text-amber-300 text-xs" role="alert">{msg}</p>
                    ))}
                    {preview.invalidItems > 0 && <p className="mt-1 text-amber-300 text-xs">無効項目 {preview.invalidItems}件を除外</p>}

                    <div className="mt-3">
                      <div className="ui-segmented w-full">
                        <button type="button" data-active={mode === 'merge'} onClick={() => setMode('merge')}>追加</button>
                        <button type="button" data-active={mode === 'replace'} onClick={() => setMode('replace')}>置換</button>
                      </div>
                    </div>

                    {mode === 'merge' && (
                      <div className="mt-2">
                        <span className="text-[11px] block mb-1" style={{ color: 'var(--color-text-muted)' }}>評価の優先</span>
                        <div className="ui-segmented w-full">
                          <button type="button" data-active={ratingPriority === 'backup'} onClick={() => setRatingPriority('backup')}>バックアップ</button>
                          <button type="button" data-active={ratingPriority === 'current'} onClick={() => setRatingPriority('current')}>現在のデータ</button>
                        </div>
                      </div>
                    )}

                    <button type="button" className="btn-primary mt-3 w-full" disabled={busy || !preview.canRestore} onClick={() => void importBackup()}>
                      この内容を復元
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {message && (
            <p className="text-xs text-center py-1 rounded-lg" role="status"
               style={{ color: 'var(--color-text-secondary)', background: 'rgba(255,255,255,0.03)' }}>
              {message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
