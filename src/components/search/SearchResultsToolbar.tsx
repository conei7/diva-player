import { useTranslate, useTranslateSourceText, type TranslationKey } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { useUiStore } from '../../stores/uiStore';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { formatCount } from '../../utils/songMeta';
import type { SearchType } from '../../utils/routes';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import { Chip, ChipBar } from '../ui/Chip';
import { TuneIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import SearchSortControls from './SearchSortControls';

const SEARCH_TYPE_CHIPS: { type: SearchType; labelKey: TranslationKey }[] = [
  { type: 'all', labelKey: 'autoSearch' },
  { type: 'song', labelKey: 'songSearch' },
  { type: 'producer', labelKey: 'producerSearch' },
  { type: 'vocalist', labelKey: 'vocalistSearch' },
];

interface SearchResultsToolbarProps {
  /** The text query; without one the type chips are not shown (advanced-only and artist searches). */
  query: string;
  type: SearchType;
  onTypeChange: (type: SearchType) => void;
  /** null while loading (no count is shown). */
  totalCount: number | null;
  /** Number of applied conditions (badge on 詳細検索). */
  appliedCount: number;
}

/**
 * Replaces the home chip bar on result pages: すべて / 曲名 / ボカロP / ボーカル on the left, then the
 * song count, sort order, 詳細検索 and the selection-mode button.
 */
export default function SearchResultsToolbar({ query, type, onTypeChange, totalCount, appliedCount }: SearchResultsToolbarProps) {
  const t = useTranslate();
  const ts = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const setAdvancedSearchOpen = useUiStore(state => state.setAdvancedSearchOpen);
  const countText = totalCount === null ? '' : formatCount(totalCount, 'song', language);

  const typeChips = query ? (
    <ChipBar label={ts('検索の種類')} className="min-w-0 flex-1">
      {SEARCH_TYPE_CHIPS.map(chip => (
        <Chip key={chip.type} selected={chip.type === type} onClick={() => onTypeChange(chip.type)}>
          {t(chip.labelKey)}
        </Chip>
      ))}
    </ChipBar>
  ) : null;

  const advancedButton = isMobile ? (
    <IconButton
      label={t('advancedSearch')}
      icon={<TuneIcon />}
      badge={appliedCount}
      onClick={() => setAdvancedSearchOpen(true)}
    />
  ) : (
    <Button icon={<TuneIcon />} onClick={() => setAdvancedSearchOpen(true)}>
      {t('advancedSearch')}
      {appliedCount > 0 && (
        <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-yt-inverse px-1.5 align-middle text-xs leading-4 font-medium text-yt-on-inverse tabular-nums">
          {appliedCount}
        </span>
      )}
    </Button>
  );

  const controls = (
    <div className={cx('flex items-center', isMobile ? 'w-full gap-1' : 'shrink-0 gap-2')}>
      {countText && (
        <span className={cx('shrink-0 whitespace-nowrap text-sm leading-5 text-yt-text-secondary tabular-nums', isMobile && 'mr-1')}>
          {countText}
        </span>
      )}
      <SearchSortControls compact={isMobile} />
      {advancedButton}
    </div>
  );

  return (
    <div className="-mx-3 bg-yt-bg px-3 sm:sticky sm:top-[calc(var(--header-height,56px)_+_var(--selection-bar-height,0px))] sm:z-[var(--z-sticky,20)] sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6">
      {isMobile ? (
        <div className="flex flex-col gap-2 py-2">
          {typeChips}
          {controls}
        </div>
      ) : (
        <div className="flex min-h-14 items-center gap-4 py-2">
          {typeChips ?? <div className="flex-1" />}
          {controls}
        </div>
      )}
    </div>
  );
}
