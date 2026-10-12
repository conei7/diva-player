import type { ReactNode } from 'react';

/** Small tonal label inside a song row (「非表示中」「サビ 1:02〜」). */
export default function RowBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center whitespace-nowrap rounded-badge bg-yt-tonal px-1.5 text-xs leading-4 font-medium text-yt-text-secondary tabular-nums">
      {children}
    </span>
  );
}
