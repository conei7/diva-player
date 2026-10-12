import type { Song } from '../../types/vocadb';
import { getFeaturedVocalistNames } from '../../utils/songMeta';
import ActionBar from './ActionBar';
import OwnerRow from './OwnerRow';

/**
 * Title (with 「feat. vocalists」 right after it), producer row and actions under the video.
 * `watch-video-info` (title + producers) and `watch-action-bar` stay siblings: the info wrapper uses
 * `display: contents`, so from 640px the actions sit next to the producers when both fit on one
 * line and wrap below them otherwise. Under 640px everything is stacked.
 */
export default function VideoInfo({ song }: { song: Song }) {
  const vocalists = getFeaturedVocalistNames(song);
  return (
    <div className="mt-3 min-w-0 max-sm:px-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-6">
        <div data-testid="watch-video-info" className="contents">
          <div className="line-clamp-2 break-words text-xl leading-7 sm:basis-full max-sm:text-lg max-sm:leading-[26px]">
            <h1 className="inline font-bold text-yt-text">{song.name}</h1>
            {vocalists.length > 0 && (
              <span className="ml-2 text-base font-normal text-yt-text-secondary max-sm:text-sm">
                feat. {vocalists.join(', ')}
              </span>
            )}
          </div>
          <OwnerRow song={song} />
        </div>
        <ActionBar song={song} />
      </div>
    </div>
  );
}
