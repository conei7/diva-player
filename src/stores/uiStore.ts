/**
 * uiStore.ts - UI状態のグローバル管理
 *
 * サイドバーの開閉状態、楽曲詳細モーダル、レイアウト状態を管理する。
 */
import { create } from 'zustand';
import type { Song } from '../types/vocadb';
import { storage } from '../utils/storage';

/** 展開ガイド（1312px 以上）を開いているか。localStorage の diva_guideExpanded（既定 true） */
const GUIDE_EXPANDED_STORAGE_KEY = 'guideExpanded';

function readGuideExpanded(): boolean {
  if (typeof window === 'undefined') return true;
  return storage.get<boolean>(GUIDE_EXPANDED_STORAGE_KEY) !== false;
}

function saveGuideExpanded(expanded: boolean): void {
  if (typeof window !== 'undefined') storage.set(GUIDE_EXPANDED_STORAGE_KEY, expanded);
}

export interface SaveToPlaylistContext {
  source: 'default' | 'queue';
  queueIndex?: number;
  /** 保存先の一覧から外すプレイリスト（今開いているリストなど） */
  excludePlaylistId?: string;
}

/** 設定ダイアログのタブ。id は今のまま（表示名は「フィルター」「全般」「データ」） */
export type SettingsTab = 'filter' | 'playback' | 'data';

export interface SettingsDialogState {
  open: boolean;
  tab: SettingsTab;
}

interface UiState {
  /** 詳細モーダルに表示中の楽曲。null = モーダル閉じている */
  detailSong: Song | null;

  /** 指定楽曲の詳細モーダルを開く */
  openSongDetail: (song: Song) => void;

  /** 詳細モーダルを閉じる */
  closeSongDetail: () => void;

  /** 「プレイリストに保存」モーダルの対象曲。null = 閉じている */
  saveToPlaylistSongs: Song[] | null;
  saveToPlaylistContext: SaveToPlaylistContext;
  openSaveToPlaylist: (songOrSongs: Song | Song[], context?: SaveToPlaylistContext) => void;
  closeSaveToPlaylist: () => void;

  /** 1312px 以上で展開ガイド（240px）を出すか。false ならミニガイド（72px）。≡ で切り替え、保存する */
  sidebarExpanded: boolean;
  toggleSidebar: () => void;
  setSidebarExpanded: (v: boolean) => void;

  /** ガイドのドロワー（1312px 未満の ≡・モバイルの「メニュー」・再生ページの ≡） */
  mobileDrawerOpen: boolean;
  toggleMobileDrawer: () => void;
  closeMobileDrawer: () => void;

  /**
   * ガイド・下部ナビで押した行き先（path + search）。ページの描画が終わるまで選択表示と
   * 上端の読み込みバーに使う。null = 移動中ではない
   */
  pendingNavigation: string | null;
  startNavigation: (to: string) => void;
  finishNavigation: () => void;

  /** 詳細検索パネルの開閉（TopNavとHomePageで共有） */
  advancedSearchOpen: boolean;
  toggleAdvancedSearch: () => void;
  setAdvancedSearchOpen: (v: boolean) => void;

  /** 設定ダイアログ。どこからでも openSettings(tab) で開ける */
  settingsDialog: SettingsDialogState;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;

  /** キーボード ショートカット一覧 */
  keyboardShortcutsOpen: boolean;
  setKeyboardShortcutsOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  detailSong: null,
  openSongDetail: (song) => set({ detailSong: song }),
  closeSongDetail: () => set({ detailSong: null }),

  saveToPlaylistSongs: null,
  saveToPlaylistContext: { source: 'default' },
  openSaveToPlaylist: (songOrSongs, context = { source: 'default' }) => set({
    saveToPlaylistSongs: Array.isArray(songOrSongs) ? [...songOrSongs] : [songOrSongs],
    saveToPlaylistContext: context,
  }),
  closeSaveToPlaylist: () => set({ saveToPlaylistSongs: null, saveToPlaylistContext: { source: 'default' } }),

  sidebarExpanded: readGuideExpanded(),
  toggleSidebar: () => set((s) => {
    const sidebarExpanded = !s.sidebarExpanded;
    saveGuideExpanded(sidebarExpanded);
    return { sidebarExpanded };
  }),
  setSidebarExpanded: (v) => {
    saveGuideExpanded(v);
    set({ sidebarExpanded: v });
  },

  mobileDrawerOpen: false,
  toggleMobileDrawer: () => set((s) => ({ mobileDrawerOpen: !s.mobileDrawerOpen })),
  closeMobileDrawer: () => set((s) => (s.mobileDrawerOpen ? { mobileDrawerOpen: false } : s)),

  pendingNavigation: null,
  startNavigation: (to) => set({ pendingNavigation: to }),
  finishNavigation: () => set((s) => (s.pendingNavigation === null ? s : { pendingNavigation: null })),

  advancedSearchOpen: false,
  toggleAdvancedSearch: () => set((s) => ({ advancedSearchOpen: !s.advancedSearchOpen })),
  setAdvancedSearchOpen: (v) => set({ advancedSearchOpen: v }),

  settingsDialog: { open: false, tab: 'filter' },
  openSettings: (tab = 'filter') => set({ settingsDialog: { open: true, tab } }),
  closeSettings: () => set((s) => (s.settingsDialog.open
    ? { settingsDialog: { ...s.settingsDialog, open: false } }
    : s)),

  keyboardShortcutsOpen: false,
  setKeyboardShortcutsOpen: (open) => set({ keyboardShortcutsOpen: open }),
}));
