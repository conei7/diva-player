import { useCallback } from 'react';
import { getEnglishTranslations, useLanguageStore, type AppLanguage } from './stores/languageStore';

const messages = {
  ja: {
    navPlaylists: 'プレイリスト',
    sidebarHome: 'ホーム',
    sidebarChorus: 'サビ発掘',
    sidebarHistory: '履歴',
    sidebarRatings: '評価した曲',
    sidebarReports: 'レポート',
    sidebarKnowledgeMap: '知ってる度',
    sidebarSoundMap: '曲調マップ',
    sidebarFavoriteProducers: 'お気に入りP',
    minutes: '{count}分',
    copied: 'コピーしました',
    originalSong: '原曲',
    albumsLabel: 'アルバム',
    create: '作成',
    pvSelectorAria: '再生PVを選択',
    youtubePrepareTimeout: 'YouTube動画の準備がタイムアウトしました',
    youtubePrepareError: 'YouTube動画の準備に失敗しました',
    youtubePlaybackError: 'YouTube動画の再生中にエラーが発生しました',
    menuClose: 'メニューを閉じる',
    searchPlaceholder: 'ボカロP名や曲名で検索',
    search: '検索',
    clear: '検索履歴をすべて削除',
    hiddenMode: '隠しモード',
    multiSelect: '複数選択モード',
    advancedSearch: '詳細検索',
    settings: '設定',
    filtersActive: '表示フィルター適用中',
    autoSearch: 'すべて',
    songSearch: '曲名',
    producerSearch: 'ボカロP',
    vocalistSearch: 'ボーカル',
    suggestionSong: '曲',
    suggestionVocalist: 'ボーカル',
    categoryRecommended: 'おすすめ',
    categoryRanking: 'ランキング',
    categoryPopular: '人気',
    categoryPace: '伸びている曲',
    categoryTrending: '急上昇',
    categoryRecent: '新着',
    categoryDeep: '隠れた名曲',
    categoryHistoryBased: '最近聴いたP',
    categoryFavoriteProducers: 'お気に入りP',
    searchResults: '「{query}」の検索結果',
    searchResultsTitle: '検索結果',
    noSongsFound: '曲が見つかりませんでした',
    noSongsMatchFilters: '条件に合う曲がありません',
    showProducerSongs: '{producer}の曲を表示',
    discoveryLoading: '発掘中…',
    discoveryPlaying: '{count}曲を再生中',
    discoveryMix: '発掘ミックス',
    discoveryEmpty: '新しい曲が見つかりませんでした',
    discoveryError: 'ミックスを作成できませんでした',
    discoveryAria: '発掘ミックスを再生',
    noSongSelected: '曲を選択してください',
    previousSong: '前の曲',
    nextSong: '次の曲',
    pause: '一時停止',
    play: '再生',
    estimatedChorus: '自動推定したサビ候補',
    seekWithChorus: 'シーク（紫色はサビ候補）',
    unofficial: '非公式',
    niconico: 'ニコニコ',
    muteToggle: 'ミュート切替',
    volumePercent: '音量: {volume}%',
    shuffleOff: 'シャッフルOFF',
    shuffleOn: 'シャッフルON',
    shuffleUnavailable: 'シャッフル不可',
    hiddenModeOff: '隠しモードOFF',
    hiddenModeOn: '隠しモードON',
    listeningHistory: '履歴',
    viewHistory: '視聴履歴',
    playQueue: 'キュー',
    playQueueTitle: '再生キュー',
    finished: '終了',
    filterRecommended: 'おすすめ',
    filterRelated: '関連曲',
    filterProducer: '同じPの曲',
    share: '共有',
    copyLink: '曲リンクをコピー',
    save: '保存',
    hide: '表示しない',
    producerShow: '他{count}名のPを表示',
    producerShowShort: '他{count}名',
    producerCollapse: 'P一覧を折りたたむ',
    collapse: '折りたたむ',
    vocalistLabel: 'ボーカル',
    pvLinks: '動画',
    showLess: '一部を表示',
    descriptionCollapseAria: '概要を折りたたむ',
    descriptionExpandAria: '概要を展開する',
    sortBy: '並べ替え',
    sortPopular: '人気順',
    sortRating: '評価順',
    sortTotalViews: '再生数順',
    sortYoutubeViews: 'YouTube再生数順',
    sortNicoViews: 'ニコニコ再生数順',
    sortPublishDate: '公開日順',
    sortAddedDate: 'VocaDB登録日順',
    sortName: '曲名順',
    sortRandom: 'ランダム',
    randomizeSort: '並べ直す',
    switchAsc: '昇順にする',
    switchDesc: '降順にする',
    menu: 'メニュー',
    // 新しいキーは自分のエリアの区画の中に足す（DESIGN_SPEC §8.2-A）。英語の messages にも同じキーを足す
    // ── foundation ──
    // ── /foundation ──
    // ── area:shell ──
    sidebarHomeShort: 'ホーム',
    sidebarChorusShort: 'サビ発掘',
    sidebarFavoriteProducersShort: 'お気に入りP',
    sidebarPlaylistsShort: 'プレイリスト',
    sidebarHistoryShort: '履歴',
    suggestionProducer: 'ボカロP',
    discoveryPlayingOne: '1曲を再生中',
    // 検索履歴の行の「削除」(英語は Remove。共通語彙の「削除」= Delete とは別)
    searchHistoryRemove: '削除',
    // ── /area:shell ──
    // ── area:player ──
    // ── /area:player ──
    // ── area:playlists ──
    // Same Japanese as other source texts but a different English (singular kind, folder, rules, action).
    playlistKindPlaylist: 'プレイリスト',
    playlistUnfiled: '未分類',
    playlistSmartEmpty: '条件に合う曲がありません',
    playlistReviewIssues: '確認',
    // ── /area:playlists ──
    // ── area:watch ──
    // Keys: the same Japanese is a source text with another English (お気に入りP = Favorite producers, 自動再生 = Autoplayed).
    watchFavoriteProducer: 'お気に入りP',
    watchAutoplayDivider: '自動再生',
    // ── /area:watch ──
    // ── area:home ──
    // ── /area:home ──
    // ── area:library ──
    // Keys (not source text): settings / home use the same Japanese with other English or may add the same text.
    libraryBackupSave: 'バックアップを保存',
    libraryBackupSaved: 'バックアップを保存しました',
    libraryBackupSaveFailed: 'バックアップを保存できませんでした',
    libraryProducerCount: '{count}人',
    libraryProducerCountOne: '1人',
    libraryNoFavoriteProducers: 'お気に入りPはまだいません',
    libraryFavoriteProducerPill: 'お気に入りP',
    // ── /area:library ──
    // ── area:discovery ──
    // ── /area:discovery ──
    // ── area:settings ──
    // 他のエリアも原文方式で足しうる汎用の語（同じ日本語で英語が違う・重複キーになる）は settings* のキーにした
    settingsViews: '再生数',
    settingsMinViewsOption: '{count}回以上',
    settingsOrMore: '回以上',
    settingsVocalists: 'ボーカル',
    settingsMatchMode: '一致',
    settingsMatchAny: 'いずれかを含む',
    settingsMatchAll: 'すべて含む',
    settingsMatchExact: 'このボーカルだけ',
    settingsRecommendations: 'おすすめ',
    settingsSaveBackup: 'バックアップを保存',
    settingsSavingBackup: '保存中…',
    settingsBackupSaved: 'バックアップを保存しました',
    settingsBackupSaveFailed: 'バックアップを保存できませんでした',
    settingsFolders: 'フォルダー',
    // ── /area:settings ──
  }
} as const;

export type TranslationKey = keyof typeof messages.ja;

export function translate(
  language: AppLanguage,
  key: TranslationKey,
  values: Record<string, string | number> = {},
): string {
  const englishMessages = language === 'en' ? getEnglishTranslations()?.messages : undefined;
  let message: string = englishMessages?.[key] ?? messages.ja[key];
  for (const [name, value] of Object.entries(values)) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
}

export function translateSourceText(
  language: AppLanguage,
  source: string,
  values: Record<string, string | number> = {},
): string {
  const englishSourceText = language === 'en' ? getEnglishTranslations()?.englishSourceText : undefined;
  let message = englishSourceText?.[source] ?? source;
  for (const [name, value] of Object.entries(values)) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
}

export function useTranslate() {
  const language = useLanguageStore(state => state.language);
  return useCallback(
    (key: TranslationKey, values?: Record<string, string | number>) => translate(language, key, values),
    [language],
  );
}

export function useTranslateSourceText() {
  const language = useLanguageStore(state => state.language);
  return useCallback(
    (source: string, values?: Record<string, string | number>) => translateSourceText(language, source, values),
    [language],
  );
}
