import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useSearchStore } from '../../stores/searchStore';
import {
  ADVANCED_SEARCH_LIMITS,
  sanitizeAdvancedIntegerInput,
  type AdvancedSearchFilters,
} from '../../stores/searchStore';
import type { SongType, VocalistMatchMode } from '../../types/vocadb';
import { searchCreditArtistsByName, searchVocalistsByName, selectVocalistVariants } from '../../api/vocadb';
import type { Artist } from '../../types/vocadb';
import { searchTagFacets, type SearchTagFacet } from '../../api/searchFacets';
import { VOICE_SYNTH_ARTIST_TYPES, VOICE_SYNTH_TYPE_LABELS } from '../../config/voiceSynthTypes';
import { AUDIO_INSTRUMENT_LABELS, AUDIO_INSTRUMENT_OPTIONS } from '../../config/audioInstruments';

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

const MATCH_MODES: { value: VocalistMatchMode; label: string }[] = [
  { value: 'All',   label: 'すべて含む' },
  { value: 'Any',   label: 'いずれか' },
  { value: 'Exact', label: '完全一致' },
];

const SONG_TYPE_OPTIONS: { value: SongType; label: string }[] = [
  { value: 'Original', label: 'オリジナル' }, { value: 'Remaster', label: 'リマスター' },
  { value: 'Remix', label: 'リミックス' }, { value: 'Cover', label: 'カバー' },
  { value: 'Arrangement', label: 'アレンジ' }, { value: 'Instrumental', label: 'インスト' },
  { value: 'Mashup', label: 'マッシュアップ' }, { value: 'MusicPV', label: '音楽PV' },
];

const CREDIT_ROLES = [
  ['', '役割を指定しない'], ['Composer', '作曲'], ['Lyricist', '作詞'], ['Arranger', '編曲'],
  ['Illustrator', 'イラスト'], ['Animator', '動画'], ['Instrumentalist', '演奏'], ['Mixer', 'ミックス'],
  ['Mastering', 'マスタリング'], ['VoiceManipulator', '調声'],
] as const;

const TAG_PRESETS = [
  { id: 481, name: 'ロック' }, { id: 337, name: 'ピアノ' }, { id: 29, name: 'バラード' },
  { id: 341, name: 'ポップ' }, { id: 1552, name: 'EDM' }, { id: 262, name: 'メタル' },
  { id: 1580, name: 'エレクトロニカ' }, { id: 1698, name: 'テクノポップ' },
  { id: 81, name: '可愛い' }, { id: 384, name: '切ない' }, { id: 369, name: '爽やか' },
];

function RangeInputs({ label, from, to, fromPlaceholder, toPlaceholder, min, max, onFrom, onTo }: {
  label: string;
  from: string;
  to: string;
  fromPlaceholder: string;
  toPlaceholder: string;
  min: number;
  max: number;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-[11px] text-neutral-500">
      {label}
      <span className="flex items-center gap-1.5">
        <input type="number" inputMode="numeric" min={min} max={max} value={from} onChange={event => onFrom(event.target.value)} placeholder={fromPlaceholder} className="ui-number-input min-w-0" />
        <span>〜</span>
        <input type="number" inputMode="numeric" min={min} max={max} value={to} onChange={event => onTo(event.target.value)} placeholder={toPlaceholder} className="ui-number-input min-w-0" />
      </span>
    </label>
  );
}

function SuggestionList({ items, onSelect }: {
  items: { id: number; label: string; detail?: string }[];
  onSelect: (item: { id: number; label: string; detail?: string }) => void;
}) {
  return (
    <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border border-white/10 bg-[var(--color-surface-elevated)] shadow-xl">
      {items.map(item => (
        <li key={item.id}>
          <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-white/5" onMouseDown={event => { event.preventDefault(); onSelect(item); }}>
            <span className="truncate">{item.label}</span><span className="shrink-0 text-xs text-neutral-500">{item.detail}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ─── 折りたたみセクション共通コンポーネント ─── */
function FilterSection({ title, badge, children, defaultOpen = false }: {
  title: string;
  badge?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // バッジが付いたら自動で開く
  useEffect(() => {
    if (badge && badge > 0 && !open) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [badge]);

  return (
    <div className="filter-section" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <button
        type="button"
        className="filter-section-header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <svg
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5"
          className="filter-section-chevron"
          data-open={open}
        >
          <path d="M9 18l6-6-6-6"/>
        </svg>
        <span className="filter-section-title">{title}</span>
        {(badge != null && badge > 0) && (
          <span className="filter-section-badge">{badge}</span>
        )}
      </button>
      <div className="filter-section-body" data-open={open}>
        <div className="filter-section-content">
          {children}
        </div>
      </div>
    </div>
  );
}

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
    search,
    vocalistFilters, vocalistMatchMode,
    addVocalistFilter, removeVocalistFilter, setVocalistFilters, setVocalistMatchMode,
    songTypeFilter, setSongTypeFilter,
    advancedFilters, setAdvancedFilters, resetAdvancedFilters, totalCount, hasSearched,
  } = useSearchStore();

  const [vocalistQuery, setVocalistQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Artist[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState<SearchTagFacet[]>([]);
  const [creditQuery, setCreditQuery] = useState('');
  const [creditSuggestions, setCreditSuggestions] = useState<Artist[]>([]);
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
    if (!tagQuery.trim()) { setTagSuggestions([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchTagFacets(tagQuery, controller.signal).then(setTagSuggestions);
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [tagQuery]);

  useEffect(() => {
    if (!creditQuery.trim()) { setCreditSuggestions([]); return; }
    const timer = window.setTimeout(() => {
      void searchCreditArtistsByName(creditQuery).then(setCreditSuggestions);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [creditQuery]);

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
  const visibleVocalistFilters = vocalistFilters.filter((filter, index, all) =>
    !filter.variantGroup
      || all.findIndex(candidate => candidate.variantGroup === filter.variantGroup) === index,
  );

  const vocalistFilterLabel = (filter: typeof vocalistFilters[number]): string => {
    if (!filter.variantGroup) return filter.name;
    const variantCount = vocalistFilters.filter(candidate => candidate.variantGroup === filter.variantGroup).length;
    return `${filter.variantGroup}（${variantCount}音源）`;
  };

  const removeVocalistSelection = (filter: typeof vocalistFilters[number]) => {
    if (filter.variantGroup) {
      setVocalistFilters(vocalistFilters.filter(candidate => candidate.variantGroup !== filter.variantGroup));
    } else {
      removeVocalistFilter(filter.id);
    }
    search();
  };

  const handleTogglePreset = (v: PresetVocalist) => {
    if (selectedIds.has(v.id)) {
      removeVocalistFilter(v.id);
    } else {
      addVocalistFilter(v);
    }
    search();
  };

  const handleSelectSuggestion = async (v: Artist) => {
    const query = vocalistQuery.trim() || v.name;
    const matchedVocalists = selectVocalistVariants(
      await searchVocalistsByName(query, 50),
      query,
    );
    const vocalists = matchedVocalists.length > 0 ? matchedVocalists : [v];
    const newIds = new Set(vocalists.map(vocalist => vocalist.id));
    setVocalistFilters([
      ...vocalistFilters.filter(existing => !newIds.has(existing.id)),
      ...vocalists.map(vocalist => ({
        id: vocalist.id,
        name: vocalist.name,
        variantGroup: vocalists.length > 1 ? query : undefined,
      })),
    ]);
    if (vocalistFilters.length === 0) {
      setVocalistMatchMode(vocalists.length > 1 ? 'Any' : 'All');
    }
    setVocalistQuery('');
    setSuggestions([]);
    setShowSuggestions(false);
    await search();
  };

  const updateBoundedInteger = (
    key: keyof Pick<AdvancedSearchFilters,
      'publishYearFrom' | 'publishYearTo' | 'lengthMinSeconds' | 'lengthMaxSeconds'
      | 'minYoutubeViews' | 'maxYoutubeViews' | 'minNicoViews' | 'maxNicoViews'
      | 'minFavoritedTimes' | 'maxFavoritedTimes' | 'bpmFrom' | 'bpmTo'>,
    value: string,
    min: number,
    max: number,
  ) => {
    setAdvancedFilters({ [key]: sanitizeAdvancedIntegerInput(value, min, max) });
  };

  const toggleSongType = (songType: SongType) => setAdvancedFilters({
    includedSongTypes: advancedFilters.includedSongTypes.includes(songType)
      ? advancedFilters.includedSongTypes.filter(type => type !== songType)
      : [...advancedFilters.includedSongTypes, songType],
  });

  const toggleTag = (tag: { id: number; name: string }) => setAdvancedFilters({
    tagFilters: advancedFilters.tagFilters.some(item => item.id === tag.id)
      ? advancedFilters.tagFilters.filter(item => item.id !== tag.id)
      : [...advancedFilters.tagFilters, tag].slice(0, 20),
  });

  const toggleInstrument = (instrumentKey: string) => setAdvancedFilters({
    instrumentKeys: advancedFilters.instrumentKeys.includes(instrumentKey)
      ? advancedFilters.instrumentKeys.filter(key => key !== instrumentKey)
      : [...advancedFilters.instrumentKeys, instrumentKey].slice(0, 12),
  });

  const rangeText = (from: string, to: string, suffix = '') => from && to
    ? `${Number(from).toLocaleString()}〜${Number(to).toLocaleString()}${suffix}`
    : from ? `${Number(from).toLocaleString()}${suffix}以上` : `${Number(to).toLocaleString()}${suffix}以下`;

  /* ---------- セクション別のバッジ計算 ---------- */
  const vocalistBadge = visibleVocalistFilters.length;

  const songTypeBadge = (songTypeFilter === 'Original' ? 1 : 0)
    + advancedFilters.includedSongTypes.length
    + (advancedFilters.selfCoverOnly ? 1 : 0);

  const periodBadge = [
    advancedFilters.publishYearFrom, advancedFilters.publishYearTo,
    advancedFilters.lengthMinSeconds, advancedFilters.lengthMaxSeconds,
  ].filter(Boolean).length > 0 ? 1 : 0;

  const viewsBadge = [
    advancedFilters.minYoutubeViews, advancedFilters.maxYoutubeViews,
    advancedFilters.minNicoViews, advancedFilters.maxNicoViews,
    advancedFilters.minFavoritedTimes, advancedFilters.maxFavoritedTimes,
  ].filter(Boolean).length > 0 ? 1 : 0;

  const tagBadge = advancedFilters.tagFilters.length;

  const creditBadge = advancedFilters.creditArtist ? 1 : 0;

  const audioBadge = (advancedFilters.bpmFrom || advancedFilters.bpmTo ? 1 : 0)
    + advancedFilters.instrumentKeys.length
    + (advancedFilters.audioComputed !== 'any' ? 1 : 0);

  const lyricsPvBadge = (advancedFilters.lyricsQuery.trim() ? 1 : 0)
    + (advancedFilters.pvService !== 'any' ? 1 : 0);

  /* ---------- 全セクション横断アクティブチップ ---------- */
  const allChips: { key: string; label: string; color: 'purple' | 'cyan' | 'default'; clear: () => void }[] = [];

  // シンガー
  visibleVocalistFilters.forEach(v => allChips.push({
    key: `vocalist-${v.id}`, label: vocalistFilterLabel(v), color: 'purple',
    clear: () => removeVocalistSelection(v),
  }));

  // 曲種
  if (songTypeFilter === 'Original') allChips.push({ key: 'original-only', label: 'オリジナルのみ', color: 'default', clear: () => { setSongTypeFilter('All'); search(); } });
  advancedFilters.includedSongTypes.forEach(type => allChips.push({ key: `type-${type}`, label: SONG_TYPE_OPTIONS.find(option => option.value === type)?.label ?? type, color: 'default', clear: () => toggleSongType(type) }));
  if (advancedFilters.selfCoverOnly) allChips.push({ key: 'self-cover', label: 'Self Cover', color: 'default', clear: () => setAdvancedFilters({ selfCoverOnly: false }) });

  // 投稿年・長さ
  if (advancedFilters.publishYearFrom || advancedFilters.publishYearTo) allChips.push({ key: 'year', label: `投稿年 ${rangeText(advancedFilters.publishYearFrom, advancedFilters.publishYearTo)}`, color: 'cyan', clear: () => setAdvancedFilters({ publishYearFrom: '', publishYearTo: '' }) });
  if (advancedFilters.lengthMinSeconds || advancedFilters.lengthMaxSeconds) allChips.push({ key: 'length', label: `長さ ${rangeText(advancedFilters.lengthMinSeconds, advancedFilters.lengthMaxSeconds, '秒')}`, color: 'cyan', clear: () => setAdvancedFilters({ lengthMinSeconds: '', lengthMaxSeconds: '' }) });

  // 再生数・支持
  if (advancedFilters.minYoutubeViews || advancedFilters.maxYoutubeViews) allChips.push({ key: 'youtube', label: `YouTube ${rangeText(advancedFilters.minYoutubeViews, advancedFilters.maxYoutubeViews)}`, color: 'cyan', clear: () => setAdvancedFilters({ minYoutubeViews: '', maxYoutubeViews: '' }) });
  if (advancedFilters.minNicoViews || advancedFilters.maxNicoViews) allChips.push({ key: 'nico', label: `ニコニコ ${rangeText(advancedFilters.minNicoViews, advancedFilters.maxNicoViews)}`, color: 'cyan', clear: () => setAdvancedFilters({ minNicoViews: '', maxNicoViews: '' }) });
  if (advancedFilters.minFavoritedTimes || advancedFilters.maxFavoritedTimes) allChips.push({ key: 'favorites', label: `VocaDB支持 ${rangeText(advancedFilters.minFavoritedTimes, advancedFilters.maxFavoritedTimes)}`, color: 'cyan', clear: () => setAdvancedFilters({ minFavoritedTimes: '', maxFavoritedTimes: '' }) });

  // タグ
  advancedFilters.tagFilters.forEach(tag => allChips.push({ key: `tag-${tag.id}`, label: `# ${tag.name}`, color: 'cyan', clear: () => toggleTag(tag) }));

  // 参加者
  if (advancedFilters.creditArtist) allChips.push({ key: 'credit', label: `${CREDIT_ROLES.find(([value]) => value === advancedFilters.creditRole)?.[1] ?? '参加'}: ${advancedFilters.creditArtist.name}`, color: 'cyan', clear: () => setAdvancedFilters({ creditArtist: null }) });

  // 音源推定
  if (advancedFilters.bpmFrom || advancedFilters.bpmTo) allChips.push({ key: 'bpm', label: `推定BPM ${rangeText(advancedFilters.bpmFrom, advancedFilters.bpmTo)}`, color: 'cyan', clear: () => setAdvancedFilters({ bpmFrom: '', bpmTo: '' }) });
  advancedFilters.instrumentKeys.forEach(key => allChips.push({ key: `instrument-${key}`, label: `推定: ${AUDIO_INSTRUMENT_LABELS.get(key) ?? key}`, color: 'cyan', clear: () => toggleInstrument(key) }));
  if (advancedFilters.audioComputed !== 'any') allChips.push({ key: 'audio', label: `音響解析: ${advancedFilters.audioComputed === 'yes' ? 'あり' : 'なし'}`, color: 'cyan', clear: () => setAdvancedFilters({ audioComputed: 'any' }) });

  // 歌詞・PV
  if (advancedFilters.lyricsQuery.trim()) allChips.push({ key: 'lyrics', label: `歌詞: ${advancedFilters.lyricsQuery.trim()}`, color: 'cyan', clear: () => setAdvancedFilters({ lyricsQuery: '' }) });
  if (advancedFilters.pvService !== 'any') allChips.push({ key: 'pv', label: `PV: ${advancedFilters.pvService === 'both' ? 'YouTube＋ニコニコ' : advancedFilters.pvService}`, color: 'cyan', clear: () => setAdvancedFilters({ pvService: 'any' }) });

  const chipColorClass = (color: 'purple' | 'cyan' | 'default') => {
    if (color === 'purple') return 'border-purple-400/30 bg-purple-400/10 text-purple-200';
    if (color === 'cyan') return 'border-cyan-300/20 bg-cyan-300/10 text-cyan-100';
    return 'border-white/10 bg-white/5 text-neutral-300';
  };

  const handleClearAll = () => {
    // シンガーをクリア
    setVocalistFilters([]);
    // songTypeFilter をリセット
    setSongTypeFilter('All');
    // 全 advanced をリセット
    resetAdvancedFilters();
    search();
  };

  return (
    <div className="flex flex-col rounded-2xl overflow-hidden"
         style={{ background: 'var(--color-bg-secondary)', border: '1px solid rgba(255,255,255,0.06)' }}>

      {/* ===== アクティブフィルタチップ一覧 ===== */}
      {allChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
          {allChips.map(chip => (
            <span key={chip.key} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${chipColorClass(chip.color)}`}>
              {chip.label}
              <button type="button" className="opacity-60 hover:opacity-100 transition-opacity ml-0.5" aria-label={`${chip.label}を解除`} onClick={() => { chip.clear(); queueMicrotask(() => void search()); }}>×</button>
            </span>
          ))}
          <button
            type="button"
            className="ml-auto text-[11px] text-neutral-500 hover:text-neutral-300 transition-colors"
            onClick={handleClearAll}
          >
            すべてクリア
          </button>
        </div>
      )}

      {/* ===== かんたん設定 ===== */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">かんたん設定</span>
        <button type="button" className="ui-chip-toggle" onClick={() => { setSongTypeFilter('Original'); setAdvancedFilters({ includedSongTypes: [] }); search(); }} data-active={songTypeFilter === 'Original'}>オリジナルのみ</button>
        <button type="button" className="ui-chip-toggle" onClick={() => setAdvancedFilters({ publishYearFrom: '2007', publishYearTo: '2012' })}>初期ボカロ</button>
        <button type="button" className="ui-chip-toggle" onClick={() => setAdvancedFilters({ publishYearFrom: '2024', publishYearTo: '' })}>2024年以降</button>
        <button type="button" className="ui-chip-toggle" onClick={() => setAdvancedFilters({ lengthMinSeconds: '', lengthMaxSeconds: '180' })}>3分以内</button>
        <button type="button" className="ui-chip-toggle" onClick={() => setAdvancedFilters({ lengthMinSeconds: '360', lengthMaxSeconds: '' })}>6分以上</button>
        <button type="button" className="ui-chip-toggle" onClick={() => setAdvancedFilters({ minYoutubeViews: '1000000' })}>YouTube 100万+</button>
        <button type="button" className="ui-chip-toggle" onClick={() => setAdvancedFilters({ minNicoViews: '100000' })}>ニコニコ 10万+</button>
      </div>

      {/* ===== 1. シンガー ===== */}
      <FilterSection title="シンガー" badge={vocalistBadge} defaultOpen={vocalistBadge > 0}>
        {/* 一致モード */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] text-neutral-500">一致モード</span>
          <div className="ui-segmented">
            {MATCH_MODES.map(m => (
              <button
                key={m.value}
                type="button"
                data-active={vocalistMatchMode === m.value}
                onClick={() => { setVocalistMatchMode(m.value); if (vocalistFilters.length > 0) search(); }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* カテゴリ別プリセット */}
        {categoriesLoading ? (
          <div className="flex items-center gap-2 py-2" style={{ color: 'var(--color-text-muted)' }}>
            <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
            <span className="text-xs">読み込み中...</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {activeCategories.map(cat => (
              <div key={cat.label} className="flex flex-col gap-1.5">
                <span className="text-[10px] font-bold tracking-wider uppercase"
                      style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
                  {cat.label}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {cat.vocalists.map(v => {
                    const isOn = selectedIds.has(v.id);
                    return (
                      <button
                        key={v.id}
                        type="button"
                        className="ui-chip-toggle"
                        data-active={isOn}
                        onClick={() => handleTogglePreset(v)}
                      >
                        {isOn && <span className="mr-0.5 text-[10px]">✓</span>}
                        {v.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* テキスト入力 + サジェスト */}
        <div className="relative mt-3" ref={suggestRef}>
          <div className="flex items-center gap-2 text-[11px] mb-1.5" style={{ color: 'var(--color-text-muted)' }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
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
            className="ui-number-input"
            style={{ width: '100%' }}
          />
          {showSuggestions && suggestions.length > 0 && (
            <ul
              className="absolute top-full left-0 right-0 z-20 mt-1 rounded-xl overflow-hidden shadow-xl"
              style={{ background: 'var(--color-surface-elevated)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              {suggestions.map(s => (
                <li
                  key={s.id}
                  className="px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-white/5"
                  style={{ color: 'var(--color-text-primary)' }}
                  onMouseDown={() => handleSelectSuggestion(s)}
                >
                  <span>{s.name}</span>
                  <span className="ml-2 text-xs opacity-40">{s.artistType}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 選択済みチップ */}
        {visibleVocalistFilters.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {visibleVocalistFilters.map(v => (
              <span
                key={v.id}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full"
                style={{
                  background: 'rgba(139, 92, 246, 0.15)',
                  color: 'var(--color-accent-purple)',
                  border: '1px solid rgba(139, 92, 246, 0.35)',
                }}
              >
                {vocalistFilterLabel(v)}
                <button
                  onClick={() => removeVocalistSelection(v)}
                  className="opacity-60 hover:opacity-100 transition-opacity ml-0.5 flex items-center"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
      </FilterSection>

      {/* ===== 2. 曲の種類 ===== */}
      <FilterSection title="曲の種類" badge={songTypeBadge}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="ui-chip-toggle"
              data-active={songTypeFilter === 'Original' || (advancedFilters.includedSongTypes.length === 1 && advancedFilters.includedSongTypes[0] === 'Original')}
              onClick={() => {
                setAdvancedFilters({ includedSongTypes: [] });
                setSongTypeFilter(songTypeFilter === 'Original' ? 'All' : 'Original');
                search();
              }}
              title="カバー・リミックスを除外し、オリジナル曲のみ表示"
            >
              {songTypeFilter === 'Original' ? '✦ オリジナルのみ' : 'オリジナルのみ'}
            </button>
            {SONG_TYPE_OPTIONS.map(option => (
              <button key={option.value} type="button" className="ui-chip-toggle" data-active={advancedFilters.includedSongTypes.includes(option.value)} onClick={() => toggleSongType(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="ui-chip-toggle self-start"
            data-active={advancedFilters.selfCoverOnly}
            onClick={() => setAdvancedFilters({ selfCoverOnly: !advancedFilters.selfCoverOnly })}
          >
            Self Coverのみ
          </button>
        </div>
      </FilterSection>

      {/* ===== 3. 投稿年・長さ ===== */}
      <FilterSection title="投稿年・長さ" badge={periodBadge}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <RangeInputs label="投稿年" from={advancedFilters.publishYearFrom} to={advancedFilters.publishYearTo} fromPlaceholder="2007" toPlaceholder="2026" min={ADVANCED_SEARCH_LIMITS.publishYearMin} max={ADVANCED_SEARCH_LIMITS.publishYearMax} onFrom={value => updateBoundedInteger('publishYearFrom', value, ADVANCED_SEARCH_LIMITS.publishYearMin, ADVANCED_SEARCH_LIMITS.publishYearMax)} onTo={value => updateBoundedInteger('publishYearTo', value, ADVANCED_SEARCH_LIMITS.publishYearMin, ADVANCED_SEARCH_LIMITS.publishYearMax)} />
          <RangeInputs label="曲の長さ（秒）" from={advancedFilters.lengthMinSeconds} to={advancedFilters.lengthMaxSeconds} fromPlaceholder="60" toPlaceholder="360" min={ADVANCED_SEARCH_LIMITS.lengthMinSeconds} max={ADVANCED_SEARCH_LIMITS.lengthMaxSeconds} onFrom={value => updateBoundedInteger('lengthMinSeconds', value, ADVANCED_SEARCH_LIMITS.lengthMinSeconds, ADVANCED_SEARCH_LIMITS.lengthMaxSeconds)} onTo={value => updateBoundedInteger('lengthMaxSeconds', value, ADVANCED_SEARCH_LIMITS.lengthMinSeconds, ADVANCED_SEARCH_LIMITS.lengthMaxSeconds)} />
        </div>
      </FilterSection>

      {/* ===== 4. 再生数・支持 ===== */}
      <FilterSection title="再生数・支持" badge={viewsBadge}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <RangeInputs label="YouTube再生数" from={advancedFilters.minYoutubeViews} to={advancedFilters.maxYoutubeViews} fromPlaceholder="0" toPlaceholder="上限なし" min={0} max={ADVANCED_SEARCH_LIMITS.viewCountMax} onFrom={value => updateBoundedInteger('minYoutubeViews', value, 0, ADVANCED_SEARCH_LIMITS.viewCountMax)} onTo={value => updateBoundedInteger('maxYoutubeViews', value, 0, ADVANCED_SEARCH_LIMITS.viewCountMax)} />
          <RangeInputs label="ニコニコ再生数" from={advancedFilters.minNicoViews} to={advancedFilters.maxNicoViews} fromPlaceholder="0" toPlaceholder="上限なし" min={0} max={ADVANCED_SEARCH_LIMITS.viewCountMax} onFrom={value => updateBoundedInteger('minNicoViews', value, 0, ADVANCED_SEARCH_LIMITS.viewCountMax)} onTo={value => updateBoundedInteger('maxNicoViews', value, 0, ADVANCED_SEARCH_LIMITS.viewCountMax)} />
          <RangeInputs label="VocaDB支持数" from={advancedFilters.minFavoritedTimes} to={advancedFilters.maxFavoritedTimes} fromPlaceholder="0" toPlaceholder="上限なし" min={0} max={ADVANCED_SEARCH_LIMITS.favoriteCountMax} onFrom={value => updateBoundedInteger('minFavoritedTimes', value, 0, ADVANCED_SEARCH_LIMITS.favoriteCountMax)} onTo={value => updateBoundedInteger('maxFavoritedTimes', value, 0, ADVANCED_SEARCH_LIMITS.favoriteCountMax)} />
        </div>
      </FilterSection>

      {/* ===== 5. VocaDBタグ ===== */}
      <FilterSection title="VocaDBタグ" badge={tagBadge}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-neutral-500">一致モード</span>
          <div className="ui-segmented">
            {(['all', 'any'] as const).map(mode => (
              <button key={mode} type="button" data-active={advancedFilters.tagMatchMode === mode} onClick={() => setAdvancedFilters({ tagMatchMode: mode })}>
                {mode === 'all' ? 'すべて含む' : 'いずれか'}
              </button>
            ))}
          </div>
        </div>
        <div data-testid="vocadb-tag-filters" className="flex flex-wrap gap-1.5">
          {TAG_PRESETS.map(tag => (
            <button key={tag.id} type="button" className="ui-chip-toggle" data-active={advancedFilters.tagFilters.some(item => item.id === tag.id)} onClick={() => toggleTag(tag)}>
              {tag.name}
            </button>
          ))}
        </div>
        <div className="relative mt-3">
          <input className="ui-number-input w-full" value={tagQuery} onChange={event => setTagQuery(event.target.value)} placeholder="ほかのタグを検索（例: ギター、和風）" />
          {tagSuggestions.length > 0 && <SuggestionList items={tagSuggestions.map(tag => ({ id: tag.id, label: tag.name, detail: `${tag.songCount.toLocaleString()}曲` }))} onSelect={item => { const tag = tagSuggestions.find(candidate => candidate.id === item.id); if (tag) toggleTag(tag); setTagQuery(''); setTagSuggestions([]); }} />}
        </div>
      </FilterSection>

      {/* ===== 6. 参加者・役割 ===== */}
      <FilterSection title="参加者・役割" badge={creditBadge}>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,0.65fr)] gap-2">
          <div className="relative">
            <input className="ui-number-input w-full" value={creditQuery} onChange={event => setCreditQuery(event.target.value)} placeholder="P、絵師、動画師、演奏者…" />
            {creditSuggestions.length > 0 && <SuggestionList items={creditSuggestions.map(artist => ({ id: artist.id, label: artist.name, detail: artist.artistType }))} onSelect={item => { setAdvancedFilters({ creditArtist: { id: item.id, name: item.label } }); setCreditQuery(''); setCreditSuggestions([]); }} />}
          </div>
          <select className="ui-select w-full" value={advancedFilters.creditRole} onChange={event => setAdvancedFilters({ creditRole: event.target.value })}>
            {CREDIT_ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        {advancedFilters.creditArtist && <p className="mt-2 text-xs text-cyan-200">選択中: {advancedFilters.creditArtist.name}</p>}
      </FilterSection>

      {/* ===== 7. 音源からの推定 ===== */}
      <FilterSection title="音源からの推定" badge={audioBadge}>
        <div className="mb-2 text-[10px] text-neutral-500">解析済みの曲のみ・誤判定を含む場合があります</div>
        <div data-testid="audio-analysis-filters" className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.8fr)]">
            <RangeInputs label="BPM（半分／倍テンポ候補も検索）" from={advancedFilters.bpmFrom} to={advancedFilters.bpmTo} fromPlaceholder="80" toPlaceholder="180" min={ADVANCED_SEARCH_LIMITS.bpmMin} max={ADVANCED_SEARCH_LIMITS.bpmMax} onFrom={value => updateBoundedInteger('bpmFrom', value, ADVANCED_SEARCH_LIMITS.bpmMin, ADVANCED_SEARCH_LIMITS.bpmMax)} onTo={value => updateBoundedInteger('bpmTo', value, ADVANCED_SEARCH_LIMITS.bpmMin, ADVANCED_SEARCH_LIMITS.bpmMax)} />
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[11px] text-neutral-500">楽器</span>
                <div className="ui-segmented ml-auto">
                  {(['all', 'any'] as const).map(mode => <button key={mode} type="button" data-active={advancedFilters.instrumentMatchMode === mode} onClick={() => setAdvancedFilters({ instrumentMatchMode: mode })}>{mode === 'all' ? 'すべて含む' : 'いずれか'}</button>)}
                </div>
              </div>
              <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto pr-1">
                {AUDIO_INSTRUMENT_OPTIONS.map(option => <button key={option.key} type="button" className="ui-chip-toggle" data-active={advancedFilters.instrumentKeys.includes(option.key)} onClick={() => toggleInstrument(option.key)}>{option.label}</button>)}
              </div>
            </div>
          </div>
          <label className="flex flex-col gap-1.5 text-[11px] text-neutral-500">
            音声特徴量
            <select id="audio-computed-filter" value={advancedFilters.audioComputed} onChange={e => setAdvancedFilters({ audioComputed: e.target.value as typeof advancedFilters.audioComputed })} className="ui-select w-full sm:w-48">
              <option value="any">指定なし</option>
              <option value="yes">あり</option>
              <option value="no">なし</option>
            </select>
          </label>
        </div>
      </FilterSection>

      {/* ===== 8. 歌詞・PV ===== */}
      <FilterSection title="歌詞・PV" badge={lyricsPvBadge}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[11px] text-neutral-500">
            歌詞から逆引き
            <input
              className="ui-number-input w-full"
              value={advancedFilters.lyricsQuery}
              maxLength={100}
              onChange={event => setAdvancedFilters({ lyricsQuery: event.target.value })}
              onKeyDown={event => { if (event.key === 'Enter') void search(); }}
              placeholder="うろ覚えのフレーズを入力"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[11px] text-neutral-500">
            PV
            <select id="pv-service-filter" value={advancedFilters.pvService} onChange={e => setAdvancedFilters({ pvService: e.target.value as typeof advancedFilters.pvService })} className="ui-select w-full">
              <option value="any">指定なし</option>
              <option value="youtube">YouTubeあり</option>
              <option value="niconico">ニコニコあり</option>
              <option value="both">両方あり</option>
            </select>
          </label>
        </div>
      </FilterSection>

      {/* ===== フッター ===== */}
      <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        {hasSearched && <span className="mr-auto text-xs text-neutral-500"><strong className="text-white">{totalCount.toLocaleString()}</strong> 曲が該当</span>}
        <button
          type="button"
          className="text-xs px-3 py-1.5 rounded-lg transition-colors"
          style={{ background: 'transparent', color: 'var(--color-text-muted)', border: '1px solid rgba(255,255,255,0.08)' }}
          onClick={handleClearAll}
        >
          クリア
        </button>
        <button
          type="button"
          className="text-xs px-4 py-1.5 rounded-lg transition-colors font-medium"
          style={{ background: 'var(--color-accent-purple)', color: '#fff' }}
          onClick={() => search()}
        >
          この条件で検索
        </button>
      </div>
    </div>
  );
}
