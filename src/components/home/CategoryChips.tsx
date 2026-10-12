import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { Chip, ChipBar } from '../ui/Chip';

/**
 * CategoryChips - the home feed's chip bar (おすすめ / ランキング / …).
 * Hovering or focusing a chip prefetches its feed.
 */

export interface CategoryChip {
  id: string;
  label: string;
}

interface CategoryChipsProps {
  chips: CategoryChip[];
  activeChip: string;
  onSelect: (id: string) => void;
  onPrefetch?: (id: string) => void;
  /** Fixed at the right end, outside the scrolling chips (the selection-mode button). */
  trailing?: ReactNode;
}

export default function CategoryChips({ chips, activeChip, onSelect, onPrefetch, trailing }: CategoryChipsProps) {
  const t = useTranslateSourceText();
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the active chip in view. Only the chip row scrolls (scrollIntoView could also move the page,
  // which would fight the restored feed scroll position).
  useEffect(() => {
    const chip = containerRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    const scroller = chip?.closest<HTMLElement>('.overflow-x-auto');
    if (!chip || !scroller) return;
    const chipRect = chip.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    if (chipRect.left >= scrollerRect.left && chipRect.right <= scrollerRect.right) return;
    scroller.scrollLeft += chipRect.left - scrollerRect.left - (scrollerRect.width - chipRect.width) / 2;
  }, [activeChip]);

  return (
    <div ref={containerRef}>
      <ChipBar label={t('カテゴリ')} trailing={trailing}>
        {chips.map(chip => (
          <Chip
            key={chip.id}
            selected={chip.id === activeChip}
            onMouseEnter={() => onPrefetch?.(chip.id)}
            onFocus={() => onPrefetch?.(chip.id)}
            onClick={() => onSelect(chip.id)}
          >
            {chip.label}
          </Chip>
        ))}
      </ChipBar>
    </div>
  );
}
