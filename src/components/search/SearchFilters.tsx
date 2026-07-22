import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchStore } from '../../stores/searchStore';
import {
  ADVANCED_SEARCH_LIMITS,
  sanitizeAdvancedIntegerInput,
  type AdvancedSearchFilters,
  type ExtendedSortRule,
} from '../../stores/searchStore';
import type { VocalistMatchMode } from '../../types/vocadb';
import { searchVocalistsByName } from '../../api/vocadb';
import type { Artist } from '../../types/vocadb';
import { VOICE_SYNTH_ARTIST_TYPES, VOICE_SYNTH_TYPE_LABELS } from '../../config/voiceSynthTypes';

// hall_of_fame_singers.json の型定義
interface HallOfFameSinger { id: number; name: string; artist_type: string; }
interface HallOfFameData {
  exported_at: string;
  by_type: Record<string, HallOfFameSinger[]>;
  all: HallOfFameSinger[];
}

// artist_type → 表示ラベルのマッピング（表示順も兼ねる）
const TYPE_DISPLAY_ORDER = VOICE_SYNTH_ARTIST_TYPES;
const TYPE_LABELS: Readonly<Record<string, string>> = VOICE_SYNTH_TYPE_LABELS;

const SORT_OPTIONS: { value: ExtendedSortRule; label: string }[] = [
  { value: 'FavoritedTimes', label: '人気順' },
  { value: 'RatingScore',    label: '評価順' },
  { value: 'TotalViews',     label: '合計再生回数順' },
  { value: 'YoutubeViews',   label: 'YouTube再生順' },
  { value: 'NicoViews',     label: 'ニコニコ再生順' },
  { value: 'PublishDate',    label: '公開日順' },
  { value: 'AdditionDate',   label: '登録日順' },
  { value: 'Name',           label: '名前順' },
];

const MATCH_MODES: { value: VocalistMatchMode; label: string }[] = [
  { value: 'All',   label: 'すべて含む' },
  { value: 'Any',   label: 'いずれかを含む' },
  { value: 'Exact', label: '完全一致' },
];

interface PresetVocalist { id: number; name: string; }

const VOCALIST_CATEGORIES: { label: string; vocalists: PresetVocalist[] }[] = [
  {
    label: 'ボカロ',
    vocalists: [
      { id: 1,     name: '初音ミク' },
      { id: 2,     name: '巡音ルカ' },
      { id: 14,    name: '鏡音リン' },
      { id: 15,    name: '鏡音レン' },
      { id: 71,    name: 'KAITO' },
      { id: 176,   name: 'MEIKO' },
      { id: 3,     name: 'GUMI' },
      { id: 12,    name: '神威がくぽ' },
      { id: 504,   name: 'IA' },
      { id: 1766,  name: 'MAYU' },
      { id: 139,   name: 'Lily' },
      { id: 381,   name: 'CUL' },
      { id: 16545, name: 'kokone' },
      { id: 25148, name: 'Chika' },
      { id: 21165, name: 'flower' },
      { id: 40866, name: 'Fukase' },
      { id: 117,   name: 'VY1' },
      { id: 118,   name: 'VY2' },
      { id: 146,   name: 'SF-A2 miki' },
      { id: 191,   name: '歌愛ユキ' },
      { id: 156,   name: '蒼姫ラピス' },
      { id: 380,   name: '兎眠りおん' },
      { id: 246,   name: '氷山キヨテル' },
      { id: 30995, name: '心華' },
      { id: 383,   name: 'Oliver' },
      { id: 623,   name: '結月ゆかり' },
    ],
  },
  {
    label: 'UTAU',
    vocalists: [
      { id: 116,   name: '重音テト' },
      { id: 1746,  name: '波音リツ' },
      { id: 803,   name: 'デフォ子（唄音ウタ）' },
      { id: 1776,  name: '健音テイ' },
      { id: 809,   name: '雪歌ユフ' },
      { id: 31161, name: '闇音レンリ' },
      { id: 1657,  name: '滲音かこい' },
      { id: 15199, name: '薪宮風季' },
      { id: 891,   name: '春歌ナナ' },
      { id: 598,   name: '桃音モモ' },
      { id: 118892, name: 'ゆっくり' },
      { id: 10081, name: 'ルーク' },
      { id: 1999,  name: '実谷ナナ' },
      { id: 364,   name: '空音ラナ' },
      { id: 2698,  name: '愛野ハテ' },
      { id: 57096, name: 'ゲキヤク' },
      { id: 14717, name: '朱音イナリ' },
      { id: 26933, name: '暗鳴ニュイ' },
      { id: 95264, name: 'ぽよろいど' },
      { id: 74389, name: '足立レイ' },
      { id: 58538, name: 'ずんだもん（UTAU）' },
    ],
  },
  {
    label: 'CeVIO / SynthV',
    vocalists: [
      { id: 83928, name: '可不（KAFU）' },
      { id: 31062, name: 'ONE' },
      { id: 99953, name: '星界' },
      { id: 105295, name: '裏命' },
      { id: 112287, name: '羽累' },
      { id: 85853, name: '小春六花' },
      { id: 103592, name: '花隈千冬' },
      { id: 69286, name: '闇音レンリ（SynthV）' },
      { id: 85854, name: 'めろう' },
      { id: 36207, name: '東北きりたん' },
      { id: 81912, name: '琴葉茜・葵（SynthV）' },
    ],
  },
  {
    label: 'ボイロ / AIVOICE',
    vocalists: [
      { id: 16933, name: '東北ずん子' },
      { id: 62968, name: '紲星あかり' },
      { id: 69771, name: '東北イタコ' },
      { id: 40988, name: '琴葉茜' },
      { id: 86365, name: '琴葉葵' },
      { id: 2053,  name: '弦巻マキ' },
      { id: 87780, name: '音街ウナ' },
    ],
  },
  {
    label: 'VOICEVOX',
    vocalists: [
      { id: 98107, name: 'ずんだもん' },
      { id: 96298, name: '四国めたん' },
      { id: 105181, name: '春日部つむぎ' },
      { id: 98817, name: '雨晴はう' },
      { id: 111156, name: 'WhiteCUL' },
    ],
  },
];

export default function SearchFilters() {
  const {
    sort, setSort, search,
    sortOrder, setSortOrder,
    vocalistFilters, vocalistMatchMode,
    addVocalistFilter, removeVocalistFilter, setVocalistMatchMode,
    songTypeFilter, setSongTypeFilter,
    advancedFilters, setAdvancedFilters, resetAdvancedFilters,
  } = useSearchStore();

  const [vocalistQuery, setVocalistQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Artist[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const suggestRef = useRef<HTMLDivElement>(null);

  // hall_of_fame_singers.json を非同期で取得 (失敗時はハードコードにフォールバック)
  const [dynamicCategories, setDynamicCategories] = useState<{ label: string; vocalists: PresetVocalist[] }[] | null>(null);
  const [categoriesLoading, setCategoriesLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/data/hall_of_fame_singers.json', { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<HallOfFameData>;
      })
      .then(data => {
        const cats = TYPE_DISPLAY_ORDER
          .filter(type => (data.by_type[type]?.length ?? 0) > 0)
          .map(type => ({
            label:     TYPE_LABELS[type],
            vocalists: data.by_type[type].map(s => ({ id: s.id, name: s.name })),
          }));
        setDynamicCategories(cats.length > 0 ? cats : null);
      })
      .catch(() => {
        // ファイル未生成 or ネットワークエラー → ハードコードを使用
        setDynamicCategories(null);
      })
      .finally(() => setCategoriesLoading(false));
    return () => controller.abort();
  }, []);

  const activeCategories = dynamicCategories ?? VOCALIST_CATEGORIES;
  const allPresets = useMemo(
    () => activeCategories.flatMap(c => c.vocalists),
    [activeCategories],
  );

  useEffect(() => {
    if (vocalistQuery.trim().length < 1) { setSuggestions([]); return; }
    const timer = setTimeout(async () => {
      const results = await searchVocalistsByName(vocalistQuery);
      setSuggestions(results);
      setShowSuggestions(true);
    }, 300);
    return () => clearTimeout(timer);
  }, [vocalistQuery]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (suggestRef.current && !suggestRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedIds = new Set(vocalistFilters.map(v => v.id));

  const handleTogglePreset = (v: PresetVocalist) => {
    if (selectedIds.has(v.id)) {
      removeVocalistFilter(v.id);
    } else {
      addVocalistFilter(v);
    }
    search();
  };

  const handleSelectSuggestion = (v: Artist) => {
    addVocalistFilter({ id: v.id, name: v.name });
    setVocalistQuery('');
    setSuggestions([]);
    setShowSuggestions(false);
    search();
  };

  const nonPresetSelected = vocalistFilters.filter(v => !allPresets.some(p => p.id === v.id));

  const updateBoundedInteger = (
    key: keyof Pick<AdvancedSearchFilters, 'publishYearFrom' | 'publishYearTo' | 'lengthMinSeconds' | 'lengthMaxSeconds'>,
    value: string,
    min: number,
    max: number,
  ) => {
    setAdvancedFilters({ [key]: sanitizeAdvancedIntegerInput(value, min, max) });
  };

  return (
    <div className="flex flex-col gap-4 rounded-xl p-4"
         style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>

      {/* ===== シンガーで絞り込み ===== */}
      <div className="flex flex-col gap-3">

        {/* ヘッダー：タイトル + 一致条件 */}
        <div 
          className="flex items-center justify-between flex-wrap gap-2 cursor-pointer select-none"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', color: 'var(--color-text-muted)' }}>
              <path d="M6 9l6 6 6-6"/>
            </svg>
            <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
              シンガーで絞り込み
            </span>
            {vocalistFilters.length > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-accent-purple)', color: '#fff' }}>
                {vocalistFilters.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            {MATCH_MODES.map(m => (
              <button
                key={m.value}
                className="text-[11px] px-2 py-0.5 rounded transition-colors"
                style={{
                  background: vocalistMatchMode === m.value ? 'rgba(139, 92, 246, 0.2)' : 'transparent',
                  color: vocalistMatchMode === m.value ? 'var(--color-accent-purple)' : 'var(--color-text-muted)',
                  border: vocalistMatchMode === m.value
                    ? '1px solid rgba(139, 92, 246, 0.4)'
                    : '1px solid transparent',
                }}
                onClick={() => { setVocalistMatchMode(m.value); if (vocalistFilters.length > 0) search(); }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* 展開時のみ表示されるエリア */}
        {isExpanded && (
          <div className="flex flex-col gap-3 mt-2 animate-fade-in">

        {/* カテゴリ別プリセットボタン */}
        {categoriesLoading ? (
          <div className="flex items-center gap-2 py-2" style={{ color: 'var(--color-text-muted)' }}>
            <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4
                       M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
            <span className="text-xs">シンガー一覧を読み込み中...</span>
          </div>
        ) : (
          activeCategories.map(cat => (
          <div key={cat.label} className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold tracking-wider uppercase"
                  style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
              {cat.label}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {cat.vocalists.map(v => {
                const isOn = selectedIds.has(v.id);
                return (
                  <button
                    key={v.id}
                    onClick={() => handleTogglePreset(v)}
                    className="text-xs px-2.5 py-1 rounded-full transition-all duration-150"
                    style={{
                      background: isOn ? 'rgba(139, 92, 246, 0.2)' : 'var(--color-surface-elevated)',
                      color: isOn ? 'var(--color-accent-purple)' : 'var(--color-text-secondary)',
                      border: isOn
                        ? '1px solid rgba(139, 92, 246, 0.5)'
                        : '1px solid var(--color-border)',
                      fontWeight: isOn ? 600 : 400,
                    }}
                  >
                    {isOn && <span className="mr-0.5 text-[10px]">✓</span>}
                    {v.name}
                  </button>
                );
              })}
            </div>
          </div>
          ))
        )}

        {/* その他: テキスト入力 + サジェスト */}
        <div className="relative" ref={suggestRef}>
          <div className="flex items-center gap-2 text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            </svg>
            その他のシンガーを検索
          </div>
          <input
            type="text"
            value={vocalistQuery}
            onChange={e => setVocalistQuery(e.target.value)}
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            placeholder="シンガー名を入力..."
            className="w-full text-sm rounded-lg px-3 py-1.5 outline-none transition-colors"
            style={{
              background: 'var(--color-surface-elevated)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border)',
            }}
          />
          {showSuggestions && suggestions.length > 0 && (
            <ul
              className="absolute top-full left-0 right-0 z-20 mt-1 rounded-lg overflow-hidden shadow-xl"
              style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}
            >
              {suggestions.map(s => (
                <li
                  key={s.id}
                  className="px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-white/5"
                  style={{ color: 'var(--color-text-primary)' }}
                  onMouseDown={() => handleSelectSuggestion(s)}
                >
                  <span>{s.name}</span>
                  <span className="ml-2 text-xs opacity-50">{s.artistType}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* プリセット外の選択チップ */}
        {isExpanded && nonPresetSelected.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {nonPresetSelected.map(v => (
              <span
                key={v.id}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                style={{
                  background: 'rgba(139, 92, 246, 0.15)',
                  color: 'var(--color-accent-purple)',
                  border: '1px solid rgba(139, 92, 246, 0.35)',
                }}
              >
                {v.name}
                <button
                  onClick={() => { removeVocalistFilter(v.id); search(); }}
                  className="opacity-70 hover:opacity-100 transition-opacity ml-0.5"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}

          </div>
        )}
        {/* Active filters display even when collapsed if any */}
        {!isExpanded && vocalistFilters.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {vocalistFilters.map(v => (
              <span
                key={v.id}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                style={{
                  background: 'rgba(139, 92, 246, 0.15)',
                  color: 'var(--color-accent-purple)',
                  border: '1px solid rgba(139, 92, 246, 0.35)',
                }}
              >
                {v.name}
                <button
                  onClick={() => { removeVocalistFilter(v.id); search(); }}
                  className="opacity-70 hover:opacity-100 transition-opacity ml-0.5"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--color-border)' }} />

      {/* ===== 詳細条件 ===== */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>投稿年</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              inputMode="numeric"
              min={ADVANCED_SEARCH_LIMITS.publishYearMin}
              max={ADVANCED_SEARCH_LIMITS.publishYearMax}
              step={1}
              value={advancedFilters.publishYearFrom}
              onChange={e => updateBoundedInteger('publishYearFrom', e.target.value, ADVANCED_SEARCH_LIMITS.publishYearMin, ADVANCED_SEARCH_LIMITS.publishYearMax)}
              placeholder="2007"
              className="w-full text-sm rounded-lg px-2 py-1.5 outline-none"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
            />
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>〜</span>
            <input
              type="number"
              inputMode="numeric"
              min={ADVANCED_SEARCH_LIMITS.publishYearMin}
              max={ADVANCED_SEARCH_LIMITS.publishYearMax}
              step={1}
              value={advancedFilters.publishYearTo}
              onChange={e => updateBoundedInteger('publishYearTo', e.target.value, ADVANCED_SEARCH_LIMITS.publishYearMin, ADVANCED_SEARCH_LIMITS.publishYearMax)}
              placeholder="2026"
              className="w-full text-sm rounded-lg px-2 py-1.5 outline-none"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>曲の長さ（秒）</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              inputMode="numeric"
              min={ADVANCED_SEARCH_LIMITS.lengthMinSeconds}
              max={ADVANCED_SEARCH_LIMITS.lengthMaxSeconds}
              step={1}
              value={advancedFilters.lengthMinSeconds}
              onChange={e => updateBoundedInteger('lengthMinSeconds', e.target.value, ADVANCED_SEARCH_LIMITS.lengthMinSeconds, ADVANCED_SEARCH_LIMITS.lengthMaxSeconds)}
              placeholder="60"
              className="w-full text-sm rounded-lg px-2 py-1.5 outline-none"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
            />
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>〜</span>
            <input
              type="number"
              inputMode="numeric"
              min={ADVANCED_SEARCH_LIMITS.lengthMinSeconds}
              max={ADVANCED_SEARCH_LIMITS.lengthMaxSeconds}
              step={1}
              value={advancedFilters.lengthMaxSeconds}
              onChange={e => updateBoundedInteger('lengthMaxSeconds', e.target.value, ADVANCED_SEARCH_LIMITS.lengthMinSeconds, ADVANCED_SEARCH_LIMITS.lengthMaxSeconds)}
              placeholder="360"
              className="w-full text-sm rounded-lg px-2 py-1.5 outline-none"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="pv-service-filter" className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>PV</label>
          <select
            id="pv-service-filter"
            value={advancedFilters.pvService}
            onChange={e => setAdvancedFilters({ pvService: e.target.value as typeof advancedFilters.pvService })}
            className="text-sm rounded-lg px-2 py-1.5 outline-none"
            style={{ background: 'var(--color-surface)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
          >
            <option value="any">指定なし</option>
            <option value="youtube">YouTubeあり</option>
            <option value="niconico">ニコニコあり</option>
            <option value="both">両方あり</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="audio-computed-filter" className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>音声特徴量</label>
          <select
            id="audio-computed-filter"
            value={advancedFilters.audioComputed}
            onChange={e => setAdvancedFilters({ audioComputed: e.target.value as typeof advancedFilters.audioComputed })}
            className="text-sm rounded-lg px-2 py-1.5 outline-none"
            style={{ background: 'var(--color-surface)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
          >
            <option value="any">指定なし</option>
            <option value="yes">あり</option>
            <option value="no">なし</option>
          </select>
        </div>

        <div className="md:col-span-2 xl:col-span-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}
            onClick={() => { resetAdvancedFilters(); search(); }}
          >
            条件をクリア
          </button>
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={{ background: 'var(--color-accent-purple)', color: '#fff', border: '1px solid rgba(139, 92, 246, 0.4)' }}
            onClick={() => search()}
          >
            条件を適用
          </button>
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--color-border)' }} />

      {/* ===== ソート ===== */}
      <div className="flex items-center justify-end flex-wrap gap-3">
        <div className="flex items-center gap-2">
          {/* オリジナル曲のみフィルター */}
          <button
            className="text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={{
              background: songTypeFilter === 'Original' ? 'rgba(139, 92, 246, 0.2)' : 'var(--color-surface)',
              color: songTypeFilter === 'Original' ? 'var(--color-accent-purple)' : 'var(--color-text-muted)',
              border: songTypeFilter === 'Original'
                ? '1px solid rgba(139, 92, 246, 0.4)'
                : '1px solid var(--color-border)',
            }}
            onClick={() => {
              const next = songTypeFilter === 'Original' ? 'All' : 'Original';
              setSongTypeFilter(next);
              search();
            }}
            title="カバー・リミックスを除外し、オリジナル曲のみ表示"
          >
            {songTypeFilter === 'Original' ? '✦ オリジナルのみ' : 'オリジナルのみ'}
          </button>
          <label htmlFor="sort-select" className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            並び替え:
          </label>
          <select
            id="sort-select"
            value={sort}
            onChange={(e) => { setSort(e.target.value as ExtendedSortRule); search(); }}
            className="text-sm rounded-lg px-3 py-1.5 outline-none cursor-pointer transition-colors"
            style={{
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border)',
            }}
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* 昇順 / 降順トグル */}
          <button
            id="sort-order-toggle"
            onClick={() => { setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc'); search(); }}
            title={sortOrder === 'desc' ? '降順 (クリックで昇順に)' : '昇順 (クリックで降順に)'}
            className="flex items-center justify-center rounded-lg transition-colors"
            style={{
              width: '32px', height: '32px',
              background: 'var(--color-surface)',
              color: 'var(--color-text-secondary)',
              border: '1px solid var(--color-border)',
              flexShrink: 0,
            }}
          >
            {sortOrder === 'desc'
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14l5-5 5 5z" transform="rotate(180 12 12)"/><path d="M7 10l5 5 5-5z"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14l5-5 5 5z"/><path d="M7 10l5 5 5-5z" transform="rotate(180 12 12)"/></svg>
            }
          </button>
        </div>
      </div>
    </div>
  );
}
