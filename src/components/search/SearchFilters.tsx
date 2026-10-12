import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  DEFAULT_ADVANCED_FILTERS,
  useSearchStore,
  type AdvancedSearchFilters,
  type ExtendedSortRule,
  type VocalistFilter,
} from '../../stores/searchStore';
import {
  getAdvancedRangeErrors,
  getAdvancedRangeLimits,
  type AdvancedRangeError,
  type AdvancedRangeKey,
} from '../../search/searchModel';
import type { Artist, SongType, VocalistMatchMode } from '../../types/vocadb';
import { searchCreditArtistsByName, searchVocalistsByName, selectVocalistVariants } from '../../api/vocadb';
import { searchTagFacets, type SearchTagFacet } from '../../api/searchFacets';
import { VOICE_SYNTH_ARTIST_TYPES, VOICE_SYNTH_TYPE_LABELS, type VoiceSynthArtistType } from '../../config/voiceSynthTypes';
import { AUDIO_INSTRUMENT_LABELS, AUDIO_INSTRUMENT_OPTIONS } from '../../config/audioInstruments';
import { useTranslate, useTranslateSourceText, type TranslationKey } from '../../i18n';
import { useLanguageStore, type AppLanguage } from '../../stores/languageStore';
import { useUiStore } from '../../stores/uiStore';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { artistRoleLabel, artistTypeLabel, formatCount, songTypeLabel } from '../../utils/songMeta';
import Dialog from '../ui/Dialog';
import Button from '../ui/Button';
import { Chip } from '../ui/Chip';
import SearchField from '../ui/SearchField';
import { InfoTip } from '../ui/InfoTip';
import { CheckIcon, ChevronDownIcon, CloseIcon } from '../ui/icons';
import { cx } from '../ui/overlay';

// hall_of_fame_singers.json の型定義
interface HallOfFameSinger { id: number; name: string; artist_type: string; }
interface HallOfFameData {
  exported_at: string;
  by_type: Record<string, HallOfFameSinger[]>;
  all: HallOfFameSinger[];
}

interface PresetVocalist { id: number; name: string; }
interface VocalistCategory { label: string; vocalists: PresetVocalist[] }

const VOCALIST_CATEGORIES: VocalistCategory[] = [
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

/** The vocalists most people look for first (shown before 「すべて表示」). */
const POPULAR_VOCALIST_IDS = [1, 14, 15, 2, 3, 504, 116, 83928, 99953, 623, 71, 176];
const POPULAR_COUNT = 12;

const SONG_TYPE_OPTIONS: SongType[] = [
  'Original', 'Remaster', 'Remix', 'Cover', 'Arrangement', 'Instrumental', 'Mashup', 'MusicPV',
];

const CREDIT_ROLES = [
  '', 'Composer', 'Lyricist', 'Arranger', 'Illustrator', 'Animator', 'Instrumentalist', 'Mixer', 'Mastering', 'VoiceManipulator',
] as const;

const TAG_PRESETS = [
  { id: 481, name: 'ロック' }, { id: 337, name: 'ピアノ' }, { id: 29, name: 'バラード' },
  { id: 341, name: 'ポップ' }, { id: 1552, name: 'EDM' }, { id: 262, name: 'メタル' },
  { id: 1580, name: 'エレクトロニカ' }, { id: 1698, name: 'テクノポップ' },
  { id: 81, name: '可愛い' }, { id: 384, name: '切ない' }, { id: 369, name: '爽やか' },
];

const MAX_DIGITS = 16;

const UNITS: Record<'year' | 'seconds' | 'views' | 'bpm', Record<AppLanguage, string>> = {
  year: { ja: '年', en: '' },
  seconds: { ja: '秒', en: 'sec' },
  views: { ja: '回', en: '' },
  bpm: { ja: 'BPM', en: 'BPM' },
};

type SectionId = 'vocalist' | 'songType' | 'period' | 'views' | 'tags' | 'credit' | 'audio' | 'lyrics';

interface SearchDraft {
  vocalistFilters: VocalistFilter[];
  vocalistMatchMode: VocalistMatchMode;
  songTypeFilter: 'All' | 'Original';
  advancedFilters: AdvancedSearchFilters;
  sort: ExtendedSortRule;
}

function digitsOnly(value: string): string {
  return value.replace(/[^\d]/g, '').slice(0, MAX_DIGITS);
}

/** 「2007〜2012」 / “2007–2012”. */
function rangeSeparatorFor(language: AppLanguage): string {
  return language === 'en' ? '–' : '〜';
}

function logicalVocalists(filters: VocalistFilter[]): VocalistFilter[] {
  return filters.filter((filter, index, all) => !filter.variantGroup
    || all.findIndex(candidate => candidate.variantGroup === filter.variantGroup) === index);
}

function summarize(names: string[], t: (source: string, values?: Record<string, string | number>) => string): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return t('{name} ほか{count}', { name: names[0], count: names.length - 1 });
}

/* ─── 折りたたみセクション ─── */
function FilterSection({ id, title, summary, open, onToggle, info, children }: {
  id: SectionId;
  title: string;
  summary: string;
  open: boolean;
  onToggle: (id: SectionId) => void;
  info?: ReactNode;
  children: ReactNode;
}) {
  const bodyId = useId();
  const summaryId = useId();
  const titleRef = useRef<HTMLSpanElement>(null);
  const [infoLeft, setInfoLeft] = useState<number | null>(null);

  // The ⓘ cannot live inside the header button; it is laid over a gap kept right after the title.
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!info || !title) return undefined;
    const update = () => setInfoLeft(title.offsetLeft + title.offsetWidth + 4);
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(title);
    return () => observer.disconnect();
  }, [info]);

  return (
    <div className="filter-section">
      <div className="relative flex items-center">
        <button
          type="button"
          className="filter-section-header"
          onClick={() => onToggle(id)}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-describedby={summary ? summaryId : undefined}
        >
          <span ref={titleRef} className="filter-section-title">{title}</span>
          {info && <span aria-hidden="true" className="w-8 shrink-0 max-sm:w-10" />}
          {summary && <span id={summaryId} className="filter-section-summary">{summary}</span>}
          <span aria-hidden="true" className="filter-section-chevron" data-open={open}>
            <ChevronDownIcon size={20} />
          </span>
        </button>
        {info && (
          <div
            className="absolute top-1/2 -translate-y-1/2"
            style={{ left: infoLeft ?? 0, visibility: infoLeft === null ? 'hidden' : undefined }}
          >
            {info}
          </div>
        )}
      </div>
      <div id={bodyId} className="filter-section-body" data-open={open} inert={!open}>
        <div className="filter-section-content">
          {children}
        </div>
      </div>
    </div>
  );
}

function QuickOption({ label, detail, selected, onSelect, removable = true }: {
  label: string;
  detail?: string;
  selected: boolean;
  onSelect: () => void;
  removable?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cx(
        '-mx-2 flex min-h-9 w-[calc(100%+1rem)] cursor-pointer items-center gap-1 rounded-chip px-2 py-1.5 text-left text-sm leading-5 text-yt-text transition-colors duration-150 hover:bg-yt-tonal',
        selected ? 'font-bold' : 'font-normal',
      )}
    >
      <span className="min-w-0 flex-1">
        {label}
        {detail && <span className="ml-1 text-xs font-normal text-yt-text-secondary tabular-nums">{detail}</span>}
      </span>
      {selected && (removable
        ? <CloseIcon size={16} className="shrink-0 text-yt-text-secondary" />
        : <CheckIcon size={16} className="shrink-0 text-yt-text" />)}
    </button>
  );
}

function QuickColumn({ heading, children }: { heading: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="min-w-0">
      <p id={headingId} className="m-0 mb-1 text-xs leading-4 font-medium text-yt-text-secondary">{heading}</p>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function NumberField({ value, onChange, label, placeholder, unit, invalid, inputRef }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  unit: string;
  invalid: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(digitsOnly(event.target.value))}
        className={cx(
          'h-10 w-full min-w-0 rounded-chip border bg-yt-field pl-3 text-sm leading-5 text-yt-text tabular-nums outline-none transition-colors duration-150 placeholder:text-yt-text-disabled focus:border-yt-focus',
          unit ? 'pr-12' : 'pr-3',
          invalid ? 'border-yt-danger' : 'border-yt-field-border',
        )}
      />
      {unit && (
        <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-yt-text-secondary">
          {unit}
        </span>
      )}
    </div>
  );
}

function RangeField({ label, unit, from, to, onFrom, onTo, error, errorKey, info, fromRef }: {
  label: string;
  unit: string;
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  error?: AdvancedRangeError;
  errorKey: AdvancedRangeKey;
  info?: ReactNode;
  fromRef?: RefObject<HTMLInputElement | null>;
}) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const errorId = useId();
  const limits = getAdvancedRangeLimits(errorKey);
  const errorText = error === 'order'
    ? t('最小は最大以下にしてください')
    : error === 'bounds'
      ? t('{min}〜{max}の範囲で入力してください', { min: limits.min.toLocaleString(), max: limits.max.toLocaleString() })
      : null;
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={errorText ? errorId : undefined}>
      <legend className="mb-1.5 flex min-h-8 items-center gap-0.5 p-0 text-xs leading-4 font-medium text-yt-text-secondary">
        {label}
        {info}
      </legend>
      <div className="flex items-center gap-2">
        <NumberField
          value={from}
          onChange={onFrom}
          label={t('{label}（最小）', { label })}
          placeholder={t('最小')}
          unit={unit}
          invalid={Boolean(error)}
          inputRef={fromRef}
        />
        <span aria-hidden="true" className="text-yt-text-secondary">{rangeSeparatorFor(language)}</span>
        <NumberField
          value={to}
          onChange={onTo}
          label={t('{label}（最大）', { label })}
          placeholder={t('最大')}
          unit={unit}
          invalid={Boolean(error)}
        />
      </div>
      {errorText && <p id={errorId} className="m-0 mt-1 text-xs leading-4 text-yt-danger">{errorText}</p>}
    </fieldset>
  );
}

function SuggestionList({ items, onSelect }: {
  items: { id: number; label: string; detail?: string }[];
  onSelect: (item: { id: number; label: string; detail?: string }) => void;
}) {
  return (
    <ul className="m-0 mt-2 max-h-56 list-none overflow-y-auto overscroll-contain rounded-chip bg-yt-menu p-0 py-1">
      {items.map(item => (
        <li key={item.id}>
          <button
            type="button"
            className="flex min-h-9 w-full cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-left text-sm leading-5 text-yt-text hover:bg-yt-tonal focus-visible:bg-yt-tonal focus-visible:outline-none"
            onMouseDown={event => event.preventDefault()}
            onClick={() => onSelect(item)}
          >
            <span className="truncate">{item.label}</span>
            {item.detail && <span className="shrink-0 text-xs text-yt-text-secondary">{item.detail}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function SelectField({ id, label, value, onChange, children, className }: {
  id?: string;
  /** aria-label when there is no visible <label for={id}>. */
  label?: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('relative', className)}>
      <select
        id={id}
        aria-label={label}
        value={value}
        onChange={event => onChange(event.target.value)}
        className="h-10 w-full cursor-pointer appearance-none rounded-chip border border-yt-field-border bg-yt-field pl-3 pr-9 text-sm leading-5 text-yt-text outline-none transition-colors duration-150 focus:border-yt-focus"
      >
        {children}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 text-yt-text-secondary">
        <ChevronDownIcon size={20} />
      </span>
    </div>
  );
}

function MatchModeChips<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map(option => (
        <Chip key={option.value} selected={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </Chip>
      ))}
    </div>
  );
}

function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex min-h-8 items-center text-xs leading-4 font-medium text-yt-text-secondary">
      {children}
    </label>
  );
}

interface SearchFiltersProps {
  /** history.state key HomePage uses to recognize the entry an advanced-only search was applied in. */
  advancedEntryState?: string;
}

/**
 * 詳細検索 dialog. Changes stay in a draft until 適用; the applied conditions then show as removable
 * chips above the results. Opened from the top bar and from the results toolbar.
 */
export default function SearchFilters({ advancedEntryState = 'divaAdvancedSearch' }: SearchFiltersProps) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const language = useLanguageStore(state => state.language);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const setAdvancedSearchOpen = useUiStore(state => state.setAdvancedSearchOpen);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const yearFromRef = useRef<HTMLInputElement>(null);
  const focusYearAfterOpen = useRef(false);

  const [draft, setDraft] = useState<SearchDraft>(() => {
    const store = useSearchStore.getState();
    return {
      // The ボーカル search mode's own vocalists are the query, not a condition of this dialog.
      vocalistFilters: store.vocalistFilters.filter(filter => !store.modeVocalistIds.includes(filter.id)),
      vocalistMatchMode: store.vocalistMatchMode,
      songTypeFilter: store.songTypeFilter,
      advancedFilters: { ...store.advancedFilters },
      sort: store.sort,
    };
  });
  const filters = draft.advancedFilters;

  const [openSections, setOpenSections] = useState<Set<SectionId>>(() => {
    const opened = new Set<SectionId>();
    if (draft.vocalistFilters.length > 0) opened.add('vocalist');
    if (filters.tagFilters.length > 0) opened.add('tags');
    if (filters.creditArtist) opened.add('credit');
    if (filters.bpmFrom || filters.bpmTo || filters.instrumentKeys.length > 0 || filters.audioComputed !== 'any') opened.add('audio');
    if (filters.lyricsQuery.trim() || filters.pvService !== 'any') opened.add('lyrics');
    return opened;
  });

  const [vocalistQuery, setVocalistQuery] = useState('');
  const [vocalistSuggestions, setVocalistSuggestions] = useState<Artist[]>([]);
  const [showAllVocalists, setShowAllVocalists] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState<SearchTagFacet[]>([]);
  const [creditQuery, setCreditQuery] = useState('');
  const [creditSuggestions, setCreditSuggestions] = useState<Artist[]>([]);
  const [showAllInstruments, setShowAllInstruments] = useState(false);
  const [dynamicData, setDynamicData] = useState<{ categories: VocalistCategory[]; popular: PresetVocalist[] } | null>(null);

  // hall_of_fame_singers.json を非同期で取得 (失敗時はハードコードにフォールバック)
  useEffect(() => {
    const controller = new AbortController();
    fetch('/data/hall_of_fame_singers.json', { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<HallOfFameData>;
      })
      .then(data => {
        const categories = VOICE_SYNTH_ARTIST_TYPES
          .filter(type => (data.by_type[type]?.length ?? 0) > 0)
          .map(type => ({
            label: VOICE_SYNTH_TYPE_LABELS[type],
            vocalists: data.by_type[type].map(singer => ({ id: singer.id, name: singer.name })),
          }));
        if (categories.length === 0) return;
        const popular = (data.all ?? []).slice(0, POPULAR_COUNT).map(singer => ({ id: singer.id, name: singer.name }));
        setDynamicData({ categories, popular });
      })
      .catch(() => {
        // ファイル未生成 or ネットワークエラー → ハードコードを使用
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!vocalistQuery.trim()) {
      setVocalistSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchVocalistsByName(vocalistQuery).then(results => {
        if (!cancelled) setVocalistSuggestions(results);
      }).catch(() => {
        if (!cancelled) setVocalistSuggestions([]);
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [vocalistQuery]);

  useEffect(() => {
    if (!tagQuery.trim()) {
      setTagSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchTagFacets(tagQuery, controller.signal).then(setTagSuggestions).catch(() => setTagSuggestions([]));
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [tagQuery]);

  useEffect(() => {
    if (!creditQuery.trim()) {
      setCreditSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchCreditArtistsByName(creditQuery).then(results => {
        if (!cancelled) setCreditSuggestions(results);
      }).catch(() => {
        if (!cancelled) setCreditSuggestions([]);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [creditQuery]);

  useEffect(() => {
    if (!focusYearAfterOpen.current || !openSections.has('period')) return;
    focusYearAfterOpen.current = false;
    yearFromRef.current?.focus();
  }, [openSections]);

  const toggleSection = (id: SectionId) => setOpenSections(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const updateFilters = (patch: Partial<AdvancedSearchFilters>) => setDraft(previous => ({
    ...previous,
    advancedFilters: { ...previous.advancedFilters, ...patch },
  }));

  const rangeErrors = useMemo(() => getAdvancedRangeErrors(filters), [filters]);
  const hasErrors = Object.keys(rangeErrors).length > 0;

  /* ---------- ボーカル ---------- */
  const categories = dynamicData?.categories ?? VOCALIST_CATEGORIES;
  const allPresets = categories.flatMap(category => category.vocalists);
  const popularVocalists = dynamicData?.popular.length
    ? dynamicData.popular
    : POPULAR_VOCALIST_IDS.flatMap(id => allPresets.find(vocalist => vocalist.id === id) ?? []);
  const selectedVocalistIds = new Set(draft.vocalistFilters.map(filter => filter.id));
  const visibleVocalists = logicalVocalists(draft.vocalistFilters);
  const presetIds = new Set((showAllVocalists ? allPresets : popularVocalists).map(vocalist => vocalist.id));
  const extraSelectedVocalists = visibleVocalists.filter(filter => filter.variantGroup || !presetIds.has(filter.id));
  const vocalistLabel = (filter: VocalistFilter) => {
    if (!filter.variantGroup) return filter.name;
    const count = draft.vocalistFilters.filter(candidate => candidate.variantGroup === filter.variantGroup).length;
    return t('{group}（{count}音源）', { group: filter.variantGroup, count });
  };

  const togglePresetVocalist = (vocalist: PresetVocalist) => setDraft(previous => {
    const selected = previous.vocalistFilters.some(filter => filter.id === vocalist.id);
    return {
      ...previous,
      vocalistFilters: selected
        ? previous.vocalistFilters.filter(filter => filter.id !== vocalist.id)
        : [...previous.vocalistFilters, vocalist],
    };
  });

  const removeVocalistSelection = (filter: VocalistFilter) => setDraft(previous => ({
    ...previous,
    vocalistFilters: previous.vocalistFilters.filter(candidate => (filter.variantGroup
      ? candidate.variantGroup !== filter.variantGroup
      : candidate.id !== filter.id)),
  }));

  const selectVocalistSuggestion = async (artist: Artist) => {
    const query = vocalistQuery.trim() || artist.name;
    setVocalistQuery('');
    setVocalistSuggestions([]);
    let vocalists: Artist[] = [artist];
    try {
      const matched = selectVocalistVariants(await searchVocalistsByName(query, 50), query);
      if (matched.length > 0) vocalists = matched;
    } catch {
      // Keep the chosen suggestion alone when the variant lookup fails.
    }
    const newIds = new Set(vocalists.map(vocalist => vocalist.id));
    setDraft(previous => ({
      ...previous,
      vocalistFilters: [
        ...previous.vocalistFilters.filter(existing => !newIds.has(existing.id)),
        ...vocalists.map(vocalist => ({
          id: vocalist.id,
          name: vocalist.name,
          variantGroup: vocalists.length > 1 ? query : undefined,
        })),
      ],
      // The voicebanks of one singer are alternatives of each other.
      vocalistMatchMode: previous.vocalistFilters.length === 0 ? (vocalists.length > 1 ? 'Any' : 'All') : previous.vocalistMatchMode,
    }));
  };

  /* ---------- 曲の種類 ---------- */
  const toggleSongType = (songType: SongType) => setDraft(previous => {
    const included = previous.advancedFilters.includedSongTypes;
    return {
      ...previous,
      songTypeFilter: 'All',
      advancedFilters: {
        ...previous.advancedFilters,
        includedSongTypes: included.includes(songType)
          ? included.filter(type => type !== songType)
          : [...included, songType],
      },
    };
  });
  const originalOnly = draft.songTypeFilter === 'Original' && filters.includedSongTypes.length === 0;
  const toggleOriginalOnly = () => setDraft(previous => ({
    ...previous,
    songTypeFilter: originalOnly ? 'All' : 'Original',
    advancedFilters: { ...previous.advancedFilters, includedSongTypes: [] },
  }));

  /* ---------- タグ・楽器 ---------- */
  const toggleTag = (tag: { id: number; name: string }) => updateFilters({
    tagFilters: filters.tagFilters.some(item => item.id === tag.id)
      ? filters.tagFilters.filter(item => item.id !== tag.id)
      : [...filters.tagFilters, tag].slice(0, 20),
  });
  const customTags = filters.tagFilters.filter(tag => !TAG_PRESETS.some(preset => preset.id === tag.id));

  const toggleInstrument = (key: string) => updateFilters({
    instrumentKeys: filters.instrumentKeys.includes(key)
      ? filters.instrumentKeys.filter(item => item !== key)
      : [...filters.instrumentKeys, key].slice(0, 12),
  });
  const instrumentOptions = showAllInstruments
    ? AUDIO_INSTRUMENT_OPTIONS
    : AUDIO_INSTRUMENT_OPTIONS.filter((option, index) => index < 12 || filters.instrumentKeys.includes(option.key));

  /* ---------- 上段（よく使う条件） ---------- */
  const yearPreset = filters.publishYearFrom === '2007' && filters.publishYearTo === '2012'
    ? 'early'
    : filters.publishYearFrom === '2024' && filters.publishYearTo === '' ? 'recent' : null;
  const hasCustomYear = !yearPreset && Boolean(filters.publishYearFrom || filters.publishYearTo);
  const setYearPreset = (preset: 'early' | 'recent') => {
    if (yearPreset === preset) updateFilters({ publishYearFrom: '', publishYearTo: '' });
    else updateFilters(preset === 'early'
      ? { publishYearFrom: '2007', publishYearTo: '2012' }
      : { publishYearFrom: '2024', publishYearTo: '' });
  };
  const openCustomPeriod = () => {
    focusYearAfterOpen.current = true;
    setOpenSections(previous => new Set(previous).add('period'));
    if (openSections.has('period')) {
      focusYearAfterOpen.current = false;
      yearFromRef.current?.focus();
    }
  };
  const shortOnly = filters.lengthMinSeconds === '' && filters.lengthMaxSeconds === '180';
  const longOnly = filters.lengthMinSeconds === '360' && filters.lengthMaxSeconds === '';
  const sortOptions: { value: ExtendedSortRule; labelKey: TranslationKey }[] = [
    { value: 'FavoritedTimes', labelKey: 'sortPopular' },
    { value: 'TotalViews', labelKey: 'sortTotalViews' },
    { value: 'PublishDate', labelKey: 'sortPublishDate' },
    { value: 'Random', labelKey: 'sortRandom' },
  ];

  /* ---------- 見出し横の要約 ---------- */
  const rangeSeparator = rangeSeparatorFor(language);
  const pvServiceLabel = filters.pvService === 'both'
    ? t('動画: YouTube＋ニコニコ')
    : filters.pvService === 'niconico' ? t('動画: ニコニコ') : t('動画: YouTube');
  const rangeSummary = (from: string, to: string) => (from || to ? `${from || ''}${rangeSeparator}${to || ''}` : '');
  const summaries: Record<SectionId, string> = {
    vocalist: summarize(visibleVocalists.map(vocalistLabel), t),
    songType: summarize([
      ...(originalOnly ? [t('オリジナルのみ')] : []),
      ...filters.includedSongTypes.map(type => songTypeLabel(type, language)),
      ...(filters.selfCoverOnly ? [t('セルフカバーのみ')] : []),
    ], t),
    period: summarize([
      ...(filters.publishYearFrom || filters.publishYearTo ? [rangeSummary(filters.publishYearFrom, filters.publishYearTo)] : []),
      ...(filters.lengthMinSeconds || filters.lengthMaxSeconds ? [t('長さ')] : []),
    ], t),
    views: summarize([
      ...(filters.minYoutubeViews || filters.maxYoutubeViews ? ['YouTube'] : []),
      ...(filters.minNicoViews || filters.maxNicoViews ? [t('ニコニコ')] : []),
      ...(filters.minFavoritedTimes || filters.maxFavoritedTimes ? [t('お気に入り数')] : []),
    ], t),
    tags: summarize(filters.tagFilters.map(tag => t(tag.name)), t),
    credit: filters.creditArtist?.name ?? '',
    audio: summarize([
      ...(filters.bpmFrom || filters.bpmTo ? [`BPM ${rangeSummary(filters.bpmFrom, filters.bpmTo)}`] : []),
      ...filters.instrumentKeys.map(key => t(AUDIO_INSTRUMENT_LABELS.get(key) ?? key)),
      ...(filters.audioComputed === 'yes' ? [t('解析済み')] : filters.audioComputed === 'no' ? [t('未解析')] : []),
    ], t),
    lyrics: summarize([
      ...(filters.lyricsQuery.trim() ? [filters.lyricsQuery.trim()] : []),
      ...(filters.pvService !== 'any' ? [pvServiceLabel] : []),
    ], t),
  };

  const close = () => setAdvancedSearchOpen(false);

  const clearAll = () => setDraft(previous => ({
    ...previous,
    vocalistFilters: [],
    songTypeFilter: 'All',
    advancedFilters: { ...DEFAULT_ADVANCED_FILTERS },
  }));

  const apply = () => {
    if (hasErrors) return;
    const store = useSearchStore.getState();
    const modeVocalists = store.vocalistFilters.filter(filter => store.modeVocalistIds.includes(filter.id));
    store.setVocalistFilters([...modeVocalists, ...draft.vocalistFilters]);
    store.setVocalistMatchMode(draft.vocalistMatchMode);
    store.setSongTypeFilter(draft.songTypeFilter);
    store.setAdvancedFilters(draft.advancedFilters);
    if (draft.sort !== store.sort) store.setSort(draft.sort);
    close();
    // Without `q` / `artistId` in the URL the results get their own history entry, so Back returns to the feed.
    if (!searchParams.get('q') && !searchParams.get('artistId')) {
      const alreadyResults = Boolean((location.state as Record<string, unknown> | null)?.[advancedEntryState]);
      navigate('/', { state: { [advancedEntryState]: true }, replace: alreadyResults });
    }
    void store.applyAdvancedSearch();
  };

  const clearButton = (
    <Button variant="text" onClick={clearAll}>{t('すべてクリア')}</Button>
  );
  const applyButton = (
    <Button variant="primary" fullWidth={isMobile} size={isMobile ? 'lg' : 'md'} disabled={hasErrors} onClick={apply} data-testid="advanced-search-apply">
      {t('適用')}
    </Button>
  );

  const roleSelectId = useId();
  const lyricsId = useId();

  return (
    <Dialog
      open
      onClose={close}
      title={tk('advancedSearch')}
      size="xl"
      mobile="fullscreen"
      panelClassName="sm:max-h-[80vh]!"
      headerActions={isMobile ? clearButton : undefined}
      footerStart={isMobile ? undefined : clearButton}
      footer={applyButton}
      data-testid="advanced-search-dialog"
    >
      {/* ===== よく使う条件（5列） ===== */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 pb-5 pt-1 sm:grid-cols-3 lg:grid-cols-5">
        <QuickColumn heading={t('公開時期')}>
          <QuickOption label={t('初期ボカロ')} detail="2007–2012" selected={yearPreset === 'early'} onSelect={() => setYearPreset('early')} />
          <QuickOption label={t('2024年以降')} selected={yearPreset === 'recent'} onSelect={() => setYearPreset('recent')} />
          <QuickOption label={t('期間を指定')} selected={hasCustomYear} removable={false} onSelect={openCustomPeriod} />
        </QuickColumn>
        <QuickColumn heading={t('長さ')}>
          <QuickOption
            label={t('3分以内')}
            selected={shortOnly}
            onSelect={() => updateFilters(shortOnly ? { lengthMinSeconds: '', lengthMaxSeconds: '' } : { lengthMinSeconds: '', lengthMaxSeconds: '180' })}
          />
          <QuickOption
            label={t('6分以上')}
            selected={longOnly}
            onSelect={() => updateFilters(longOnly ? { lengthMinSeconds: '', lengthMaxSeconds: '' } : { lengthMinSeconds: '360', lengthMaxSeconds: '' })}
          />
        </QuickColumn>
        <QuickColumn heading={t('種類')}>
          <QuickOption label={t('オリジナルのみ')} selected={originalOnly} onSelect={toggleOriginalOnly} />
          <QuickOption label={t('カバー')} selected={filters.includedSongTypes.includes('Cover')} onSelect={() => toggleSongType('Cover')} />
          <QuickOption label={t('リミックス')} selected={filters.includedSongTypes.includes('Remix')} onSelect={() => toggleSongType('Remix')} />
          <QuickOption label={t('セルフカバー')} selected={filters.selfCoverOnly} onSelect={() => updateFilters({ selfCoverOnly: !filters.selfCoverOnly })} />
        </QuickColumn>
        <QuickColumn heading={t('再生数')}>
          <QuickOption
            label={t('YouTube 100万回以上')}
            selected={filters.minYoutubeViews === '1000000'}
            onSelect={() => updateFilters({ minYoutubeViews: filters.minYoutubeViews === '1000000' ? '' : '1000000' })}
          />
          <QuickOption
            label={t('ニコニコ 10万回以上')}
            selected={filters.minNicoViews === '100000'}
            onSelect={() => updateFilters({ minNicoViews: filters.minNicoViews === '100000' ? '' : '100000' })}
          />
        </QuickColumn>
        <QuickColumn heading={t('並べ替え')}>
          {sortOptions.map(option => (
            <QuickOption
              key={option.value}
              label={tk(option.labelKey)}
              selected={draft.sort === option.value}
              removable={false}
              onSelect={() => setDraft(previous => ({ ...previous, sort: option.value }))}
            />
          ))}
        </QuickColumn>
      </div>

      {/* ===== 1. ボーカル ===== */}
      <FilterSection id="vocalist" title={t('ボーカル')} summary={summaries.vocalist} open={openSections.has('vocalist')} onToggle={toggleSection}>
        <SearchField value={vocalistQuery} onChange={setVocalistQuery} label={t('ボーカルを検索')} />
        {vocalistSuggestions.length > 0 && (
          <SuggestionList
            items={vocalistSuggestions.map(artist => ({
              id: artist.id,
              label: artist.name,
              detail: t(VOICE_SYNTH_TYPE_LABELS[artist.artistType as VoiceSynthArtistType] ?? ''),
            }))}
            onSelect={item => {
              const artist = vocalistSuggestions.find(candidate => candidate.id === item.id);
              if (artist) void selectVocalistSuggestion(artist);
            }}
          />
        )}
        {extraSelectedVocalists.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {extraSelectedVocalists.map(filter => (
              <Chip key={filter.variantGroup ?? filter.id} selected onClick={() => removeVocalistSelection(filter)}>
                {vocalistLabel(filter)}
              </Chip>
            ))}
          </div>
        )}
        {showAllVocalists ? (
          <div className="mt-3 flex flex-col gap-3">
            {categories.map(category => (
              <div key={category.label}>
                <p className="m-0 mb-1.5 text-xs leading-4 font-medium text-yt-text-secondary">{t(category.label)}</p>
                <div className="flex flex-wrap gap-2">
                  {category.vocalists.map(vocalist => (
                    <Chip key={vocalist.id} selected={selectedVocalistIds.has(vocalist.id)} onClick={() => togglePresetVocalist(vocalist)}>
                      {vocalist.name}
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {popularVocalists.map(vocalist => (
              <Chip key={vocalist.id} selected={selectedVocalistIds.has(vocalist.id)} onClick={() => togglePresetVocalist(vocalist)}>
                {vocalist.name}
              </Chip>
            ))}
          </div>
        )}
        <Button variant="text" size="sm" className="-ml-3 mt-2" onClick={() => setShowAllVocalists(value => !value)}>
          {showAllVocalists ? tk('showLess') : t('すべて表示')}
        </Button>
        {visibleVocalists.length >= 2 && (
          <div className="mt-3">
            {/* The same words and order as 設定 > フィルター > ボーカル. */}
            <MatchModeChips
              label={t('一致モード')}
              value={draft.vocalistMatchMode}
              options={[
                { value: 'Any', label: tk('settingsMatchAny') },
                { value: 'All', label: tk('settingsMatchAll') },
                { value: 'Exact', label: tk('settingsMatchExact') },
              ]}
              onChange={mode => setDraft(previous => ({ ...previous, vocalistMatchMode: mode }))}
            />
          </div>
        )}
      </FilterSection>

      {/* ===== 2. 曲の種類 ===== */}
      <FilterSection id="songType" title={t('曲の種類')} summary={summaries.songType} open={openSections.has('songType')} onToggle={toggleSection}>
        <div className="flex flex-wrap gap-2">
          <Chip selected={originalOnly} onClick={toggleOriginalOnly}>{t('オリジナルのみ')}</Chip>
          {SONG_TYPE_OPTIONS.map(type => (
            <Chip key={type} selected={filters.includedSongTypes.includes(type)} onClick={() => toggleSongType(type)}>
              {songTypeLabel(type, language)}
            </Chip>
          ))}
          <Chip selected={filters.selfCoverOnly} onClick={() => updateFilters({ selfCoverOnly: !filters.selfCoverOnly })}>
            {t('セルフカバーのみ')}
          </Chip>
        </div>
      </FilterSection>

      {/* ===== 3. 公開年・長さ ===== */}
      <FilterSection id="period" title={t('公開年・長さ')} summary={summaries.period} open={openSections.has('period')} onToggle={toggleSection}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <RangeField
            label={t('公開年')}
            unit={UNITS.year[language]}
            from={filters.publishYearFrom}
            to={filters.publishYearTo}
            onFrom={value => updateFilters({ publishYearFrom: value })}
            onTo={value => updateFilters({ publishYearTo: value })}
            error={rangeErrors.publishYear}
            errorKey="publishYear"
            fromRef={yearFromRef}
          />
          <RangeField
            label={t('長さ')}
            unit={UNITS.seconds[language]}
            from={filters.lengthMinSeconds}
            to={filters.lengthMaxSeconds}
            onFrom={value => updateFilters({ lengthMinSeconds: value })}
            onTo={value => updateFilters({ lengthMaxSeconds: value })}
            error={rangeErrors.length}
            errorKey="length"
          />
        </div>
      </FilterSection>

      {/* ===== 4. 再生数・お気に入り数 ===== */}
      <FilterSection id="views" title={t('再生数・お気に入り数')} summary={summaries.views} open={openSections.has('views')} onToggle={toggleSection}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <RangeField
            label={t('YouTube再生数')}
            unit={UNITS.views[language]}
            from={filters.minYoutubeViews}
            to={filters.maxYoutubeViews}
            onFrom={value => updateFilters({ minYoutubeViews: value })}
            onTo={value => updateFilters({ maxYoutubeViews: value })}
            error={rangeErrors.youtubeViews}
            errorKey="youtubeViews"
          />
          <RangeField
            label={t('ニコニコ再生数')}
            unit={UNITS.views[language]}
            from={filters.minNicoViews}
            to={filters.maxNicoViews}
            onFrom={value => updateFilters({ minNicoViews: value })}
            onTo={value => updateFilters({ maxNicoViews: value })}
            error={rangeErrors.nicoViews}
            errorKey="nicoViews"
          />
          <RangeField
            label={t('VocaDBお気に入り数')}
            unit=""
            from={filters.minFavoritedTimes}
            to={filters.maxFavoritedTimes}
            onFrom={value => updateFilters({ minFavoritedTimes: value })}
            onTo={value => updateFilters({ maxFavoritedTimes: value })}
            error={rangeErrors.favorites}
            errorKey="favorites"
          />
        </div>
      </FilterSection>

      {/* ===== 5. VocaDBタグ ===== */}
      <FilterSection id="tags" title={t('VocaDBタグ')} summary={summaries.tags} open={openSections.has('tags')} onToggle={toggleSection}>
        <SearchField value={tagQuery} onChange={setTagQuery} label={t('タグを検索')} />
        {tagSuggestions.length > 0 && (
          <SuggestionList
            items={tagSuggestions.map(tag => ({ id: tag.id, label: tag.name, detail: formatCount(tag.songCount, 'song', language) }))}
            onSelect={item => {
              const tag = tagSuggestions.find(candidate => candidate.id === item.id);
              if (tag && !filters.tagFilters.some(existing => existing.id === tag.id)) toggleTag({ id: tag.id, name: tag.name });
              setTagQuery('');
              setTagSuggestions([]);
            }}
          />
        )}
        <div data-testid="vocadb-tag-filters" className="mt-3 flex flex-wrap gap-2">
          {customTags.map(tag => (
            <Chip key={tag.id} selected onClick={() => toggleTag(tag)}>{t(tag.name)}</Chip>
          ))}
          {TAG_PRESETS.map(tag => (
            <Chip key={tag.id} selected={filters.tagFilters.some(item => item.id === tag.id)} onClick={() => toggleTag(tag)}>
              {t(tag.name)}
            </Chip>
          ))}
        </div>
        {filters.tagFilters.length >= 2 && (
          <div className="mt-3">
            <MatchModeChips
              label={t('一致モード')}
              value={filters.tagMatchMode}
              options={[{ value: 'any', label: tk('settingsMatchAny') }, { value: 'all', label: tk('settingsMatchAll') }]}
              onChange={mode => updateFilters({ tagMatchMode: mode })}
            />
          </div>
        )}
      </FilterSection>

      {/* ===== 6. 参加者・役割 ===== */}
      <FilterSection id="credit" title={t('参加者・役割')} summary={summaries.credit} open={openSections.has('credit')} onToggle={toggleSection}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(160px,0.6fr)]">
          <div className="min-w-0">
            <SearchField value={creditQuery} onChange={setCreditQuery} label={t('クリエイターを検索')} />
            {creditSuggestions.length > 0 && (
              <SuggestionList
                items={creditSuggestions.map(artist => ({ id: artist.id, label: artist.name, detail: artistTypeLabel(artist.artistType, language) }))}
                onSelect={item => {
                  updateFilters({ creditArtist: { id: item.id, name: item.label } });
                  setCreditQuery('');
                  setCreditSuggestions([]);
                }}
              />
            )}
          </div>
          <SelectField
            id={roleSelectId}
            label={t('役割')}
            value={filters.creditRole}
            onChange={value => updateFilters({ creditRole: value })}
          >
            {CREDIT_ROLES.map(role => (
              <option key={role} value={role}>{role ? artistRoleLabel(role, language) : t('すべての役割')}</option>
            ))}
          </SelectField>
        </div>
        {filters.creditArtist && (
          <div className="mt-3 flex">
            <Chip selected onClick={() => updateFilters({ creditArtist: null })}>
              {filters.creditArtist.name}
            </Chip>
          </div>
        )}
      </FilterSection>

      {/* ===== 7. 音源からの推定 ===== */}
      <FilterSection
        id="audio"
        title={t('音源からの推定')}
        summary={summaries.audio}
        open={openSections.has('audio')}
        onToggle={toggleSection}
        info={<InfoTip label={t('音源からの推定について')}>{t('解析済みの曲だけが対象です。推定のため誤りを含むことがあります。')}</InfoTip>}
      >
        <div data-testid="audio-analysis-filters" className="flex flex-col gap-4">
          <div className="max-w-sm">
            <RangeField
              label="BPM"
              unit={UNITS.bpm[language]}
              from={filters.bpmFrom}
              to={filters.bpmTo}
              onFrom={value => updateFilters({ bpmFrom: value })}
              onTo={value => updateFilters({ bpmTo: value })}
              error={rangeErrors.bpm}
              errorKey="bpm"
              info={<InfoTip label={t('BPMについて')}>{t('半分・倍のテンポも含みます')}</InfoTip>}
            />
          </div>
          <div>
            <FieldLabel>{t('楽器')}</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {instrumentOptions.map(option => (
                <Chip key={option.key} selected={filters.instrumentKeys.includes(option.key)} onClick={() => toggleInstrument(option.key)}>
                  {t(option.label)}
                </Chip>
              ))}
            </div>
            <Button variant="text" size="sm" className="-ml-3 mt-2" onClick={() => setShowAllInstruments(value => !value)}>
              {showAllInstruments ? tk('showLess') : t('すべて表示')}
            </Button>
            {filters.instrumentKeys.length >= 2 && (
              <div className="mt-3">
                <MatchModeChips
                  label={t('一致モード')}
                  value={filters.instrumentMatchMode}
                  options={[{ value: 'any', label: tk('settingsMatchAny') }, { value: 'all', label: tk('settingsMatchAll') }]}
                  onChange={mode => updateFilters({ instrumentMatchMode: mode })}
                />
              </div>
            )}
          </div>
          <div className="sm:max-w-60">
            <FieldLabel htmlFor="audio-computed-filter">{t('音響解析')}</FieldLabel>
            <SelectField
              id="audio-computed-filter"
              value={filters.audioComputed}
              onChange={value => updateFilters({ audioComputed: value as AdvancedSearchFilters['audioComputed'] })}
            >
              <option value="any">{t('指定なし')}</option>
              <option value="yes">{t('解析済み')}</option>
              <option value="no">{t('未解析')}</option>
            </SelectField>
          </div>
        </div>
      </FilterSection>

      {/* ===== 8. 歌詞・動画 ===== */}
      <FilterSection id="lyrics" title={t('歌詞・動画')} summary={summaries.lyrics} open={openSections.has('lyrics')} onToggle={toggleSection}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <FieldLabel htmlFor={lyricsId}>{t('歌詞')}</FieldLabel>
            <input
              id={lyricsId}
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              className="h-10 w-full rounded-chip border border-yt-field-border bg-yt-field px-3 text-sm leading-5 text-yt-text outline-none transition-colors duration-150 placeholder:text-yt-text-disabled focus:border-yt-focus [&::-webkit-search-cancel-button]:appearance-none"
              value={filters.lyricsQuery}
              maxLength={100}
              placeholder={t('歌詞の一部')}
              onChange={event => updateFilters({ lyricsQuery: event.target.value })}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  apply();
                }
              }}
            />
          </div>
          <div className="min-w-0">
            {/* The same name and choices as the smart playlist rule (「PV」 is also a song type here). */}
            <FieldLabel htmlFor="pv-service-filter">{t('再生できる動画')}</FieldLabel>
            <SelectField
              id="pv-service-filter"
              value={filters.pvService}
              onChange={value => updateFilters({ pvService: value as AdvancedSearchFilters['pvService'] })}
            >
              <option value="any">{t('すべて')}</option>
              <option value="youtube">YouTube</option>
              <option value="niconico">{t('ニコニコ')}</option>
              <option value="both">{t('両方')}</option>
            </SelectField>
          </div>
        </div>
      </FilterSection>
    </Dialog>
  );
}
