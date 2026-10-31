import type { SongRowSize } from '../ui/SongListRow';

/** The right column (検索・並べ替え・バックアップ・視聴統計) plus its 24px gap: 280px, 320px from 1280px. */
const RAIL_SPACE = { default: 280 + 24, xl: 320 + 24 };
/** Narrower pages show the header variant (検索 + ⋮) instead, so the list keeps a readable width. */
export const HISTORY_RAIL_MIN_WIDTH = 860;
/** From this list width the 246px-thumbnail rows still leave a readable text column. */
const LARGE_ROWS_MIN_WIDTH = 640;

export interface HistoryLayoutInput {
  /** The music layout (the library and the 再生中 panel take part of the window). */
  musicLayout: boolean;
  /** Width of the page's content (px) without the window's scrollbar; 0 until it is measured. */
  contentWidth: number;
  /** ≥1024px window. */
  wideViewport: boolean;
  /** ≥1280px window (the column is 320px wide). */
  xlViewport: boolean;
  /** <640px window. */
  mobile: boolean;
}

export interface HistoryLayout {
  /** The right column next to the list (else 検索 + ⋮ in the header). */
  rail: boolean;
  rowSize: SongRowSize;
}

/**
 * The standard layout keeps its window breakpoints (md rows beside the column below 1280px).
 * The music layout follows the width the page really has: the library and the 再生中 panel take
 * part of the window, so a 1440px window can leave only ~730px. The column still needs a ≥1024px
 * window there.
 */
export function getHistoryLayout({ musicLayout, contentWidth, wideViewport, xlViewport, mobile }: HistoryLayoutInput): HistoryLayout {
  if (!musicLayout || contentWidth <= 0) {
    return { rail: wideViewport, rowSize: mobile || (wideViewport && !xlViewport) ? 'md' : 'lg' };
  }
  const rail = wideViewport && contentWidth >= HISTORY_RAIL_MIN_WIDTH;
  const listWidth = rail ? contentWidth - (xlViewport ? RAIL_SPACE.xl : RAIL_SPACE.default) : contentWidth;
  return { rail, rowSize: !mobile && listWidth >= LARGE_ROWS_MIN_WIDTH ? 'lg' : 'md' };
}
