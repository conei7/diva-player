import { useTranslateSourceText } from '../../i18n';
import { useSearchStore } from '../../stores/searchStore';
import Button from '../ui/Button';
import { RemovableChip } from '../ui/Chip';
import type { AppliedFilterItem } from './appliedFilters';

/**
 * The conditions applied to the search, under the results toolbar. Each × removes its condition right
 * away; 「すべてクリア」 removes all of them (the ボーカル mode's own vocalists stay: they are the query).
 */
export default function AppliedFilterChips({ items }: { items: AppliedFilterItem[] }) {
  const t = useTranslateSourceText();
  if (items.length === 0) return null;

  const clearAll = () => {
    const store = useSearchStore.getState();
    store.clearSearchConditions();
    void store.search();
  };

  return (
    <div
      role="group"
      aria-label={t('適用中の条件')}
      className="-mx-3 flex min-h-12 items-center gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      {items.map(item => (
        <RemovableChip key={item.key} label={item.label} onRemove={item.remove} />
      ))}
      <Button variant="text" size="sm" className="shrink-0" onClick={clearAll}>
        {t('すべてクリア')}
      </Button>
    </div>
  );
}
