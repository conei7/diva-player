import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { COARSE_POINTER_MEDIA_QUERY, MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useTranslateSourceText } from '../../i18n';
import { confirmDialog } from '../../stores/confirmStore';
import {
  DEFAULT_GLOBAL_FILTER_SETTINGS,
  getGlobalFilterSettings,
  useGlobalFilterStore,
} from '../../stores/globalFilterStore';
import type { GlobalFilterSettings, GlobalFilterState } from '../../stores/globalFilterStore';
import { useLanguageStore } from '../../stores/languageStore';
import type { AppLanguage } from '../../stores/languageStore';
import { usePlayerInteractionStore } from '../../stores/playerInteractionStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useRecommendationDisplayStore } from '../../stores/recommendationDisplayStore';
import { useSearchStore } from '../../stores/searchStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { showToast } from '../../stores/toastStore';
import type { SettingsTab } from '../../stores/uiStore';
import type { PVPreference } from '../../types/vocadb';
import {
  areGlobalFilterSettingsEqual,
  hasConfiguredSongFilters,
  isDiscoveryFilterActive,
} from '../../utils/globalFilters';
import Button from '../ui/Button';
import Dialog from '../ui/Dialog';
import Switch from '../ui/Switch';
import { FolderIcon, SettingsIcon, TuneIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import DataSettingsPanel from './DataSettingsPanel';
import FilterSettingsPanel from './FilterSettingsPanel';
import type { UpdateFilterDraft, ViewThresholdService } from './FilterSettingsPanel';
import { SettingRow, SettingsSelect } from './settingsControls';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 開いた時に表示するタブ（無ければフィルター） */
  initialTab?: SettingsTab;
}

const TAB_ORDER: SettingsTab[] = ['filter', 'playback', 'data'];

const NO_CUSTOM_VIEWS: Record<ViewThresholdService, boolean> = { youtube: false, nico: false };

function selectFilterSettings(state: GlobalFilterState): GlobalFilterSettings {
  return {
    enabled: state.enabled,
    minYoutubeViews: state.minYoutubeViews,
    minNicoViews: state.minNicoViews,
    excludedSongTypes: state.excludedSongTypes,
    excludeSelfCovers: state.excludeSelfCovers,
    vocalistFilters: state.vocalistFilters,
    vocalistMatchMode: state.vocalistMatchMode,
    cooldownHours: state.cooldownHours,
    excludeRatedFromDiscovery: state.excludeRatedFromDiscovery,
  };
}

/** 検索結果を出している時は、新しい条件で検索し直す。 */
function refreshSearchIfShown() {
  const search = useSearchStore.getState();
  if (search.hasSearched) void search.search();
}

/** トーストの［元に戻す］。ダイアログを閉じた後でも動く。 */
function restoreSavedFilters(settings: GlobalFilterSettings) {
  useGlobalFilterStore.getState().setSettings(settings);
  refreshSearchIfShown();
}

/**
 * 全体のショートカット（Space＝再生/一時停止、← →＝シーク）が、設定の中のボタンやタブの操作を
 * 横取りしないようにする（window へ伝えない。Tab と Esc は止めない）。
 */
function keepKeysInside(event: KeyboardEvent<HTMLElement>) {
  if (event.key === ' ' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopPropagation();
}

/** 設定ダイアログ（DESIGN_SPEC §6.8.1）。props はレイアウトから使われるので変えない。 */
export default function SettingsModal({ isOpen, onClose, initialTab }: SettingsModalProps) {
  if (!isOpen) return null;
  return <SettingsDialog onClose={onClose} initialTab={initialTab} />;
}

function SettingsDialog({ onClose, initialTab }: Omit<SettingsModalProps, 'isOpen'>) {
  const t = useTranslateSourceText();
  const navigate = useNavigate();
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const contentRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmingRef = useRef(false);

  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'filter');
  // 開いたまま別のタブを指定された時（「フィルターを変更」など）は、そのタブを出す
  const [requestedTab, setRequestedTab] = useState(initialTab);
  if (requestedTab !== initialTab) {
    setRequestedTab(initialTab);
    setActiveTab(initialTab ?? 'filter');
  }

  /* ─── フィルターの下書き ─── */
  const savedFilters = useGlobalFilterStore(useShallow(selectFilterSettings));
  const setGlobalFilterSettings = useGlobalFilterStore(state => state.setSettings);
  const resetGlobalFilterSettings = useGlobalFilterStore(state => state.resetSettings);
  const [draft, setDraft] = useState<GlobalFilterSettings>(savedFilters);
  const [customViews, setCustomViews] = useState(NO_CUSTOM_VIEWS);
  // 保存済みの値がダイアログの外で変わった時（［元に戻す］・復元など）は、未適用の変更が無ければ下書きも合わせる
  const [followedSaved, setFollowedSaved] = useState(savedFilters);
  if (followedSaved !== savedFilters) {
    setFollowedSaved(savedFilters);
    if (areGlobalFilterSettingsEqual(draft, followedSaved)) {
      setDraft(savedFilters);
      setCustomViews(NO_CUSTOM_VIEWS);
    }
  }
  const filtersDirty = !areGlobalFilterSettingsEqual(draft, savedFilters);
  const resetDisabled = areGlobalFilterSettingsEqual(draft, DEFAULT_GLOBAL_FILTER_SETTINGS)
    && areGlobalFilterSettingsEqual(savedFilters, DEFAULT_GLOBAL_FILTER_SETTINGS);

  const updateDraft: UpdateFilterDraft = (key, value) => {
    setDraft(current => {
      const next: GlobalFilterSettings = { ...current, [key]: value };
      // 再生数・種類・ボーカルを触ったら「フィルターを使う」をオンにする（今までの挙動）
      if ((key === 'minYoutubeViews' || key === 'minNicoViews' || key === 'excludedSongTypes' || key === 'excludeSelfCovers' || key === 'vocalistFilters')
        && hasConfiguredSongFilters(next)) {
        next.enabled = true;
      }
      return next;
    });
  };

  const applyFilters = () => {
    if (!filtersDirty) return;
    const previous = savedFilters;
    setGlobalFilterSettings(draft);
    // ストアは値を正規化して保存するので、下書きも保存された形にそろえる（適用後に「変更あり」が残らないように）
    setDraft(getGlobalFilterSettings());
    refreshSearchIfShown();
    const turnedOff = isDiscoveryFilterActive(previous) && !isDiscoveryFilterActive(draft);
    showToast(turnedOff ? t('フィルターをオフにしました') : t('フィルターを適用しました'), {
      action: { label: t('元に戻す'), onAction: () => restoreSavedFilters(previous) },
    });
  };

  const resetFilters = () => {
    const previous = savedFilters;
    resetGlobalFilterSettings();
    setDraft(DEFAULT_GLOBAL_FILTER_SETTINGS);
    setCustomViews(NO_CUSTOM_VIEWS);
    refreshSearchIfShown();
    showToast(t('フィルターをリセットしました'), {
      action: { label: t('元に戻す'), onAction: () => restoreSavedFilters(previous) },
    });
  };

  /** 閉じる（×・Esc・背景・キャンセル・ページへの移動）。未適用の変更がある時は確認する。 */
  const requestClose = async (afterClose?: () => void) => {
    if (confirmingRef.current) return;
    if (filtersDirty) {
      confirmingRef.current = true;
      try {
        const discard = await confirmDialog({ title: t('変更を破棄しますか？'), confirmLabel: t('破棄') });
        if (!discard) return;
      } finally {
        confirmingRef.current = false;
      }
    }
    afterClose?.();
    onClose();
  };

  const handleLinkClick = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!filtersDirty) {
      onClose();
      return;
    }
    event.preventDefault();
    void requestClose(() => navigate(path));
  };

  /* ─── タブ ─── */
  const selectTab = (tab: SettingsTab) => {
    if (tab === activeTab) return;
    setActiveTab(tab);
    // パネル（ダイアログで唯一のスクロール領域）を先頭へ戻す
    const panel = contentRef.current?.closest('[role="dialog"]')?.firstElementChild;
    if (panel instanceof HTMLElement) panel.scrollTop = 0;
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TAB_ORDER.indexOf(activeTab);
    let next: number;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % TAB_ORDER.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TAB_ORDER.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    const tab = TAB_ORDER[next];
    selectTab(tab);
    tabRefs.current[tab]?.focus();
  };

  const tabs: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
    { id: 'filter', label: t('フィルター'), icon: <TuneIcon /> },
    { id: 'playback', label: t('全般'), icon: <SettingsIcon /> },
    { id: 'data', label: t('データ'), icon: <FolderIcon /> },
  ];

  /**
   * ［適用］［リセット］は押すと押せなくなる（変更が無くなる）。フォーカスがそのボタンに残ると body へ落ちて
   * 押した場所を見失うので、押せるまま残る［キャンセル］へ先に移す。
   */
  const moveFocusOffPressedButton = (event: MouseEvent<HTMLButtonElement>) => {
    if (document.activeElement === event.currentTarget) cancelButtonRef.current?.focus({ preventScroll: true });
  };

  const onFilterTab = activeTab === 'filter';
  const footerStart = onFilterTab ? (
    <div className="contents" onKeyDown={keepKeysInside}>
      <Button
        variant="text"
        disabled={resetDisabled}
        onClick={event => {
          moveFocusOffPressedButton(event);
          resetFilters();
        }}
      >
        {t('リセット')}
      </Button>
    </div>
  ) : undefined;
  const footer = onFilterTab ? (
    <div className="contents" onKeyDown={keepKeysInside}>
      <Button ref={cancelButtonRef} variant="ghost" onClick={() => void requestClose()}>{t('キャンセル')}</Button>
      <Button
        variant="primary"
        disabled={!filtersDirty}
        onClick={event => {
          moveFocusOffPressedButton(event);
          applyFilters();
        }}
      >
        {t('適用')}
      </Button>
    </div>
  ) : undefined;

  return (
    <Dialog
      open
      onClose={() => void requestClose()}
      title={<span className="text-xl leading-7">{t('設定')}</span>}
      ariaLabel={t('設定')}
      size="xl"
      panelClassName={cx(
        'sm:h-[min(640px,calc(100dvh-48px))]',
        // フッター（フィルタータブだけ）の上の区切り線
        onFilterTab && '[&>div:last-child]:border-t [&>div:last-child]:border-yt-divider',
      )}
      footerStart={footerStart}
      footer={footer}
    >
      <div ref={contentRef} className="sm:flex sm:items-start sm:gap-6 sm:pt-2" onKeyDown={keepKeysInside}>
        <div
          role="tablist"
          aria-label={t('設定カテゴリ')}
          aria-orientation={isMobile ? 'horizontal' : 'vertical'}
          onKeyDown={onTabKeyDown}
          className={cx(
            'flex gap-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            // モバイル: ヘッダーの下に固定する Chip 型のタブ
            'max-sm:sticky max-sm:top-[max(56px,calc(48px_+_env(safe-area-inset-top)))] max-sm:z-[5] max-sm:-mx-4 max-sm:overflow-x-auto max-sm:bg-yt-raised max-sm:px-4 max-sm:py-2',
            // デスクトップ: 左の縦のタブ（220px）。本文をスクロールしても見えたまま
            'sm:sticky sm:top-16 sm:w-[220px] sm:shrink-0 sm:flex-col sm:gap-1 sm:self-start',
          )}
        >
          {tabs.map(tab => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                ref={element => { tabRefs.current[tab.id] = element; }}
                type="button"
                role="tab"
                id={`settings-tab-${tab.id}`}
                aria-controls={`settings-panel-${tab.id}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(tab.id)}
                className={cx(
                  'flex h-10 shrink-0 cursor-pointer select-none items-center whitespace-nowrap text-sm leading-5 transition-colors duration-150 [-webkit-tap-highlight-color:transparent]',
                  'max-sm:rounded-chip max-sm:px-3 max-sm:font-medium',
                  'sm:w-full sm:gap-4 sm:rounded-row sm:px-3',
                  selected
                    ? 'max-sm:bg-yt-inverse max-sm:text-yt-on-inverse sm:bg-yt-tonal sm:font-medium sm:text-yt-text'
                    : 'max-sm:bg-yt-tonal max-sm:text-yt-text max-sm:hover:bg-yt-tonal-hover sm:text-yt-text-secondary sm:hover:bg-yt-tonal sm:hover:text-yt-text',
                )}
              >
                <span aria-hidden="true" className="flex max-sm:hidden">{tab.icon}</span>
                {tab.label}
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
          className="min-w-0 flex-1 max-sm:pt-2"
        >
          {activeTab === 'filter' && (
            <FilterSettingsPanel
              draft={draft}
              updateDraft={updateDraft}
              customViews={customViews}
              setCustomView={(service, custom) => setCustomViews(current => ({ ...current, [service]: custom }))}
            />
          )}
          {activeTab === 'playback' && <GeneralSettingsPanel />}
          {activeTab === 'data' && <DataSettingsPanel onLinkClick={handleLinkClick} />}
        </div>
      </div>
    </Dialog>
  );
}

/** タブ「全般」。すべて即時に反映する。 */
function GeneralSettingsPanel() {
  const t = useTranslateSourceText();
  const ids = useId();
  const language = useLanguageStore(state => state.language);
  const setLanguage = useLanguageStore(state => state.setLanguage);
  const pvPreference = usePlayerStore(state => state.pvPreference);
  const setPVPreference = usePlayerStore(state => state.setPVPreference);
  const showRecommendationHints = useRecommendationDisplayStore(state => state.showHints);
  const setShowRecommendationHints = useRecommendationDisplayStore(state => state.setShowHints);
  const longPressSelectionEnabled = useSelectionStore(state => state.longPressSelectionEnabled);
  const setLongPressSelectionEnabled = useSelectionStore(state => state.setLongPressSelectionEnabled);
  const swipeGestureEnabled = usePlayerInteractionStore(state => state.swipeGestureEnabled);
  const setSwipeGestureEnabled = usePlayerInteractionStore(state => state.setSwipeGestureEnabled);
  // ミニプレイヤーのスワイプはタッチ操作だけの機能なので、タッチ端末の時だけ出す
  const touchDevice = useMediaQuery(COARSE_POINTER_MEDIA_QUERY);

  return (
    <div>
      <SettingRow label={t('表示言語')} htmlFor={`${ids}-language`}>
        <SettingsSelect
          id={`${ids}-language`}
          value={language}
          onChange={event => void setLanguage(event.target.value as AppLanguage)}
        >
          <option value="ja" lang="ja">日本語</option>
          <option value="en" lang="en">English</option>
        </SettingsSelect>
      </SettingRow>
      <SettingRow label={t('優先する動画サービス')} htmlFor={`${ids}-pv`}>
        <SettingsSelect
          id={`${ids}-pv`}
          value={pvPreference}
          onChange={event => setPVPreference(event.target.value as PVPreference)}
        >
          <option value="auto">{t('自動（公式優先）')}</option>
          <option value="Youtube">YouTube</option>
          <option value="NicoNicoDouga">{t('ニコニコ')}</option>
        </SettingsSelect>
      </SettingRow>
      <Switch
        className="setting-row min-h-14 py-2"
        label={t('おすすめの理由を表示')}
        checked={showRecommendationHints}
        onChange={setShowRecommendationHints}
      />
      <Switch
        className="setting-row min-h-14 py-2"
        label={t('長押しで複数選択')}
        checked={longPressSelectionEnabled}
        onChange={setLongPressSelectionEnabled}
      />
      {touchDevice && (
        <Switch
          className="setting-row min-h-14 py-2"
          label={t('ミニプレイヤーのスワイプ')}
          description={t('左右で曲送り・上で再生ページ')}
          checked={swipeGestureEnabled}
          onChange={setSwipeGestureEnabled}
        />
      )}
    </div>
  );
}
