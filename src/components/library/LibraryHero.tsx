import { useState, type ReactNode } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { cx } from '../ui/overlay';

export interface LibraryHeroProps {
  /** The page's h1. */
  title: ReactNode;
  titleId: string;
  /** 14px secondary line(s) under the title. */
  meta?: ReactNode;
  /** 16:9 cover (from 640px up; the phone layout leaves it out to show more rows). */
  cover?: ReactNode;
  /** Image blurred behind the hero from 640px up (skipped in hidden mode). Without one the hero is raised gray. */
  backdropUrl?: string;
  /** Round tonal icon buttons. */
  iconActions?: ReactNode;
  /** The main buttons (play / shuffle…), laid out as two equal columns. */
  actions?: ReactNode;
  /** 'fill-first': the first button takes the remaining width (e.g. [再生][↻] on phones). */
  actionsLayout?: 'equal' | 'fill-first';
  className?: string;
}

/**
 * The playlist-style hero of the library pages (rated songs, chorus highlights), framed like
 * PlaylistHero: from 1280px a sticky 360px column as tall as the window, from 640px a band above
 * the list, both on the blurred cover; on phones a compact title + buttons block.
 */
export default function LibraryHero({
  title,
  titleId,
  meta,
  cover,
  backdropUrl,
  iconActions,
  actions,
  actionsLayout = 'equal',
  className,
}: LibraryHeroProps) {
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const [failedBackdrop, setFailedBackdrop] = useState<string | null>(null);
  const showBackdrop = Boolean(backdropUrl) && !hiddenMode && failedBackdrop !== backdropUrl;

  return (
    <section
      aria-labelledby={titleId}
      className={cx(
        'relative isolate min-w-0',
        'sm:overflow-hidden sm:rounded-panel',
        !showBackdrop && 'sm:bg-yt-raised',
        'xl:sticky xl:top-[calc(var(--header-height,56px)_+_var(--selection-bar-height,0px)_+_24px)] xl:h-[calc(100dvh_-_var(--header-height,56px)_-_var(--selection-bar-height,0px)_-_48px)] xl:w-[360px] xl:shrink-0',
        className,
      )}
    >
      {showBackdrop && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 hidden overflow-hidden sm:block">
          <img
            src={backdropUrl}
            alt=""
            decoding="async"
            className="absolute inset-0 h-full w-full scale-[1.2] object-cover opacity-50 blur-[48px]"
            onError={() => setFailedBackdrop(backdropUrl ?? null)}
          />
          <div className="absolute inset-0 bg-[image:var(--hero-gradient)]" />
        </div>
      )}
      <div className="sm:flex sm:items-start sm:gap-6 sm:p-6 xl:block xl:h-full xl:overflow-y-auto xl:overscroll-contain">
        {cover && <div className="hidden w-[320px] shrink-0 sm:block xl:mb-4 xl:w-full">{cover}</div>}
        <div className="min-w-0 flex-1">
          <h1
            id={titleId}
            className="m-0 line-clamp-3 break-words text-[22px] leading-[30px] font-bold text-yt-text sm:text-[28px] sm:leading-9"
          >
            {title}
          </h1>
          {meta && <div className="mt-2 text-sm leading-5 text-yt-text-secondary">{meta}</div>}
          {iconActions && <div className="mt-4 flex flex-wrap items-center gap-2">{iconActions}</div>}
          {actions && (
            <div
              className={cx(
                'mt-4 gap-2 sm:max-w-[360px]',
                actionsLayout === 'fill-first' ? 'flex items-center [&>*:first-child]:min-w-0 [&>*:first-child]:flex-1' : 'grid grid-cols-2',
              )}
            >
              {actions}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
