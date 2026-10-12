import type { MouseEvent, ReactNode, Ref } from 'react';
import { Link } from 'react-router';
import type { Song } from '../../types/vocadb';
import SongThumbnail from '../ui/SongThumbnail';

interface RelatedSongCardProps {
  song: Song;
  href: string;
  /** Plain left click: preventDefault and call this (modifier clicks open `href` in a new tab). */
  onActivate: () => void;
  meta: ReactNode;
  badges?: ReactNode;
  /** ⋮ (always visible on phones). */
  trailing?: ReactNode;
  active?: boolean;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  cardRef?: Ref<HTMLDivElement>;
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Related song on phones: full-width 16:9 thumbnail, then a two-line title and one meta line,
 * with ⋮ at the top right. The title link covers the whole card (like SongListRow).
 */
export default function RelatedSongCard({
  song,
  href,
  onActivate,
  meta,
  badges,
  trailing,
  active = false,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  cardRef,
}: RelatedSongCardProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (selectionMode) {
      event.preventDefault();
      onToggleSelect?.();
      return;
    }
    if (isPlainLeftClick(event)) {
      event.preventDefault();
      onActivate();
    }
  };

  return (
    <div
      ref={cardRef}
      data-now-playing={active ? 'true' : undefined}
      data-selected={selectionMode && selected ? 'true' : undefined}
      className="group relative"
    >
      <SongThumbnail song={song} className="w-full" radius="md" nowPlaying={active} selected={selectionMode && selected}>
        {selectionMode && !selected && (
          <span aria-hidden="true" className="pointer-events-none absolute left-1 top-1 size-6 rounded-full border-2 border-white/80 bg-black/30" />
        )}
      </SongThumbnail>
      <div className="mt-3 flex gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 line-clamp-2 break-words text-sm font-medium leading-5 text-yt-text">
            <Link
              to={href}
              onClick={handleClick}
              onAuxClick={event => { if (selectionMode) event.preventDefault(); }}
              aria-current={active ? 'true' : undefined}
              className="text-inherit no-underline after:absolute after:inset-0 after:rounded-card after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-yt-focus"
            >
              {song.name}
            </Link>
          </h3>
          <p className="m-0 mt-1 truncate text-xs leading-[18px] text-yt-text-secondary">{meta}</p>
          {badges && <div className="pointer-events-none relative z-[1] mt-1">{badges}</div>}
        </div>
        {trailing && <div className="relative z-[1] -mr-2 -mt-2 shrink-0">{trailing}</div>}
      </div>
    </div>
  );
}
