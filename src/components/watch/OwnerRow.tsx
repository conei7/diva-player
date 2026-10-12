import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import type { Song } from '../../types/vocadb';
import { useTranslate } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { getSongProducerEntries } from '../../utils/songArtists';
import { cx } from '../ui/overlay';
import FavoriteProducerButton from './FavoriteProducerButton';
import type { FavoriteProducerTarget } from './FavoriteProducerButton';

const PRODUCER_COLLAPSE_THRESHOLD = 3;

const TOGGLE_BUTTON =
  'inline-flex min-h-10 min-w-10 shrink-0 cursor-pointer items-center justify-center rounded-full px-2 text-sm font-normal text-yt-text-secondary transition-colors duration-150 hover:bg-yt-tonal hover:text-yt-text sm:min-h-7 sm:min-w-0 sm:text-xs';

/**
 * The producer row under the title: producer names (links) · お気に入りP (the vocalists follow the title).
 * More than three producers collapse into 「他N名」. On phones the one-line name links get a 40px tall
 * hit area (padding inside the clipped line, so the layout does not move).
 */
export default function OwnerRow({ song }: { song: Song }) {
  const tk = useTranslate();
  const language = useLanguageStore(state => state.language);
  const [showAllProducers, setShowAllProducers] = useState(false);

  const producers = getSongProducerEntries(song);
  const visibleProducers = showAllProducers || producers.length <= PRODUCER_COLLAPSE_THRESHOLD
    ? producers
    : producers.slice(0, PRODUCER_COLLAPSE_THRESHOLD);
  const hiddenCount = producers.length - visibleProducers.length;
  const favoriteTargets: FavoriteProducerTarget[] = producers.flatMap(producer => (
    producer.id ? [{ id: producer.id, name: producer.name, artistType: producer.artistType }] : []
  ));
  const separator = language === 'ja' ? '・' : ', ';

  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="min-w-0 flex-1 sm:flex-initial">
        <div
          id="watch-producer-list"
          className="flex min-w-0 items-center text-base font-medium leading-[22px] text-yt-text max-sm:text-sm max-sm:leading-5"
        >
          {/* One line (ellipsis) while collapsed; the full list may wrap (then the links keep their own height). */}
          <span className={cx('min-w-0', showAllProducers ? 'break-words' : 'truncate max-sm:-my-3 max-sm:py-3')}>
            {producers.length > 0 ? visibleProducers.map((producer, index) => (
              <Fragment key={`${producer.id ?? producer.name}-${index}`}>
                {producer.href ? (
                  <Link
                    to={producer.href}
                    className={cx('text-yt-text no-underline hover:underline', !showAllProducers && 'max-sm:py-3')}
                    aria-label={tk('showProducerSongs', { producer: producer.name })}
                  >
                    {producer.name}
                  </Link>
                ) : (
                  <span>{producer.name}</span>
                )}
                {index < visibleProducers.length - 1 && (
                  <span aria-hidden="true" className="text-yt-text-secondary">{separator}</span>
                )}
              </Fragment>
            )) : (
              <span>{song.artistString}</span>
            )}
          </span>
          {hiddenCount > 0 && (
            <button
              type="button"
              className={`${TOGGLE_BUTTON} ml-1`}
              onClick={() => setShowAllProducers(true)}
              aria-expanded="false"
              aria-controls="watch-producer-list"
              aria-label={tk('producerShow', { count: hiddenCount })}
            >
              {tk('producerShowShort', { count: hiddenCount })}
            </button>
          )}
          {showAllProducers && producers.length > PRODUCER_COLLAPSE_THRESHOLD && (
            <button
              type="button"
              className={`${TOGGLE_BUTTON} ml-1`}
              onClick={() => setShowAllProducers(false)}
              aria-expanded="true"
              aria-controls="watch-producer-list"
              aria-label={tk('producerCollapse')}
            >
              {tk('collapse')}
            </button>
          )}
        </div>
      </div>
      <div className="shrink-0 max-sm:ml-auto">
        <FavoriteProducerButton producers={favoriteTargets} />
      </div>
    </div>
  );
}
