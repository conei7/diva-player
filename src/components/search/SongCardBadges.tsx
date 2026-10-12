import { Fragment } from 'react';
import type { MouseEvent, PointerEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import type { Song } from '../../types/vocadb';
import { getVocalistNames } from '../../utils/songMeta';
import { artistPath } from '../../utils/routes';
import { getSongProducerLinks } from './songCardMeta';

/*
 * Small presentational pieces shared by the home tile (SongCard) and the search result row:
 * the artist line and the gray tag (view counts: ui/ViewCounts).
 */

const stopPropagation = (event: MouseEvent | PointerEvent) => event.stopPropagation();

/**
 * 「wowaka · 初音ミク, GUMI」 (tile) or 「wowaka feat. 初音ミク」 (row). Producer names link to their song
 * list unless `linked` is false (selection mode).
 */
export function SongArtistLine({ song, linked = true, vocalistSeparator = ' · ' }: {
  song: Song;
  linked?: boolean;
  vocalistSeparator?: string;
}) {
  const producers = getSongProducerLinks(song);
  // A producer who also sings (self-covers) is named once.
  const producerNames = new Set(producers.map(producer => producer.name));
  const vocalists = getVocalistNames(song).filter(name => !producerNames.has(name)).join(', ');
  if (producers.length === 0 && !vocalists) return <>{song.artistString}</>;
  return (
    <>
      {producers.map((producer, index) => (
        <Fragment key={`${producer.id ?? 'name'}-${producer.name}`}>
          {index > 0 && ', '}
          {linked && producer.id ? (
            <Link
              to={artistPath({ id: producer.id, name: producer.name })}
              onClick={stopPropagation}
              onPointerDown={stopPropagation}
              className="text-inherit no-underline transition-colors duration-150 hover:text-yt-text"
            >
              {producer.name}
            </Link>
          ) : producer.name}
        </Fragment>
      ))}
      {vocalists && (producers.length > 0 ? `${vocalistSeparator}${vocalists}` : vocalists)}
    </>
  );
}

/** The gray 12px tag (song type, self-cover, hidden). */
export function MetaTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-badge bg-yt-tonal px-1.5 text-xs leading-4 font-medium text-yt-text-secondary">
      {children}
    </span>
  );
}
