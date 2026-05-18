import { useRef, useEffect } from 'react';

/**
 * CategoryChips - YouTube風のカテゴリーフィルターチップ
 *
 * 横スクロール可能な丸薬型（Pill型）ボタン群。
 * ユーザーの気分に合わせてホームの表示内容を切り替える。
 */

export interface CategoryChip {
  id: string;
  label: string;
}

interface CategoryChipsProps {
  chips: CategoryChip[];
  activeChip: string;
  onSelect: (id: string) => void;
}

export default function CategoryChips({ chips, activeChip, onSelect }: CategoryChipsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // アクティブチップが見えるようにスクロール
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const activeEl = container.querySelector('[data-active="true"]') as HTMLElement;
    if (activeEl) {
      const containerRect = container.getBoundingClientRect();
      const chipRect = activeEl.getBoundingClientRect();
      if (chipRect.left < containerRect.left || chipRect.right > containerRect.right) {
        activeEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  }, [activeChip]);

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide"
        style={{
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
      >
        <style>{`.scrollbar-hide::-webkit-scrollbar { display: none; }`}</style>
        {chips.map((chip) => {
          const isActive = chip.id === activeChip;
          return (
            <button
              key={chip.id}
              data-active={isActive}
              onClick={() => onSelect(chip.id)}
              className="yt-chip flex-shrink-0"
              style={{
                background: isActive ? 'var(--color-yt-chip-active)' : 'var(--color-yt-chip)',
                color: isActive ? '#0f0f0f' : 'var(--color-yt-text)',
                fontWeight: isActive ? 600 : 400,
              }}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
