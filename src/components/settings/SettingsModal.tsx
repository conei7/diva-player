import { useEffect, useState } from 'react';
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
import { usePlayerInteractionStore } from '../../stores/playerInteractionStore';
import { useRecommendationDisplayStore } from '../../stores/recommendationDisplayStore';
import type { PVPreference, SongType } from '../../types/vocadb';
import {
  areGlobalFilterSettingsEqual,
  getGlobalFilterSummary,
  hasConfiguredSongFilters,
  isGlobalSongFilterActive,
  SONG_TYPE_LABELS,
} from '../../utils/globalFilters';
import BackupModal from './BackupModal';
import { Link } from 'react-router';

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
  const [message, setMessage] = useState('');
  const [draftFilters, setDraftFilters] = useState<GlobalFilterSettings>(DEFAULT_GLOBAL_FILTER_SETTINGS);
  const [activeTab, setActiveTab] = useState<'filter' | 'playback' | 'data'>('filter');
  const [backupOpen, setBackupOpen] = useState(false);
  const globalFilterState = useGlobalFilterStore();
  const setGlobalFilterSettings = useGlobalFilterStore(state => state.setSettings);
  const resetGlobalFilterSettings = useGlobalFilterStore(state => state.resetSettings);
  const hasSearched = useSearchStore(state => state.hasSearched);
  const refreshSearch = useSearchStore(state => state.search);
  const pvPreference = usePlayerStore(state => state.pvPreference);
  const setPVPreference = usePlayerStore(state => state.setPVPreference);
  const longPressSelectionEnabled = useSelectionStore(state => state.longPressSelectionEnabled);
  const setLongPressSelectionEnabled = useSelectionStore(state => state.setLongPressSelectionEnabled);
  const swipeGestureEnabled = usePlayerInteractionStore(state => state.swipeGestureEnabled);
  const setSwipeGestureEnabled = usePlayerInteractionStore(state => state.setSwipeGestureEnabled);
  const showRecommendationHints = useRecommendationDisplayStore(state => state.showHints);
  const setShowRecommendationHints = useRecommendationDisplayStore(state => state.setShowHints);

  useEffect(() => {
    if (!isOpen) {
      setMessage('');
      setBackupOpen(false);
    } else {
      setDraftFilters(getGlobalFilterSettings());
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || backupOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [backupOpen, isOpen, onClose]);

  if (!isOpen) return null;

  if (backupOpen) {
    return <BackupModal isOpen onBack={() => setBackupOpen(false)} onClose={onClose} />;
  }

  const savedFilters: GlobalFilterSettings = {
    enabled: globalFilterState.enabled,
    minYoutubeViews: globalFilterState.minYoutubeViews,
    minNicoViews: globalFilterState.minNicoViews,
    excludedSongTypes: globalFilterState.excludedSongTypes,
    cooldownHours: globalFilterState.cooldownHours,
    excludeRatedFromDiscovery: globalFilterState.excludeRatedFromDiscovery,
  };
  const filtersAreDirty = !areGlobalFilterSettingsEqual(draftFilters, savedFilters);

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
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="設定">
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
                <div className="setting-row" style={{ paddingBottom: 0 }}>
                  <div className="setting-row-info">
                    <span className="setting-row-title">選曲ヒント</span>
                    <span className="setting-row-desc">カードに「音が近い」などの短いヒントを表示</span>
                  </div>
                  <ToggleSwitch checked={showRecommendationHints} onChange={setShowRecommendationHints} />
                </div>
              </div>

              {/* 適用/初期化 */}
              <div className="flex gap-2">
                <button type="button" className="btn-primary flex-1" disabled={!filtersAreDirty} onClick={applyFilters}>
                  適用
                </button>
                <button type="button" className="btn-secondary px-4" onClick={resetFilters}>
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
                    <span className="setting-row-desc">自動は公式PVを優先し、両方公式ならYouTube</span>
                  </div>
                  <select
                    className="ui-select"
                    value={pvPreference}
                    onChange={e => setPVPreference(e.target.value as PVPreference)}
                  >
                    <option value="auto">自動（公式優先）</option>
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
                <div className="setting-row" style={{ paddingTop: 0, paddingBottom: 0 }}>
                  <div className="setting-row-info">
                    <span className="setting-row-title">PiPのスワイプ操作</span>
                    <span className="setting-row-desc">左・右で曲送り、上で再生画面を開く（スマホ・タッチ操作のみ）</span>
                  </div>
                  <ToggleSwitch checked={swipeGestureEnabled} onChange={setSwipeGestureEnabled} />
                </div>
              </div>
            </div>
          )}

          {/* ========== データタブ ========== */}
          {activeTab === 'data' && (
            <div id="settings-panel-data" role="tabpanel" aria-labelledby="settings-tab-data" tabIndex={0} className="flex flex-col gap-4">
              <div className="settings-data-hero">
                <div className="settings-data-icon" aria-hidden="true">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14a2 2 0 0 0 2-2v-4" /><path d="M3 15v4a2 2 0 0 0 2 2" />
                  </svg>
                </div>
                <span className="backup-version-badge">完全バックアップ v6</span>
                <h3>大切なデータをまとめて管理</h3>
                <p>履歴、評価、プレイリスト、お気に入りP、表示しない曲、表示設定をひとつのJSONファイルとして保存・復元できます。</p>
                <div className="settings-data-items" aria-label="バックアップ対象">
                  {['履歴', '評価', 'プレイリスト', 'お気に入りP', '表示しない曲', '表示設定'].map(item => <span key={item}>{item}</span>)}
                </div>
                <button type="button" className="btn-primary w-full" onClick={() => setBackupOpen(true)}>
                  データとバックアップを開く
                </button>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">好みの管理</div>
                <p className="setting-row-desc mb-3">「表示しない」にした曲の確認と解除は、専用ページから行えます。</p>
                <Link to="/settings/hidden-songs" className="btn-secondary flex w-full items-center justify-between px-4 py-3" onClick={onClose}>
                  <span>表示しない曲を管理</span>
                  <span aria-hidden="true">→</span>
                </Link>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">保存について</div>
                <p className="setting-row-desc">データはこのブラウザ内に保存されています。端末移行やブラウザデータ消去に備え、定期的な完全バックアップをおすすめします。</p>
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
