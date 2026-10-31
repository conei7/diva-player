import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslateSourceText } from '../../../i18n';
import IconButton from '../../ui/IconButton';
import { ChevronLeftIcon, ChevronRightIcon } from '../../ui/icons';

export interface SongShelfProps {
  /** `data-shelf` of the section (recent, playlists, weekly, …). */
  shelf: string;
  title: string;
  /** A page with everything the shelf previews (shown as 「すべて表示」 next to the title). */
  seeAllTo?: string;
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
export default function SongShelf({ shelf, title, seeAllTo, finePointer, children }: SongShelfProps) {
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
        <h2 id={headingId} className="m-0 min-w-0 flex-1 truncate text-xl font-bold leading-7 text-yt-text">
          {title}
        </h2>
        {seeAllTo && (
          <Link
            to={seeAllTo}
            aria-describedby={headingId}
            className="inline-flex min-h-10 shrink-0 items-center rounded-chip px-2 text-sm font-medium leading-5 text-yt-text-secondary no-underline hover:text-yt-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus"
          >
            {t('すべて表示')}
          </Link>
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
        {/* py-1: room inside the scroll box for the cards' focus rings, which it would clip otherwise. */}
        <div
          ref={scrollerRef}
          onScroll={measure}
          className="snap-x snap-mandatory scroll-px-3 overflow-x-auto overscroll-x-contain px-3 py-1 sm:scroll-px-4 sm:px-4 lg:scroll-px-6 lg:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
