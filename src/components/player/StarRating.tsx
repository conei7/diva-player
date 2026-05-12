import { useState } from 'react';

const STAR_PATH =
  'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';

interface StarRatingProps {
  /** 現在の評価値 (0 = 未評価, 1〜5) */
  rating: number;
  /** 星クリック時のコールバック */
  onRate: (rating: number) => void;
  /** 表示サイズ。'md' = 通常 (18px), 'sm' = コンパクト (12px) */
  size?: 'md' | 'sm';
}

/** 星5段階評価コンポーネント */
export default function StarRating({ rating, onRate, size = 'md' }: StarRatingProps) {
  const [hovered, setHovered] = useState(0);
  const px = size === 'md' ? 18 : 12;
  const display = hovered > 0 ? hovered : rating;

  return (
    <div
      className="flex items-center gap-0.5"
      onMouseLeave={() => setHovered(0)}
      role="group"
      aria-label="星評価"
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= display;
        return (
          <button
            key={n}
            type="button"
            aria-label={`${n}星`}
            onMouseEnter={() => setHovered(n)}
            onClick={(e) => {
              e.stopPropagation();
              onRate(n);
            }}
            style={{
              padding: 0,
              lineHeight: 0,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: filled ? '#facc15' : 'var(--color-border)',
              transition: 'color 0.1s',
              flexShrink: 0,
            }}
          >
            <svg width={px} height={px} viewBox="0 0 24 24" fill="currentColor">
              <path d={STAR_PATH} />
            </svg>
          </button>
        );
      })}
    </div>
  );
}
