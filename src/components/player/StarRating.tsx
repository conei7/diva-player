import { useState } from 'react';
import { useTranslateSourceText } from '../../i18n';
import Tooltip from '../ui/Tooltip';

const STAR_PATH =
  'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';

interface StarRatingProps {
  /** 現在の評価値 (0 = 未評価, 1〜5) */
  rating: number;
  /** 星クリック時のコールバック（同じ星をもう一度押すと解除するのは ratingStore 側） */
  onRate: (rating: number) => void;
  /** 表示サイズ。'md' = 通常 (20px), 'sm' = コンパクト (12px) */
  size?: 'md' | 'sm';
}

/**
 * 星5段階評価。未評価は灰色の線、評価済みは黄色の塗り。
 * hover / focus で黄色のプレビューを出す。各星は aria-pressed で今の評価を伝える。
 * アイコンだけのボタンなので、各星にツールチップ（＝aria-label「星{n}つ」）を付ける（DESIGN_SPEC §2.1-4）。
 * 640px 以下のタップ領域（40×40）は index.css の area:watch の `.rating-star-button` で決める。
 */
export default function StarRating({ rating, onRate, size = 'md' }: StarRatingProps) {
  const [preview, setPreview] = useState(0);
  const t = useTranslateSourceText();
  const px = size === 'md' ? 20 : 12;
  const display = preview > 0 ? preview : rating;

  return (
    <div
      className="flex items-center gap-0.5"
      onMouseLeave={() => setPreview(0)}
      role="group"
      aria-label={t('星評価')}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= display;
        const label = n === 1 ? t('星1つ') : t('星{count}つ', { count: n });
        return (
          <Tooltip key={n} content={label}>
            <button
              type="button"
              className="rating-star-button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 leading-none transition-colors duration-150"
              aria-label={label}
              aria-pressed={n <= rating}
              onMouseEnter={() => setPreview(n)}
              onFocus={(e) => {
                // Keyboard focus previews like hover; a programmatic focus (dialog opening) does not.
                if (e.currentTarget.matches(':focus-visible')) setPreview(n);
              }}
              onBlur={() => setPreview(0)}
              onClick={(e) => {
                e.stopPropagation();
                onRate(n);
              }}
              style={{ color: filled ? 'var(--color-rating)' : 'var(--color-yt-text-secondary)' }}
            >
              <svg
                width={px}
                height={px}
                viewBox="0 0 24 24"
                fill={filled ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth={filled ? 0 : 1.5}
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={STAR_PATH} />
              </svg>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
