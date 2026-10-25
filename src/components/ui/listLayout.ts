/**
 * Layout helpers for the list/card primitives. SONG_ROW_LAYOUT is shared by
 * SongListRow and SkeletonListRow so a skeleton row has the
 * same height as the row that replaces it (no layout shift).
 */
export type SongRowSize = 'fluid' | 'xl' | 'lg' | 'md' | 'sm' | 'xs';

export interface SongRowLayout {
  /** Thumbnail width (16:9). Capped at half of the row so narrow screens never overflow. */
  thumb: string;
  /** Gap between thumbnail and text. */
  gap: string;
  /** Row padding. */
  padding: string;
  /** SongThumbnail radius. */
  radius: 'sm' | 'md';
  /** Title typography. */
  title: string;
  /** Large rows (xl / lg) use the 18px title and top-aligned trailing actions. */
  large: boolean;
  meta?: string;
}

export const SONG_ROW_LAYOUT: Record<SongRowSize, SongRowLayout> = {
  // Watch sidebar establishes an inline-size container; rem bounds preserve text zoom.
  fluid: {
    thumb: 'w-[clamp(12.5rem,46cqw,17.25rem)] max-w-[50%]',
    gap: 'gap-[clamp(0.75rem,2.7cqw,1.25rem)]',
    padding: 'px-2 py-[clamp(0.5rem,1.7cqw,0.75rem)]',
    radius: 'md',
    title: 'text-[clamp(1rem,3.4cqw,1.25rem)] leading-[1.45] font-normal',
    meta: 'text-[clamp(0.75rem,2.2cqw,0.875rem)] leading-normal',
    large: true,
  },
  xl: {
    thumb: 'w-[360px] max-w-[50%]',
    gap: 'gap-4',
    padding: 'p-2',
    radius: 'md',
    title: 'text-lg leading-[26px] font-normal',
    large: true,
  },
  lg: {
    thumb: 'w-[246px] max-w-[50%]',
    gap: 'gap-4',
    padding: 'p-2',
    radius: 'md',
    title: 'text-lg leading-[26px] font-normal',
    large: true,
  },
  md: {
    thumb: 'w-[168px] max-w-[50%]',
    gap: 'gap-2',
    padding: 'p-2',
    radius: 'sm',
    title: 'text-sm leading-5 font-medium',
    large: false,
  },
  // sm / xs keep the 72px / 64px phone rows; from 640px they get 6px above and below (12px between
  // thumbnails) so desktop lists don't look packed next to the md / lg ones.
  sm: {
    thumb: 'w-[120px] max-w-[50%]',
    gap: 'gap-2',
    padding: 'px-2 py-0.5 sm:py-1.5',
    radius: 'sm',
    title: 'text-sm leading-5 font-medium',
    large: false,
  },
  xs: {
    thumb: 'w-[100px] max-w-[50%]',
    gap: 'gap-2',
    padding: 'px-2 py-1 sm:py-1.5',
    radius: 'sm',
    title: 'text-sm leading-5 font-medium',
    large: false,
  },
};
