import { useEffect, useId, useRef, useState } from 'react';
import { searchVocalistsByName, selectVocalistVariants } from '../../api/vocadb';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { SONG_TYPES } from '../../stores/globalFilterStore';
import type { GlobalFilterSettings } from '../../stores/globalFilterStore';
import { useLanguageStore } from '../../stores/languageStore';
import type { Artist, SongType, VocalistMatchMode } from '../../types/vocadb';
import { formatCooldownDuration } from '../../utils/globalFilters';
import { formatCompactCount, songTypeLabel } from '../../utils/songMeta';
import { Chip, RemovableChip } from '../ui/Chip';
import Switch from '../ui/Switch';
import { CloseIcon, SearchIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { SettingRow, SettingsNumberInput, SettingsSection, SettingsSelect } from './settingsControls';

export type ViewThresholdService = 'youtube' | 'nico';

export type UpdateFilterDraft = <K extends keyof GlobalFilterSettings>(key: K, value: GlobalFilterSettings[K]) => void;

const VIEW_PRESETS: Record<ViewThresholdService, readonly number[]> = {
  youtube: [10_000, 50_000, 100_000, 500_000, 1_000_000],
  nico: [1_000, 5_000, 10_000, 50_000, 100_000],
};

const VIEW_KEYS = { youtube: 'minYoutubeViews', nico: 'minNicoViews' } as const;

const COOLDOWN_HOURS = [0, 1, 6, 24, 72, 168];

const CUSTOM_VALUE = 'custom';

/** 「カスタム…」を選んだ時、またはプリセットに無い値の時は数値欄を出す。 */
function isCustomViewThreshold(service: ViewThresholdService, value: number, customChosen: boolean): boolean {
  return customChosen || (value > 0 && !VIEW_PRESETS[service].includes(value));
}

interface FilterSettingsPanelProps {
  draft: GlobalFilterSettings;
  updateDraft: UpdateFilterDraft;
  customViews: Record<ViewThresholdService, boolean>;
  setCustomView: (service: ViewThresholdService, custom: boolean) => void;
}

/** タブ「フィルター」。値は下書き（適用はフッターの［適用］）。 */
export default function FilterSettingsPanel({ draft, updateDraft, customViews, setCustomView }: FilterSettingsPanelProps) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const language = useLanguageStore(state => state.language);
  const locale = language === 'en' ? 'en-US' : 'ja-JP';
  const ids = useId();

  const toggleExcludedType = (songType: SongType) => {
    updateDraft('excludedSongTypes', draft.excludedSongTypes.includes(songType)
      ? draft.excludedSongTypes.filter(type => type !== songType)
      : [...draft.excludedSongTypes, songType]);
  };

  const viewRow = (service: ViewThresholdService) => {
    const key = VIEW_KEYS[service];
    const value = draft[key];
    const custom = isCustomViewThreshold(service, value, customViews[service]);
    const selectId = `${ids}-${service}-views`;
    const labelId = `${selectId}-label`;
    return (
      <SettingRow
        label={service === 'youtube' ? 'YouTube' : t('ニコニコ')}
        labelId={labelId}
        htmlFor={selectId}
      >
        <SettingsSelect
          id={selectId}
          aria-labelledby={`${ids}-views-title ${labelId}`}
          value={custom ? CUSTOM_VALUE : String(VIEW_PRESETS[service].includes(value) ? value : 0)}
          onChange={event => {
            if (event.target.value === CUSTOM_VALUE) {
              setCustomView(service, true);
              return;
            }
            setCustomView(service, false);
            updateDraft(key, Number(event.target.value));
          }}
        >
          <option value="0">{t('指定なし')}</option>
          {VIEW_PRESETS[service].map(preset => (
            <option key={preset} value={preset}>
              {tk('settingsMinViewsOption', { count: formatCompactCount(preset, language) })}
            </option>
          ))}
          <option value={CUSTOM_VALUE}>{t('カスタム…')}</option>
        </SettingsSelect>
        {custom && (
          <span className="flex items-center gap-2">
            <SettingsNumberInput
              value={value}
              locale={locale}
              label={service === 'youtube' ? t('YouTubeの最低再生数') : t('ニコニコの最低再生数')}
              onChange={next => updateDraft(key, next)}
            />
            <span aria-hidden="true" className="text-sm text-yt-text-secondary">{tk('settingsOrMore')}</span>
          </span>
        )}
      </SettingRow>
    );
  };

  const vocalistChips = draft.vocalistFilters.filter((item, index, all) => (
    !item.variantGroup || all.findIndex(candidate => candidate.variantGroup === item.variantGroup) === index
  ));

  const removeVocalist = (id: number, variantGroup?: string) => {
    updateDraft('vocalistFilters', draft.vocalistFilters.filter(item => (
      variantGroup ? item.variantGroup !== variantGroup : item.id !== id
    )));
  };

  const cooldownOptions = COOLDOWN_HOURS.includes(draft.cooldownHours)
    ? COOLDOWN_HOURS
    : [...COOLDOWN_HOURS, draft.cooldownHours].sort((a, b) => a - b);

  return (
    <div>
      <Switch
        className="setting-row min-h-14 py-2"
        label={t('フィルターを使う')}
        checked={draft.enabled}
        onChange={value => updateDraft('enabled', value)}
      />

      <SettingsSection title={tk('settingsViews')} titleId={`${ids}-views-title`}>
        {viewRow('youtube')}
        {viewRow('nico')}
      </SettingsSection>

      <SettingsSection title={t('除外する種類')} titleId={`${ids}-types-title`}>
        <div role="group" aria-labelledby={`${ids}-types-title`} className="flex flex-wrap gap-2 pb-2 pt-2">
          {SONG_TYPES.map(songType => {
            const excluded = draft.excludedSongTypes.includes(songType);
            return (
              <Chip
                key={songType}
                selected={excluded}
                icon={excluded ? <CloseIcon /> : undefined}
                onClick={() => toggleExcludedType(songType)}
              >
                {songTypeLabel(songType, language)}
              </Chip>
            );
          })}
          <Chip
            selected={draft.excludeSelfCovers}
            icon={draft.excludeSelfCovers ? <CloseIcon /> : undefined}
            onClick={() => updateDraft('excludeSelfCovers', !draft.excludeSelfCovers)}
          >
            {t('セルフカバー')}
          </Chip>
        </div>
      </SettingsSection>

      <SettingsSection title={tk('settingsVocalists')} titleId={`${ids}-vocalists-title`}>
        {vocalistChips.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-2">
            {vocalistChips.map(item => {
              const label = item.variantGroup ?? item.name;
              return (
                <RemovableChip
                  key={item.variantGroup ?? item.id}
                  label={label}
                  removeLabel={t('「{name}」を外す', { name: label })}
                  onRemove={() => removeVocalist(item.id, item.variantGroup)}
                />
              );
            })}
          </div>
        )}
        <VocalistCombobox draft={draft} updateDraft={updateDraft} />
        {vocalistChips.length > 1 && (
          <SettingRow label={tk('settingsMatchMode')} labelId={`${ids}-match-label`} htmlFor={`${ids}-match`}>
            <SettingsSelect
              id={`${ids}-match`}
              value={draft.vocalistMatchMode}
              onChange={event => updateDraft('vocalistMatchMode', event.target.value as VocalistMatchMode)}
            >
              <option value="Any">{tk('settingsMatchAny')}</option>
              <option value="All">{tk('settingsMatchAll')}</option>
              <option value="Exact">{tk('settingsMatchExact')}</option>
            </SettingsSelect>
          </SettingRow>
        )}
      </SettingsSection>

      <SettingsSection title={tk('settingsRecommendations')} titleId={`${ids}-recommendations-title`}>
        <SettingRow label={t('最近聴いた曲を除く')} htmlFor={`${ids}-cooldown`}>
          <SettingsSelect
            id={`${ids}-cooldown`}
            value={draft.cooldownHours}
            onChange={event => updateDraft('cooldownHours', Number(event.target.value))}
          >
            {cooldownOptions.map(hours => (
              <option key={hours} value={hours}>
                {hours === 0 ? t('しない') : formatCooldownDuration(hours, language)}
              </option>
            ))}
          </SettingsSelect>
        </SettingRow>
        <Switch
          className="setting-row min-h-14 py-2"
          label={t('評価した曲を除く')}
          checked={draft.excludeRatedFromDiscovery}
          onChange={value => updateDraft('excludeRatedFromDiscovery', value)}
        />
      </SettingsSection>
    </div>
  );
}

/** 「ボーカルを追加」の検索欄（combobox。候補は listbox。↑↓・Enter・Esc）。 */
function VocalistCombobox({ draft, updateDraft }: { draft: GlobalFilterSettings; updateDraft: UpdateFilterDraft }) {
  const t = useTranslateSourceText();
  const listboxId = useId();
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Artist[]>([]);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const requestRef = useRef(0);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    const requestId = ++requestRef.current;
    if (trimmed.length < 2) {
      setSuggestions([]);
      setLoading(false);
      setActiveIndex(-1);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void searchVocalistsByName(trimmed, 20)
        .then(items => {
          if (requestId !== requestRef.current) return;
          setSuggestions(items);
          setActiveIndex(-1);
        })
        .catch(() => {
          if (requestId === requestRef.current) setSuggestions([]);
        })
        .finally(() => {
          if (requestId === requestRef.current) setLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const searching = query.trim().length >= 2;
  const open = focused && !dismissed && searching && (loading || suggestions.length > 0);
  const showOptions = open && !loading && suggestions.length > 0;

  // 候補はダイアログのパネル（唯一のスクロール領域）の中に出るので、隠れないところまでパネルを送る
  useEffect(() => {
    if (showOptions) popupRef.current?.scrollIntoView({ block: 'nearest' });
  }, [showOptions, suggestions]);

  // ↑↓で選んだ候補を見える位置に
  useEffect(() => {
    if (activeIndex < 0) return;
    popupRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const choose = async (artist: Artist) => {
    const groupQuery = query.trim() || artist.name;
    const matches = selectVocalistVariants(
      await searchVocalistsByName(groupQuery, 50).catch(() => [artist]),
      groupQuery,
    );
    const selected = matches.length > 0 ? matches : [artist];
    const newIds = new Set(selected.map(item => item.id));
    updateDraft('vocalistFilters', [
      ...draft.vocalistFilters.filter(item => !newIds.has(item.id)),
      ...selected.map(item => ({
        id: item.id,
        name: item.name,
        ...(selected.length > 1 ? { variantGroup: groupQuery } : {}),
      })),
    ]);
    setQuery('');
    setSuggestions([]);
    setActiveIndex(-1);
  };

  const optionId = (index: number) => `${listboxId}-option-${index}`;

  return (
    <div className="relative max-w-[400px] py-3">
      <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-yt-text-secondary">
        <SearchIcon size={20} />
      </span>
      <input
        type="text"
        role="combobox"
        autoComplete="off"
        enterKeyHint="search"
        aria-label={t('ボーカルを検索')}
        aria-autocomplete="list"
        aria-expanded={showOptions}
        aria-controls={showOptions ? listboxId : undefined}
        aria-activedescendant={showOptions && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        placeholder={t('ボーカルを追加')}
        value={query}
        onChange={event => {
          setQuery(event.target.value);
          setDismissed(false);
        }}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => {
          setFocused(false);
          setActiveIndex(-1);
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (suggestions.length === 0) return;
            event.preventDefault();
            setDismissed(false);
            setActiveIndex(index => {
              if (event.key === 'ArrowDown') return index + 1 >= suggestions.length ? 0 : index + 1;
              return index <= 0 ? suggestions.length - 1 : index - 1;
            });
          } else if (event.key === 'Enter') {
            if (!showOptions) return;
            event.preventDefault();
            void choose(suggestions[Math.max(0, activeIndex)]);
          } else if (event.key === 'Escape') {
            // 候補を先に閉じる。次の Esc で文字を消し、その次でダイアログが閉じる
            if (open) {
              event.preventDefault();
              event.stopPropagation();
              setDismissed(true);
              setActiveIndex(-1);
            } else if (query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery('');
            }
          }
        }}
        className="h-10 w-full rounded-chip border border-yt-field-border bg-yt-field pl-10 pr-3 text-sm leading-5 text-yt-text outline-none transition-colors duration-150 placeholder:text-yt-text-secondary focus:border-yt-focus"
      />
      {open && (
        <div
          ref={popupRef}
          className="absolute inset-x-0 top-full z-20 -mt-2 scroll-mb-4 overflow-hidden rounded-card bg-yt-menu py-2 shadow-[0_4px_32px_rgba(0,0,0,0.5)]"
        >
          {loading ? (
            <p className="px-4 py-2 text-sm text-yt-text-secondary">{t('検索中…')}</p>
          ) : (
            <ul id={listboxId} role="listbox" aria-label={t('ボーカルを検索')} className="max-h-60 overflow-y-auto">
              {suggestions.map((artist, index) => (
                <li
                  key={artist.id}
                  id={optionId(index)}
                  data-index={index}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={event => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void choose(artist)}
                  className={cx(
                    'flex h-12 cursor-pointer items-center gap-3 px-4 text-sm leading-5 text-yt-text',
                    index === activeIndex && 'bg-yt-tonal',
                  )}
                >
                  <span className="min-w-0 truncate">{artist.name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
