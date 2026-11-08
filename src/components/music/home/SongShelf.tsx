import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslateSourceText } from '../../../i18n';
import IconButton from '../../ui/IconButton';
import { ChevronLeftIcon, ChevronRightIcon } from '../../ui/icons';
import { cx } from '../../ui/overlay';
import { SkeletonBlock } from '../../ui/Skeleton';
import { SHELF_CARD_WIDTH_CLASS } from './musicHomeShelves';

const SKELETON_CARDS = [0, 1, 2, 3, 4, 5, 6, 7];

const SEE_ALL_CLASS = 'inline-flex min-h-10 shrink-0 cursor-pointer items-center rounded-chip px-2 text-sm font-bold leading-5 text-yt-text-secondary no-underline hover:text-yt-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus';

/**
 * A card's hover panel: a rounded face 8px around the card, behind its content (the card is `isolate`),
 * like a music app's cards. The shelf's scroller keeps 8px above and below for it.
 */
export const CARD_HOVER_CLASS =
  "isolate before:pointer-events-none before:absolute before:-inset-2 before:-z-10 before:rounded-md before:transition-colors before:duration-150 before:content-[''] hover:before:bg-(--music-hover) focus-within:before:bg-(--music-hover)";

/** The artwork's soft shadow (index.css --music-art-shadow). */
export const ART_SHADOW_CLASS = 'shadow-[var(--music-art-shadow)]';

export interface SongShelfProps {
  /** `data-shelf` of the section (recent, playlists, weekly, …). */
  shelf: string;
  title: string;
  /** A page with everything the shelf previews (shown as 「すべて表示」 next to the title). */
  seeAllTo?: string;
  /** 「すべて表示」 as a button, for a list shown on this page (Home's feed below the shelves). */
  onSeeAll?: () => void;
  /** Mouse devices: ‹ › buttons next to the title scroll the row by about a screen. */
  finePointer: boolean;
  /** The cards, each an <li>. */
  children: ReactNode;
}

/**
 * One Home shelf: a titled row of square cards that scrolls sideways (scroll-snap, edge fades and
 * ‹ › buttons as in ChipBar). The row runs to the edges of the page so the next card peeks in;
 * phones show about 2.3 cards per screen.
 */
export default function SongShelf({ shelf, title, seeAllTo, onSeeAll, finePointer, children }: SongShelfProps) {
  const t = useTranslateSourceText();
  const headingId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLUListElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    const start = scroller.scrollLeft > 1;
    const end = scroller.scrollLeft < maxScroll - 1;
    setOverflow(previous => (previous.start === start && previous.end === end ? previous : { start, end }));
  }, []);

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measure());
    if (scrollerRef.current) observer.observe(scrollerRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [measure]);

  const scrollByPage = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const distance = Math.max(scroller.clientWidth - 96, scroller.clientWidth * 0.6);
    scroller.scrollBy({ left: direction * distance, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  const showArrows = finePointer && (overflow.start || overflow.end);

  return (
    <section data-testid="music-shelf" data-shelf={shelf} aria-labelledby={headingId} className="min-w-0">
      <div className="mb-2 flex min-h-10 items-center gap-2">
        <h2 id={headingId} className="m-0 min-w-0 flex-1 truncate text-2xl font-bold leading-8 text-yt-text">
          {title}
        </h2>
        {seeAllTo ? (
          <Link to={seeAllTo} data-testid="music-shelf-see-all" aria-describedby={headingId} className={SEE_ALL_CLASS}>
            {t('すべて表示')}
          </Link>
        ) : onSeeAll && (
          <button type="button" data-testid="music-shelf-see-all" aria-describedby={headingId} className={SEE_ALL_CLASS} onClick={onSeeAll}>
            {t('すべて表示')}
          </button>
        )}
        {showArrows && (
          // Not in the tab order (as in ChipBar): focusing a card scrolls it into view.
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              label={t('左へスクロール')}
              icon={<ChevronLeftIcon />}
              size="sm"
              tabIndex={-1}
              disabled={!overflow.start}
              onClick={() => scrollByPage(-1)}
            />
            <IconButton
              label={t('右へスクロール')}
              icon={<ChevronRightIcon />}
              size="sm"
              tabIndex={-1}
              disabled={!overflow.end}
              onClick={() => scrollByPage(1)}
            />
          </div>
        )}
      </div>
      <div className="relative -mx-3 sm:-mx-4 lg:-mx-6">
        {/* py-2: room inside the scroll box for the cards' hover panels and focus rings, which it would clip otherwise. */}
        <div
          ref={scrollerRef}
          onScroll={measure}
          className="snap-x snap-mandatory scroll-px-3 overflow-x-auto overscroll-x-contain px-3 py-2 sm:scroll-px-4 sm:px-4 lg:scroll-px-6 lg:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <ul ref={contentRef} role="list" className="m-0 flex w-max list-none items-start gap-3 p-0 sm:gap-4">
            {children}
          </ul>
        </div>
        {overflow.start && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-3 bg-linear-to-r from-yt-bg to-transparent sm:w-4 lg:w-6" />
        )}
        {overflow.end && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-yt-bg to-transparent lg:w-12" />
        )}
      </div>
    </section>
  );
}

/**
 * Stands in for a shelf whose cards are still loading, with the height of the real one (the
 * header row, the scroller's py-1 and cards whose title wraps to two lines), so the shelves and
 * the feed below stay where they are when the cards arrive. aria-hidden: MusicHome says
 * 「読み込み中…」 once for all of them. No `music-shelf` test id and no `.aspect-square`: the music
 * layout E2E reads those as real shelves.
 */
export function SongShelfSkeleton() {
  return (
    <div data-testid="music-shelf-loading" aria-hidden="true" className="min-w-0">
      <div className="mb-2 flex min-h-10 items-center">
        <SkeletonBlock className="h-7 w-48 rounded-badge" />
      </div>
      <div className="-mx-3 overflow-hidden px-3 py-2 sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6">
        <div className="flex w-max items-start gap-3 sm:gap-4">
          {SKELETON_CARDS.map(index => (
            <div key={index} className={cx('shrink-0', SHELF_CARD_WIDTH_CLASS)}>
              <SkeletonBlock className="aspect-[1/1] w-full rounded-[8px]" />
              {/* 62px: two 20px title lines, mt-0.5 and the 20px artist line of a card. */}
              <div className="mt-2 h-[62px] space-y-2 pt-1">
                <SkeletonBlock className="h-3.5 w-11/12 rounded-badge" />
                <SkeletonBlock className="h-3.5 w-3/5 rounded-badge" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
